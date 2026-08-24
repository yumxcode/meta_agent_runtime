import { createHash } from 'node:crypto'
import { access } from 'node:fs/promises'
import { listTrajectoryIndex } from '../trajectory/indexStore.js'
import { readTrajectoryPreservingUnknown } from '../trajectory/reader.js'
import {
  trajectoryFile,
  trajectoryLeaseFile,
  type TrajectoryPathsOptions,
} from '../trajectory/paths.js'
import type {
  PreservedTrajectoryLine,
  TrajectoryIndexEntry,
} from '../trajectory/types.js'
import {
  buildReviewWindows,
  redactTaskSummary,
  reduceTrajectoryLine,
  type ReviewTrigger,
} from './TrajectoryReviewScanner.js'

export interface TaskCaseScope {
  all?: boolean
  limit?: number
  trajectoryId?: string
  workspace?: string
  since?: number
}

export interface TaskCaseDescriptor {
  caseId: string
  rootTrajectoryId: string
  root: TrajectoryIndexEntry
  entries: TrajectoryIndexEntry[]
  workspace?: string
  workspaceId?: string
  createdAt: number
  lastActivity: number
}

export interface TaskCaseMember {
  entry: TrajectoryIndexEntry
  lines: PreservedTrajectoryLine[]
}

export interface TaskCaseTriggerHint {
  windowId: string
  trajectoryId: string
  trigger: ReviewTrigger
  triggerOrdinals: number[]
}

export interface TaskCase {
  id: string
  rootTrajectoryId: string
  workspace?: string
  workspaceId?: string
  taskSummary: string
  inputHash: string
  members: TaskCaseMember[]
  triggerHints: TaskCaseTriggerHint[]
  createdAt: number
  lastActivity: number
  metrics: {
    trajectories: number
    runs: number
    toolCalls: number
    toolErrors: number
    totalCostUsd: number
    lines: number
  }
}

export interface SkippedTaskCase {
  caseId: string
  rootTrajectoryId: string
  reason: string
}

export async function listTaskCaseDescriptors(
  scope: TaskCaseScope = {},
  options: TrajectoryPathsOptions = {},
): Promise<TaskCaseDescriptor[]> {
  const entries = (await listTrajectoryIndex(options)).filter(entry => entry.mode !== 'reviewer')
  return selectTaskCaseDescriptors(entries, scope)
}

export function selectTaskCaseDescriptors(
  entries: readonly TrajectoryIndexEntry[],
  scope: TaskCaseScope = {},
): TaskCaseDescriptor[] {
  const eligible = entries.filter(entry => entry.mode !== 'reviewer')
  const byId = new Map(eligible.map(entry => [entry.trajectoryId, entry]))
  const groups = new Map<string, TrajectoryIndexEntry[]>()
  for (const entry of eligible) {
    const rootId = resolveRootTrajectoryId(entry, byId)
    const members = groups.get(rootId) ?? []
    members.push(entry)
    groups.set(rootId, members)
  }

  let descriptors = [...groups.entries()].map(([rootTrajectoryId, members]) => {
    const ordered = [...members].sort((left, right) => {
      if (left.trajectoryId === rootTrajectoryId) return -1
      if (right.trajectoryId === rootTrajectoryId) return 1
      return left.createdAt - right.createdAt || left.trajectoryId.localeCompare(right.trajectoryId)
    })
    const root = byId.get(rootTrajectoryId) ?? ordered[0]!
    return {
      caseId: caseIdFor(rootTrajectoryId),
      rootTrajectoryId,
      root,
      entries: ordered,
      ...(root.workspace ? { workspace: root.workspace } : {}),
      ...(root.workspaceId ? { workspaceId: root.workspaceId } : {}),
      createdAt: Math.min(...ordered.map(entry => entry.createdAt)),
      lastActivity: Math.max(...ordered.map(entry => entry.lastActivity)),
    }
  })

  if (scope.trajectoryId) {
    const exact = eligible.find(entry => entry.trajectoryId === scope.trajectoryId)
    const prefixMatches = exact
      ? [exact]
      : eligible.filter(entry => entry.trajectoryId.startsWith(scope.trajectoryId!))
    if (prefixMatches.length > 1) throw new Error(`trajectory id prefix '${scope.trajectoryId}' is ambiguous`)
    if (prefixMatches.length === 0) throw new Error(`unknown trajectory '${scope.trajectoryId}'`)
    const selectedId = prefixMatches[0]!.trajectoryId
    descriptors = descriptors.filter(item => item.entries.some(entry => entry.trajectoryId === selectedId))
  }
  if (scope.workspace) {
    descriptors = descriptors.filter(item => item.entries.some(entry =>
      entry.workspace === scope.workspace || entry.workspaceId === scope.workspace))
  }
  if (scope.since !== undefined) {
    descriptors = descriptors.filter(item => item.lastActivity >= scope.since!)
  }
  descriptors.sort((left, right) =>
    right.lastActivity - left.lastActivity || left.caseId.localeCompare(right.caseId))
  if (!scope.all) descriptors = descriptors.slice(0, scope.limit ?? 20)
  return descriptors
}

export async function loadTaskCase(
  descriptor: TaskCaseDescriptor,
  options: TrajectoryPathsOptions = {},
): Promise<TaskCase | SkippedTaskCase> {
  for (const entry of descriptor.entries) {
    if (await access(trajectoryLeaseFile(entry.trajectoryId, options)).then(() => true, () => false)) {
      return {
        caseId: descriptor.caseId,
        rootTrajectoryId: descriptor.rootTrajectoryId,
        reason: `active writer lease on trajectory ${entry.trajectoryId}`,
      }
    }
  }

  let members: TaskCaseMember[]
  try {
    members = await Promise.all(descriptor.entries.map(async entry => ({
      entry,
      lines: await readTrajectoryPreservingUnknown(trajectoryFile(entry.trajectoryId, options)),
    })))
  } catch (error) {
    return {
      caseId: descriptor.caseId,
      rootTrajectoryId: descriptor.rootTrajectoryId,
      reason: `task case unreadable: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  try {
    const digest = createHash('sha256')
    const triggerHints: TaskCaseTriggerHint[] = []
    for (const member of members) {
      digest.update(`${member.entry.trajectoryId}\0`)
      for (const line of member.lines) digest.update(`${line.rawLine}\n`)
      for (const window of buildReviewWindows(member.entry, member.lines)) {
        triggerHints.push({
          windowId: window.id,
          trajectoryId: window.trajectoryId,
          trigger: window.trigger,
          triggerOrdinals: window.triggerOrdinals,
        })
      }
    }
    const summarySource = descriptor.root.firstPrompt
      ?? descriptor.entries.find(entry => entry.firstPrompt)?.firstPrompt
      ?? descriptor.root.title
      ?? 'Untitled agent task'
    const workspace = descriptor.workspace
    return {
      id: descriptor.caseId,
      rootTrajectoryId: descriptor.rootTrajectoryId,
      ...(workspace ? { workspace } : {}),
      ...(descriptor.workspaceId ? { workspaceId: descriptor.workspaceId } : {}),
      taskSummary: redactTaskSummary(summarySource, workspace),
      inputHash: digest.digest('hex'),
      members,
      triggerHints,
      createdAt: descriptor.createdAt,
      lastActivity: descriptor.lastActivity,
      metrics: {
        trajectories: members.length,
        runs: sum(descriptor.entries.map(entry => entry.runs)),
        toolCalls: sum(descriptor.entries.map(entry => entry.toolCalls)),
        toolErrors: sum(descriptor.entries.map(entry => entry.toolErrors)),
        totalCostUsd: sum(descriptor.entries.map(entry => entry.totalCostUsd)),
        lines: sum(members.map(member => member.lines.length)),
      },
    }
  } catch (error) {
    return {
      caseId: descriptor.caseId,
      rootTrajectoryId: descriptor.rootTrajectoryId,
      reason: `task case pre-scan failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

export function taskCaseOverview(taskCase: TaskCase): Record<string, unknown> {
  const runResults = taskCase.members.flatMap(member => member.lines
    .filter(line => line.knownItem && line.item.type === 'run_result')
    .map(line => ({
      trajectoryId: member.entry.trajectoryId,
      ordinal: line.ordinal,
      summary: reduceTrajectoryLine(line).text,
    })))
  return {
    caseId: taskCase.id,
    rootTrajectoryId: taskCase.rootTrajectoryId,
    taskSummary: taskCase.taskSummary,
    workspaceId: taskCase.workspaceId,
    createdAt: taskCase.createdAt,
    lastActivity: taskCase.lastActivity,
    metrics: taskCase.metrics,
    trajectories: taskCase.members.map(member => ({
      trajectoryId: member.entry.trajectoryId,
      subject: member.entry.subject,
      mode: member.entry.mode,
      parentTrajectoryId: member.entry.parentTrajectoryId,
      rootTrajectoryId: member.entry.rootTrajectoryId,
      lastOrdinal: member.entry.lastOrdinal,
      runs: member.entry.runs,
      toolCalls: member.entry.toolCalls,
      toolErrors: member.entry.toolErrors,
      lastOutcome: member.entry.lastOutcome,
    })),
    triggerHints: taskCase.triggerHints,
    runResults: runResults.slice(-40),
  }
}

export function caseIdFor(rootTrajectoryId: string): string {
  return `case_${createHash('sha256').update(rootTrajectoryId).digest('hex').slice(0, 24)}`
}

function resolveRootTrajectoryId(
  entry: TrajectoryIndexEntry,
  byId: ReadonlyMap<string, TrajectoryIndexEntry>,
): string {
  if (entry.rootTrajectoryId) return entry.rootTrajectoryId
  let current = entry
  const path = [entry.trajectoryId]
  const position = new Map([[entry.trajectoryId, 0]])
  while (current.parentTrajectoryId) {
    const parentId = current.parentTrajectoryId
    const cycleStart = position.get(parentId)
    if (cycleStart !== undefined) {
      // Corrupt parent graphs should still converge on one deterministic case,
      // independent of which member happens to be resolved first.
      return [...path.slice(cycleStart)].sort()[0]!
    }
    const parent = byId.get(parentId)
    if (!parent) return parentId
    position.set(parentId, path.length)
    path.push(parentId)
    current = parent
    if (current.rootTrajectoryId) return current.rootTrajectoryId
  }
  return current.trajectoryId
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0)
}
