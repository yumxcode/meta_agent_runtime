/**
 * RoboticsSession — the SessionImpl for mode='robotics'.
 *
 * Architecture (composition, not inheritance):
 *
 *   RoboticsSession
 *     ├─ inner: AgenticSession            ← handles the API loop and tools
 *     ├─ experienceStore: ExperienceStore  ← persistent robotics knowledge base
 *     ├─ hardwareProfile: HardwareProfile  ← robot specs + safety limits
 *     ├─ gitManager: GitWorkspaceManager  ← sub-agent branch/worktree management
 *     ├─ projectStore: RoboticsProjectStore ← session persistence + progress notes
 *     └─ sectionRegistry: SectionRegistry ← R1-R5 dynamic prompt sections
 *
 * On every submit():
 *   1. First call only: classify agent mode (single vs multi) via flash model side-call.
 *      After classification, invalidate R1 cache so it re-renders with the correct
 *      mode, then gets memoized for all subsequent turns.
 *   2. Resolve R1-R5 sections → combined string
 *   3. Push into inner.setAppendSystemPrompt()
 *   4. Delegate to inner.submit()
 *   5. Touch projectStore (update lastActiveAt)
 *
 * Session persistence:
 *   - init() checks RoboticsProjectStore for an existing session in projectDir
 *   - If found (within 30-day window): restores state → R5 shows resume context
 *   - If not found: creates fresh state
 *   - agentMode is persisted in project state; resumed sessions keep prior mode.
 *
 * Workflow integration:
 *   - WorkflowLoader.load('robotics', projectDir) finds AGENT.md
 *   - If found: W1 section registered + workflow tools injected
 *
 * System prompt layout:
 *   AgenticSession.systemPrompt = buildStaticSystemPrompt()              (S1-S6, cached)
 *   AgenticSession.appendSystemPrompt = buildDynamicSections({           (refreshed per submit)
 *     mode: 'robotics',
 *     modeExtensions: [R1, R2, R3, R4, R5, (W1)],   ← injected after D4c
 *     ...
 *   })
 */

import { randomUUID } from 'crypto'
import Anthropic from '@anthropic-ai/sdk'
import type { ConversationMessage, MetaAgentEvent, MetaAgentTool } from '../core/types.js'
import { AgenticSession } from '../modes/AgenticSession.js'
import type { MetaAgentConfig } from '../core/config.js'
import { detectProvider } from '../core/config.js'
import { buildStaticSystemPrompt } from '../core/staticPrompt.js'
import { SectionRegistry, DANGEROUS_uncachedSystemPromptSection } from '../core/systemPromptSections.js'
import { SubAgentBridge } from '../subagent/SubAgentBridge.js'
import { ExperienceStore } from './ExperienceStore.js'
import { ExperiencePendingStore } from './ExperiencePendingStore.js'
import { HardwareProfile } from './HardwareProfile.js'
import { GitWorkspaceManager } from './git/GitWorkspaceManager.js'
import { RoboticsProjectStore } from './persistence/RoboticsProjectStore.js'
import type { RoboticsAgentMode, RoboticsProjectState } from './types.js'
import { buildR1Section, buildR2Section, buildR3Section, buildR4Section, buildR5Section } from './dynamicSections.js'
import {
  buildDynamicSections,
  buildVolatileContextSections,
  formatVolatileContext,
} from '../core/dynamicPrompt.js'
import { createRoboticsTools } from './tools/index.js'
import { createFsTools } from '../tools/fs/index.js'
import { createBashTool } from '../tools/shell/bash/index.js'
import { makeGetSubAgentStatusTool } from '../subagent/tools/get_sub_agent_status.js'
import { WorkflowLoader } from '../workflow/WorkflowLoader.js'
import { WorkflowStateStore } from '../workflow/WorkflowStateStore.js'
import type { WorkflowDefinition, WorkflowState } from '../workflow/types.js'
import { buildW1Section } from '../workflow/dynamicSection.js'
import { createWorkflowTools } from '../workflow/tools/index.js'
import { TeamStore, type TeamModuleAddInput, type TeamSyncSummary, type TeamTaskAddInput, type TeamTaskStatus } from './team/TeamStore.js'
import { TeamWatcher, type TeamWatcherEvent } from './team/TeamWatcher.js'
import { buildTeamSection } from './team/dynamicSection.js'

// ── Options ───────────────────────────────────────────────────────────────────

export interface RoboticsSessionOptions extends MetaAgentConfig {
  /** Robot/platform name (e.g. 'go2', 'franka_panda'). Injected into R1 & R4. */
  robot?: string
  /**
   * Project directory for git workspace management and session persistence.
   * Defaults to process.cwd().
   */
  projectDir?: string
  /**
   * Agent orchestration mode override.
   *
   * - 'single' — disable sub-agent dispatching; main agent handles everything.
   * - 'multi'  — full multi-agent orchestration (experiment_dispatch, paper_search, git).
   * - 'auto'   — (default) classify via flash model on first submit() using task context.
   *
   * When set explicitly, no flash model side-call is made.
   * Persisted to project state; resumed sessions inherit the stored mode unless
   * an explicit override is provided here.
   */
  agentMode?: RoboticsAgentMode | 'auto'
}

// ── RoboticsSession ───────────────────────────────────────────────────────────

export class RoboticsSession {
  private readonly inner: AgenticSession
  /** Last assembled R-section prompt, exposed for debugging. */
  private _lastSystemPrompt: string | null = null
  private readonly bridge: SubAgentBridge
  private readonly store: ExperienceStore
  /** Session-scoped pending experience buffer. Exposed so the CLI can drive review UI. */
  readonly pendingExperiences: ExperiencePendingStore
  private readonly hwProfile: HardwareProfile
  private readonly gitMgr: GitWorkspaceManager
  private readonly teamStore: TeamStore
  private readonly teamWatcher: TeamWatcher
  private readonly projectDir: string
  private readonly robot: string | undefined
  private readonly sectionRegistry = new SectionRegistry()
  /** Explicit caller override; undefined means 'auto' (classify on first submit). */
  private readonly _modeOverride: RoboticsAgentMode | undefined

  private _state: RoboticsProjectState | null = null
  private _resumedAt: number | null = null
  private _workflowDef: WorkflowDefinition | null = null
  private _workflowState: WorkflowState | null = null
  /** Resolved agent mode. Starts as 'multi' (safe default) until classified. */
  private _agentMode: RoboticsAgentMode = 'multi'
  /** True once mode has been classified or overridden; prevents re-classification. */
  private _modeClassified = false
  /** Heartbeat timer — touches lastActiveAt every HEARTBEAT_INTERVAL_MS */
  private _heartbeatTimer: ReturnType<typeof setInterval> | null = null
  /** True after dispose() has been called — prevents double-cleanup */
  private _disposed = false
  /** Session start timestamp — passed to buildDynamicSections() for D2 env_info. */
  private readonly _sessionStartMs = Date.now()
  /** #11: Guard against concurrent submit() calls on the same RoboticsSession. */
  private _submitInFlight = false
  /**
   * Last assembled stable system prompt (memoized sections only).
   * Used to deduplicate setAppendSystemPrompt() calls across turns so that
   * messages[0] stays byte-identical when only volatile context changed,
   * preserving the DeepSeek KV cache prefix across conversation turns.
   */
  private _lastStablePrompt: string | null = null
  /**
   * Plan B context boundary — set once after task claim when the session has prior history.
   * Injected as the first section in _getRoboticsExtensions() to anchor the AI's perception
   * of where this task starts.
   */
  private _teamContextBoundary: string | null = null

  /** Mirrors MetaAgentSession.sessionId */
  readonly sessionId: string

  /** Heartbeat interval: 30 s. If lastActiveAt is older than 3× this, session is stale. */
  static readonly HEARTBEAT_INTERVAL_MS = 30_000
  static readonly STALE_SESSION_TTL_MS  = 3 * RoboticsSession.HEARTBEAT_INTERVAL_MS

  constructor(config: RoboticsSessionOptions = {}) {
    this.sessionId = randomUUID()
    this.robot = config.robot
    this.projectDir = config.projectDir ?? process.cwd()
    this._modeOverride = config.agentMode === 'auto' || config.agentMode == null
      ? undefined
      : config.agentMode

    // Build inner session using AgenticSession directly — skips MetaAgentSession's
    // D-section assembly, which is superseded by the R1-R5 sections injected below.
    //
    // System prompt layout:
    //   systemPrompt       = buildStaticSystemPrompt() (S1-S6, stable → prompt-cacheable)
    //   appendSystemPrompt = R1-R5 (+ W1) sections, rebuilt per submit
    //
    // Pin sessionId so debug file paths and store entries align with getSessionId().
    this.inner = new AgenticSession({
      ...config,
      sessionId:    this.sessionId,           // ← align inner UUID with outer
      systemPrompt: buildStaticSystemPrompt('robotics'), // base static context (S1-S6, robotics-trimmed)
      robot:        undefined,                 // not a MetaAgentConfig field
      projectDir:   this.projectDir,
      agentMode:    undefined,
    } as MetaAgentConfig)

    // Infrastructure
    this.store = new ExperienceStore()
    this.pendingExperiences = new ExperiencePendingStore(this.projectDir)
    this.hwProfile = new HardwareProfile(undefined, this.robot)
    this.gitMgr = new GitWorkspaceManager(this.projectDir)
    this.teamStore = new TeamStore(this.projectDir)
    this.teamWatcher = new TeamWatcher(this.teamStore)
    this.bridge = new SubAgentBridge(this.sessionId)
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Initialise the session: restore or create project state, then register
   * all tools and dynamic sections.
   *
   * Must be called once before the first submit().
   * SessionRouter.robotics case calls this automatically.
   */
  async init(): Promise<{ resumed: boolean; sessionAgeMs?: number }> {
    await this.pendingExperiences.load()

    // ── 1. Persistence: try to restore project state ─────────────────────
    const existing = await RoboticsProjectStore.findByProjectDir(this.projectDir)
    if (existing) {
      this._state = existing
      this._resumedAt = existing.lastActiveAt
      await RoboticsProjectStore.touch(this.projectDir)

      // ── Crash-recovery: detect abnormally terminated previous session ────
      // If lastActiveAt is older than STALE_SESSION_TTL and there are active
      // sub-agent tasks, the previous process died without calling dispose().
      // Force-discard all active worktrees to prevent resource leaks.
      const sessionAge = Date.now() - existing.lastActiveAt
      const hasActiveTasks = existing.activeSubAgentTasks.length > 0
      if (sessionAge > RoboticsSession.STALE_SESSION_TTL_MS && hasActiveTasks) {
        for (const task of existing.activeSubAgentTasks) {
          if (task.branchName) {
            await this.gitMgr.removeWorktree(
              task.taskId,
              { deleteBranch: false },  // keep branch for forensics; only remove worktree
            ).catch(() => undefined)
          }
          await RoboticsProjectStore.purgeStaleSubAgentTask(this.projectDir, task.taskId)
        }
      }

      // ── Reconcile worktrees still on disk ────────────────────────────────
      // staleIds = tasks whose worktree/branch no longer exists — purge them.
      const staleIds = await this.gitMgr.reconcileWorktrees(existing.git)
      if (staleIds.length > 0) {
        for (const id of staleIds) {
          await RoboticsProjectStore.purgeStaleSubAgentTask(this.projectDir, id)
        }
      }
      // Restore persisted agent mode (explicit override wins)
      if (this._modeOverride) {
        this._agentMode = this._modeOverride
        this._modeClassified = true
      } else if (existing.agentMode) {
        this._agentMode = existing.agentMode
        this._modeClassified = true  // don't re-classify resumed sessions
      }
    } else {
      // Fresh session — apply explicit override immediately if provided
      const gitState = await this.gitMgr.detectGitState()
      this._state = {
        schemaVersion: '1.0',
        sessionId: this.sessionId,
        projectDir: this.projectDir,
        robot: this.robot,
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        progressNotes: [],
        activeSubAgentTasks: [],
        completedSubAgentTaskIds: [],
        git: gitState,
      }
      if (this._modeOverride) {
        this._agentMode = this._modeOverride
        this._modeClassified = true
        this._state.agentMode = this._modeOverride
      }
      await RoboticsProjectStore.save(this._state)
    }

    // ── 2. Workflow: discover AGENT.md ────────────────────────────────────
    const wfDef = WorkflowLoader.load('robotics', this.projectDir)
    if (wfDef) {
      this._workflowDef = wfDef
      const existingWfState = await WorkflowStateStore.read(this.projectDir)
      this._workflowState = existingWfState
        ?? await WorkflowStateStore.initialize(this.projectDir, wfDef)
    }

    // ── 3. Register robotics tools ────────────────────────────────────────
    const roboticsTools = createRoboticsTools({
      bridge: this.bridge,
      projectDir: this.projectDir,
      robot: this.robot,
      experienceStore: this.store,
      experiencePendingStore: this.pendingExperiences,
      hardwareProfile: this.hwProfile,
      gitManager: this.gitMgr,
    })
    for (const tool of roboticsTools) {
      this.inner.registerTool(tool)
    }

    // ── 3b. Register foundational tools (file I/O, shell, sub-agent status) ──
    //
    // These are essential for the main agent to:
    //   - Read log files / CSVs directly without dispatching sub-agents (glob, read_file, bash)
    //   - Retrieve sub-agent results after experiment_dispatch (get_sub_agent_status)
    //
    // Without these the agent has no way to do direct analysis, falls back to
    // dispatching sub-agents for every file operation — creating orphan tasks.
    const fsTools = await createFsTools()
    for (const tool of fsTools) {
      this.inner.registerTool(tool)
    }
    this.inner.registerTool(await createBashTool())
    this.inner.registerTool(makeGetSubAgentStatusTool(this.bridge))

    // ── 4. Register workflow tools (if workflow found) ────────────────────
    if (this._workflowDef) {
      const wfTools = createWorkflowTools(
        this.projectDir,
        this._workflowDef,
        () => this._workflowState,
        (newState) => {
          this._workflowState = newState
          // Invalidate W1 section so next turn reflects updated phase/gates
          this.sectionRegistry.invalidate('workflow_phase')
        },
      )
      for (const tool of wfTools) {
        this.inner.registerTool(tool)
      }
    }

    // ── 5. Dynamic sections (R1-R5 + W1) ─────────────────────────────────
    // Sections are built lazily on first submit() via _getRoboticsExtensions().
    // No warm-up needed here — resolveToString() caches on first call.

    // ── 6. Start heartbeat ────────────────────────────────────────────────
    // Periodically touch lastActiveAt so crash-recovery on next startup
    // can detect that this session was alive recently.
    this._heartbeatTimer = setInterval(() => {
      RoboticsProjectStore.touch(this.projectDir).catch(() => undefined)
    }, RoboticsSession.HEARTBEAT_INTERVAL_MS)
    // Allow Node to exit even if the timer is still running
    if (this._heartbeatTimer.unref) this._heartbeatTimer.unref()

    // ── 6b. Start team watcher (lazy — only when team.json already exists) ──
    // Starting unconditionally would poll every 60 s even on projects that
    // never use team mode. We activate it on init/join when team.json is created.
    if (await this.teamStore.exists()) {
      this.teamWatcher.start()
    }

    // ── 7. Background: purge stale sessions + worktrees ─────────────────
    // Fire-and-forget: delete non-starred sessions idle for > 7 days.
    // Runs asynchronously so it never blocks the first submit().
    RoboticsProjectStore.purgeStale().catch(() => undefined)
    // #13: Prune worktree directories older than 7 days. These are left on
    // disk when a sub-agent completed successfully but removeWorktree() was
    // never explicitly called (e.g. after a crash or process restart).
    this.gitMgr.pruneStaleWorktrees(7 * 24 * 60 * 60_000).catch(() => undefined)

    return {
      resumed: Boolean(existing),
      sessionAgeMs: existing ? Date.now() - existing.lastActiveAt : undefined,
    }
  }

  // ── Lifecycle: dispose ────────────────────────────────────────────────────

  /**
   * Gracefully shut down the session.
   *
   * - Stops the heartbeat timer
   * - Cancels all in-flight sub-agent tasks via SubAgentBridge
   * - Force-removes all active git worktrees (data is safe on branch)
   * - Purges active task records from RoboticsProjectStore
   *
   * Safe to call multiple times (idempotent).
   * Called automatically by the CLI on SIGINT / SIGTERM / uncaughtException.
   */
  async dispose(): Promise<void> {
    if (this._disposed) return
    this._disposed = true

    // Stop heartbeat
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer)
      this._heartbeatTimer = null
    }
    this.teamWatcher.stop()

    // Cancel running sub-agents
    try {
      await this.bridge.cancelAll()
    } catch { /* best-effort */ }

    // Clean up active worktrees and purge state records
    const state = this._state
    if (state && state.activeSubAgentTasks.length > 0) {
      await Promise.allSettled(
        state.activeSubAgentTasks.map(async task => {
          // Remove worktree (keep branch for post-mortem)
          if (task.worktreePath) {
            await this.gitMgr.removeWorktree(
              task.taskId,
              { deleteBranch: false },
            ).catch(() => undefined)
          }
          await RoboticsProjectStore.purgeStaleSubAgentTask(this.projectDir, task.taskId)
        }),
      )
    }

    this.bridge.destroy()
  }

  // ── SessionImpl interface ─────────────────────────────────────────────────

  async *submit(prompt: string): AsyncGenerator<MetaAgentEvent> {
    // #11: Friendlier reentrancy check at the RoboticsSession level.
    if (this._submitInFlight) {
      throw new Error(
        '[RoboticsSession] Cannot submit a new prompt while the current robotics turn is still in progress. ' +
        'Wait for the ongoing turn (tool loop + response) to complete before calling submit() again.',
      )
    }
    this._submitInFlight = true

    // ── First submit only: classify agent mode ────────────────────────────────
    if (!this._modeClassified) {
      await this._classifyAgentMode(prompt)
    }

    // ── Stable system prompt (memoized sections) ──────────────────────────────
    // Only R1 (domain identity), R4 (hardware profile), W1 (workflow phase if
    // present), and the team section go here — all are memoized and change at
    // most once per session (on mode classification, hardware write, workflow
    // advance, or team operation).  Keeping these sections stable is what lets
    // DeepSeek cache the entire conversation history prefix across turns.
    const stableSections = buildDynamicSections({
      mode:           'robotics',
      modeExtensions: this._getStableRoboticsExtensions(),
      sessionId:      this.sessionId,
      sessionStartMs: this._sessionStartMs,
      projectDir:     this.projectDir,
      // currentQuery / subAgentBridge intentionally omitted — those drive
      // D1b and D11 which are now in the volatile user prefix below.
    })
    const stablePrompt = await this.sectionRegistry.resolveToString(stableSections)
    this._lastSystemPrompt = stablePrompt

    // Only update inner session's system message when content actually changed.
    if (stablePrompt !== this._lastStablePrompt) {
      this.inner.setAppendSystemPrompt(stablePrompt)
      this._lastStablePrompt = stablePrompt
    }

    // ── Volatile user-message prefix (per-turn, recomputed each turn) ────────
    // R2 (experience_index), R3 (subagent_tasks), R5 (progress_notes),
    // team_context_boundary, D1b (memory), and D11 (notifications) are resolved
    // here and prepended to the user message as XML-tagged context blocks.
    const volatileSections = buildVolatileContextSections({
      currentQuery:       prompt,
      mode:               'robotics',
      subAgentBridge:     this.bridge,
      volatileExtensions: this._getVolatileRoboticsExtensions(),
    })
    const resolvedVolatile = await this.sectionRegistry.resolve(volatileSections)
    const volatilePrefix   = formatVolatileContext(volatileSections, resolvedVolatile)

    const effectivePrompt = volatilePrefix
      ? `${volatilePrefix}\n\n---\n\n${prompt}`
      : prompt

    try {
      yield* this.inner.submit(effectivePrompt)
      // Touch persistence so lastActiveAt is current
      await RoboticsProjectStore.touch(this.projectDir).catch(() => undefined)
    } finally {
      this._submitInFlight = false
    }
  }

  registerTool(tool: MetaAgentTool): void {
    this.inner.registerTool(tool)
  }

  interrupt(): void {
    this.inner.interrupt()
  }

  getMessages(): readonly ConversationMessage[] {
    // KernelMessage is structurally compatible with ConversationMessage
    return this.inner.getMessages() as unknown as readonly ConversationMessage[]
  }

  getUsage() {
    return this.inner.getUsage()
  }

  getEstimatedCost() {
    return this.inner.getEstimatedCost()
  }

  getLastSystemPrompt(): string | null {
    return this._lastSystemPrompt
  }

  getSessionId(): string {
    return this.sessionId
  }

  async teamInit(github?: string) {
    this.sectionRegistry.invalidate('robotics_team_mode')
    const state = await this.teamStore.init(github)
    // team.json now exists — activate the watcher if it hasn't been started yet.
    this.teamWatcher.start()
    await this.teamWatcher.forceSync(false)
    return state
  }

  async teamJoin(github?: string, human?: string) {
    this.sectionRegistry.invalidate('robotics_team_mode')
    const state = await this.teamStore.join(github, human)
    // team.json now exists — activate the watcher if it hasn't been started yet.
    this.teamWatcher.start()
    await this.teamWatcher.forceSync(false)
    return state
  }

  async teamClaim(taskId: string) {
    this.sectionRegistry.invalidate('robotics_team_mode')
    const result = await this.teamStore.claim(taskId)
    await this.teamWatcher.forceSync(false)
    return result
  }

  /** Transition a claimed/backlog task to in_progress (begin active work). */
  async teamStart(taskId?: string) {
    this.sectionRegistry.invalidate('robotics_team_mode')
    const result = await this.teamStore.startTask(taskId)
    await this.teamWatcher.forceSync(false)
    return result
  }

  async teamTaskAdd(input: TeamTaskAddInput) {
    this.sectionRegistry.invalidate('robotics_team_mode')
    const result = await this.teamStore.addTask(input)
    await this.teamWatcher.forceSync(false)
    return result
  }

  async teamTaskStatus(taskId: string, status: TeamTaskStatus) {
    this.sectionRegistry.invalidate('robotics_team_mode')
    const result = await this.teamStore.updateTaskStatus(taskId, status)
    await this.teamWatcher.forceSync(false)
    return result
  }

  async teamModuleAdd(input: TeamModuleAddInput) {
    this.sectionRegistry.invalidate('robotics_team_mode')
    const result = await this.teamStore.addModule(input)
    await this.teamWatcher.forceSync(false)
    return result
  }

  async teamModuleOwner(name: string, ownerUnit?: string) {
    this.sectionRegistry.invalidate('robotics_team_mode')
    const result = await this.teamStore.setModuleOwner(name, ownerUnit)
    await this.teamWatcher.forceSync(false)
    return result
  }

  async teamCheck() {
    return this.teamStore.checkWorkspaceConflicts()
  }

  async teamCheckPaths(paths: string[]) {
    return this.teamStore.checkPathsConflicts(paths)
  }

  async teamBranch(taskId?: string) {
    this.sectionRegistry.invalidate('robotics_team_mode')
    const result = await this.teamStore.branchForTask(taskId)
    await this.teamWatcher.forceSync(false)
    return result
  }

  async teamPush() {
    return this.teamStore.pushCurrentBranch()
  }

  async teamPr(taskId?: string) {
    return this.teamStore.createPrDraft(taskId)
  }

  async teamHandoff(taskId?: string, note?: string) {
    this.sectionRegistry.invalidate('robotics_team_mode')
    const result = await this.teamStore.createHandoff(taskId, note)
    await this.teamWatcher.forceSync(false)
    return result
  }

  async teamOnboarding() {
    return this.teamStore.onboardingSummary()
  }

  async teamGitHubIssuesSync(taskId?: string) {
    this.sectionRegistry.invalidate('robotics_team_mode')
    const result = await this.teamStore.syncGitHubIssues(taskId)
    await this.teamWatcher.forceSync(false)
    return result
  }

  async teamGitHubProjectAdd(projectNumber: string, owner?: string) {
    return this.teamStore.addGitHubIssuesToProject(projectNumber, owner)
  }

  async teamStatus() {
    return this.teamStore.status()
  }

  async teamSync(): Promise<TeamSyncSummary> {
    this.sectionRegistry.invalidate('robotics_team_mode')
    const summary = await this.teamStore.sync()
    await this.teamWatcher.forceSync(false)
    return summary
  }

  async teamPull() {
    this.sectionRegistry.invalidate('robotics_team_mode')
    const result = await this.teamStore.pullRemoteTeam()
    await this.teamWatcher.forceSync(false)
    return result
  }

  async teamConflicts() {
    return this.teamStore.detectMergeConflicts()
  }

  async teamResolveTeamJson() {
    this.sectionRegistry.invalidate('robotics_team_mode')
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
      this._teamContextBoundary = `[任务背景] 此 session 创建 ${taskId} 之前的对话，是本任务的直接起源。AI 可将其作为背景参考，但不应将其内容描述为"当前任务的工作进展"。`
    } else {
      this._teamContextBoundary = `[边界提示] ${taskId} 于此刻新建，以上对话内容与本任务无关，请不要将其归因为本任务的工作记录或进展。`
    }
    this.sectionRegistry.invalidate('team_context_boundary')
  }

  async teamWatcherPoll(): Promise<TeamWatcherEvent[]> {
    await this.teamWatcher.forceSync(true)
    return this.teamWatcher.getRecentEvents()
  }

  teamWatcherEvents(): TeamWatcherEvent[] {
    return this.teamWatcher.getRecentEvents()
  }

  /**
   * @deprecated Use dispose() for full cleanup (heartbeat, watcher, worktrees, bridge).
   * This alias remains for backward compatibility and now delegates to dispose().
   */
  destroy(): void {
    void this.dispose()
  }

  // ── Private ───────────────────────────────────────────────────────────────

  /**
   * Stable robotics extensions — injected into the system message via
   * buildDynamicSections({ modeExtensions }).
   *
   * All sections here must be memoized (systemPromptSection) so that the
   * system message stays byte-identical across turns, preserving the DeepSeek
   * KV cache prefix.  Sections that change at most once per session (on mode
   * classification, hardware write, workflow advance, team operations) are
   * acceptable here — their infrequent invalidations are expected.
   *
   * Contents:
   *   W1  workflow_phase     — memoized, invalidated on workflow_advance
   *   R1  robotics_domain    — memoized, invalidated on mode classification (once)
   *   team section           — memoized, invalidated on team operations
   *   R4  hardware_profile   — memoized, rarely changes
   */
  private _getStableRoboticsExtensions() {
    const sections = [
      buildR1Section(this.robot, () => this._agentMode),
      buildTeamSection(this.teamStore, this.teamWatcher),
      buildR4Section(this.hwProfile, this.robot),
    ]

    // W1 goes first when a workflow is loaded (it provides the most critical context)
    if (this._workflowDef) {
      const w1 = buildW1Section(this._workflowDef, () => this._workflowState)
      return [w1, ...sections]
    }

    return sections
  }

  /**
   * Volatile robotics extensions — injected into the user message prefix via
   * buildVolatileContextSections({ volatileExtensions }).
   *
   * These sections change frequently (every turn or on tool calls) and must
   * stay out of the system message to avoid invalidating the DeepSeek KV cache.
   *
   * Contents:
   *   R2  experience_index      — recomputed each turn (disk read)
   *   R3  subagent_tasks        — recomputed each turn (bridge + git query)
   *   R5  progress_notes        — recomputed each turn (state read)
   *   team_context_boundary     — fixed content once set, but must appear every turn
   */
  private _getVolatileRoboticsExtensions() {
    const sections = [
      buildR2Section(this.store),
      buildR3Section(this.bridge, this.gitMgr, () => this._state),
      buildR5Section(() => this._state, this._resumedAt),
    ]

    // Plan B: context boundary — prepend before other volatile sections so
    // the model reads the task scope immediately after <context>.
    if (this._teamContextBoundary) {
      const boundary = this._teamContextBoundary
      sections.unshift(DANGEROUS_uncachedSystemPromptSection(
        'team_context_boundary',
        () => boundary,
        'Boundary message is written once on task claim and must appear on every subsequent turn.',
      ))
    }

    return sections
  }

  /**
   * @deprecated Use _getStableRoboticsExtensions() + _getVolatileRoboticsExtensions()
   * to separate system-message sections from user-prefix sections.
   * Kept for backward compatibility; returns all sections combined.
   */
  private _getRoboticsExtensions() {
    return [
      ...this._getStableRoboticsExtensions(),
      ...this._getVolatileRoboticsExtensions(),
    ]
  }

  // ── Agent mode classification ─────────────────────────────────────────────

  /**
   * Classify whether this session should use single-agent or multi-agent mode.
   *
   * Uses a one-shot flash model call (~300–500 ms, ~$0.00012) with:
   *   - The user's first prompt
   *   - Robot name (if known)
   *   - AGENT.md content (if present, from D1c)
   *   - Existing experience count (signals project maturity)
   *
   * On any error or timeout, falls back to 'multi' (conservative: full capability).
   *
   * After classification:
   *   - Sets _agentMode and _modeClassified
   *   - Invalidates the R1 section cache so next resolveToString() renders
   *     the correct single/multi variant, then memoizes it for all future turns
   *   - Persists the mode to project state for session resumption
   */
  private async _classifyAgentMode(firstPrompt: string): Promise<void> {
    this._modeClassified = true  // set first to prevent re-entry on any error path

    try {
      // Resolve provider from the session config
      const sessionConfig = (this.inner as unknown as { _config?: MetaAgentConfig })._config
      const { apiKey, baseURL } = detectProvider(sessionConfig ?? {})

      if (!apiKey) {
        // No API key available for side-call; keep default 'multi'
        return
      }

      const { flashModel } = detectProvider(sessionConfig ?? {})
      const client = new Anthropic({ apiKey, baseURL })

      // Build context snippets for the classifier
      const robotLine = this.robot ? `Robot/platform: ${this.robot}` : 'Robot/platform: unknown'
      const expCount = (await this.store.listIds()).length
      const expLine = `Existing experiences in store: ${expCount}`

      // Include AGENT.md content if available (first 800 chars is enough signal)
      let agentMdLine = 'AGENT.md: not found'
      try {
        const raw = WorkflowLoader.loadRaw(this.projectDir)
        if (raw) {
          agentMdLine = `AGENT.md (first 800 chars):\n${raw.slice(0, 800)}`
        }
      } catch { /* ignore */ }

      const systemPrompt = `\
You are deciding whether a robotics development task requires multi-agent orchestration.

single — Direct implementation, quick script, simple fix, single focused experiment,
         or tasks completable in under 5 minutes. No need for parallel work or git
         branch isolation. Sub-agent overhead would outweigh any benefit.

multi  — Complex algorithm development, multiple parallel experiments, hypothesis
         comparison, long-running simulations (>5 min), paper search + implementation
         + validation pipeline, or tasks that benefit from isolated git branches.

When uncertain, prefer single (lower cost and latency).

Reply with exactly one word: single or multi`

      const userContent = [
        robotLine,
        expLine,
        agentMdLine,
        `User's first message:\n${firstPrompt.slice(0, 600)}`,
      ].join('\n\n')

      // 5 s timeout — mode classification is on the critical path to first API call
      let timer: ReturnType<typeof setTimeout>
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('mode classification timed out')), 5_000)
      })

      const msg = await Promise.race([
        client.messages.create({
          model: flashModel,
          max_tokens: 5,
          system: systemPrompt,
          messages: [{ role: 'user', content: userContent }],
        }),
        timeout,
      ]).finally(() => {
        clearTimeout(timer!)
      })

      const firstBlock = (msg as Anthropic.Message).content[0]
      const raw = firstBlock?.type === 'text'
        ? (firstBlock as Anthropic.TextBlock).text.trim().toLowerCase()
        : ''

      const classified: RoboticsAgentMode = raw === 'single' ? 'single' : 'multi'
      this._agentMode = classified

      // Invalidate R1 cache so next resolveToString() picks up the correct mode
      this.sectionRegistry.invalidate('robotics_domain')

      // Persist to project state
      if (this._state) {
        this._state.agentMode = classified
        await RoboticsProjectStore.save(this._state).catch(() => undefined)
      }
    } catch {
      // Network error, timeout, missing key — keep default 'multi' silently
    }
  }
}
