import type {
  FrozenLoopGraphSpec,
  JsonValue,
  SequencedGraphJournalEvent,
  WorkspaceBindingSpec,
  WorkspaceProjectionSpec,
} from '../spec/GraphTypes.js'
import { ArtifactPlane } from './ArtifactPlane.js'
import type { GraphStore, GraphSnapshot } from './GraphStore.js'
import type { LaneManager } from './LaneManager.js'
import { materializeWorkspaceBindingFile } from './WorkspaceFile.js'

/**
 * Rebuildable workspace projection of Kernel-owned planes. It is intentionally
 * optional and contains no domain filenames or schemas. A failed process can
 * replay it from State/Artifact/Journal without re-running an Agent.
 */
export class WorkspacePlaneMaterializer {
  private readonly artifacts: ArtifactPlane

  constructor(private readonly input: {
    store: GraphStore
    graph: FrozenLoopGraphSpec
    lanes: LaneManager
  }) {
    this.artifacts = new ArtifactPlane(input.store)
  }

  async reconcile(): Promise<void> {
    const bindings = Object.entries(this.input.graph.workspaceBindings ?? {})
      .filter(([, binding]) => binding.direction !== 'ingest')
    if (!bindings.length) return
    const snapshot = await this.input.store.snapshot()
    let journal: SequencedGraphJournalEvent[] | undefined
    for (const [name, binding] of bindings) {
      try {
        const root = binding.lane
          ? await this.input.lanes.workspaceRoot(binding.lane)
          : this.input.store.projectDir
        if (binding.projection?.kind === 'journal') journal ??= await this.input.store.readJournal()
        const projected = await this.project(binding, snapshot, journal)
        await materializeWorkspaceBindingFile(root, binding, projected)
      } catch (error) {
        if (binding.required !== false) throw new Error(`Workspace Binding '${name}' materialization failed: ${message(error)}`)
      }
    }
  }

  private async project(
    binding: WorkspaceBindingSpec,
    snapshot: GraphSnapshot,
    journal?: SequencedGraphJournalEvent[],
  ): Promise<JsonValue> {
    const projection = binding.projection
    if (!projection) throw new Error('materializing binding has no projection')
    switch (projection.kind) {
      case 'state': return projectState(snapshot, projection)
      case 'evidence_view': return projectRecords(
        await this.artifacts.namedEvidenceView(projection.view),
        projection.record ?? 'envelope',
        projection.flattenArrays ?? false,
      )
      case 'artifact_view': return projectRecords(
        await this.artifacts.namedArtifactView(projection.view),
        projection.record ?? 'envelope',
        projection.flattenArrays ?? false,
      )
      case 'journal': {
        const eventTypes = projection.eventTypes ? new Set(projection.eventTypes) : undefined
        const records = (journal ?? []).filter(item => !eventTypes || eventTypes.has(item.event.type))
        return records.map(item => projection.record === 'event' ? item.event : item) as unknown as JsonValue
      }
      case 'data_view': throw new Error('logical data_view projection reached Kernel without Freeze compilation')
    }
  }
}

function projectState(snapshot: GraphSnapshot, projection: Extract<WorkspaceProjectionSpec, { kind: 'state' }>): JsonValue {
  const keys = projection.keys ?? Object.keys(snapshot.state.values)
  return Object.fromEntries(keys.filter(key => key in snapshot.state.values).map(key => [key, snapshot.state.values[key]!]))
}

function projectRecords(
  records: Awaited<ReturnType<ArtifactPlane['list']>>,
  record: 'content' | 'envelope',
  flattenArrays: boolean,
): JsonValue {
  const chronological = [...records].sort((a, b) =>
    a.provenance.createdAt - b.provenance.createdAt || a.id.localeCompare(b.id))
  const projected = chronological.map(item => record === 'content' ? item.content : item) as JsonValue[]
  return (flattenArrays ? projected.flatMap(item => Array.isArray(item) ? item : [item]) : projected) as JsonValue
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }
