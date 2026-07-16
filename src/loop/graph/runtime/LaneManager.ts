import { join } from 'node:path'
import { AutoWorktreeCoordinator } from '../../../core/auto/AutoWorktreeCoordinator.js'
import { atomicWriteJson, readJsonFile } from '../../../infra/persist/index.js'
import type { SubAgentWorkspaceMode } from '../../../subagent/types.js'
import { workspaceScopedLineage } from '../../workspace/WorkspaceIdentity.js'
import type { ActivationRecord, ExecutionLaneSpec, FrozenLoopGraphSpec, GraphInstanceRecord } from '../spec/GraphTypes.js'
import type { GraphStore } from './GraphStore.js'

export interface LaneRuntimeRecord {
  schemaVersion: 'graph-lane-1.0'
  laneId: string
  lineageSessionId: string
  workspacePath: string
  workspaceMode: SubAgentWorkspaceMode
  branchName?: string
  status: 'ready' | 'conflicted' | 'merged'
  createdAt: number
  updatedAt: number
  lastActivationId?: string
  error?: string
}

export interface LaneExecutionBinding {
  lane: LaneRuntimeRecord
  lineageSessionId?: string
  projectDir: string
  workspaceMode: SubAgentWorkspaceMode
}

/**
 * A Lane is the continuity and single-writer boundary. The GraphStore owns
 * scheduling exclusion; this class owns the durable session id and selects a
 * workspace backend. Only lane_overlay allocates a persistent git worktree.
 */
export class LaneManager {
  private readonly worktrees: AutoWorktreeCoordinator

  constructor(
    private readonly store: GraphStore,
    private readonly graph: FrozenLoopGraphSpec,
    private readonly instance: GraphInstanceRecord,
  ) {
    this.worktrees = new AutoWorktreeCoordinator(store.projectDir, {
      worktreeBase: join(store.paths.lanesDir, 'worktrees'),
      registryPath: join(store.paths.lanesDir, 'worktrees.json'),
    })
  }

  async bind(laneId: string, activation: ActivationRecord): Promise<LaneExecutionBinding> {
    const spec = this.graph.lanes[laneId]
    if (!spec) throw new Error(`unknown Lane '${laneId}'`)
    const record = await this.loadOrCreate(laneId, spec)
    if (record.status === 'conflicted') throw new Error(`Lane '${laneId}' is conflicted: ${record.error ?? 'merge failed'}`)
    const next = { ...record, lastActivationId: activation.id, updatedAt: Date.now() }
    await atomicWriteJson(this.lanePath(laneId), next)
    return {
      lane: next,
      lineageSessionId: spec.context === 'persistent' ? next.lineageSessionId : undefined,
      projectDir: next.workspacePath,
      workspaceMode: next.workspaceMode,
    }
  }

  /** Resolve/create a Lane workspace for Kernel-owned projections. */
  async workspaceRoot(laneId: string): Promise<string> {
    const spec = this.graph.lanes[laneId]
    if (!spec) throw new Error(`unknown Lane '${laneId}'`)
    const record = await this.loadOrCreate(laneId, spec)
    if (record.status === 'conflicted') throw new Error(`Lane '${laneId}' is conflicted: ${record.error ?? 'merge failed'}`)
    // Terminal merge has moved the Lane projection into the project tree. A
    // final journal/audit reconciliation therefore targets the merged root.
    if (record.status === 'merged') return this.store.projectDir
    return record.workspacePath
  }

  async mergeAll(): Promise<LaneRuntimeRecord[]> {
    const output: LaneRuntimeRecord[] = []
    for (const [laneId, spec] of Object.entries(this.graph.lanes)) {
      const record = await readJsonFile<LaneRuntimeRecord>(this.lanePath(laneId))
      if (!record || spec.workspace !== 'lane_overlay' || record.status === 'merged') {
        if (record) output.push(record)
        continue
      }
      const taskId = this.laneTaskId(laneId)
      try {
        const result = await this.worktrees.merge(taskId, { message: `meta-agent graph ${this.instance.instanceId} Lane ${laneId}` })
        if (!result?.merged) throw new Error('worktree merge returned no result')
        const next: LaneRuntimeRecord = { ...record, status: 'merged', error: undefined, updatedAt: Date.now() }
        await atomicWriteJson(this.lanePath(laneId), next)
        output.push(next)
      } catch (error) {
        const next: LaneRuntimeRecord = {
          ...record,
          status: 'conflicted',
          error: error instanceof Error ? error.message : String(error),
          updatedAt: Date.now(),
        }
        await atomicWriteJson(this.lanePath(laneId), next)
        output.push(next)
      }
    }
    return output
  }

  async reconcile(): Promise<void> {
    await this.worktrees.reconcile()
  }

  /** Reconcile an interrupted/conflicted Lane and retry its durable merge. */
  async repair(laneId: string): Promise<LaneRuntimeRecord> {
    const spec = this.graph.lanes[laneId]
    if (!spec) throw new Error(`unknown Lane '${laneId}'`)
    const record = await readJsonFile<LaneRuntimeRecord>(this.lanePath(laneId))
    if (!record) throw new Error(`Lane '${laneId}' has not been created`)
    if (spec.workspace !== 'lane_overlay' || record.status === 'merged') return record
    await this.worktrees.reconcile()
    try {
      const result = await this.worktrees.merge(this.laneTaskId(laneId), {
        message: `meta-agent graph ${this.instance.instanceId} repaired Lane ${laneId}`,
      })
      if (!result?.merged) throw new Error('worktree merge returned no result')
      const next: LaneRuntimeRecord = { ...record, status: 'merged', error: undefined, updatedAt: Date.now() }
      await atomicWriteJson(this.lanePath(laneId), next)
      return next
    } catch (error) {
      const next: LaneRuntimeRecord = {
        ...record,
        status: 'conflicted',
        error: error instanceof Error ? error.message : String(error),
        updatedAt: Date.now(),
      }
      await atomicWriteJson(this.lanePath(laneId), next)
      return next
    }
  }

  private async loadOrCreate(laneId: string, spec: ExecutionLaneSpec): Promise<LaneRuntimeRecord> {
    const existing = await readJsonFile<LaneRuntimeRecord>(this.lanePath(laneId))
    if (existing) return existing
    const now = Date.now()
    const lineageSessionId = workspaceScopedLineage(
      { workspaceId: this.instance.workspaceId },
      this.instance.instanceId,
      `lane-${laneId}`,
    )
    let workspacePath = this.store.projectDir
    let workspaceMode: SubAgentWorkspaceMode = 'shared_readonly'
    let branchName: string | undefined
    if (spec.workspace === 'lane_overlay') {
      if (!this.worktrees.enabled) throw new Error(`Lane '${laneId}' requests lane_overlay, but the workspace is not a git repository`)
      const handle = await this.worktrees.allocate(this.laneTaskId(laneId), lineageSessionId)
      if (!handle) throw new Error(`could not allocate worktree for Lane '${laneId}'`)
      workspacePath = handle.worktreePath
      workspaceMode = 'shared_write'
      branchName = handle.branchName
    } else if (spec.workspace === 'shared_controlled') {
      workspaceMode = 'shared_write'
    } else if (spec.workspace === 'effect_only') {
      throw new Error(`Lane '${laneId}' is effect_only and cannot execute an Agent node`)
    }
    const record: LaneRuntimeRecord = {
      schemaVersion: 'graph-lane-1.0',
      laneId,
      lineageSessionId,
      workspacePath,
      workspaceMode,
      branchName,
      status: 'ready',
      createdAt: now,
      updatedAt: now,
    }
    await atomicWriteJson(this.lanePath(laneId), record)
    return record
  }

  private laneTaskId(laneId: string): string {
    const safe = `${this.instance.instanceId}-${laneId}`.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 80)
    return `graph-lane-${safe}`
  }

  private lanePath(laneId: string): string {
    return join(this.store.paths.lanesDir, `${laneId}.json`)
  }
}
