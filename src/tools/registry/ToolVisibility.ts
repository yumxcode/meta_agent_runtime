/**
 * Tool-layer re-export of the kernel's visibility registry.
 *
 * The implementation lives in `kernel/tools/ToolVisibility.ts` because the
 * kernel is what decides which schemas go on the wire, and the kernel must not
 * import upward from `tools/`. This module exists so tool-layer code (and
 * embedders) can reach the same process-global registry without reaching into
 * kernel internals by path.
 */
export {
  ToolVisibilityRegistry,
  toolVisibility,
  resetToolVisibility,
  visibleToolsForApi,
  searchTools,
  namespaceOf,
  isDeferred,
  eagerToolsForced,
  DEFAULT_NAMESPACE,
} from '../../kernel/tools/ToolVisibility.js'
export type {
  VisibilityTool,
  NamespaceSummary,
  ToolSearchHit,
} from '../../kernel/tools/ToolVisibility.js'
