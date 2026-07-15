import { createHash } from 'node:crypto'
import type {
  ActivationRecord,
  ContextSectionSpec,
  ContextTrust,
  FrozenLoopGraphSpec,
  GraphArtifactRecord,
  GraphInstanceRecord,
  GraphStateSnapshot,
  JsonValue,
  LoopGraphSpec,
  SequencedGraphJournalEvent,
} from '../spec/GraphTypes.js'
import type { CapabilityManifest } from './CapabilityRegistry.js'
import { CapabilityRegistry } from './CapabilityRegistry.js'
import { readWorkspaceBindingFile } from '../runtime/WorkspaceFile.js'

export interface ContextArtifactReader {
  evidenceView(name: string): Promise<GraphArtifactRecord[]>
  artifactView(name: string): Promise<GraphArtifactRecord[]>
}

export interface ContextJournalReader {
  events(options?: { eventTypes?: string[]; maxItems?: number }): Promise<SequencedGraphJournalEvent[]>
}

export interface ContextProviderResolveContext {
  graph: FrozenLoopGraphSpec
  instance: GraphInstanceRecord
  activation: ActivationRecord
  state: GraphStateSnapshot
  artifacts: ContextArtifactReader
  journal: ContextJournalReader
  workspace: { projectRoot: string; laneRoot?: string }
  now: number
}

export interface ContextProviderResult {
  source: string
  content: JsonValue
}

export interface ContextProvider {
  manifest: CapabilityManifest & { trust: ContextTrust }
  validate?(section: ContextSectionSpec, graph: LoopGraphSpec): string[]
  resolve(context: ContextProviderResolveContext, section: ContextSectionSpec): Promise<ContextProviderResult>
}

export function createBuiltinContextProviderRegistry(): CapabilityRegistry<ContextProvider> {
  const registry = new CapabilityRegistry<ContextProvider>('context_provider')
  registry.register(provider('builtin/activation', 'Kernel-owned graph and Activation identity.', 'trusted_runtime', async ctx => ({
    source: `activation:${ctx.activation.id}`,
    content: {
      graph: { id: ctx.graph.id, version: ctx.graph.version, goal: ctx.graph.goal, hash: ctx.graph.graphHash },
      activation: {
        id: ctx.activation.id,
        nodeId: ctx.activation.nodeId,
        attempt: ctx.activation.attempt,
        segmentCount: ctx.activation.segmentCount ?? 0,
        continuationVersion: ctx.activation.continuationVersion,
      },
      node: {
        id: ctx.activation.nodeId,
        type: ctx.graph.nodes[ctx.activation.nodeId]?.type ?? 'unknown',
        description: ctx.graph.nodes[ctx.activation.nodeId]?.description ?? null,
      },
      laneId: ctx.activation.laneId ?? null,
      inputStateVersion: ctx.activation.inputStateVersion,
    },
  })))
  registry.register(provider('builtin/input', 'Materialized Activation input.', 'untrusted_data', async (ctx, section) => ({
    source: `activation-input:${ctx.activation.id}`,
    content: selectKeys(ctx.activation.input, configKeys(section)),
  }), validateKeysConfig))
  registry.register(provider('builtin/state', 'Current authoritative Graph State snapshot.', 'trusted_runtime', async (ctx, section) => ({
    source: `graph-state:v${ctx.state.version}`,
    content: { version: ctx.state.version, values: selectKeys(ctx.state.values, configKeys(section)) },
  }), validateStateKeysConfig))
  registry.register(provider('builtin/evidence-view', 'A named Evidence Plane view.', 'untrusted_data', async (ctx, section) => {
    const view = requiredConfigString(section, 'view')
    return { source: `evidence-view:${view}`, content: await ctx.artifacts.evidenceView(view) as unknown as JsonValue }
  }, validateNamedView('evidenceViews')))
  registry.register(provider('builtin/artifact-view', 'A named Artifact Plane view.', 'untrusted_data', async (ctx, section) => {
    const view = requiredConfigString(section, 'view')
    return { source: `artifact-view:${view}`, content: await ctx.artifacts.artifactView(view) as unknown as JsonValue }
  }, validateNamedView('artifactViews')))
  registry.register(provider('builtin/clock', 'Kernel wall-clock snapshot for this segment.', 'trusted_runtime', async ctx => ({
    source: 'kernel-clock', content: { now: ctx.now },
  })))
  registry.register(provider('builtin/continuation', 'Timer continuation checkpoint and reason.', 'untrusted_data', async ctx => ({
    source: `continuation:${ctx.activation.continuationVersion}`,
    content: {
      continuationVersion: ctx.activation.continuationVersion,
      reason: ctx.activation.input['__agentTimerReason'] ?? null,
      checkpoint: ctx.activation.input['__continuationCheckpoint'] ?? null,
    },
  })))
  registry.register(provider('builtin/workspace-binding', 'A declared workspace-backed Input/State/Evidence/Artifact/Audit/Observability binding.', 'untrusted_data', async (ctx, section) => {
    const name = requiredConfigString(section, 'binding')
    const binding = ctx.graph.workspaceBindings?.[name]
    if (!binding) throw new Error(`unknown Workspace Binding '${name}'`)
    if (binding.lane && binding.lane !== ctx.activation.laneId) {
      throw new Error(`Workspace Binding '${name}' belongs to Lane '${binding.lane}', not '${ctx.activation.laneId ?? 'none'}'`)
    }
    const root = binding.lane ? ctx.workspace.laneRoot : ctx.workspace.projectRoot
    if (!root) throw new Error(`Workspace Binding '${name}' requires a Lane workspace`)
    const snapshot = await readWorkspaceBindingFile(root, binding)
    if (!snapshot) {
      if (binding.required) throw new Error(`required Workspace Binding '${name}' is missing at '${binding.path}'`)
      return {
        source: `workspace-binding:${name}:${binding.path}`,
        content: { available: false, binding: name, plane: binding.plane, path: binding.path } as JsonValue,
      }
    }
    return {
      source: `workspace-binding:${name}:${binding.path}:sha256:${snapshot.sha256}`,
      content: {
        available: true,
        binding: name,
        plane: binding.plane,
        path: binding.path,
        format: binding.format,
        bytes: snapshot.bytes,
        sha256: snapshot.sha256,
        data: snapshot.content,
      } as JsonValue,
    }
  }, validateWorkspaceBinding))
  registry.register(provider('builtin/journal-view', 'A bounded view over the Kernel journal; envelopes are trusted but may contain untrusted Agent data.', 'untrusted_data', async (ctx, section) => {
    const config = objectConfig(section)
    const eventTypes = Array.isArray(config?.['eventTypes'])
      ? config!['eventTypes'].filter((item): item is string => typeof item === 'string')
      : undefined
    const maxItems = typeof config?.['maxItems'] === 'number' ? config['maxItems'] : undefined
    return {
      source: `graph-journal:${eventTypes?.join(',') || 'all'}`,
      content: await ctx.journal.events({ eventTypes, maxItems }) as unknown as JsonValue,
    }
  }, validateJournalView))
  registry.register(provider('builtin/data-plane-view', 'Distill-level logical Data View marker compiled to a physical Context Provider by Freeze.', 'untrusted_data', async () => {
    throw new Error('builtin/data-plane-view@1 must be compiled by Freeze before execution')
  }, validateDataPlaneView))
  return registry
}

function provider(
  id: string,
  description: string,
  trust: ContextTrust,
  resolve: ContextProvider['resolve'],
  validate?: ContextProvider['validate'],
): ContextProvider {
  return {
    manifest: {
      id,
      version: '1',
      description,
      trust,
      pure: false,
      integrity: `sha256:${createHash('sha256').update(`meta-agent:context:${id}@1:1`).digest('hex')}`,
    },
    resolve,
    ...(validate ? { validate } : {}),
  }
}

function validateKeysConfig(section: ContextSectionSpec): string[] {
  const config = objectConfig(section)
  if (!config || config['keys'] === undefined) return []
  if (!Array.isArray(config['keys']) || config['keys'].some(value => typeof value !== 'string' || !value)) {
    return ['config.keys must be an array of non-empty strings']
  }
  return []
}

function validateStateKeysConfig(section: ContextSectionSpec, graph: LoopGraphSpec): string[] {
  const errors = validateKeysConfig(section)
  if (errors.length) return errors
  for (const key of configKeys(section) ?? []) if (!(key in graph.state)) errors.push(`config.keys references unknown State '${key}'`)
  return errors
}

function validateNamedView(kind: 'evidenceViews' | 'artifactViews'): NonNullable<ContextProvider['validate']> {
  return (section, graph) => {
    const config = objectConfig(section)
    const view = config?.['view']
    if (typeof view !== 'string' || !view) return ['config.view must be a non-empty string']
    if (!(view in (graph[kind] ?? {}))) return [`config.view references unknown ${kind === 'evidenceViews' ? 'Evidence' : 'Artifact'} View '${view}'`]
    return []
  }
}

function validateWorkspaceBinding(section: ContextSectionSpec, graph: LoopGraphSpec): string[] {
  const config = objectConfig(section)
  const binding = config?.['binding']
  if (typeof binding !== 'string' || !binding) return ['config.binding must be a non-empty string']
  if (!(binding in (graph.workspaceBindings ?? {}))) return [`config.binding references unknown Workspace Binding '${binding}'`]
  return []
}

function validateDataPlaneView(section: ContextSectionSpec, graph: LoopGraphSpec): string[] {
  const config = objectConfig(section)
  const view = config?.['view']
  if (typeof view !== 'string' || !view) return ['config.view must be a non-empty string']
  if (!(view in (graph.dataViews ?? {}))) return [`config.view references unknown Data View '${view}'`]
  return []
}

function validateJournalView(section: ContextSectionSpec): string[] {
  const config = objectConfig(section)
  const errors: string[] = []
  if (config?.['eventTypes'] !== undefined && (!Array.isArray(config['eventTypes']) || config['eventTypes'].some(item => typeof item !== 'string'))) {
    errors.push('config.eventTypes must be an array of strings')
  }
  if (config?.['maxItems'] !== undefined && (typeof config['maxItems'] !== 'number' || !Number.isInteger(config['maxItems']) || config['maxItems'] < 1 || config['maxItems'] > 10_000)) {
    errors.push('config.maxItems must be an integer in 1..10000')
  }
  return errors
}

function configKeys(section: ContextSectionSpec): string[] | undefined {
  const value = objectConfig(section)?.['keys']
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined
}

function requiredConfigString(section: ContextSectionSpec, key: string): string {
  const value = objectConfig(section)?.[key]
  if (typeof value !== 'string' || !value) throw new Error(`context section '${section.name}' requires config.${key}`)
  return value
}

function objectConfig(section: ContextSectionSpec): Record<string, JsonValue> | undefined {
  const config = section.config
  return config && typeof config === 'object' && !Array.isArray(config) ? config : undefined
}

function selectKeys(values: Record<string, JsonValue>, keys: string[] | undefined): Record<string, JsonValue> {
  if (!keys) return { ...values }
  return Object.fromEntries(keys.filter(key => key in values).map(key => [key, values[key]!]))
}
