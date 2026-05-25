/**
 * MetaAgentContextStore — session-level context injection store.
 *
 * Storage: ~/.claude/meta-agent/session/active-context.metaagent
 *
 * This file is entirely separate from CLAUDE.md. It uses a dedicated
 * .metaagent extension to signal "runtime-managed state, do not edit manually".
 *
 * Lifecycle:
 *   Write: CampaignMonitor calls write() after each phase transition.
 *   Read:  MetaAgentSession._buildCampaignContext() calls read() on every submit().
 *   Clear: CampaignMonitor calls clear() when all campaigns are DONE/FAILED.
 *
 * The contextBlock strings stored here are pre-computed by CapsuleBuilder and
 * are < 500 tokens each — injecting them costs O(1) regardless of campaign size.
 */
import { mkdir, readFile, rename, unlink, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { dirname, join } from 'path';
// ── Paths ─────────────────────────────────────────────────────────────────────
export const SESSION_DIR = join(homedir(), '.claude', 'meta-agent', 'session');
export const ACTIVE_CONTEXT_FILE = join(SESSION_DIR, 'active-context.metaagent');
// ── MetaAgentContextStore ─────────────────────────────────────────────────────
export class MetaAgentContextStore {
    // ── TTL cache — avoids disk read on every submit() ──────────────────────────
    // Written only during phase transitions (infrequent), so 2 s staleness is fine.
    static _cache = null;
    static CACHE_TTL_MS = 2_000;
    /**
     * Read timeout in ms — prevents infinite stall on NFS hang or frozen disk.
     * A 2 s timeout is conservative for local disk; NFS deployments may need higher.
     */
    static READ_TIMEOUT_MS = 2_000;
    /**
     * Read the current session context.
     * Returns null if no active campaigns exist (file not present).
     * Results are cached for CACHE_TTL_MS to avoid per-submit() disk I/O.
     *
     * A 2 s timeout guards against infinite stalls on NFS/frozen mounts (P1-5).
     */
    static async read() {
        const now = Date.now();
        if (MetaAgentContextStore._cache !== null &&
            now - MetaAgentContextStore._cache.ts < MetaAgentContextStore.CACHE_TTL_MS) {
            return MetaAgentContextStore._cache.data;
        }
        try {
            // Race disk read against a timeout so a hung filesystem can't stall submit()
            const timeoutPromise = new Promise((_, reject) => {
                const t = setTimeout(() => reject(new Error(`Context store read timed out after ${MetaAgentContextStore.READ_TIMEOUT_MS} ms`)), MetaAgentContextStore.READ_TIMEOUT_MS);
                // Allow the process to exit even if this timer is pending
                t.unref?.();
            });
            const raw = await Promise.race([
                readFile(ACTIVE_CONTEXT_FILE, 'utf-8'),
                timeoutPromise,
            ]);
            const ctx = JSON.parse(raw);
            // Validate schema version
            if (ctx.schemaVersion !== '1.0') {
                MetaAgentContextStore._cache = null;
                return null;
            }
            MetaAgentContextStore._cache = { data: ctx, ts: now };
            return ctx;
        }
        catch {
            MetaAgentContextStore._cache = null;
            return null;
        }
    }
    /**
     * Write (overwrite) the full session context.
     * Called by CampaignMonitor after every phase transition.
     *
     * Cache is invalidated AFTER the atomic rename completes (P1-2).
     * Invalidating before the write would cause concurrent read() calls to
     * hit disk and read the stale file while the new file is being written.
     */
    static async write(ctx) {
        await mkdir(dirname(ACTIVE_CONTEXT_FILE), { recursive: true });
        // Atomic write via temp-file rename
        const tmp = ACTIVE_CONTEXT_FILE + '.tmp';
        await writeFile(tmp, JSON.stringify(ctx, null, 2), 'utf-8');
        // rename is atomic on POSIX — invalidate cache only AFTER the new file is live
        await rename(tmp, ACTIVE_CONTEXT_FILE);
        MetaAgentContextStore._cache = null; // invalidate after atomic write
    }
    /**
     * Remove the active-context file.
     * Called when all campaigns reach DONE or FAILED.
     * Invalidates the read cache after unlink completes.
     */
    static async clear() {
        await unlink(ACTIVE_CONTEXT_FILE).catch(() => { });
        MetaAgentContextStore._cache = null; // invalidate after file is gone
    }
    /**
     * Convenience: build a MetaAgentSessionContext from a list of CampaignSummary
     * objects and persist it.
     */
    static async refresh(summaries) {
        if (summaries.length === 0) {
            await MetaAgentContextStore.clear();
            return;
        }
        await MetaAgentContextStore.write({
            schemaVersion: '1.0',
            updatedAt: new Date().toISOString(),
            activeCampaigns: summaries,
        });
    }
    /**
     * Build the Markdown block to inject into the conversation system prompt.
     * Returns empty string if no active campaigns.
     *
     * Format injected per campaign:
     *   ## Campaign: <projectName> [<phase label>]
     *   <contextBlock>
     */
    static async buildInjectionBlock() {
        const ctx = await MetaAgentContextStore.read();
        if (!ctx || ctx.activeCampaigns.length === 0)
            return '';
        const blocks = ctx.activeCampaigns.map(c => c.contextBlock);
        return ['## Active Engineering Campaigns', ...blocks].join('\n\n');
    }
}
//# sourceMappingURL=MetaAgentContextStore.js.map