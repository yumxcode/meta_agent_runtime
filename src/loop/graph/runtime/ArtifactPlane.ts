import type { ArtifactViewSpec, EvidenceViewSpec, GraphArtifactRecord } from '../spec/GraphTypes.js'
import type { GraphStore } from './GraphStore.js'

/** Whole-graph public, provenance-carrying Artifact/Evidence plane. */
export class ArtifactPlane {
  constructor(private readonly store: GraphStore) {}

  async list(options?: {
    channels?: readonly string[]
    kind?: 'artifact' | 'evidence'
    statuses?: readonly GraphArtifactRecord['status'][]
    maxItems?: number
  }): Promise<GraphArtifactRecord[]> {
    const snapshot = await this.store.snapshot()
    const channels = options?.channels ? new Set(options.channels) : undefined
    const statuses = options?.statuses ? new Set(options.statuses) : undefined
    return [...snapshot.artifacts.values()]
      .filter(item => !channels || channels.has(item.channel))
      .filter(item => !options?.kind || item.kind === options.kind)
      .filter(item => !statuses || statuses.has(item.status))
      .sort((a, b) => b.provenance.createdAt - a.provenance.createdAt || a.id.localeCompare(b.id))
      .slice(0, options?.maxItems ?? 200)
  }

  async evidenceView(spec: EvidenceViewSpec): Promise<GraphArtifactRecord[]> {
    return this.list({
      channels: spec.channels,
      kind: 'evidence',
      statuses: spec.statuses ?? ['admitted'],
      maxItems: spec.maxItems,
    })
  }

  async artifactView(spec: ArtifactViewSpec): Promise<GraphArtifactRecord[]> {
    return this.list({
      channels: spec.channels,
      kind: 'artifact',
      statuses: spec.statuses ?? ['admitted', 'proposed'],
      maxItems: spec.maxItems,
    })
  }

  async namedEvidenceView(name: string): Promise<GraphArtifactRecord[]> {
    const graph = await this.store.loadSpec()
    const spec = graph.evidenceViews?.[name]
    if (!spec) throw new Error(`unknown Evidence View '${name}'`)
    return this.evidenceView(spec)
  }

  async namedArtifactView(name: string): Promise<GraphArtifactRecord[]> {
    const graph = await this.store.loadSpec()
    const spec = graph.artifactViews?.[name]
    if (!spec) throw new Error(`unknown Artifact View '${name}'`)
    return this.artifactView(spec)
  }

}
