/**
 * Web Tools
 *
 * web_search  — search the web (via multiple backends: Exa, Tavily, DuckDuckGo, SearXNG)
 * web_fetch   — fetch and extract content from a URL
 */

import { registerTools } from './registry.js';
import type { ToolEntry } from '../types.js';

const MAX_FETCH_CHARS = 50_000;
const MAX_SEARCH_RESULTS = 10;

// ---------------------------------------------------------------------------
// Web fetch helpers
// ---------------------------------------------------------------------------

async function fetchUrl(url: string, maxChars = MAX_FETCH_CHARS): Promise<string> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; HermesAgent/1.0)',
      Accept: 'text/html,application/json,*/*',
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const contentType = response.headers.get('content-type') ?? '';

  if (contentType.includes('application/json')) {
    const json = await response.json();
    const text = JSON.stringify(json, null, 2);
    return text.length > maxChars ? text.slice(0, maxChars) + '\n[... truncated]' : text;
  }

  const html = await response.text();

  // Simple HTML → text extraction (strip tags)
  const text = stripHtml(html);
  return text.length > maxChars ? text.slice(0, maxChars) + '\n[... truncated]' : text;
}

function stripHtml(html: string): string {
  // Remove scripts and styles
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return text;
}

// ---------------------------------------------------------------------------
// Search backends
// ---------------------------------------------------------------------------

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** Exa search (exa.ai) */
async function searchExa(
  query: string,
  apiKey: string,
  numResults: number,
): Promise<SearchResult[]> {
  const response = await fetch('https://api.exa.ai/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify({
      query,
      numResults,
      type: 'auto',
      contents: { text: { maxCharacters: 1000 } },
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) throw new Error(`Exa API error: ${response.status}`);
  const data = await response.json() as {
    results: Array<{ title: string; url: string; text?: string; snippet?: string }>;
  };

  return data.results.map((r) => ({
    title: r.title ?? '',
    url: r.url,
    snippet: r.text ?? r.snippet ?? '',
  }));
}

/** Tavily search */
async function searchTavily(
  query: string,
  apiKey: string,
  numResults: number,
): Promise<SearchResult[]> {
  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: apiKey, query, max_results: numResults }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) throw new Error(`Tavily API error: ${response.status}`);
  const data = await response.json() as {
    results: Array<{ title: string; url: string; content: string }>;
  };

  return data.results.map((r) => ({
    title: r.title ?? '',
    url: r.url,
    snippet: r.content ?? '',
  }));
}

/** SearXNG (self-hosted) */
async function searchSearXNG(
  query: string,
  baseUrl: string,
  numResults: number,
): Promise<SearchResult[]> {
  const url = new URL('/search', baseUrl);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('engines', 'google,bing');

  const response = await fetch(url.toString(), {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) throw new Error(`SearXNG error: ${response.status}`);
  const data = await response.json() as {
    results: Array<{ title: string; url: string; content: string }>;
  };

  return data.results.slice(0, numResults).map((r) => ({
    title: r.title ?? '',
    url: r.url,
    snippet: r.content ?? '',
  }));
}

/** Auto-select search backend based on environment variables. */
async function performSearch(
  query: string,
  numResults: number,
): Promise<SearchResult[]> {
  const exaKey = process.env['EXA_API_KEY'];
  const tavilyKey = process.env['TAVILY_API_KEY'];
  const searxngUrl = process.env['SEARXNG_URL'];

  if (exaKey) return searchExa(query, exaKey, numResults);
  if (tavilyKey) return searchTavily(query, tavilyKey, numResults);
  if (searxngUrl) return searchSearXNG(query, searxngUrl, numResults);

  // Fallback: DuckDuckGo Instant Answer API (limited but no key needed)
  const ddgUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
  const resp = await fetch(ddgUrl, { signal: AbortSignal.timeout(10_000) });
  const data = await resp.json() as {
    Abstract?: string;
    AbstractURL?: string;
    AbstractText?: string;
    RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>;
  };

  const results: SearchResult[] = [];
  if (data.AbstractText) {
    results.push({
      title: query,
      url: data.AbstractURL ?? '',
      snippet: data.AbstractText,
    });
  }
  for (const topic of data.RelatedTopics?.slice(0, numResults - 1) ?? []) {
    if (topic.Text && topic.FirstURL) {
      results.push({ title: topic.Text.slice(0, 80), url: topic.FirstURL, snippet: topic.Text });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const webTools: ToolEntry[] = [
  // ---------------------------
  // web_search
  // ---------------------------
  {
    name: 'web_search',
    toolset: 'web',
    parallelSafe: true,
    emoji: '🌐',
    definition: {
      name: 'web_search',
      description:
        'Search the web for current information. Returns a list of results with titles, URLs, and snippets. Supports Exa (EXA_API_KEY), Tavily (TAVILY_API_KEY), SearXNG (SEARXNG_URL), or DuckDuckGo as fallback.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query.',
          },
          num_results: {
            type: 'integer',
            description: `Number of results to return. Default ${MAX_SEARCH_RESULTS}.`,
          },
        },
        required: ['query'],
      },
    },
    handler: async (args) => {
      const query = args['query'] as string;
      const numResults = (args['num_results'] as number | undefined) ?? MAX_SEARCH_RESULTS;

      const results = await performSearch(query, numResults);

      if (results.length === 0) return `No results found for: "${query}"`;

      return results
        .map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet}`)
        .join('\n\n');
    },
  },

  // ---------------------------
  // web_fetch
  // ---------------------------
  {
    name: 'web_fetch',
    toolset: 'web',
    parallelSafe: true,
    emoji: '🔗',
    maxResultSizeChars: 50_000,
    definition: {
      name: 'web_fetch',
      description:
        'Fetch the content of a URL and return its text. Strips HTML tags. Useful for reading articles, documentation, or API responses.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The URL to fetch.',
          },
          max_chars: {
            type: 'integer',
            description: `Maximum characters to return. Default ${MAX_FETCH_CHARS}.`,
          },
        },
        required: ['url'],
      },
    },
    handler: async (args) => {
      const url = args['url'] as string;
      const maxChars = (args['max_chars'] as number | undefined) ?? MAX_FETCH_CHARS;

      try {
        const content = await fetchUrl(url, maxChars);
        return `Content from ${url}:\n\n${content}`;
      } catch (err) {
        return `Failed to fetch ${url}: ${(err as Error).message}`;
      }
    },
  },
];

// Register all web tools
registerTools(webTools);

export default webTools;
