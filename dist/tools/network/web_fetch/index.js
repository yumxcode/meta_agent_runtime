import { lookup } from 'node:dns/promises';
import { loadToolPrompt } from '../../util.js';
const MAX_CONTENT = 100 * 1024;
/** Max entries — eviction runs on both insert and read paths. */
const CACHE_MAX = 50;
/** Max redirects we follow manually. */
const MAX_REDIRECTS = 5;
const cache = new Map();
/** Evict all expired entries.  O(n) but cache is bounded at CACHE_MAX. */
function evictExpired() {
    const now = Date.now();
    for (const [k, v] of cache)
        if (v.expiresAt < now)
            cache.delete(k);
}
/**
 * M4: Allow tests / callers to clear the module-level cache.
 *
 * Exposed so vitest can reset state between cases and so application code
 * can drop cached pages on demand (e.g. when network conditions change or
 * the user explicitly asks for a fresh fetch).
 */
export function clearWebFetchCache() {
    cache.clear();
}
function stripHtml(html) {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"')
        .replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}
// ── H1: SSRF defence ──────────────────────────────────────────────────────────
//
// Reject URLs that resolve to private / loopback / link-local IP space, the
// metadata services used by AWS/GCP/Azure, or non-http(s) schemes. Redirects
// are followed manually so every hop gets the same treatment — a 302 from a
// public host to 169.254.169.254 cannot bypass the check.
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);
/** Returns null if the IP is allowed, otherwise a human-readable rejection. */
function classifyIp(ip) {
    // IPv4 private ranges (RFC 1918) + loopback + link-local + CG-NAT + IMDS
    // + this-network + benchmark + documentation + multicast + broadcast.
    const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (v4) {
        const a = Number(v4[1]);
        const b = Number(v4[2]);
        if (a === 10)
            return 'private 10/8';
        if (a === 127)
            return 'loopback 127/8';
        if (a === 0)
            return 'this-network 0/8';
        if (a === 169 && b === 254)
            return 'link-local / metadata 169.254/16';
        if (a === 172 && b >= 16 && b <= 31)
            return 'private 172.16/12';
        if (a === 192 && b === 168)
            return 'private 192.168/16';
        if (a === 192 && b === 0)
            return 'IETF / IANA reserved 192.0/16';
        if (a === 198 && (b === 18 || b === 19))
            return 'benchmark 198.18/15';
        if (a === 100 && b >= 64 && b <= 127)
            return 'CG-NAT 100.64/10';
        if (a >= 224 && a <= 239)
            return 'multicast 224/4';
        if (a >= 240)
            return 'reserved 240/4';
        return null;
    }
    // IPv6 — best-effort.  Treat anything that isn't clearly global as private.
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::')
        return 'loopback ::1';
    if (lower.startsWith('fe80:') || lower.startsWith('fe80::'))
        return 'IPv6 link-local fe80::/10';
    if (/^f[cd][0-9a-f]{2}:/.test(lower))
        return 'IPv6 ULA fc00::/7';
    if (lower.startsWith('::ffff:')) {
        // IPv4-mapped IPv6 — re-check the embedded IPv4 portion.
        const mapped = lower.slice(7);
        return classifyIp(mapped);
    }
    if (lower.startsWith('ff'))
        return 'IPv6 multicast ff00::/8';
    return null;
}
async function validateUrl(rawUrl) {
    let parsed;
    try {
        parsed = new URL(rawUrl);
    }
    catch {
        return { ok: false, reason: 'invalid URL' };
    }
    if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
        return { ok: false, reason: `scheme ${parsed.protocol} is not allowed` };
    }
    const host = parsed.hostname;
    if (!host)
        return { ok: false, reason: 'URL has no hostname' };
    // Reject explicit literal "localhost" before DNS so a tampered resolver
    // mapping localhost → public IP can't bypass us.
    if (host.toLowerCase() === 'localhost') {
        return { ok: false, reason: 'localhost is not allowed' };
    }
    // DNS-resolve and inspect every returned address. `all: true` returns the
    // full set so we don't accidentally allow a host that round-robins between
    // a public and a private IP.
    try {
        const results = await lookup(host, { all: true });
        for (const { address } of results) {
            const reason = classifyIp(address);
            if (reason !== null) {
                return { ok: false, reason: `host ${host} resolved to ${address} (${reason})` };
            }
        }
        if (results.length === 0)
            return { ok: false, reason: `host ${host} did not resolve` };
        return { ok: true, value: { url: parsed, resolvedHost: host } };
    }
    catch (err) {
        return { ok: false, reason: `DNS lookup failed for ${host}: ${err instanceof Error ? err.message : String(err)}` };
    }
}
async function fetchWithSafeRedirects(startUrl, signal) {
    let currentUrl = startUrl;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const check = await validateUrl(currentUrl);
        if (!check.ok)
            return { ok: false, reason: check.reason };
        const res = await fetch(check.value.url, {
            signal,
            headers: { 'User-Agent': 'MetaAgentRuntime/1.0' },
            redirect: 'manual',
        });
        // Treat 3xx with Location as a redirect we control.
        if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
            const next = new URL(res.headers.get('location'), currentUrl).toString();
            currentUrl = next;
            continue;
        }
        return { ok: true, res, finalUrl: currentUrl };
    }
    return { ok: false, reason: `too many redirects (>${MAX_REDIRECTS})` };
}
export async function createWebFetchTool() {
    const description = await loadToolPrompt(import.meta.url);
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
        async call(input, ctx) {
            const rawUrl = input['url'];
            const prompt = input['prompt'];
            if (!rawUrl)
                return { content: 'Error: url is required', isError: true };
            const url = rawUrl.startsWith('http://') ? rawUrl.replace('http://', 'https://') : rawUrl;
            // Evict expired entries on every read (not just on insert) so stale
            // entries don't linger when the 50-entry high-watermark is never hit.
            evictExpired();
            const cached = cache.get(url);
            if (cached && cached.expiresAt > Date.now())
                return { content: cached.content, isError: false };
            if (cached)
                cache.delete(url); // expired entry found on direct lookup — remove it
            try {
                const fetchOutcome = await fetchWithSafeRedirects(url, ctx.abortSignal);
                if (!fetchOutcome.ok) {
                    return { content: `Refused: ${fetchOutcome.reason}`, isError: true };
                }
                const { res, finalUrl } = fetchOutcome;
                if (!res.ok)
                    return { content: `HTTP ${res.status}: ${res.statusText}`, isError: true };
                const ct = res.headers.get('content-type') ?? '';
                let text;
                if (ct.includes('application/json')) {
                    text = JSON.stringify(await res.json(), null, 2);
                }
                else {
                    const raw = await res.text();
                    text = ct.includes('html') ? stripHtml(raw) : raw;
                }
                if (text.length > MAX_CONTENT)
                    text = text.slice(0, MAX_CONTENT) + `\n[Truncated — ${text.length} chars total]`;
                const result = `URL: ${finalUrl}\nPrompt: ${prompt}\n\n---\n\n${text}`;
                cache.set(url, { content: result, expiresAt: Date.now() + 15 * 60 * 1000 });
                // Hard cap: if still over limit after TTL eviction, drop oldest entries.
                if (cache.size > CACHE_MAX) {
                    evictExpired();
                    // If still over cap (all entries fresh), drop the insertion-oldest ones.
                    for (const k of cache.keys()) {
                        if (cache.size <= CACHE_MAX)
                            break;
                        cache.delete(k);
                    }
                }
                return { content: result, isError: false };
            }
            catch (err) {
                return { content: `Fetch error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
            }
        },
    };
}
//# sourceMappingURL=index.js.map