/**
 * Tool registry barrel.
 *
 * Add new tools here as they are implemented.  Each tool is a factory
 * function (async, returns MetaAgentTool) so the prompt.md is read once
 * at startup rather than on every call.
 *
 * Convention:
 *   src/tools/<name>/
 *   ├── prompt.md   ← tool description (edit this, not the code)
 *   └── index.ts    ← export async function create<Name>Tool(): Promise<MetaAgentTool>
 */

export { createEchoTool } from './echo/index.js'
export { loadToolPrompt } from './util.js'

// ── Provenance query tools (路径②) ────────────────────────────────────────────
export {
  createProvenanceTools,
  createGetProvenanceTool,
  createListRecentTool,
  createFindDuplicateTool,
  createGetLineageTool,
} from './provenance/index.js'

// ── Engineering tool registry ─────────────────────────────────────────────────
export {
  EngineeringToolRegistry,
  defaultRegistry as defaultToolRegistry,
  FIDELITY_LABELS,
} from './registry/index.js'
export type { FidelityLevel, RegistryEntry } from './registry/index.js'
