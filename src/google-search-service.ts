// google-search-service.ts
import axios from 'axios';
import TurndownService from 'turndown';

export interface SearchResult {
  url: string;
  title: string;
  snippet: string;
  markdown?: string;
}

export interface SearchResponse {
  success: boolean;
  data: SearchResult[];
  warning?: string;
}

export interface SearchOptions {
  timeout?: number;
  limit?: number;
  scrapeOptions?: { formats: string[] };
}

export class GoogleSearchService {
  private turndown: TurndownService;
  
  constructor(
    private apiKey: string = process.env.GOOGLE_API_KEY || '',
    private searchEngineId: string = process.env.GOOGLE_SEARCH_ENGINE_ID || ''
  ) {
    if (!this.apiKey || !this.searchEngineId) {
      throw new Error('Google API key or Search Engine ID not configured');
    }
    this.turndown = new TurndownService();
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
    try {
      const response = await axios.get('https://www.googleapis.com/customsearch/v1', {
        params: {
          key: this.apiKey,
          cx: this.searchEngineId,
          q: query,
          num: options.limit || 10
        },
        timeout: options.timeout || 15000
      });

      if (response.status === 200 && response.data.items) {
        const results: SearchResult[] = await Promise.all(
          response.data.items.map(async (item: any) => {
            let markdown = '';
            
            if (options.scrapeOptions?.formats?.includes('markdown')) {
              try {
                const pageResponse = await axios.get(item.link, { 
                  timeout: 5000,
                  headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                  }
                });
                markdown = this.turndown.turndown(pageResponse.data);
              } catch (error) {
                console.warn(`Failed to fetch content for ${item.link}`);
              }
            }

            return {
              url: item.link,
              title: item.title,
              snippet: item.snippet || '',
              markdown: markdown
            };
          })
        );

        return {
          success: true,
          data: results
        };
      }

      return {
        success: true,
        data: []
      };

    } catch (error: any) {
      console.error('Search error:', error.message);
      throw new Error(`Search failed: ${error.message}`);
    }
  }
}