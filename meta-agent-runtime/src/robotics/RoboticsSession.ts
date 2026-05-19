/**
 * RoboticsSession — the SessionImpl for mode='robotics'.
 *
 * Architecture (composition, not inheritance):
 *
 *   RoboticsSession
 *     ├─ inner: MetaAgentSession          ← handles the API loop, tools, memory
 *     ├─ experienceStore: ExperienceStore  ← persistent robotics knowledge base
 *     ├─ hardwareProfile: HardwareProfile  ← robot specs + safety limits
 *     ├─ gitManager: GitWorkspaceManager  ← sub-agent branch/worktree management
 *     ├─ projectStore: RoboticsProjectStore ← session persistence + progress notes
 *     └─ sectionRegistry: SectionRegistry ← R1-R5 dynamic prompt sections
 *
 * On every submit():
 *   1. First call only: classify agent mode (single vs multi) via Haiku side-call.
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
 */

import { randomUUID } from 'crypto'
import Anthropic from '@anthropic-ai/sdk'
import type { MetaAgentEvent, MetaAgentTool } from '../core/types.js'
import { MetaAgentSession } from '../core/MetaAgentSession.js'
import type { MetaAgentConfig } from '../core/config.js'
import { SectionRegistry } from '../core/systemPromptSections.js'
import { SubAgentBridge } from '../subagent/SubAgentBridge.js'
import { ExperienceStore } from './ExperienceStore.js'
import { ExperiencePendingStore } from './ExperiencePendingStore.js'
import { HardwareProfile } from './HardwareProfile.js'
import { GitWorkspaceManager } from './git/GitWorkspaceManager.js'
import { RoboticsProjectStore } from './persistence/RoboticsProjectStore.js'
import type { RoboticsAgentMode, RoboticsProjectState } from './types.js'
import { buildR1Section, buildR2Section, buildR3Section, buildR4Section, buildR5Section } from './dynamicSections.js'
import { createRoboticsTools } from './tools/index.js'
import { createFsTools } from '../tools/fs/index.js'
import { createBashTool } from '../tools/shell/bash/index.js'
import { makeGetSubAgentStatusTool } from '../subagent/tools/get_sub_agent_status.js'
import { WorkflowLoader } from '../workflow/WorkflowLoader.js'
import { WorkflowStateStore } from '../workflow/WorkflowStateStore.js'
import type { WorkflowDefinition, WorkflowState } from '../workflow/types.js'
import { buildW1Section } from '../workflow/dynamicSection.js'
import { createWorkflowTools } from '../workflow/tools/index.js'

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
   * - 'auto'   — (default) classify via Haiku on first submit() using task context.
   *
   * When set explicitly, no Haiku side-call is made.
   * Persisted to project state; resumed sessions inherit the stored mode unless
   * an explicit override is provided here.
   */
  agentMode?: RoboticsAgentMode | 'auto'
}

// ── RoboticsSession ───────────────────────────────────────────────────────────

export class RoboticsSession {
  private readonly inner: MetaAgentSession
  private readonly bridge: SubAgentBridge
  private readonly store: ExperienceStore
  /** Session-scoped pending experience buffer. Exposed so the CLI can drive review UI. */
  readonly pendingExperiences: ExperiencePendingStore = new ExperiencePendingStore()
  private readonly hwProfile: HardwareProfile
  private readonly gitMgr: GitWorkspaceManager
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

    // Build inner session (agentic mode — full tool support, no campaign sections).
    // Pin sessionId to this.sessionId so debug file paths and SessionStore entries
    // written by MetaAgentSession align with the ID exposed via getSessionId().
    this.inner = new MetaAgentSession({
      ...config,
      sessionId:   this.sessionId, // ← align inner UUID with outer
      robot:       undefined,      // not a MetaAgentConfig field; strip to avoid type errors
      projectDir:  undefined,
      agentMode:   undefined,
    } as MetaAgentConfig)

    // Infrastructure
    this.store = new ExperienceStore()
    this.hwProfile = new HardwareProfile(undefined, this.robot)
    this.gitMgr = new GitWorkspaceManager(this.projectDir)
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

    // ── 5. Register R1-R5 (+ W1 if workflow) dynamic sections ────────────
    this._buildSections()

    // ── 6. Start heartbeat ────────────────────────────────────────────────
    // Periodically touch lastActiveAt so crash-recovery on next startup
    // can detect that this session was alive recently.
    this._heartbeatTimer = setInterval(() => {
      RoboticsProjectStore.touch(this.projectDir).catch(() => undefined)
    }, RoboticsSession.HEARTBEAT_INTERVAL_MS)
    // Allow Node to exit even if the timer is still running
    if (this._heartbeatTimer.unref) this._heartbeatTimer.unref()

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
  }

  // ── SessionImpl interface ─────────────────────────────────────────────────

  async *submit(prompt: string): AsyncGenerator<MetaAgentEvent> {
    // ── First submit only: classify agent mode ────────────────────────────────
    if (!this._modeClassified) {
      await this._classifyAgentMode(prompt)
    }

    // Refresh R1-R5 every turn (volatile sections recompute; memoized ones cache)
    const roboticsPrompt = await this.sectionRegistry.resolveToString(
      this._getSections(),
    )
    this.inner.setAppendSystemPrompt(roboticsPrompt)

    yield* this.inner.submit(prompt)

    // Touch persistence so lastActiveAt is current
    await RoboticsProjectStore.touch(this.projectDir).catch(() => undefined)
  }

  registerTool(tool: MetaAgentTool): void {
    this.inner.registerTool(tool)
  }

  interrupt(): void {
    this.inner.interrupt()
  }

  getMessages() {
    return this.inner.getMessages()
  }

  getUsage() {
    return this.inner.getUsage()
  }

  getEstimatedCost() {
    return this.inner.getEstimatedCost()
  }

  getLastSystemPrompt() {
    return this.inner.getLastSystemPrompt()
  }

  getSessionId(): string {
    return this.sessionId
  }

  /**
   * Clean up resources (SubAgentBridge listeners + timers).
   * Call when the session ends to prevent memory leaks.
   */
  destroy(): void {
    this.bridge.destroy()
  }

  // ── Private ───────────────────────────────────────────────────────────────

  /** Return the ordered list of R1-R5 (+ optional W1) sections. */
  private _getSections() {
    const sections = [
      buildR1Section(this.robot, () => this._agentMode),
      buildR2Section(this.store),
      buildR3Section(
        this.bridge,
        this.gitMgr,
        () => this._state,
      ),
      buildR4Section(this.hwProfile, this.robot),
      buildR5Section(() => this._state, this._resumedAt),
    ]

    // W1 goes first when a workflow is loaded (it provides the most critical context)
    if (this._workflowDef) {
      const w1 = buildW1Section(
        this._workflowDef,
        () => this._workflowState,
      )
      return [w1, ...sections]
    }

    return sections
  }

  /**
   * Prime the SectionRegistry by resolving sections once so memoized ones
   * are warm before the first submit().
   */
  private _buildSections(): void {
    // No-op: sections are lazily resolved on first submit.
    // The registry is warmed automatically on first resolveToString() call.
  }

  // ── Agent mode classification ─────────────────────────────────────────────

  /**
   * Classify whether this session should use single-agent or multi-agent mode.
   *
   * Uses a one-shot Haiku call (~300–500 ms, ~$0.00012) with:
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
      const apiKey = (this.inner as unknown as { config?: { apiKey?: string } })
        .config?.apiKey ?? process.env['ANTHROPIC_API_KEY']

      if (!apiKey) {
        // No API key available for side-call; keep default 'multi'
        return
      }

      const client = new Anthropic({ apiKey })

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
          model: 'claude-haiku-4-5-20251001',
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
