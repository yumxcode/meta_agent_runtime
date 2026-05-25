/**
 * Campaign Plugin Framework — Core Types
 *
 * Defines the CampaignPlugin<TPhase, TState, TParams> interface that every
 * campaign type must implement.  The framework is intentionally agnostic about
 * the specific phases and state shape — those are owned by each plugin.
 *
 * Design goals:
 *  - Registration Pattern now (zero dynamic loading overhead)
 *  - Interface-stable for future true plugin loading (loadExternalPlugin)
 *  - Minimal disruption to existing DOE code (CampaignStateStore stays as-is)
 *  - First-class state migration from day one
 *
 * Directory layout:
 *   src/campaign/         ← framework (this file, registry, generic store)
 *   src/campaigns/doe/    ← DOE plugin (wraps existing CampaignStateStore)
 *   src/campaigns/paper-repro/  ← PaperRepro plugin
 *   src/campaigns/index.ts      ← registration entrypoint (import at startup)
 */
export const GENERIC_SCHEMA_VERSION = '1.0';
//# sourceMappingURL=types.js.map