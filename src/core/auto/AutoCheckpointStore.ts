/**
 * AutoCheckpointStore — durable progress snapshot for auto (unattended) sessions.
 *
 * An auto run can hit its budget/turn cap, the stall circuit, or a crash with no
 * human watching. A checkpoint at `<workspace>/.meta-agent/auto/checkpoint.json`
 * lets a later `--resume` recover the goal, what's done, what's pending, and
 * which sub-agents were in flight — instead of starting from zero.
 *
 * This module is pure I/O over one JSON file: write is atomic (tmp + rename),
 * read is tolerant (returns null on missing/corrupt). It is independent of the
 * session/loop, so it is trivially testable and carries no coupling to modes.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join, resolve } from 'path'

export const AUTO_CHECKPOINT_SCHEMA_VERSION = '1.0'

export interface AutoCheckpoint {
  schemaVersion: string
  sessionId: string
  /** Epoch ms of the last update. */
  updatedAt: number
  /** The original task — the first real user request, captured once. */
  goal?: string
  /** Short free-form progress note / latest summary. */
  note?: string
  /** Steps already completed (durable, append-only across turns). */
  completedSteps?: string[]
  /** Outstanding to-dos at checkpoint time. */
  pendingTodos?: string[]
  /** Sub-agent task IDs that were active/queued at checkpoint time. */
  activeSubAgentIds?: string[]
  /** Key artifact paths produced so far (relative or absolute). */
  artifacts?: string[]
  /** Best-effort turn count and cost for observability. */
  turnCount?: number
  estimatedCostUsd?: number
  /** Why the run stopped, when known (e.g. 'max_budget_usd', 'max_turns'). */
  stopReason?: string
}

/** Absolute path of the auto checkpoint file for a workspace. */
export function autoCheckpointPath(workspaceRoot: string): string {
  return join(resolve(workspaceRoot), '.meta-agent', 'auto', 'checkpoint.json')
}

/**
 * Atomically write the checkpoint. Best-effort: never throws (returns false on
 * failure) so a checkpoint write can never crash the run it is protecting.
 */
export function writeAutoCheckpoint(workspaceRoot: string, checkpoint: AutoCheckpoint): boolean {
  try {
    const path = autoCheckpointPath(workspaceRoot)
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(checkpoint, null, 2), 'utf-8')
    renameSync(tmp, path)
    return true
  } catch {
    return false
  }
}

/**
 * Build a recovery preamble injected into the model's context on `--resume` of
 * an auto session. Unlike the CLI banner (which is shown only to the human), this
 * goes to the model so the resumed run actually knows where it left off: the
 * original goal, what was already done, what's still pending, and which
 * sub-agents were in flight. Returns null when there is nothing useful to inject.
 */
export function buildAutoResumePreamble(cp: AutoCheckpoint | null): string | null {
  if (!cp) return null
  const lines: string[] = []
  if (cp.goal) lines.push(`原始目标：${cp.goal}`)
  if (cp.completedSteps?.length) {
    lines.push(`已完成：\n${cp.completedSteps.map(s => `  - ${s}`).join('\n')}`)
  }
  if (cp.pendingTodos?.length) {
    lines.push(`未完成待办：\n${cp.pendingTodos.map(s => `  - ${s}`).join('\n')}`)
  }
  if (cp.artifacts?.length) {
    lines.push(`已产出文件（需要时直接读取，不要重做）：\n${cp.artifacts.map(s => `  - ${s}`).join('\n')}`)
  }
  if (cp.activeSubAgentIds?.length) {
    lines.push(`上次在途的子代理：${cp.activeSubAgentIds.join(', ')}`)
  }
  if (cp.stopReason) lines.push(`上次停止原因：${cp.stopReason}`)
  if (lines.length === 0) return null
  return (
    '[系统·会话恢复] 这是一次被恢复的自动(auto)会话。以下是上次中断时的进度快照，' +
    '请在此基础上继续，不要从零重来：\n\n' +
    lines.join('\n') +
    '\n\n请先用一句话确认你的下一步，然后继续推进未完成的部分。'
  )
}

/** Read the checkpoint, or null when missing / unreadable / wrong shape. */
export function readAutoCheckpoint(workspaceRoot: string): AutoCheckpoint | null {
  try {
    const path = autoCheckpointPath(workspaceRoot)
    if (!existsSync(path)) return null
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown
    if (!parsed || typeof parsed !== 'object') return null
    const cp = parsed as Partial<AutoCheckpoint>
    if (typeof cp.sessionId !== 'string' || typeof cp.updatedAt !== 'number') return null
    return cp as AutoCheckpoint
  } catch {
    return null
  }
}

/**
 * Merge an update into the existing checkpoint (or create a fresh one), bumping
 * updatedAt and unioning the append-only lists. Returns the written checkpoint.
 */
export function updateAutoCheckpoint(
  workspaceRoot: string,
  sessionId: string,
  patch: Partial<Omit<AutoCheckpoint, 'schemaVersion' | 'sessionId' | 'updatedAt'>>,
): AutoCheckpoint {
  const prior = readAutoCheckpoint(workspaceRoot)
  const union = (a?: string[], b?: string[]): string[] | undefined => {
    if (!a && !b) return undefined
    return [...new Set([...(a ?? []), ...(b ?? [])])]
  }
  const maxDefined = (a?: number, b?: number): number | undefined => {
    if (a === undefined) return b
    if (b === undefined) return a
    return Math.max(a, b)
  }
  const next: AutoCheckpoint = {
    schemaVersion: AUTO_CHECKPOINT_SCHEMA_VERSION,
    sessionId,
    updatedAt: Date.now(),
    goal: patch.goal ?? prior?.goal,
    note: patch.note ?? prior?.note,
    completedSteps: union(prior?.completedSteps, patch.completedSteps),
    // pendingTodos / activeSubAgentIds reflect the latest state, not a union.
    pendingTodos: patch.pendingTodos ?? prior?.pendingTodos,
    activeSubAgentIds: patch.activeSubAgentIds ?? prior?.activeSubAgentIds,
    artifacts: union(prior?.artifacts, patch.artifacts),
    // turnCount is monotonic: a resumed run restarts its in-memory counter from
    // 1, so take the max to avoid regressing the accumulated total on resume.
    turnCount: maxDefined(prior?.turnCount, patch.turnCount),
    estimatedCostUsd: patch.estimatedCostUsd ?? prior?.estimatedCostUsd,
    stopReason: patch.stopReason ?? prior?.stopReason,
  }
  writeAutoCheckpoint(workspaceRoot, next)
  return next
}
