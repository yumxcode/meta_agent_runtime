import { lookup } from 'node:dns/promises'
import { isIP, type LookupFunction } from 'node:net'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { LookupAddress } from 'node:dns'
import type { MetaAgentTool, ToolCallContext, ToolResult } from '../../../core/types.js'
import { loadToolPrompt } from '../../util.js'
import { RuntimeEnv } from '../../../infra/env/RuntimeEnv.js'

const MAX_CONTENT = 100 * 1024

/**
 * Request headers presented to the remote server.
 *
 * Many sites (GitHub, anything behind Cloudflare) reject obvious bot
 * User-Agents with 403/404, so we present a realistic browser UA by default.
 * Override with META_AGENT_WEB_FETCH_UA when a specific identity is required.
 */
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/124.0.0.0 Safari/537.36'

function buildRequestHeaders(): Record<string, string> {
  return {
    'User-Agent': RuntimeEnv.webFetchUserAgent(DEFAULT_USER_AGENT),
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    // Identity only. We decode nothing, so a server that honours this header
    // cannot hand us a gzip stream that we would then decode as UTF-8 garbage.
    'Accept-Encoding': 'identity',
  }
}

/** Max entries — eviction runs on both insert and read paths. */
const CACHE_MAX = 50
/** Max redirects we follow manually. */
const MAX_REDIRECTS = 5

/**
 * Idle-socket deadline for ONE request hop, and the ceiling for the whole call
 * (validation + every redirect hop + every address retry).
 *
 * web_fetch used to carry no deadline of its own: it passed the caller's signal
 * (the kernel's per-tool timeout) straight through, so a server that trickled
 * bytes below the size cap held the socket for the entire tool budget. "Slow"
 * and "hung" were indistinguishable and both cost the maximum. The per-hop
 * timeout also lets address failover move on quickly instead of waiting out a
 * blackholed IP.
 */
const HOP_IDLE_TIMEOUT_MS = 20_000
const TOTAL_TIMEOUT_MS = 45_000

/** How many of the validated addresses to try before giving up. */
const MAX_ADDRESS_ATTEMPTS = 3

/**
 * One cached page.
 *
 * The BODY is cached, not the rendered result. Caching the rendered string meant
 * caching the `Prompt:` line baked into it, so a second fetch of the same URL
 * with a different extraction goal replayed the FIRST call's prompt back to the
 * model — a stale instruction presented as if it were the current one.
 */
export interface CachedPage {
  finalUrl: string
  text: string
  /** Advisory prepended to the body (e.g. the SPA-shell warning). */
  note?: string
  expiresAt: number
}

const cache = new Map<string, CachedPage>()

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

/**
 * @internal Seed the cache directly.
 *
 * Exists for tests: the SSRF guard refuses loopback, so a test cannot stand up a
 * local server to populate the cache the normal way, and the prompt-vs-body
 * caching rule is exactly the kind of thing that silently regresses.
 */
export function primeWebFetchCache(url: string, page: CachedPage): void {
  cache.set(url, page)
}

/** Compose the tool result. The prompt is applied HERE, never cached. */
export function renderPage(page: Pick<CachedPage, 'finalUrl' | 'text' | 'note'>, prompt: string): string {
  const header = `URL: ${page.finalUrl}\nPrompt: ${prompt}\n\n---\n\n`
  return `${header}${page.note ? `${page.note}\n\n` : ''}${page.text}`.trim()
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"')
    .replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
}

// ── Content-type gate ─────────────────────────────────────────────────────────
//
// web_fetch returns TEXT. Everything that reached this tool used to be decoded
// as UTF-8 regardless of what it was, so fetching a PDF, an image or a tarball
// spent up to 100 KB of context on mojibake — and the model, seeing a non-error
// result, would try to read meaning out of it. Refusing with a named reason is
// both cheaper and actionable.

type BodyKind = 'html' | 'json' | 'text' | 'binary'

/** `application/…` subtypes that are text despite not living under `text/`. */
const TEXTUAL_APPLICATION_SUBTYPE =
  /^(?:json|xml|yaml|x-yaml|csv|javascript|ecmascript|x-ndjson|graphql|x-www-form-urlencoded|rss\+xml|atom\+xml)$/

/** A NUL byte in the first KB is the classic "this is not text" tell. */
function looksBinary(body: Buffer): boolean {
  return body.subarray(0, 1024).includes(0)
}

function mimeOf(contentType: string): string {
  return (contentType.split(';')[0] ?? '').trim().toLowerCase()
}

/** @internal exported for tests. */
export function classifyBody(contentType: string, body: Buffer): BodyKind {
  const mime = mimeOf(contentType)
  // No declared type: sniff rather than guess, so a plain-text endpoint that
  // omits the header keeps working.
  if (!mime) return looksBinary(body) ? 'binary' : 'text'
  if (mime === 'text/html' || mime === 'application/xhtml+xml') return 'html'
  if (mime === 'application/json' || mime.endsWith('+json')) return 'json'
  if (mime.startsWith('text/')) return 'text'
  const [type, subtype = ''] = mime.split('/')
  if (type === 'application' && TEXTUAL_APPLICATION_SUBTYPE.test(subtype)) return 'text'
  return 'binary'
}

/**
 * Produce a short, actionable hint for a non-2xx response so the model
 * self-corrects instead of retrying the same dead URL. Returns '' when no
 * specific guidance applies.
 */
function nonOkHint(url: string, status: number): string {
  let host = ''
  try { host = new URL(url).hostname } catch { /* ignore */ }
  const isSearchPage = /[?&]q=/.test(url) && /\/search\b/.test(url)
  if (host === 'github.com' && isSearchPage) {
    return ' Hint: github.com/search blocks non-browser clients. Use the API: ' +
      'https://api.github.com/search/repositories?q=<keywords>&sort=stars'
  }
  if (status === 404) {
    return ' Hint: the URL does not exist or the server rejects bots. ' +
      'Try a JSON API endpoint or a different source rather than retrying this URL.'
  }
  if (status === 403 || status === 429) {
    return ' Hint: blocked or rate-limited. Prefer an official API endpoint, ' +
      'or back off and try a different source.'
  }
  return ''
}

/** Heuristic: did an HTML page strip down to almost nothing (likely a SPA shell)? */
function looksLikeEmptySpa(stripped: string, kind: BodyKind): boolean {
  return kind === 'html' && stripped.replace(/\s+/g, ' ').trim().length < 200
}

// ── H1: SSRF defence ──────────────────────────────────────────────────────────
//
// Reject URLs that resolve to private / loopback / link-local IP space, the
// metadata services used by AWS/GCP/Azure, or non-http(s) schemes. Redirects
// are followed manually so every hop gets the same treatment — a 302 from a
// public host to 169.254.169.254 cannot bypass the check.

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])

/**
 * When META_AGENT_TRUST_FAKE_IP=1 is set, the 198.18/15 benchmark range is
 * allowed through.  This range is used as a "fake IP" pool by transparent
 * proxies such as Clash (TUN + fake-ip DNS mode): the proxy intercepts the
 * connection and routes it to the real destination.  Without this opt-in the
 * SSRF check refuses the fake IP before the proxy gets a chance to intercept.
 */
const TRUST_FAKE_IP = RuntimeEnv.trustFakeIp()

/** Returns null if the IP is allowed, otherwise a human-readable rejection. */
function classifyIp(ip: string): string | null {
  // WHATWG URL.hostname keeps brackets around IPv6 literals in Node. DNS
  // results do not, so normalize both representations before classification.
  const normalized = ip.startsWith('[') && ip.endsWith(']') ? ip.slice(1, -1) : ip
  // IPv4 private ranges (RFC 1918) + loopback + link-local + CG-NAT + IMDS
  // + this-network + benchmark + documentation + multicast + broadcast.
  const v4 = normalized.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const a = Number(v4[1]); const b = Number(v4[2])
    if (a === 10) return 'private 10/8'
    if (a === 127) return 'loopback 127/8'
    if (a === 0) return 'this-network 0/8'
    if (a === 169 && b === 254) return 'link-local / metadata 169.254/16'
    if (a === 172 && b >= 16 && b <= 31) return 'private 172.16/12'
    if (a === 192 && b === 168) return 'private 192.168/16'
    if (a === 192 && b === 0) return 'IETF / IANA reserved 192.0/16'
    if (a === 198 && (b === 18 || b === 19) && !TRUST_FAKE_IP) return 'benchmark 198.18/15'
    if (a === 100 && b >= 64 && b <= 127) return 'CG-NAT 100.64/10'
    if (a >= 224 && a <= 239) return 'multicast 224/4'
    if (a >= 240) return 'reserved 240/4'
    return null
  }
  // IPv6 — best-effort.  Treat anything that isn't clearly global as private.
  const lower = normalized.toLowerCase()
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
  // Classify IP literals directly. Besides avoiding needless DNS, this is
  // essential for bracketed IPv6: request() connects literals without calling
  // the custom lookup hook, so they must be rejected before the request.
  const literalHost = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
  const literalFamily = isIP(literalHost)
  if (literalFamily !== 0) {
    const reason = classifyIp(literalHost)
    if (reason !== null) {
      return { ok: false, reason: `host ${host} is not allowed (${reason})` }
    }
    return {
      ok: true,
      value: {
        url: parsed,
        resolvedHost: host,
        addresses: [{ address: literalHost, family: literalFamily }],
      },
    }
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
  bytes(): Buffer
}

type PinnedLookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void

/** @internal exported for regression tests around Node's lookup callback modes. */
export function createPinnedLookup(pinned: LookupAddress) {
  return (
    _hostname: string,
    opts: unknown,
    cb: PinnedLookupCallback,
  ): void => {
    if (classifyIp(pinned.address) !== null) {
      cb(new Error('pinned address failed re-validation'), '', 0)
      return
    }
    if (
      opts !== null &&
      typeof opts === 'object' &&
      'all' in opts &&
      (opts as { all?: unknown }).all === true
    ) {
      cb(null, [{ address: pinned.address, family: pinned.family }])
      return
    }
    cb(null, pinned.address, pinned.family)
  }
}

/**
 * Perform a single HTTP(S) request PINNED to one pre-validated IP.
 *
 * The custom `lookup` short-circuits Node's DNS so the socket connects to an
 * address that already passed classifyIp() — there is no second, independent
 * resolution that a rebinding attacker could swing to a private IP. The
 * original hostname is preserved on the request, so the Host header and TLS
 * SNI/certificate validation remain correct.
 */
function requestPinned(
  target: ValidatedTarget,
  pinned: LookupAddress,
  signal: AbortSignal,
): Promise<PinnedResponse> {
  return new Promise<PinnedResponse>((resolvePromise, reject) => {
    const isHttps = target.url.protocol === 'https:'
    const requestFn = isHttps ? httpsRequest : httpRequest

    // Custom lookup: ignore the queried hostname and return a validated IP.
    const pinnedLookup = createPinnedLookup(pinned)

    const req = requestFn(
      target.url,
      {
        method: 'GET',
        headers: buildRequestHeaders(),
        signal,
        // createPinnedLookup accepts `opts: unknown` so it can answer both the
        // `all: true` and single-address call shapes; LookupFunction declares
        // the narrower overload set, so the cast is on the options parameter
        // only, not on the callback contract.
        lookup: pinnedLookup as unknown as LookupFunction,
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
            bytes: () => Buffer.alloc(0),
          })
          return
        }
        const chunks: Buffer[] = []
        let total = 0
        res.on('data', (chunk: Buffer) => {
          total += chunk.length
          // Read a little past MAX_CONTENT so the caller's truncation message
          // is accurate; then stop to bound memory.
          if (total <= MAX_CONTENT * 2) {
            chunks.push(chunk)
            return
          }
          // L2-fix: once over the cap, TERMINATE the transfer instead of
          // draining it — a malicious server could otherwise stream gigabytes
          // and hold the connection/bandwidth until the tool timeout. Resolving
          // first makes the destroy-triggered 'error' a no-op (promise already
          // settled).
          const body = Buffer.concat(chunks)
          resolvePromise({
            status,
            statusText: res.statusMessage ?? '',
            headers,
            bytes: () => body,
          })
          res.destroy()
        })
        res.on('end', () => {
          const body = Buffer.concat(chunks)
          resolvePromise({
            status,
            statusText: res.statusMessage ?? '',
            headers,
            bytes: () => body,
          })
        })
        res.on('error', reject)
      },
    )
    // Idle-socket deadline for THIS hop. Independent of the overall budget so a
    // blackholed address is abandoned promptly and the next one gets a turn.
    req.setTimeout(HOP_IDLE_TIMEOUT_MS, () => {
      req.destroy(new Error(`no data for ${HOP_IDLE_TIMEOUT_MS}ms`))
    })
    req.on('error', reject)
    req.end()
  })
}

/**
 * Try the validated addresses in turn until one answers.
 *
 * Pinning previously used `addresses[0]` and nothing else, so a host whose first
 * A record was down or blackholed failed outright even though the remaining
 * records had passed the same validation and were sitting right there. Every
 * candidate here is already classifyIp()-approved, so failover widens
 * availability without widening the SSRF surface.
 */
export async function tryAddresses<T>(
  addresses: readonly LookupAddress[],
  signal: AbortSignal,
  attempt: (address: LookupAddress) => Promise<T>,
  label = 'host',
): Promise<T> {
  const candidates = addresses.slice(0, MAX_ADDRESS_ATTEMPTS)
  let lastError: unknown
  for (const address of candidates) {
    try {
      return await attempt(address)
    } catch (err) {
      // A caller-side abort (or the overall deadline) is final — retrying the
      // next address would ignore the cancellation and burn the budget twice.
      if (signal.aborted) throw err
      lastError = err
    }
  }
  throw lastError ?? new Error(`no usable address for ${label}`)
}

function requestWithFailover(
  target: ValidatedTarget,
  signal: AbortSignal,
): Promise<PinnedResponse> {
  return tryAddresses(
    target.addresses,
    signal,
    address => requestPinned(target, address, signal),
    target.resolvedHost,
  )
}

async function fetchWithSafeRedirects(
  startUrl: string,
  signal: AbortSignal,
): Promise<{ ok: true; res: PinnedResponse; finalUrl: string } | { ok: false; reason: string }> {
  let currentUrl = startUrl
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const check = await validateUrl(currentUrl)
    if (!check.ok) return { ok: false, reason: check.reason }
    const res = await requestWithFailover(check.value, signal)
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

/**
 * A signal that aborts when the caller aborts OR when `ms` elapses, whichever
 * comes first. `expired` distinguishes the two so the error message can say
 * which one fired.
 */
export function callDeadline(parent: AbortSignal | undefined, ms: number): {
  signal: AbortSignal
  expired: () => boolean
  dispose: () => void
} {
  const ctrl = new AbortController()
  let expired = false
  const onParentAbort = (): void => ctrl.abort(parent?.reason ?? new Error('aborted'))
  const timer = setTimeout(() => {
    expired = true
    ctrl.abort(new Error(`web_fetch timed out after ${ms}ms`))
  }, ms)
  timer.unref?.()
  if (parent?.aborted) onParentAbort()
  else parent?.addEventListener('abort', onParentAbort, { once: true })
  return {
    signal: ctrl.signal,
    expired: () => expired,
    dispose: () => {
      clearTimeout(timer)
      parent?.removeEventListener('abort', onParentAbort)
    },
  }
}

export interface WebFetchToolOptions {
  /**
   * Per-result character budget applied by the kernel (applyToolResultBudget).
   * MAIN sessions should set a tight budget (e.g. 8k) so a single fetch cannot
   * flood the long-lived context — full-text reading belongs in isolated
   * research sub-agents, which register an unbudgeted variant.
   */
  maxResultSizeChars?: number
}

export async function createWebFetchTool(options: WebFetchToolOptions = {}): Promise<MetaAgentTool> {
  const description = await loadToolPrompt(import.meta.url)
  return {
    name: 'web_fetch',
    abortSupport: 'cooperative',
    description,
    ...(options.maxResultSizeChars !== undefined
      ? { maxResultSizeChars: options.maxResultSizeChars }
      : {}),
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
      // Upgrade http → https for PUBLIC hosts only, and only on the scheme
      // prefix (the old `.replace('http://','https://')` also rewrote the first
      // occurrence anywhere in the URL, mangling `?next=http://…` query params).
      // Loopback and private targets are already refused by validateUrl, and a
      // plain-http intranet endpoint should fail with its real reason rather
      // than a confusing TLS error from a silent rewrite.
      const url = rawUrl.startsWith('http://')
        ? `https://${rawUrl.slice('http://'.length)}`
        : rawUrl

      // Evict expired entries on every read (not just on insert) so stale
      // entries don't linger when the 50-entry high-watermark is never hit.
      evictExpired()
      const cached = cache.get(url)
      if (cached && cached.expiresAt > Date.now()) {
        // L3: touch-on-read so eviction is true LRU, not FIFO. Re-inserting
        // moves this key to the most-recently-used end of the Map.
        cache.delete(url)
        cache.set(url, cached)
        // Rendered with THIS call's prompt — the cache holds the body only.
        return { content: renderPage(cached, prompt), isError: false }
      }
      if (cached) cache.delete(url)  // expired entry found on direct lookup — remove it

      const deadline = callDeadline(ctx.abortSignal, TOTAL_TIMEOUT_MS)
      try {
        const fetchOutcome = await fetchWithSafeRedirects(url, deadline.signal)
        if (!fetchOutcome.ok) {
          return { content: `Refused: ${fetchOutcome.reason}`, isError: true }
        }
        const { res, finalUrl } = fetchOutcome
        if (res.status < 200 || res.status >= 300) {
          return {
            content: `HTTP ${res.status}: ${res.statusText}.${nonOkHint(finalUrl, res.status)}`,
            isError: true,
          }
        }

        const ct = res.headers.get('content-type') ?? ''
        const body = res.bytes()
        const kind = classifyBody(ct, body)
        if (kind === 'binary') {
          // Refuse rather than hand the model 100 KB of decoded noise it will
          // try to interpret. Naming the type is what makes this recoverable.
          return {
            content:
              `Refused: ${finalUrl} returned ${mimeOf(ct) || 'binary content'} ` +
              `(${body.length} bytes). web_fetch reads text only — HTML, JSON, ` +
              `plain text, XML/CSV/YAML. Hint: look for a text or JSON ` +
              `representation of this resource (many sites expose one via an API), ` +
              `or process the file with a dedicated tool instead of fetching it here.`,
            isError: true,
          }
        }

        const raw = body.toString('utf-8')
        let text: string
        if (kind === 'json') {
          try { text = JSON.stringify(JSON.parse(raw), null, 2) } catch { text = raw }
        } else {
          text = kind === 'html' ? stripHtml(raw) : raw
        }
        // Near-empty HTML almost always means a JavaScript-rendered (SPA) page —
        // tell the model so it doesn't treat the empty shell as "no results".
        const note = looksLikeEmptySpa(text, kind)
          ? '[This page returned almost no text after HTML stripping — it is ' +
            'likely client-rendered (SPA) and cannot be read by a raw fetch. ' +
            'Try an API endpoint for this site, or a different source.]'
          : undefined
        if (text.length > MAX_CONTENT) {
          text = text.slice(0, MAX_CONTENT) + `\n[Truncated — ${text.length} chars total]`
        }

        const page: CachedPage = {
          finalUrl,
          text,
          ...(note ? { note } : {}),
          expiresAt: Date.now() + 15 * 60 * 1000,
        }
        cache.set(url, page)
        // Hard cap: if still over limit after TTL eviction, drop oldest entries.
        if (cache.size > CACHE_MAX) {
          evictExpired()
          // If still over cap (all entries fresh), drop the insertion-oldest ones.
          for (const k of cache.keys()) {
            if (cache.size <= CACHE_MAX) break
            cache.delete(k)
          }
        }
        return { content: renderPage(page, prompt), isError: false }
      } catch (err) {
        if (deadline.expired()) {
          return {
            content:
              `Fetch error: no response within ${TOTAL_TIMEOUT_MS}ms. ` +
              'Hint: the host is slow or unreachable — try a different source.',
            isError: true,
          }
        }
        return { content: `Fetch error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      } finally {
        deadline.dispose()
      }
    },
  }
}
