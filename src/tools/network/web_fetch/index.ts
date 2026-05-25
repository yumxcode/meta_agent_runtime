import type { MetaAgentTool, ToolCallContext, ToolResult } from '../../../core/types.js'
import { loadToolPrompt } from '../../util.js'

const MAX_CONTENT = 100 * 1024
/** Max entries — eviction runs on both insert and read paths. */
const CACHE_MAX = 50
const cache = new Map<string, { content: string; expiresAt: number }>()

/** Evict all expired entries.  O(n) but cache is bounded at CACHE_MAX. */
function evictExpired(): void {
  const now = Date.now()
  for (const [k, v] of cache) if (v.expiresAt < now) cache.delete(k)
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"')
    .replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
}

export async function createWebFetchTool(): Promise<MetaAgentTool> {
  const description = await loadToolPrompt(import.meta.url)
  return {
    name: 'web_fetch',
    description,
    isConcurrencySafe: true,
    permission: { category: 'network', planMode: 'allow' },
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to fetch' },
        prompt: { type: 'string', description: 'What to extract from the page' },
      },
      required: ['url', 'prompt'],
    },
    async call(input: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolResult> {
      const rawUrl = input['url'] as string
      const prompt = input['prompt'] as string
      if (!rawUrl) return { content: 'Error: url is required', isError: true }
      const url = rawUrl.startsWith('http://') ? rawUrl.replace('http://', 'https://') : rawUrl

      // Evict expired entries on every read (not just on insert) so stale
      // entries don't linger when the 50-entry high-watermark is never hit.
      evictExpired()
      const cached = cache.get(url)
      if (cached && cached.expiresAt > Date.now()) return { content: cached.content, isError: false }
      if (cached) cache.delete(url)  // expired entry found on direct lookup — remove it

      try {
        const res = await fetch(url, { signal: ctx.abortSignal, headers: { 'User-Agent': 'MetaAgentRuntime/1.0' }, redirect: 'follow' })
        if (!res.ok) return { content: `HTTP ${res.status}: ${res.statusText}`, isError: true }

        const ct = res.headers.get('content-type') ?? ''
        let text: string
        if (ct.includes('application/json')) {
          text = JSON.stringify(await res.json(), null, 2)
        } else {
          const raw = await res.text()
          text = ct.includes('html') ? stripHtml(raw) : raw
        }
        if (text.length > MAX_CONTENT) text = text.slice(0, MAX_CONTENT) + `\n[Truncated — ${text.length} chars total]`

        const result = `URL: ${url}\nPrompt: ${prompt}\n\n---\n\n${text}`
        cache.set(url, { content: result, expiresAt: Date.now() + 15 * 60 * 1000 })
        // Hard cap: if still over limit after TTL eviction, drop oldest entries.
        if (cache.size > CACHE_MAX) {
          evictExpired()
          // If still over cap (all entries fresh), drop the insertion-oldest ones.
          for (const k of cache.keys()) {
            if (cache.size <= CACHE_MAX) break
            cache.delete(k)
          }
        }
        return { content: result, isError: false }
      } catch (err) {
        return { content: `Fetch error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  }
}
