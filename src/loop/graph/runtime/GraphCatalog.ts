import {
  CapabilityRegistry,
  createBuiltinFunctionRegistry,
  createBuiltinReducerRegistry,
  type EffectProvider,
  type FunctionProvider,
  type ReducerProvider,
} from '../registry/CapabilityRegistry.js'
import { CapabilityPackRegistry } from '../registry/CapabilityPack.js'

/**
 * The SINGLE canonical graph_agent tool catalog. Distill, Create, Tick, the
 * Scheduler, tests, and every embedder validate frozen graphs against this
 * set (optionally narrowed to what the runtime actually provides — never
 * widened ad hoc), so a graph that freezes once validates identically from
 * every entrypoint. Session-only conveniences (sleep, todo_write, ask_user…)
 * are deliberately excluded: durable waiting belongs to wait nodes and agent
 * timer hard-park, not to in-segment sleeping. Extend via Capability Packs,
 * not by editing call sites. Parity with the unattended runtime toolset is
 * locked by the parity test in GraphV2Cli.test.ts.
 */
export const DEFAULT_GRAPH_AGENT_TOOLS = new Set([
  'read_file', 'write_file', 'append_file', 'edit_file', 'glob', 'grep', 'bash',
  'web_fetch', 'web_search', 'skill',
])

export interface GraphRuntimeCatalog {
  functions: CapabilityRegistry<FunctionProvider>
  reducers: CapabilityRegistry<ReducerProvider>
  effects: CapabilityRegistry<EffectProvider>
  agentTools: Set<string>
  packs: CapabilityPackRegistry
}

export function createDefaultGraphRuntimeCatalog(): GraphRuntimeCatalog {
  const catalog: GraphRuntimeCatalog = {
    functions: createBuiltinFunctionRegistry(),
    reducers: createBuiltinReducerRegistry(),
    effects: new CapabilityRegistry<EffectProvider>('effect'),
    agentTools: new Set(DEFAULT_GRAPH_AGENT_TOOLS),
    packs: new CapabilityPackRegistry(),
  }
  catalog.packs.registerManifest({ id: 'builtin/core', version: '1', integrity: 'builtin:meta-agent-graph-core-v1' })
  return catalog
}
