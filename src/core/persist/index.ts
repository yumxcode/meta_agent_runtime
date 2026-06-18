// Re-export shim — implementation moved to infra/persist (mode-agnostic
// low-level persistence util) so infra modules can use it without reaching up
// into core. See architecture-review-2026-06-18.md §5.1 (#2b).
export * from '../../infra/persist/index.js'
