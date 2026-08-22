import type { TrajectoryLine } from './types.js'

export interface TrajectoryTelemetrySummary {
  trajectories: number
  runs: number
  successfulRuns: number
  failedRuns: number
  toolCalls: number
  toolErrors: number
  compactions: number
  subagents: number
  totalCostUsd: number
  modes: Record<string, number>
}

export class TrajectoryTelemetryProjector {
  private readonly seenTrajectories: Set<string>
  private readonly summary: TrajectoryTelemetrySummary

  constructor(initial?: {
    summary: TrajectoryTelemetrySummary
    seenTrajectoryIds: readonly string[]
  }) {
    this.seenTrajectories = new Set(initial?.seenTrajectoryIds ?? [])
    this.summary = initial
      ? { ...initial.summary, modes: { ...initial.summary.modes } }
      : emptyTrajectoryTelemetrySummary()
  }

  observe(line: TrajectoryLine): void {
    if (!this.seenTrajectories.has(line.trajectoryId)) {
      this.seenTrajectories.add(line.trajectoryId)
      this.summary.trajectories++
    }
    switch (line.item.type) {
      case 'trajectory_meta':
        this.summary.modes[line.item.mode] = (this.summary.modes[line.item.mode] ?? 0) + 1
        break
      case 'run_started':
        this.summary.runs++
        break
      case 'run_result':
        if (line.item.isError) this.summary.failedRuns++
        else this.summary.successfulRuns++
        this.summary.totalCostUsd += Math.max(0, line.item.costUsd ?? 0)
        break
      case 'tool_outcome':
        this.summary.toolCalls++
        if (line.item.isError) this.summary.toolErrors++
        break
      case 'compaction':
        this.summary.compactions++
        break
      case 'subagent':
        if (line.item.action === 'spawned') this.summary.subagents++
        break
    }
  }

  snapshot(): TrajectoryTelemetrySummary {
    return {
      ...this.summary,
      modes: { ...this.summary.modes },
    }
  }
}

export function emptyTrajectoryTelemetrySummary(): TrajectoryTelemetrySummary {
  return {
    trajectories: 0,
    runs: 0,
    successfulRuns: 0,
    failedRuns: 0,
    toolCalls: 0,
    toolErrors: 0,
    compactions: 0,
    subagents: 0,
    totalCostUsd: 0,
    modes: {},
  }
}
