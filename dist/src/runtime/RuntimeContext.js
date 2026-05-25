/**
 * RuntimeContext — the three shared singletons that power Phase 1 integration.
 *
 * A RuntimeContext bundles:
 *   • JobManager       — async job submission, polling, cancellation
 *   • VVHookChain      — pre/post-call validation & verification
 *   • ProvenanceTracker — full audit trail for every tool call
 *
 * A single RuntimeContext is typically created per agent process and shared
 * across multiple sessions.  Pass it to MetaAgentConfig.runtimeContext to
 * enable automatic tool instrumentation, session preamble injection, and
 * provenance-to-context routing.
 *
 * Usage:
 *   const rtx = createRuntimeContext({ sessionId: 'agent-1' })
 *   const session = new MetaAgentSession({ runtimeContext: rtx, ... })
 */
import { JobManager } from '../jobs/JobManager.js';
import { LocalExecutor } from '../jobs/JobExecutor.js';
import { createDefaultVVChain } from '../validation/index.js';
import { ProvenanceTracker } from '../provenance/ProvenanceTracker.js';
// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Create a RuntimeContext with sensible defaults.
 *
 * Example (minimal):
 *   const rtx = createRuntimeContext({ sessionId: 'sess-abc' })
 *
 * Example (custom V&V chain):
 *   const chain = new VVHookChain([new OOMChecker(), myCustomHook])
 *   const rtx = createRuntimeContext({ sessionId: 'sess-abc', vvChain: chain })
 */
export function createRuntimeContext(opts) {
    const sessionId = opts.sessionId;
    const agentId = opts.agentId ?? sessionId;
    const executor = new LocalExecutor(opts.maxConcurrentJobs ?? 4);
    const jobManager = new JobManager(sessionId, executor);
    const vvChain = opts.vvChain ?? createDefaultVVChain();
    const provenanceTracker = opts.provenanceTracker ?? new ProvenanceTracker(sessionId);
    return { jobManager, vvChain, provenanceTracker, sessionId, agentId };
}
//# sourceMappingURL=RuntimeContext.js.map