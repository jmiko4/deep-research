import { 
  GoogleSearchService, 
  SearchResponse
} from './google-search-service';
import { generateObject } from 'ai';
import { compact } from 'lodash-es';
import pLimit from 'p-limit';
import { z } from 'zod';

import { o3MiniModel, trimPrompt } from './ai/providers';
import { systemPrompt } from './prompt';
import { OutputManager } from './output-manager';

// Initialize output manager for coordinated console/progress output
const output = new OutputManager();

// Replace console.log with output.log
function log(...args: any[]) {
  output.log(...args);
}

export type ResearchProgress = {
  currentDepth: number;
  totalDepth: number;
  currentBreadth: number;
  totalBreadth: number;
  currentQuery?: string;
  totalQueries: number;
  completedQueries: number;
};

type ResearchResult = {
  learnings: string[];
  visitedUrls: string[];
};

// increase this if you have higher API rate limits
const ConcurrencyLimit = 2;

// Initialize the search service
const searchService = new GoogleSearchService();


// take en user query, return a list of SERP queries
async function generateSerpQueries({
  query,
  numQueries = 3,
  learnings,
}: {
  query: string;
  numQueries?: number;

  // optional, if provided, the research will continue from the last learning
  learnings?: string[];
}) {
  const res = await generateObject({
    model: o3MiniModel,
    system: systemPrompt(),
    prompt: `Given the following prompt from the user, generate a list of SERP queries to research the topic. Return a maximum of ${numQueries} queries, but feel free to return less if the original prompt is clear. Make sure each query is unique and not similar to each other: <prompt>${query}</prompt>\n\n${
      learnings
        ? `Here are some learnings from previous research, use them to generate more specific queries: ${learnings.join(
            '\n',
          )}`
        : ''
    }`,
    schema: z.object({
      queries: z
        .array(
          z.object({
            query: z.string().describe('The SERP query'),
            researchGoal: z
              .string()
              .describe(
                'First talk about the goal of the research that this query is meant to accomplish, then go deeper into how to advance the research once the results are found, mention additional research directions. Be as specific as possible, especially for additional research directions.',
              ),
          }),
        )
        .describe(`List of SERP queries, max of ${numQueries}`),
    }),
  });
  log(
    `Created ${res.object.queries.length} queries`,
    res.object.queries,
  );

  return res.object.queries.slice(0, numQueries);
}

async function processSerpResult({
  query,
  result,
  numLearnings = 3,
  numFollowUpQuestions = 3,
}: {
  query: string;
  result: SearchResponse;
  numLearnings?: number;
  numFollowUpQuestions?: number;
}) {
  const contents = compact(
    result.data.flatMap(item => {
      const content = item.markdown || item.snippet;
      if (!content) return null;
      return chunkContent(trimPrompt(content, 25_000));
    })
  );

  log(`Ran ${query}, found ${contents.length} contents`);

  // If no contents were found, return empty results
  if (contents.length === 0) {
    return {
      learnings: [],
      followUpQuestions: []
    };
  }

  // Add retry logic with exponential backoff
  const maxRetries = 3;
  let currentTry = 0;
  let lastError: any;

  while (currentTry < maxRetries) {
    try {
      const res = await generateObject({
        model: o3MiniModel,
        // Increase timeout for larger content
        abortSignal: AbortSignal.timeout(120_000), // Increased to 120 seconds
        system: systemPrompt(),
        prompt: `Given the following contents from a search for the query <query>${query}</query>, generate a list of learnings from the contents. Return a maximum of ${numLearnings} learnings, but feel free to return less if the contents are clear. Make sure each learning is unique and not similar to each other. The learnings should be concise and to the point, as detailed and information dense as possible. Make sure to include any entities like people, places, companies, products, things, etc in the learnings, as well as any exact metrics, numbers, or dates. The learnings will be used to research the topic further.\n\n<contents>${contents
          .map(content => `<content>\n${content}\n</content>`)
          .join('\n')}</contents>`,
        schema: z.object({
          learnings: z
            .array(z.string())
            .describe(`List of learnings, max of ${numLearnings}`),
          followUpQuestions: z
            .array(z.string())
            .describe(
              `List of follow-up questions to research the topic further, max of ${numFollowUpQuestions}`,
            ),
        }),
      });

      log(
        `Created ${res.object.learnings.length} learnings`,
        res.object.learnings,
      );

      return res.object;
    } catch (error) {
      lastError = error;
      currentTry++;
      
      if (currentTry < maxRetries) {
        // Calculate exponential backoff time
        const backoffTime = Math.min(1000 * Math.pow(2, currentTry), 10000);
        log(`Retry ${currentTry}/${maxRetries} after ${backoffTime}ms for query: ${query}`);
        await new Promise(resolve => setTimeout(resolve, backoffTime));
      }
    }
  }

  // If all retries failed, log the error and return empty results
  console.error(`Failed after ${maxRetries} retries for query: ${query}`, lastError);
  return {
    learnings: [],
    followUpQuestions: []
  };
}

function chunkContent(content: string, maxLength: number = 15000): string[] {
  if (content.length <= maxLength) return [content];
  
  const chunks: string[] = [];
  let currentChunk = '';
  const sentences = content.split(/(?<=[.!?])\s+/);

  for (const sentence of sentences) {
    if ((currentChunk + sentence).length > maxLength) {
      if (currentChunk) chunks.push(currentChunk.trim());
      currentChunk = sentence;
    } else {
      currentChunk += (currentChunk ? ' ' : '') + sentence;
    }
  }
  
  if (currentChunk) chunks.push(currentChunk.trim());
  return chunks;
}

export async function writeFinalReport({
  prompt,
  learnings,
  visitedUrls,
}: {
  prompt: string;
  learnings: string[];
  visitedUrls: string[];
}) {
  // Filter out empty learnings and deduplicate
  const uniqueLearnings = [...new Set(learnings.filter(Boolean))];
  
  const learningsString = trimPrompt(
    uniqueLearnings
      .map(learning => `<learning>\n${learning}\n</learning>`)
      .join('\n'),
    150_000,
  );

  try {
    const res = await generateObject({
      model: o3MiniModel,
      system: systemPrompt(),
      prompt: `Given the following prompt from the user, write a final report on the topic using the learnings from research. Make it as detailed as possible, aim for 3 or more pages, include ALL the learnings from research:\n\n<prompt>${prompt}</prompt>\n\nHere are all the learnings from previous research:\n\n<learnings>\n${learningsString}\n</learnings>`,
      schema: z.object({
        reportMarkdown: z
          .string()
          .describe('Final report on the topic in Markdown'),
      }),
    });

    // Filter out duplicate URLs and invalid URLs
    const uniqueUrls = [...new Set(visitedUrls.filter(url => url && url.startsWith('http')))];

    // Append the visited URLs section to the report
    const urlsSection = `\n\n## Sources\n\n${uniqueUrls.map(url => `- ${url}`).join('\n')}`;
    return res.object.reportMarkdown + urlsSection;
  } catch (error) {
    console.error('Error generating final report:', error);
    return `# Error Generating Report\n\nAn error occurred while generating the final report. Please try again.\n\n## Raw Learnings\n\n${uniqueLearnings.map(l => `- ${l}`).join('\n')}\n\n## Sources\n\n${visitedUrls.map(url => `- ${url}`).join('\n')}`;
  }
}

export async function deepResearch({
  query,
  breadth,
  depth,
  learnings = [],
  visitedUrls = [],
  onProgress,
}: {
  query: string;
  breadth: number;
  depth: number;
  learnings?: string[];
  visitedUrls?: string[];
  onProgress?: (progress: ResearchProgress) => void;
}): Promise<ResearchResult> {
  const progress: ResearchProgress = {
    currentDepth: depth,
    totalDepth: depth,
    currentBreadth: breadth,
    totalBreadth: breadth,
    totalQueries: 0,
    completedQueries: 0,
  };
  
  const reportProgress = (update: Partial<ResearchProgress>) => {
    Object.assign(progress, update);
    onProgress?.(progress);
  };

  const serpQueries = await generateSerpQueries({
    query,
    learnings,
    numQueries: breadth,
  });
  
  reportProgress({
    totalQueries: serpQueries.length,
    currentQuery: serpQueries[0]?.query
  });
  
  const limit = pLimit(ConcurrencyLimit);

  const results = await Promise.all(
    serpQueries.map(serpQuery =>
      limit(async () => {
        try {
          const result = await searchService.search(serpQuery.query, {
            timeout: 15000,
            limit: 5,
            scrapeOptions: { formats: ['markdown'] },
          });

          // Collect URLs from this search
          const newUrls = compact(result.data.map(item => item.url));
          const newBreadth = Math.ceil(breadth / 2);
          const newDepth = depth - 1;

          const newLearnings = await processSerpResult({
            query: serpQuery.query,
            result,
            numFollowUpQuestions: newBreadth,
          });
          const allLearnings = [...learnings, ...newLearnings.learnings];
          const allUrls = [...visitedUrls, ...newUrls];

          if (newDepth > 0) {
            log(
              `Researching deeper, breadth: ${newBreadth}, depth: ${newDepth}`,
            );

            reportProgress({
              currentDepth: newDepth,
              currentBreadth: newBreadth,
              completedQueries: progress.completedQueries + 1,
              currentQuery: serpQuery.query,
            });

            const nextQuery = `
            Previous research goal: ${serpQuery.researchGoal}
            Follow-up research directions: ${newLearnings.followUpQuestions.map(q => `\n${q}`).join('')}
          `.trim();

            return deepResearch({
              query: nextQuery,
              breadth: newBreadth,
              depth: newDepth,
              learnings: allLearnings,
              visitedUrls: allUrls,
              onProgress,
            });
          } else {
            reportProgress({
              currentDepth: 0,
              completedQueries: progress.completedQueries + 1,
              currentQuery: serpQuery.query,
            });
            return {
              learnings: allLearnings,
              visitedUrls: allUrls,
            };
          }
        } catch (e: any) {
          if (e.message && e.message.includes('Timeout')) {
            log(
              `Timeout error running query: ${serpQuery.query}: `,
              e,
            );
          } else {
            log(`Error running query: ${serpQuery.query}: `, e);
          }
          return {
            learnings: [],
            visitedUrls: [],
          };
        }
      }),
    ),
  );

  return {
    learnings: [...new Set(results.flatMap(r => r.learnings))],
    visitedUrls: [...new Set(results.flatMap(r => r.visitedUrls))],
  };
}
