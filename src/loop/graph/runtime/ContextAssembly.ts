import type { CapabilityRegistry } from '../registry/CapabilityRegistry.js'
import type { ContextProvider } from '../registry/ContextProvider.js'
import type {
  ActivationRecord,
  ContextSectionSnapshot,
  ContextSectionSpec,
  FrozenCapabilityRef,
  FrozenLoopGraphSpec,
  GraphInstanceRecord,
  GraphStateSnapshot,
  JsonValue,
  NodeSpec,
} from '../spec/GraphTypes.js'
import { ArtifactPlane } from './ArtifactPlane.js'
import type { GraphStore } from './GraphStore.js'
import { isJsonValue } from './GraphJson.js'

const DEFAULT_MAX_BYTES = 32_768
const MANDATORY_ACTIVATION: ContextSectionSpec = {
  name: 'kernel_activation',
  provider: 'builtin/activation@1',
  refresh: 'every_segment',
  required: true,
  maxBytes: DEFAULT_MAX_BYTES,
}

export interface AssembledContext {
  sections: ContextSectionSnapshot[]
  rendered: string[]
}

/** Resolves a node's declarative context plan and durably caches activation_start sections. */
export class ContextAssembler {
  private readonly artifacts: ArtifactPlane

  constructor(private readonly input: {
    store: GraphStore
    graph: FrozenLoopGraphSpec
    instance: GraphInstanceRecord
    providers: CapabilityRegistry<ContextProvider>
    now?: () => number
  }) {
    this.artifacts = new ArtifactPlane(input.store)
  }

  async assemble(
    node: Extract<NodeSpec, { type: 'agent' }>,
    activation: ActivationRecord,
    state: GraphStateSnapshot,
    workspace?: { laneRoot?: string },
  ): Promise<AssembledContext> {
    const declarations = [
      MANDATORY_ACTIVATION,
      ...(node.context?.sections ?? []),
    ]
    const sections: ContextSectionSnapshot[] = []
    const cache = { ...(activation.contextCache ?? {}) }
    for (const declaration of declarations) {
      if (declaration.refresh === 'continuation_only' && activation.continuationVersion === 0) continue
      let section = declaration.refresh === 'activation_start' ? cache[declaration.name] : undefined
      if (!section) {
        section = await this.resolve(declaration, activation, state, workspace)
        if (declaration.refresh === 'activation_start') {
          if (!activation.lease?.token) throw new Error(`Activation '${activation.id}' has no live lease for context caching`)
          section = await this.input.store.cacheActivationContext({
            activationId: activation.id,
            leaseToken: activation.lease.token,
            section,
            now: this.now(),
          })
          cache[declaration.name] = section
        }
      }
      sections.push(section)
    }
    return { sections, rendered: sections.map(renderContextSection) }
  }

  private async resolve(
    declaration: ContextSectionSpec,
    activation: ActivationRecord,
    state: GraphStateSnapshot,
    workspace?: { laneRoot?: string },
  ): Promise<ContextSectionSnapshot> {
    const provider = this.input.providers.get(declaration.provider)
    const now = this.now()
    let source: string
    let content: JsonValue
    try {
      const result = await provider.resolve({
        graph: this.input.graph,
        instance: this.input.instance,
        activation,
        state,
        artifacts: {
          evidenceView: name => this.artifacts.namedEvidenceView(name),
          artifactView: name => this.artifacts.namedArtifactView(name),
        },
        journal: {
          events: async options => {
            const eventTypes = options?.eventTypes ? new Set(options.eventTypes) : undefined
            return (await this.input.store.readJournal())
              .filter(item => !eventTypes || eventTypes.has(item.event.type))
              .slice(-(options?.maxItems ?? 200))
          },
        },
        workspace: {
          projectRoot: this.input.store.projectDir,
          ...(workspace?.laneRoot ? { laneRoot: workspace.laneRoot } : {}),
        },
        now,
      }, declaration)
      if (typeof result.source !== 'string' || !result.source.trim()) throw new Error(`Context Provider '${declaration.provider}' returned an empty source`)
      if (!isJsonValue(result.content)) throw new Error(`Context Provider '${declaration.provider}' returned non-JSON content`)
      source = result.source
      content = result.content
    } catch (error) {
      if (declaration.required !== false) throw error
      source = `provider-error:${declaration.provider}`
      content = { available: false, error: message(error) }
    }
    const bounded = boundContent(content, declaration.maxBytes ?? DEFAULT_MAX_BYTES)
    return {
      schemaVersion: 'graph-context-section-1.0',
      name: declaration.name,
      provider: manifestRef(provider.manifest),
      source,
      trust: providerTrust(provider.manifest.trust, declaration.provider),
      role: 'context_data',
      refresh: declaration.refresh,
      resolvedAt: now,
      stateVersion: state.version,
      truncated: bounded.truncated,
      originalBytes: bounded.originalBytes,
      renderedBytes: bounded.renderedBytes,
      content: bounded.content,
    }
  }

  private now(): number { return this.input.now?.() ?? Date.now() }
}

export function renderContextSection(section: ContextSectionSnapshot): string {
  return `<prompt_section>\n${safeJson(section)}\n</prompt_section>`
}

function boundContent(content: JsonValue, maxBytes: number): {
  content: JsonValue
  truncated: boolean
  originalBytes: number
  renderedBytes: number
} {
  const original = JSON.stringify(content)
  const originalBytes = Buffer.byteLength(original, 'utf8')
  if (originalBytes <= maxBytes) return { content, truncated: false, originalBytes, renderedBytes: originalBytes }
  let bounded: JsonValue
  if (Array.isArray(content)) {
    const kept: JsonValue[] = []
    for (const item of content) {
      const candidate = [...kept, item]
      if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > maxBytes) break
      kept.push(item)
    }
    bounded = kept
  } else if (typeof content === 'string') {
    bounded = truncateUtf8(content, Math.max(0, maxBytes - 2))
  } else {
    bounded = {
      __truncated: true,
      preview: truncateUtf8(original, Math.max(0, maxBytes - 128)),
    }
  }
  const renderedBytes = Buffer.byteLength(JSON.stringify(bounded), 'utf8')
  return { content: bounded, truncated: true, originalBytes, renderedBytes }
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
  let low = 0
  let high = value.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(value.slice(0, middle), 'utf8') <= maxBytes) low = middle
    else high = middle - 1
  }
  return value.slice(0, low)
}

function safeJson(value: unknown): string {
  return JSON.stringify(value, null, 2)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
}

function manifestRef(manifest: { id: string; version: string; integrity: string }): FrozenCapabilityRef {
  return { id: manifest.id, version: manifest.version, integrity: manifest.integrity }
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }

function providerTrust(value: string, reference: string): ContextSectionSnapshot['trust'] {
  if (!['trusted_runtime', 'trusted_graph', 'untrusted_data'].includes(value)) {
    throw new Error(`Context Provider '${reference}' has invalid trust '${value}'`)
  }
  return value as ContextSectionSnapshot['trust']
}
