/**
 * Re-export shim. The implementation moved to infra/metaAgentHome.ts (a
 * mode-agnostic low-level util) so infra-layer modules like the experience
 * store can depend on it WITHOUT reaching up into core — see
 * architecture-review-2026-06-18.md §1.2 / §5.1 (#2b). Existing
 * `core/metaAgentHome` importers keep working unchanged.
 */
export * from '../infra/metaAgentHome.js'
