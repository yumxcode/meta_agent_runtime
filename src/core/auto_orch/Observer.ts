import type { OrchVerdict } from './Verdict.js'
import type { PlanRunStatus } from './PlanRunner.js'
import type { NodeKind, OrchPlan } from './LoopIR.js'

export type AutoOrchEvent =
  | {
      type: 'planner_started'
      maxAttempts: number
      maxInvalidAttempts?: number
      reviewEnabled: boolean
    }
  | {
      type: 'planner_attempt_started'
      attempt: number
      maxAttempts: number
      reason: 'initial' | 'validation_retry' | 'user_revision'
    }
  | {
      type: 'planner_attempt_failed'
      attempt: number
      errors: string[]
    }
  | {
      type: 'planner_subagent_event'
      attempt: number
      taskId: string
      eventType: string
      toolName?: string
      preview?: string
      isError?: boolean
    }
  | {
      type: 'planner_completed'
      source: 'planner' | 'fallback'
      note?: string
    }
  | {
      type: 'plan_started'
      planId?: string
      entry: string
      nodeCount: number
      edgeCount: number
      bounds?: OrchPlan['bounds']
    }
  | {
      type: 'node_started'
      nodeId: string
      nodeKind: NodeKind
      visit: number
      step: number
    }
  | {
      type: 'node_finished'
      nodeId: string
      action: OrchVerdict['action']
      label?: string
      note?: string
      costUsd: number
    }
  | {
      type: 'edge_selected'
      from: string
      to?: string
      label?: string
      action: OrchVerdict['action']
    }
  | {
      type: 'run_paused'
      nodeId?: string
      note?: string
      resumeHandle?: Record<string, unknown>
    }
  | {
      type: 'run_resumed'
      scheduleId: string
      orchestrationTaskId: string
      nodeId: string
      subTaskId: string
      externalRunId?: string
    }
  | {
      type: 'run_completed'
      status: PlanRunStatus
      visitedPath: string[]
      costUsd: number
      note?: string
    }

export type AutoOrchObserver = (event: AutoOrchEvent) => void | Promise<void>

export async function notifyAutoOrchObserver(
  observer: AutoOrchObserver | undefined,
  event: AutoOrchEvent,
): Promise<void> {
  if (!observer) return
  try {
    await observer(event)
  } catch {
    // Observability must never affect graph execution.
  }
}
