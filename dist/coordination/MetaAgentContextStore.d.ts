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
import type { CampaignSummary, MetaAgentSessionContext } from './types.js';
export declare const SESSION_DIR: string;
export declare const ACTIVE_CONTEXT_FILE: string;
export declare class MetaAgentContextStore {
    private static _cache;
    private static readonly CACHE_TTL_MS;
    /**
     * Read timeout in ms — prevents infinite stall on NFS hang or frozen disk.
     * A 2 s timeout is conservative for local disk; NFS deployments may need higher.
     */
    private static readonly READ_TIMEOUT_MS;
    /**
     * Read the current session context.
     * Returns null if no active campaigns exist (file not present).
     * Results are cached for CACHE_TTL_MS to avoid per-submit() disk I/O.
     *
     * A 2 s timeout guards against infinite stalls on NFS/frozen mounts (P1-5).
     */
    static read(): Promise<MetaAgentSessionContext | null>;
    /**
     * Write (overwrite) the full session context.
     * Called by CampaignMonitor after every phase transition.
     *
     * Cache is invalidated AFTER the atomic rename completes (P1-2).
     * Invalidating before the write would cause concurrent read() calls to
     * hit disk and read the stale file while the new file is being written.
     */
    static write(ctx: MetaAgentSessionContext): Promise<void>;
    /**
     * Remove the active-context file.
     * Called when all campaigns reach DONE or FAILED.
     * Invalidates the read cache after unlink completes.
     */
    static clear(): Promise<void>;
    /**
     * Convenience: build a MetaAgentSessionContext from a list of CampaignSummary
     * objects and persist it.
     */
    static refresh(summaries: CampaignSummary[]): Promise<void>;
    /**
     * Reset all in-process state for test isolation.
     *
     * Clears the TTL cache without touching the filesystem.  Call this in
     * `beforeEach` / `afterEach` so tests never share cached context state.
     *
     * @testonly — not intended for production use.
     */
    static resetForTest(): void;
    /**
     * Build the Markdown block to inject into the conversation system prompt.
     * Returns empty string if no active campaigns.
     *
     * Format injected per campaign:
     *   ## Campaign: <projectName> [<phase label>]
     *   <contextBlock>
     */
    static buildInjectionBlock(): Promise<string>;
}
//# sourceMappingURL=MetaAgentContextStore.d.ts.map