/**
 * RoboticsTeamCoordinator — the team-collaboration half of a robotics unit,
 * extracted out of RoboticsSession (which was a god-object — see
 * architecture-review-2026-06-18.md §3.1).
 *
 * It owns the thin "mutate TeamStore → invalidate the prompt section → refresh
 * the watcher" choreography that every team operation shares, plus the Plan-B
 * context-boundary state. RoboticsSession holds one of these and exposes it via
 * getTeamController(); SessionRouter/CLI drive it through the
 * RoboticsTeamController interface, and the agent-facing team tools use it as
 * their TeamToolsHost.
 *
 * The only thing it borrows from the session is an `invalidate(section)`
 * callback (the SectionRegistry lives on the session), so it stays decoupled
 * from RoboticsSession's internals.
 */
import type { RoboticsTeamController } from '../contracts.js'
import type { TeamToolsHost } from '../tools/team/index.js'
import type {
  TeamStore,
  TeamNoteInput,
  TeamTaskAddInput,
  TeamTaskStatus,
  TeamSyncSummary,
  TeamPushResult,
  TeamPublishState,
} from './TeamStore.js'
import type { TeamWatcher, TeamWatcherEvent } from './TeamWatcher.js'

export class RoboticsTeamCoordinator implements RoboticsTeamController, TeamToolsHost {
  /**
   * Plan-B context boundary — set once after task claim when the session has
   * prior history. Read by RoboticsSession's volatile prompt extensions.
   */
  private _contextBoundary: string | null = null

  constructor(
    private readonly teamStore: TeamStore,
    private readonly teamWatcher: TeamWatcher,
    /** Invalidate a memoized prompt section on the owning session's registry. */
    private readonly invalidate: (section: string) => void,
  ) {}

  /** Current Plan-B context-boundary text (or null). */
  get contextBoundary(): string | null {
    return this._contextBoundary
  }

  async teamInit(github?: string) {
    this.invalidate('robotics_team_mode')
    const state = await this.teamStore.init(github)
    this.teamWatcher.start()
    await this.teamWatcher.forceSync(false)
    return state
  }

  async teamJoin(github?: string, human?: string) {
    this.invalidate('robotics_team_mode')
    const state = await this.teamStore.join(github, human)
    this.teamWatcher.start()
    await this.teamWatcher.forceSync(false)
    return state
  }

  async teamStatus() {
    return this.teamStore.status()
  }

  async teamTaskAdd(input: TeamTaskAddInput) {
    this.invalidate('robotics_team_mode')
    const result = await this.teamStore.addTask(input)
    await this.teamWatcher.forceSync(false)
    return result
  }

  /** Exclusively take a task; throws if owned by another unit. */
  async teamTake(taskId: string) {
    this.invalidate('robotics_team_mode')
    const result = await this.teamStore.take(taskId)
    await this.teamWatcher.forceSync(false)
    return result
  }

  /** Release a task you own (no-op if you don't own it). */
  async teamDrop(taskId?: string) {
    this.invalidate('robotics_team_mode')
    const result = await this.teamStore.drop(taskId)
    await this.teamWatcher.forceSync(false)
    return result
  }

  /** Force-take a task currently owned by someone else; records audit attempt. */
  async teamSteal(taskId: string, reason?: string) {
    this.invalidate('robotics_team_mode')
    const result = await this.teamStore.steal(taskId, reason)
    await this.teamWatcher.forceSync(false)
    return result
  }

  /** Append a single direction+outcome attempt to a task you own. */
  async teamNote(input: TeamNoteInput) {
    this.invalidate('robotics_team_mode')
    const result = await this.teamStore.note(input)
    await this.teamWatcher.forceSync(false)
    return result
  }

  async teamTaskStatus(taskId: string, status: TeamTaskStatus) {
    this.invalidate('robotics_team_mode')
    const result = await this.teamStore.updateTaskStatus(taskId, status)
    await this.teamWatcher.forceSync(false)
    return result
  }

  async teamSync(): Promise<TeamSyncSummary> {
    this.invalidate('robotics_team_mode')
    // /team sync is an explicit user request — bypass the fetch cooldown.
    const summary = await this.teamStore.sync({ forceFetch: true })
    await this.teamWatcher.forceSync(false)
    return summary
  }

  async teamPull() {
    this.invalidate('robotics_team_mode')
    const result = await this.teamStore.pullRemoteTeam()
    await this.teamWatcher.forceSync(false)
    return result
  }

  /** Switch this unit's focus to a task it owns. */
  async teamFocus(taskId: string) {
    this.invalidate('robotics_team_mode')
    const result = await this.teamStore.focus(taskId)
    await this.teamWatcher.forceSync(false)
    return result
  }

  /** All active tasks this unit owns + the current focus id. */
  async teamOwnedTasks() {
    return this.teamStore.ownedActiveTasks()
  }

  /** Resolve a no-arg done/drop target: explicit → focus → single-owned → throw. */
  async teamResolveOwnTaskId(explicit?: string): Promise<string> {
    return this.teamStore.requireOwnTaskId(explicit)
  }

  /** Publish local team/ changes: stage team/ only, commit, push. */
  async teamPush(): Promise<TeamPushResult> {
    const result = await this.teamStore.push()
    await this.teamWatcher.forceSync(false)
    return result
  }

  /** What local team/ work teammates can't see yet (dirty + unpushed). */
  async teamPublishState(): Promise<TeamPublishState> {
    return this.teamStore.publishState()
  }

  /** True when team/team.json exists (team mode initialised for this project). */
  async teamExists(): Promise<boolean> {
    return this.teamStore.exists()
  }

  /** This unit's id (user-hostname) — the owner identity for take/note/done. */
  teamUnitId(): string {
    return this.teamStore.unitId
  }

  async teamConflicts() {
    return this.teamStore.detectMergeConflicts()
  }

  async teamResolveTeamJson() {
    this.invalidate('robotics_team_mode')
    return this.teamStore.resolveTeamJsonConflict()
  }

  /**
   * Plan B: context boundary.
   * Called once after task claim when the session has prior conversation history.
   *
   * mode='background' — prior conversation is the origin of this task; AI may reference it
   *   as background context but must not describe it as task work-in-progress.
   * mode='unrelated'  — prior conversation is unrelated; AI must not attribute it to this task.
   */
  async teamSetContextBoundary(mode: 'background' | 'unrelated', taskId: string): Promise<void> {
    if (mode === 'background') {
      this._contextBoundary = `[任务背景] 此 session 创建 ${taskId} 之前的对话，是本任务的直接起源。AI 可将其作为背景参考，但不应将其内容描述为"当前任务的工作进展"。`
    } else {
      this._contextBoundary = `[边界提示] ${taskId} 于此刻新建，以上对话内容与本任务无关，请不要将其归因为本任务的工作记录或进展。`
    }
    this.invalidate('team_context_boundary')
  }

  async teamWatcherPoll(): Promise<TeamWatcherEvent[]> {
    // Background poll: let the TeamStore fetch cooldown decide whether a real
    // `git fetch` runs.  Passing fetch=true here only means "attempt", not
    // "force" — TeamStore.sync({fetch:true}) will no-op inside the cooldown.
    await this.teamWatcher.forceSync(true)
    return this.teamWatcher.getRecentEvents()
  }

  teamWatcherEvents(): TeamWatcherEvent[] {
    return this.teamWatcher.getRecentEvents()
  }
}
