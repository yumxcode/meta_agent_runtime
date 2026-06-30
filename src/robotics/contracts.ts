/**
 * Robotics capability contracts.
 *
 * These interfaces describe the robotics-mode-specific surface that
 * SessionRouter exposes to the CLI. They live HERE (in the robotics package),
 * not in routing, so:
 *   - `RoboticsSession implements` them → the compiler verifies the session
 *     actually provides every advertised capability (renaming/removing a method
 *     now fails the build instead of silently returning `undefined` at runtime
 *     via the old `as any` casts — see architecture-review-2026-06-18.md §2.1);
 *   - the router imports them type-only and narrows `_impl` through ONE typed
 *     cast guarded by `mode === 'robotics'`, never per-accessor `as any`.
 */
import type { ExperiencePendingStore } from './ExperiencePendingStore.js'
import type { PhysicalAnchorPendingStore } from './PhysicalAnchorPendingStore.js'
import type { PrinciplePendingStore } from './PrinciplePendingStore.js'
import type { proposePrincipleFromExperience } from './PrinciplePromotion.js'
import type { EvaluatePromotionResult } from './PrincipleConvergence.js'
import type { TeamState, TeamTask, TeamTaskAddInput, TeamNoteInput, TeamAttempt, TeamTaskStatus, TeamSyncOptions, TeamSyncSummary, TeamPullResult, TeamPushResult, TeamPublishState, MergeConflictReport, TeamJsonResolveResult } from './team/TeamStore.js'
import type { TeamWatcherEvent } from './team/TeamWatcher.js'

/**
 * Knowledge-review surface (experience / anchor / principle pending buffers and
 * the principle promotion/reinforcement operations) the CLI drives between turns.
 */
export interface RoboticsCapabilities {
  readonly pendingExperiences: ExperiencePendingStore
  readonly pendingPhysicalAnchors: PhysicalAnchorPendingStore
  readonly pendingPrinciples: PrinciplePendingStore

  proposePrincipleForExperience(
    experienceId: string,
    reason: 'confidence_threshold' | 'explicit_user_request',
  ): Promise<Awaited<ReturnType<typeof proposePrincipleFromExperience>>>

  reinforcePrinciplesFromExperience(
    experienceId: string,
  ): Promise<Array<{ principleId: string; signal: 'observation' | 'contradiction' }>>

  evaluatePromotionForExperience(experienceId: string): Promise<EvaluatePromotionResult>

  /** Drop the memoized R6 anchor section so newly committed anchors appear next turn. */
  invalidateAnchors(): void

  /** The team-collaboration controller (the ~20 team operations live here). */
  getTeamController(): RoboticsTeamController
}

/**
 * Formal TeamController interface — the typed contract between SessionRouter and
 * the CLI team commands. All methods are optional so the controller can be
 * returned safely before the RoboticsSession has fully initialised.
 *
 * Moved here from routing/SessionRouter.ts so RoboticsSession can `implements`
 * it (the team methods return robotics/team types, so this is its natural home).
 */
export interface RoboticsTeamController {
  // Lifecycle
  teamInit?(github?: string): Promise<TeamState>
  teamJoin?(github?: string, human?: string): Promise<TeamState>
  teamStatus?(): Promise<TeamState | null>

  // Task mutation (v2.0 collaboration log)
  teamTaskAdd?(input: TeamTaskAddInput): Promise<{ state: TeamState; task: TeamTask }>
  teamTake?(taskId: string): Promise<{ state: TeamState; task: TeamTask }>
  teamDrop?(taskId?: string): Promise<{ state: TeamState; task: TeamTask }>
  teamSteal?(taskId: string, reason?: string): Promise<{ state: TeamState; task: TeamTask; previousOwner?: string }>
  teamNote?(input: TeamNoteInput): Promise<{ state: TeamState; task: TeamTask; attempt: TeamAttempt }>
  teamFocus?(taskId: string): Promise<{ state: TeamState; task: TeamTask }>
  teamOwnedTasks?(): Promise<{ owned: TeamTask[]; focusId?: string }>
  teamResolveOwnTaskId?(explicit?: string): Promise<string>
  teamTaskStatus?(taskId: string, status: TeamTaskStatus): Promise<{ state: TeamState; task: TeamTask }>

  // Git transport
  teamSync?(options?: TeamSyncOptions): Promise<TeamSyncSummary>
  teamPull?(): Promise<TeamPullResult>
  teamPush?(): Promise<TeamPushResult>
  teamPublishState?(): Promise<TeamPublishState>
  teamConflicts?(): Promise<MergeConflictReport>
  teamResolveTeamJson?(): Promise<TeamJsonResolveResult>

  // Prompt boundary + watcher
  teamSetContextBoundary?(mode: 'background' | 'unrelated', taskId: string): Promise<void>
  teamWatcherPoll?(): Promise<TeamWatcherEvent[]>
  teamWatcherEvents?(): TeamWatcherEvent[]
}
