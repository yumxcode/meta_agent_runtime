import { lookup } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { LookupAddress } from 'node:dns'
import type { MetaAgentTool, ToolCallContext, ToolResult } from '../../../core/types.js'
import { loadToolPrompt } from '../../util.js'

const MAX_CONTENT = 100 * 1024
/** Max entries — eviction runs on both insert and read paths. */
const CACHE_MAX = 50
/** Max redirects we follow manually. */
const MAX_REDIRECTS = 5
const cache = new Map<string, { content: string; expiresAt: number }>()

/** Evict all expired entries.  O(n) but cache is bounded at CACHE_MAX. */
function evictExpired(): void {
  const now = Date.now()
  for (const [k, v] of cache) if (v.expiresAt < now) cache.delete(k)
}

/**
 * M4: Allow tests / callers to clear the module-level cache.
 *
 * Exposed so vitest can reset state between cases and so application code
 * can drop cached pages on demand (e.g. when network conditions change or
 * the user explicitly asks for a fresh fetch).
 */
export function clearWebFetchCache(): void {
  cache.clear()
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"')
    .replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
}

// ── H1: SSRF defence ──────────────────────────────────────────────────────────
//
// Reject URLs that resolve to private / loopback / link-local IP space, the
// metadata services used by AWS/GCP/Azure, or non-http(s) schemes. Redirects
// are followed manually so every hop gets the same treatment — a 302 from a
// public host to 169.254.169.254 cannot bypass the check.

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])

/** Returns null if the IP is allowed, otherwise a human-readable rejection. */
function classifyIp(ip: string): string | null {
  // IPv4 private ranges (RFC 1918) + loopback + link-local + CG-NAT + IMDS
  // + this-network + benchmark + documentation + multicast + broadcast.
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const a = Number(v4[1]); const b = Number(v4[2])
    if (a === 10) return 'private 10/8'
    if (a === 127) return 'loopback 127/8'
    if (a === 0) return 'this-network 0/8'
    if (a === 169 && b === 254) return 'link-local / metadata 169.254/16'
    if (a === 172 && b >= 16 && b <= 31) return 'private 172.16/12'
    if (a === 192 && b === 168) return 'private 192.168/16'
    if (a === 192 && b === 0) return 'IETF / IANA reserved 192.0/16'
    if (a === 198 && (b === 18 || b === 19)) return 'benchmark 198.18/15'
    if (a === 100 && b >= 64 && b <= 127) return 'CG-NAT 100.64/10'
    if (a >= 224 && a <= 239) return 'multicast 224/4'
    if (a >= 240) return 'reserved 240/4'
    return null
  }
  // IPv6 — best-effort.  Treat anything that isn't clearly global as private.
  const lower = ip.toLowerCase()
  if (lower === '::1' || lower === '::') return 'loopback ::1'
  if (lower.startsWith('fe80:') || lower.startsWith('fe80::')) return 'IPv6 link-local fe80::/10'
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return 'IPv6 ULA fc00::/7'
  if (lower.startsWith('::ffff:')) {
    // IPv4-mapped IPv6 — re-check the embedded IPv4 portion.
    const mapped = lower.slice(7)
    return classifyIp(mapped)
  }
  if (lower.startsWith('ff')) return 'IPv6 multicast ff00::/8'
  return null
}

interface ValidatedTarget {
  url: URL
  resolvedHost: string
  /** The DNS results that PASSED classification, captured at validation time. */
  addresses: LookupAddress[]
}

async function validateUrl(rawUrl: string): Promise<{ ok: true; value: ValidatedTarget } | { ok: false; reason: string }> {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return { ok: false, reason: 'invalid URL' }
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return { ok: false, reason: `scheme ${parsed.protocol} is not allowed` }
  }
  const host = parsed.hostname
  if (!host) return { ok: false, reason: 'URL has no hostname' }
  // Reject explicit literal "localhost" before DNS so a tampered resolver
  // mapping localhost → public IP can't bypass us.
  if (host.toLowerCase() === 'localhost') {
    return { ok: false, reason: 'localhost is not allowed' }
  }
  // DNS-resolve and inspect every returned address. `all: true` returns the
  // full set so we don't accidentally allow a host that round-robins between
  // a public and a private IP.
  try {
    const results = await lookup(host, { all: true })
    for (const { address } of results) {
      const reason = classifyIp(address)
      if (reason !== null) {
        return { ok: false, reason: `host ${host} resolved to ${address} (${reason})` }
      }
    }
    if (results.length === 0) return { ok: false, reason: `host ${host} did not resolve` }
    // H1: capture the validated addresses so the connection can be PINNED to
    // them. The previous implementation handed the URL to fetch(), which did
    // its OWN second DNS resolution — opening a DNS-rebinding window where a
    // malicious resolver returns a public IP at validation time (T1) and a
    // private/metadata IP at connect time (T2). Pinning closes that gap.
    return { ok: true, value: { url: parsed, resolvedHost: host, addresses: results } }
  } catch (err) {
    return { ok: false, reason: `DNS lookup failed for ${host}: ${err instanceof Error ? err.message : String(err)}` }
  }
}

interface PinnedResponse {
  status: number
  statusText: string
  headers: Map<string, string>
  text(): Promise<string>
}

/**
 * Perform a single HTTP(S) request PINNED to a set of pre-validated IPs.
 *
 * The custom `lookup` short-circuits Node's DNS so the socket connects to an
 * address that already passed classifyIp() — there is no second, independent
 * resolution that a rebinding attacker could swing to a private IP. The
 * original hostname is preserved on the request, so the Host header and TLS
 * SNI/certificate validation remain correct.
 */
function requestPinned(
  target: ValidatedTarget,
  signal: AbortSignal,
): Promise<PinnedResponse> {
  return new Promise<PinnedResponse>((resolvePromise, reject) => {
    const isHttps = target.url.protocol === 'https:'
    const requestFn = isHttps ? httpsRequest : httpRequest
    const pinned = target.addresses[0]!

    // Custom lookup: ignore the queried hostname and return a validated IP.
    // Re-classify defensively in case a future caller widens the address set.
    const pinnedLookup = (
      _hostname: string,
      _opts: unknown,
      cb: (err: NodeJS.ErrnoException | null, address: string, family: number) => void,
    ): void => {
      if (classifyIp(pinned.address) !== null) {
        cb(new Error('pinned address failed re-validation'), '', 0)
        return
      }
      cb(null, pinned.address, pinned.family)
    }

    const req = requestFn(
      target.url,
      {
        method: 'GET',
        headers: { 'User-Agent': 'MetaAgentRuntime/1.0', Accept: '*/*' },
        signal,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        lookup: pinnedLookup as any,
        servername: isHttps ? target.resolvedHost : undefined,
      },
      (res) => {
        const headers = new Map<string, string>()
        for (const [k, v] of Object.entries(res.headers)) {
          if (typeof v === 'string') headers.set(k.toLowerCase(), v)
          else if (Array.isArray(v)) headers.set(k.toLowerCase(), v.join(', '))
        }
        const status = res.statusCode ?? 0
        // For redirects we don't need the body — drain and resolve immediately.
        if (status >= 300 && status < 400 && headers.has('location')) {
          res.resume()
          resolvePromise({
            status,
            statusText: res.statusMessage ?? '',
            headers,
            text: async () => '',
          })
          return
        }
        const chunks: Buffer[] = []
        let total = 0
        res.on('data', (chunk: Buffer) => {
          total += chunk.length
          // Read a little past MAX_CONTENT so the caller's truncation message
          // is accurate; then stop to bound memory.
          if (total <= MAX_CONTENT * 2) chunks.push(chunk)
        })
        res.on('end', () => {
          resolvePromise({
            status,
            statusText: res.statusMessage ?? '',
            headers,
            text: async () => Buffer.concat(chunks).toString('utf-8'),
          })
        })
        res.on('error', reject)
      },
    )
    req.on('error', reject)
    req.end()
  })
}

async function fetchWithSafeRedirects(
  startUrl: string,
  signal: AbortSignal,
): Promise<{ ok: true; res: PinnedResponse; finalUrl: string } | { ok: false; reason: string }> {
  let currentUrl = startUrl
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const check = await validateUrl(currentUrl)
    if (!check.ok) return { ok: false, reason: check.reason }
    const res = await requestPinned(check.value, signal)
    // Treat 3xx with Location as a redirect we control — every hop is
    // re-validated AND re-pinned by the next loop iteration.
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      currentUrl = new URL(res.headers.get('location')!, currentUrl).toString()
      continue
    }
    return { ok: true, res, finalUrl: currentUrl }
  }
  return { ok: false, reason: `too many redirects (>${MAX_REDIRECTS})` }
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
      if (cached && cached.expiresAt > Date.now()) {
        // L3: touch-on-read so eviction is true LRU, not FIFO. Re-inserting
        // moves this key to the most-recently-used end of the Map.
        cache.delete(url)
        cache.set(url, cached)
        return { content: cached.content, isError: false }
      }
      if (cached) cache.delete(url)  // expired entry found on direct lookup — remove it

      try {
        const fetchOutcome = await fetchWithSafeRedirects(url, ctx.abortSignal)
        if (!fetchOutcome.ok) {
          return { content: `Refused: ${fetchOutcome.reason}`, isError: true }
        }
        const { res, finalUrl } = fetchOutcome
        if (res.status < 200 || res.status >= 300) {
          return { content: `HTTP ${res.status}: ${res.statusText}`, isError: true }
        }

        const ct = res.headers.get('content-type') ?? ''
        const raw = await res.text()
        let text: string
        if (ct.includes('application/json')) {
          try { text = JSON.stringify(JSON.parse(raw), null, 2) } catch { text = raw }
        } else {
          text = ct.includes('html') ? stripHtml(raw) : raw
        }
        if (text.length > MAX_CONTENT) text = text.slice(0, MAX_CONTENT) + `\n[Truncated — ${text.length} chars total]`

        const result = `URL: ${finalUrl}\nPrompt: ${prompt}\n\n---\n\n${text}`
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
