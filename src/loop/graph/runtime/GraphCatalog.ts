import {
  CapabilityRegistry,
  createBuiltinFunctionRegistry,
  createBuiltinReducerRegistry,
  type EffectProvider,
  type FunctionProvider,
  type ReducerProvider,
} from '../registry/CapabilityRegistry.js'
import { CapabilityPackRegistry } from '../registry/CapabilityPack.js'
import { createBuiltinContextProviderRegistry, type ContextProvider } from '../registry/ContextProvider.js'

export interface GraphRuntimeCatalog {
  functions: CapabilityRegistry<FunctionProvider>
  reducers: CapabilityRegistry<ReducerProvider>
  effects: CapabilityRegistry<EffectProvider>
  contextProviders: CapabilityRegistry<ContextProvider>
  packs: CapabilityPackRegistry
}

export function createDefaultGraphRuntimeCatalog(): GraphRuntimeCatalog {
  const catalog: GraphRuntimeCatalog = {
    functions: createBuiltinFunctionRegistry(),
    reducers: createBuiltinReducerRegistry(),
    effects: new CapabilityRegistry<EffectProvider>('effect'),
    contextProviders: createBuiltinContextProviderRegistry(),
    packs: new CapabilityPackRegistry(),
  }
  catalog.packs.registerManifest({ id: 'builtin/core', version: '1', integrity: 'builtin:meta-agent-graph-core-v1' })
  return catalog
}
