import Anthropic from '@anthropic-ai/sdk'
import type { MetaAgentTool, ToolCallContext, ToolResult } from '../../../core/types.js'
import { loadToolPrompt } from '../../util.js'
import { mcpClients } from '../../mcp/registry.js'
import { loadModelConfig } from '../../../core/config/ConfigService.js'
import { RuntimeEnv } from '../../../infra/env/RuntimeEnv.js'
import { PROVIDERS } from '../../../providers/registry.js'
import { withAbortableTimeout } from '../../../core/utils/withTimeout.js'

export interface WebSearchToolOptions {
  /** Anthropic API key (last-resort provider). */
  apiKey?: string
  /** Model for the Anthropic web-search side-call. */
  model?: string
  /** Tavily API key — preferred provider. Falls back to TAVILY_API_KEY env. */
  tavilyApiKey?: string
}

/**
 * Model for the Anthropic side-call, taken from the provider registry rather
 * than written out here.
 *
 * A hardcoded model string in a leaf tool is a silent expiry date: when the
 * registry moves on, this one keeps naming a model the API may no longer
 * accept, and the failure surfaces at the very bottom of the fallback chain as
 * a generic "all providers failed". Sourcing it from PROVIDERS means the search
 * side-call ages with everything else. `fallback` (not `default`) is the right
 * tier — this is a one-shot summarisation call, not the main loop.
 */
export const DEFAULT_WEB_SEARCH_MODEL =
  PROVIDERS.anthropic.models.fallback ?? PROVIDERS.anthropic.models.default

/**
 * THE provider order: Tavily → GLM → Anthropic. Cheapest and most purpose-built
 * first, a full Claude API request last.
 *
 * This array is the single source of that order. It used to be implied twice —
 * once by the sequence of `if (pinned === …)` branches and once by the sequence
 * of fallback blocks — so the two could drift apart without anything failing,
 * and neither one stated the order as a fact you could read off. Both the pinned
 * path and the fallback chain now iterate this list.
 *
 * Pin a single provider (no fallback) with META_AGENT_SEARCH_PROVIDER=
 * tavily | glm | anthropic — useful for cost control and debugging.
 */
export const SEARCH_PROVIDER_ORDER = ['tavily', 'glm', 'anthropic'] as const
export type SearchProviderId = (typeof SEARCH_PROVIDER_ORDER)[number]

function isSearchProviderId(value: string): value is SearchProviderId {
  return (SEARCH_PROVIDER_ORDER as readonly string[]).includes(value)
}

/** First argument that is a non-empty (after trim) string, else undefined. */
function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const v of values) {
    if (typeof v === 'string' && v.trim() !== '') return v.trim()
  }
  return undefined
}

const TAVILY_ENDPOINT = 'https://api.tavily.com/search'
const TAVILY_MAX_RESULTS = 8
const TAVILY_SNIPPET_CHARS = 600

/** MCP server name and tool name for the GLM web search provider. */
const GLM_MCP_SERVER = 'web-search-prime'
const GLM_MCP_TOOL   = 'web_search_prime'

// ── Deadlines ─────────────────────────────────────────────────────────────────
//
// Every provider is bounded. GLM got a deadline first, because its MCP client
// takes no AbortSignal and a hung server could wedge an unattended run — but
// Tavily and the Anthropic side-call were left leaning entirely on the caller's
// signal, which is the kernel's whole-tool budget. One unresponsive endpoint
// therefore consumed the time the NEXT provider in the chain needed, turning a
// clean fallback into a timeout. Bounding each hop keeps the chain a chain.

const TAVILY_SEARCH_TIMEOUT_MS    = 20_000
const GLM_SEARCH_TIMEOUT_MS       = 30_000
/** Higher: this is a full model turn that itself performs searches. */
const ANTHROPIC_SEARCH_TIMEOUT_MS = 60_000

// ── Provider: Tavily (direct REST — deliberately NOT an MCP server) ──────────

async function callTavilySearch(
  query: string,
  apiKey: string,
  allowedDomains: string[] | undefined,
  blockedDomains: string[] | undefined,
  signal: AbortSignal | undefined,
): Promise<ToolResult> {
  try {
    const res = await withAbortableTimeout(
      deadline => fetch(TAVILY_ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          query,
          max_results: TAVILY_MAX_RESULTS,
          search_depth: 'basic',
          include_answer: true,
          ...(allowedDomains?.length ? { include_domains: allowedDomains } : {}),
          ...(blockedDomains?.length ? { exclude_domains: blockedDomains } : {}),
        }),
        signal: deadline,
      }),
      TAVILY_SEARCH_TIMEOUT_MS,
      signal,
    )
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return { content: `Tavily search error: HTTP ${res.status} ${body.slice(0, 200)}`, isError: true }
    }
    const data = await res.json() as {
      answer?: string
      results?: Array<{ title?: string; url?: string; content?: string; score?: number }>
    }
    const lines: string[] = []
    if (data.answer?.trim()) {
      lines.push(`Answer: ${data.answer.trim()}`, '')
    }
    if (data.results?.length) {
      lines.push('Sources:')
      for (const r of data.results) {
        lines.push(`- ${r.title ?? '(untitled)'}`)
        if (r.url) lines.push(`  ${r.url}`)
        const snippet = (r.content ?? '').trim()
        if (snippet) lines.push(`  ${snippet.slice(0, TAVILY_SNIPPET_CHARS)}`)
      }
    }
    const text = lines.join('\n').trim()
    if (!text) return { content: 'Tavily returned no results', isError: true }
    return { content: text, isError: false }
  } catch (err) {
    return { content: `Tavily search error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
  }
}

// ── Provider: GLM web-search-prime MCP ────────────────────────────────────────

/**
 * Bound a wait that cannot be cancelled.
 *
 * `McpClient.callTool` takes no AbortSignal, so this provider used to be barred
 * from autonomous runs outright ("non-abortable"): a hung MCP server could wedge
 * an unattended session forever. Disabling it fixed the hang by removing the
 * capability — and for a GLM-only install that left auto mode with NO search
 * provider at all, reported as the misleading "no web search provider
 * configured".
 *
 * Bounding the WAIT restores abortability where it matters. We cannot cancel the
 * request itself, but we stop waiting on it, so the loop can never be held
 * hostage by an unresponsive server. The orphaned promise is neutralised so a
 * late rejection cannot surface as an unhandled rejection (which the CLI treats
 * as fatal).
 */
async function withDeadline<T>(
  work: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  label: string,
): Promise<T> {
  work.catch(() => undefined)   // the loser of the race must not go unhandled
  let timer: NodeJS.Timeout | undefined
  let onAbort: (() => void) | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
        timer.unref?.()
        if (signal) {
          onAbort = () => reject(new Error(`${label} aborted`))
          if (signal.aborted) onAbort()
          else signal.addEventListener('abort', onAbort, { once: true })
        }
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
    if (onAbort && signal) signal.removeEventListener('abort', onAbort)
  }
}

async function callGlmSearch(
  query: string,
  signal: AbortSignal | undefined,
): Promise<ToolResult> {
  const client = mcpClients.get(GLM_MCP_SERVER)
  if (!client) {
    // Availability is decided before dispatch (see resolveProviders), so this is
    // a defensive path only — the server cannot vanish between the two.
    return { content: `GLM search error: MCP server "${GLM_MCP_SERVER}" is not registered`, isError: true }
  }
  try {
    const result = await withDeadline(
      client.callTool(GLM_MCP_TOOL, {
        search_query: query,
        content_size: 'medium',
        location: 'us',
      }),
      GLM_SEARCH_TIMEOUT_MS,
      signal,
      'GLM MCP search',
    )
    const text = result.content.filter(c => c.type === 'text' && c.text).map(c => c.text!).join('\n')
    return { content: text || 'No results found', isError: false }
  } catch (err) {
    return { content: `GLM search error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
  }
}

// ── Provider: Anthropic native web_search server tool ─────────────────────────

async function callAnthropicSearch(
  query: string,
  apiKey: string,
  model: string,
  input: Record<string, unknown>,
  signal: AbortSignal | undefined,
): Promise<ToolResult> {
  try {
    const client = new Anthropic({ apiKey, baseURL: PROVIDERS.anthropic.defaultBaseURL })
    const webSearchTool = {
      type: 'web_search_20250305',
      name: 'web_search',
      ...(input['allowed_domains'] ? { allowed_domains: input['allowed_domains'] } : {}),
      ...(input['blocked_domains'] ? { blocked_domains: input['blocked_domains'] } : {}),
    }
    const response = await withAbortableTimeout(
      deadline => (client.messages as unknown as { create: (p: unknown, o: unknown) => Promise<{ content: Array<{ type: string; text?: string }> }> }).create({
        model,
        max_tokens: 1024,
        tools: [webSearchTool],
        messages: [{ role: 'user', content: `Search: ${query}. Provide a concise summary with sources.` }],
      }, { signal: deadline }),
      ANTHROPIC_SEARCH_TIMEOUT_MS,
      signal,
    )
    const text = response.content.filter(b => b.type === 'text' && b.text).map(b => b.text!).join('\n')
    return { content: text || 'No results found', isError: false }
  } catch (err) {
    return { content: `Anthropic search error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
  }
}

// ── Chain assembly ────────────────────────────────────────────────────────────

/**
 * One provider, resolved against the current credentials and MCP registry.
 *
 * `unavailable` is a REASON, not a boolean: the same sentence is what the
 * fallback chain reports as "skipped" and what a failed pin reports as the
 * cause. Keeping one string means the two can never explain the same condition
 * differently.
 */
interface ResolvedProvider {
  id: SearchProviderId
  unavailable: string | null
  run: () => Promise<ToolResult>
}

function resolveProviders(
  query: string,
  input: Record<string, unknown>,
  creds: { tavilyKey: string; anthropicKey: string; model: string },
  signal: AbortSignal | undefined,
): ResolvedProvider[] {
  const allowedDomains = input['allowed_domains'] as string[] | undefined
  const blockedDomains = input['blocked_domains'] as string[] | undefined

  const byId: Record<SearchProviderId, ResolvedProvider> = {
    tavily: {
      id: 'tavily',
      unavailable: creds.tavilyKey
        ? null
        : 'TAVILY_API_KEY not set (env or ~/.meta-agent/config.json)',
      run: () => callTavilySearch(query, creds.tavilyKey, allowedDomains, blockedDomains, signal),
    },
    glm: {
      id: 'glm',
      unavailable: mcpClients.get(GLM_MCP_SERVER)
        ? null
        : `MCP server "${GLM_MCP_SERVER}" is not registered (set ZHIPU_API_KEY / mcp.json)`,
      run: () => callGlmSearch(query, signal),
    },
    anthropic: {
      id: 'anthropic',
      unavailable: creds.anthropicKey ? null : 'ANTHROPIC_API_KEY not set',
      run: () => callAnthropicSearch(query, creds.anthropicKey, creds.model, input, signal),
    },
  }
  return SEARCH_PROVIDER_ORDER.map(id => byId[id])
}

// ── Tool ──────────────────────────────────────────────────────────────────────

export async function createWebSearchTool(options: WebSearchToolOptions = {}): Promise<MetaAgentTool> {
  const description = await loadToolPrompt(import.meta.url)
  return {
    name: 'web_search',
    abortSupport: 'cooperative',
    description,
    isConcurrencySafe: true,
    permission: { category: 'network', planMode: 'allow' },
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (min 2 chars)' },
        allowed_domains: { type: 'array', items: { type: 'string' }, description: 'Only include these domains' },
        blocked_domains: { type: 'array', items: { type: 'string' }, description: 'Exclude these domains' },
      },
      required: ['query'],
    },
    async call(input: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolResult> {
      const query = input['query'] as string
      if (!query || query.length < 2) return { content: 'Error: query must be ≥ 2 characters', isError: true }

      // Resolution: explicit option → env var → ~/.meta-agent/config.json
      // ("tavilyApiKey"). The config-file path is what most users actually
      // configure; without it the chain silently fell through to GLM MCP even
      // though Tavily is the preferred provider. Empty/whitespace values are
      // treated as absent so an empty env var cannot mask the config file.
      const tavilyKey =
        firstNonEmpty(
          options.tavilyApiKey,
          RuntimeEnv.tavilyApiKey(),
          loadModelConfig().tavilyApiKey,
        ) ?? ''
      // ANTHROPIC_API_KEY here is a provider CREDENTIAL (last-resort search
      // provider), not plain config — left at its source per RuntimeEnv's scope.
      const anthropicKey = options.apiKey ?? process.env['ANTHROPIC_API_KEY'] ?? ''
      const model = options.model ?? DEFAULT_WEB_SEARCH_MODEL
      const providers = resolveProviders(
        query, input, { tavilyKey, anthropicKey, model }, ctx.abortSignal,
      )

      // ── Pinned provider: exactly one attempt, no fallback ─────────────────
      const pin = RuntimeEnv.searchProviderPin()
      if (pin) {
        if (!isSearchProviderId(pin)) {
          return {
            content:
              `Error: META_AGENT_SEARCH_PROVIDER="${pin}" is not a known provider. ` +
              `Valid values: ${SEARCH_PROVIDER_ORDER.join(' | ')}.`,
            isError: true,
          }
        }
        const provider = providers.find(p => p.id === pin)!
        if (provider.unavailable) {
          return {
            content: `Error: META_AGENT_SEARCH_PROVIDER=${pin} but ${provider.unavailable}.`,
            isError: true,
          }
        }
        return provider.run()
      }

      // ── Default chain: Tavily → GLM → Anthropic ───────────────────────────
      const failures: string[] = []
      /** Providers that were not even attempted, and why. Reported on failure. */
      const skipped: string[] = []

      for (const provider of providers) {
        if (provider.unavailable) {
          skipped.push(`${provider.id}: ${provider.unavailable}`)
          continue
        }
        const result = await provider.run()
        if (!result.isError) return result
        failures.push(result.content)
      }

      // Name what happened to EVERY provider. The old message reported only
      // "no web search provider configured" whenever nothing had been tried,
      // which sent operators looking for a missing key while the real cause was
      // a provider that had been skipped for an entirely different reason.
      const detail = [
        ...failures.map(f => `- failed → ${f}`),
        ...skipped.map(s => `- skipped → ${s}`),
      ].join('\n')
      return {
        content: failures.length > 0
          ? `web_search failed across all providers:\n${detail}`
          : `Error: no usable web search provider.\n${detail}\n` +
            'Set TAVILY_API_KEY (recommended), or ZHIPU_API_KEY (GLM web-search-prime MCP), or ANTHROPIC_API_KEY.',
        isError: true,
      }
    },
  }
}
