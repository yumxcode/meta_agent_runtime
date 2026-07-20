import { join } from 'node:path'
import { atomicWriteJson, readJsonFile } from '../../../infra/persist/index.js'
import type { SubAgentWorkspaceMode } from '../../../subagent/types.js'
import { workspaceScopedLineage } from '../../workspace/WorkspaceIdentity.js'
import type { ActivationRecord, FrozenLoopGraphSpec, GraphInstanceRecord } from '../spec/GraphTypes.js'
import type { GraphStore } from './GraphStore.js'

export interface LaneRuntimeRecord {
  schemaVersion: 'graph-lane-2.0'
  laneId: string
  lineageSessionId: string
  workspacePath: string
  workspaceMode: SubAgentWorkspaceMode
  status: 'ready'
  createdAt: number
  updatedAt: number
  lastActivationId?: string
}

export interface LaneExecutionBinding {
  lane: LaneRuntimeRecord
  lineageSessionId?: string
  projectDir: string
  workspaceMode: SubAgentWorkspaceMode
}

/** Lane = conversation continuity + single-writer ownership on the project root. */
export class LaneManager {
  constructor(
    private readonly store: GraphStore,
    private readonly graph: FrozenLoopGraphSpec,
    private readonly instance: GraphInstanceRecord,
  ) {}

  async bind(laneId: string, activation: ActivationRecord): Promise<LaneExecutionBinding> {
    const spec = this.graph.lanes[laneId]
    if (!spec) throw new Error(`unknown Lane '${laneId}'`)
    const record = await this.loadOrCreate(laneId)
    const next = { ...record, lastActivationId: activation.id, updatedAt: Date.now() }
    await atomicWriteJson(this.lanePath(laneId), next)
    return {
      lane: next,
      ...(spec.context === 'persistent' ? { lineageSessionId: next.lineageSessionId } : {}),
      projectDir: this.store.projectDir,
      workspaceMode: next.workspaceMode,
    }
  }

  async reconcile(): Promise<void> {}

  private async loadOrCreate(laneId: string): Promise<LaneRuntimeRecord> {
    const existing = await readJsonFile<LaneRuntimeRecord>(this.lanePath(laneId))
    if (existing) return existing
    const now = Date.now()
    const record: LaneRuntimeRecord = {
      schemaVersion: 'graph-lane-2.0',
      laneId,
      lineageSessionId: workspaceScopedLineage({ workspaceId: this.instance.workspaceId }, this.instance.instanceId, `lane-${laneId}`),
      workspacePath: this.store.projectDir,
      workspaceMode: (this.graph.lanes[laneId]?.workspace.write?.length ?? 0) > 0 ? 'shared_write' : 'shared_readonly',
      status: 'ready',
      createdAt: now,
      updatedAt: now,
    }
    await atomicWriteJson(this.lanePath(laneId), record)
    return record
  }

  private lanePath(laneId: string): string { return join(this.store.paths.lanesDir, `${laneId}.json`) }
}
