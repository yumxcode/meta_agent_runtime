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
 *   - WorkflowLoader.loadWithRepair('robotics', projectDir) finds explicit workflow
 *     files or <META-WORKFLOW> blocks in AGENT.md
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

import { createHash, randomUUID } from 'crypto'
import type { ConversationMessage, MetaAgentEvent, MetaAgentTool } from '../core/types.js'
import { AgenticSession } from '../modes/AgenticSession.js'
import type { MetaAgentConfig } from '../core/config.js'
import { buildStaticSystemPrompt } from '../core/staticPrompt.js'
import { SectionRegistry, DANGEROUS_uncachedSystemPromptSection } from '../core/systemPromptSections.js'
import { SubAgentBridge } from '../subagent/SubAgentBridge.js'
import { ExperienceStore } from './ExperienceStore.js'
import { ExperiencePendingStore } from './ExperiencePendingStore.js'
import { PhysicalAnchorStore } from './PhysicalAnchorStore.js'
import { PhysicalAnchorPendingStore } from './PhysicalAnchorPendingStore.js'
import { PhysicalAnchorSource } from '../context/sources/PhysicalAnchorSource.js'
import { PrincipleStore } from './PrincipleStore.js'
import { PrinciplePendingStore } from './PrinciplePendingStore.js'
import { proposePrincipleFromExperience } from './PrinciplePromotion.js'
import { HardwareProfile } from './HardwareProfile.js'
import { GitWorkspaceManager } from './git/GitWorkspaceManager.js'
import { RoboticsProjectStore } from './persistence/RoboticsProjectStore.js'
import { ContextPager } from '../context/ContextPager.js'
import { estimateTokens } from '../context/TokenEstimator.js'
import { ExperienceSource } from '../context/sources/ExperienceSource.js'
import { createRoboticsRuntimeContext } from './runtimeContext.js'
import type { QueryAnalyzer, QueryIntent } from '../context/QueryAnalyzer.js'
import type { ExperienceMatch } from '../context/sources/IKnowledgeSource.js'
import type { RoboticsAgentMode, RoboticsProjectState } from './types.js'
import { buildR1Section, buildR2Section, buildR3Section, buildR4Section, buildR5Section, buildR6Section } from './dynamicSections.js'
import { buildRoboticsCompactInstructions } from './compactInstructions.js'
import {
  buildDynamicSections,
  buildVolatileContextSections,
  formatVolatileContext,
} from '../core/dynamicPrompt.js'
import { createRoboticsTools } from './tools/index.js'
import { createFsTools } from '../tools/fs/index.js'
import { createBashTool } from '../tools/shell/bash/index.js'
import { createSkillTool } from '../tools/system/skill/index.js'
import { makeGetSubAgentStatusTool } from '../subagent/tools/get_sub_agent_status.js'
import { WorkflowLoader } from '../workflow/WorkflowLoader.js'
import { WorkflowStateStore } from '../workflow/WorkflowStateStore.js'
import type { WorkflowDefinition, WorkflowRepairInput, WorkflowState } from '../workflow/types.js'
import { buildW1Section } from '../workflow/dynamicSection.js'
import { createWorkflowTools } from '../workflow/tools/index.js'
import { TeamStore, type TeamNoteInput, type TeamSyncSummary, type TeamTaskAddInput, type TeamTaskStatus } from './team/TeamStore.js'
import { TeamWatcher, type TeamWatcherEvent } from './team/TeamWatcher.js'
import { buildTeamSection } from './team/dynamicSection.js'

// ── Options ───────────────────────────────────────────────────────────────────

const EXPERIENCE_SLOT_REF_RE = /\bexperience:([A-Za-z0-9_-]+)\b/g
const EXPERIENCE_ID_REF_RE = /\b(exp_[0-9a-z]+_[0-9a-f]{8})\b/g
const EXPERIENCE_TASK_SWITCH_RE = /\b(new task|switch task|different task|another task|unrelated)\b|换个|另一个|另外一个|新任务|重新开始/

const EXPERIENCE_RELEVANCE_SYSTEM = `\
You select stored robotics experiences that should be injected into the current task context.

Judge applicability by mechanism and abstract principle, not surface word overlap.
Return JSON only: {"applicable":["id1","id2"]}

Rules:
- Include only experiences that materially constrain, warn, or guide this task.
- Prefer same robot/domain/algorithm/mechanism, but allow cross-domain transfer only when the principle clearly applies.
- Exclude weakly related memories; noisy context is worse than no context.
- Return at most 6 IDs.
- If none apply, return {"applicable":[]}.`

function assistantText(message: ConversationMessage): string {
  if (message.role !== 'assistant') return ''
  return message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

function extractReferencedExperienceSlotIds(messages: readonly ConversationMessage[]): Set<string> {
  const latestAssistant = [...messages].reverse().find(m => m.role === 'assistant')
  const text = latestAssistant ? assistantText(latestAssistant) : ''
  const ids = new Set<string>()

  for (const match of text.matchAll(EXPERIENCE_SLOT_REF_RE)) {
    const id = match[1]
    if (id) ids.add(`experience:${id}`)
  }
  for (const match of text.matchAll(EXPERIENCE_ID_REF_RE)) {
    const id = match[1]
    if (id) ids.add(`experience:${id}`)
  }

  return ids
}

function normalizeExperienceKeyword(keyword: string): string | null {
  const normalized = keyword.trim().toLowerCase()
  if (normalized.length < 3) return null
  return normalized
}

function formatExperienceCandidate(e: ExperienceMatch): string {
  return [
    `ID: ${e.id}`,
    `Domain: ${e.domain}`,
    `Outcome: ${e.outcome}`,
    `Confidence: ${e.confidenceTier ?? 'observed'} (${e.observationCount ?? 1} obs, ${e.contradictionCount ?? 0} contradictions)`,
    `Title: ${e.title}`,
    `Principle: ${e.abstractPrinciple}`,
    ...(e.failureReason ? [`Failure: ${e.failureReason.slice(0, 160)}`] : []),
    ...(e.workarounds?.length ? [`Workaround: ${e.workarounds[0]}`] : []),
  ].join('\n')
}

function parseApplicableExperienceIds(raw: string, candidates: ExperienceMatch[]): Set<string> {
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return new Set()
    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>
    const validIds = new Set(candidates.map(c => c.id))
    const ids = Array.isArray(parsed['applicable'])
      ? parsed['applicable'].filter((id): id is string => typeof id === 'string' && validIds.has(id))
      : []
    return new Set(ids.slice(0, 6))
  } catch {
    return new Set()
  }
}

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
  /**
   * Called when the flash classifier determines that multi-agent orchestration
   * would benefit the task.  The caller (e.g. CLI) should present a confirmation
   * prompt and return true to allow escalation, or false to stay in single mode.
   *
   * @param reason  Human-readable explanation of why multi-agent was suggested.
   *
   * When not provided, escalation is silently denied — the session stays in
   * single-agent mode even if the flash model recommends multi.
   */
  onEscalationRequest?: (reason: string) => Promise<boolean>
  /**
   * Whether this session was explicitly resumed by the user (e.g. via --resume or
   * the session picker).  When true, R5 will show the resume banner and previous
   * progress notes.  When false (default), prior project state is loaded for
   * continuity (git state, agent mode) but R5 is suppressed — the user started
   * a fresh conversation in the same workspace.
   */
  explicitResume?: boolean
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
  private readonly physicalAnchors: PhysicalAnchorStore
  /** Session-scoped pending physical anchor buffer. Exposed for CLI /anchor review. */
  readonly pendingPhysicalAnchors: PhysicalAnchorPendingStore
  private readonly principles: PrincipleStore
  /** Session-scoped pending principle buffer. Exposed for CLI /principle review. */
  readonly pendingPrinciples: PrinciplePendingStore
  private readonly anchorSource: PhysicalAnchorSource
  private readonly hwProfile: HardwareProfile
  private readonly gitMgr: GitWorkspaceManager
  private readonly teamStore: TeamStore
  private readonly teamWatcher: TeamWatcher
  private readonly projectDir: string
  private readonly robot: string | undefined
  private readonly _userAppendPrompt: string
  private readonly sectionRegistry = new SectionRegistry()
  /** Demand-paged knowledge context manager */
  private readonly contextPager: ContextPager
  /** Knowledge source for proactive failure pre-loading during reasoning phase */
  private readonly experienceSource: ExperienceSource
  /** Flash-model intent analyzer for pre-loading relevant context */
  private queryAnalyzer: QueryAnalyzer | null = null
  /** Shared FlashClient — passed to tools that need flash (e.g. experience_write) */
  private _flashClient: import('../core/flash/FlashClient.js').FlashClient | null = null
  /** Explicit caller override; undefined means 'auto' (classify on first submit). */
  private readonly _modeOverride: RoboticsAgentMode | undefined
  /** Callback to ask the user whether to escalate to multi-agent mode. */
  private readonly _onEscalationRequest: ((reason: string) => Promise<boolean>) | undefined

  private _state: RoboticsProjectState | null = null
  private _resumedAt: number | null = null
  private _workflowDef: WorkflowDefinition | null = null
  private _workflowState: WorkflowState | null = null
  private _experienceWorkingSet: ExperienceMatch[] = []
  private _experienceWorkingSetDomains = new Set<string>()
  private _experienceWorkingSetKeywords = new Set<string>()
  /** Resolved agent mode. Starts as 'single'; upgraded to 'multi' only on user confirmation. */
  private _agentMode: RoboticsAgentMode = 'single'
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

  /** Whether the caller explicitly resumed this session (controls R5 visibility). */
  private readonly _explicitResume: boolean

  /**
   * The sessionId used for all RoboticsProjectStore reads/writes.
   *
   * Fresh session  → equals this.sessionId (new UUID, new isolated state file).
   * Resumed session → equals the original session's sessionId so progress notes
   *                   accumulate in the same bucket rather than starting fresh.
   *
   * Set during init() once we know whether we are resuming.
   */
  private _storeSessionId: string = ''

  constructor(config: RoboticsSessionOptions = {}) {
    this.sessionId = randomUUID()
    this.robot = config.robot
    this.projectDir = config.projectDir ?? process.cwd()
    this._userAppendPrompt = config.appendSystemPrompt ?? ''
    this._explicitResume = config.explicitResume ?? false
    this._onEscalationRequest = config.onEscalationRequest
    this._modeOverride = config.agentMode === 'auto' || config.agentMode == null
      ? undefined
      : config.agentMode

    // Infrastructure — must be created before runtimeContext (which depends on
    // store, hwProfile) and before inner (which receives runtimeContext).
    this.store = new ExperienceStore()
    this.experienceSource = new ExperienceSource(this.store)
    this.pendingExperiences = new ExperiencePendingStore(this.projectDir)
    this.physicalAnchors = new PhysicalAnchorStore()
    this.pendingPhysicalAnchors = new PhysicalAnchorPendingStore(this.projectDir)
    this.principles = new PrincipleStore()
    this.pendingPrinciples = new PrinciplePendingStore(this.projectDir)
    this.anchorSource = new PhysicalAnchorSource(this.physicalAnchors)
    this.hwProfile = new HardwareProfile(undefined, this.robot)
    this.gitMgr = new GitWorkspaceManager(this.projectDir)
    this.teamStore = new TeamStore(this.projectDir)
    this.teamWatcher = new TeamWatcher(this.teamStore)
    this.bridge = new SubAgentBridge(this.sessionId)

    // Context pager — initialise before runtimeContext so hooks can reference it
    this.contextPager = new ContextPager({ maxBudget: 1500 })

    // Build robotics runtime context (VV hooks + QueryAnalyzer share one FlashClient).
    // Must happen before inner so runtimeContext can be wired into AgenticSession.
    const rtxResult = createRoboticsRuntimeContext({
      sessionId:       this.sessionId,
      config,
      experienceStore: this.store,
      contextPager:    this.contextPager,
    })
    this.queryAnalyzer = rtxResult.queryAnalyzer
    this._flashClient = rtxResult.flashClient

    // Build inner session using AgenticSession directly — skips MetaAgentSession's
    // D-section assembly, which is superseded by the R1-R5 sections injected below.
    //
    // System prompt layout:
    //   systemPrompt       = buildStaticSystemPrompt() (S1-S6, stable → prompt-cacheable)
    //   appendSystemPrompt = R1-R5 (+ W1) sections, rebuilt per submit
    //
    // Pin sessionId so debug file paths and store entries align with getSessionId().
    // Pass runtimeContext to wire the VV hook chain into tool instrumentation.
    this.inner = new AgenticSession({
      ...config,
      sessionId:      this.sessionId,              // ← align inner UUID with outer
      systemPrompt:   buildStaticSystemPrompt('robotics'), // base static context (S1-S6, robotics-trimmed)
      robot:          undefined,                    // not a MetaAgentConfig field
      projectDir:     this.projectDir,
      agentMode:      undefined,
      runtimeContext: rtxResult.runtimeContext,     // ← wire VV pipeline (HardwareSafety + FailurePattern + OOM + Physics)
    } as MetaAgentConfig)
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
    await Promise.all([
      this.pendingExperiences.load(),
      this.pendingPhysicalAnchors.load(),
      this.pendingPrinciples.load(),
    ])

    // ── 1. Persistence: try to restore project state ─────────────────────
    //
    // Resume path: findLatestByProjectDir() locates the most recently active
    // session for this workspace.  _storeSessionId is set to that session's
    // original UUID so all subsequent store writes go to the same bucket —
    // progress notes accumulate there and are never mixed with other sessions.
    //
    // Fresh path: a brand-new state file is created under this.sessionId,
    // ensuring complete isolation from any prior sessions in this workspace.
    const existing = this._explicitResume
      ? await RoboticsProjectStore.findLatestByProjectDir(this.projectDir)
      : null

    if (existing) {
      this._state = existing
      // _storeSessionId = the resumed session's original UUID (not this.sessionId)
      this._storeSessionId = existing.sessionId
      // R5 resume banner + progress notes shown only on explicit --resume
      this._resumedAt = existing.lastActiveAt
      await RoboticsProjectStore.touch(this.projectDir, this._storeSessionId)

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
          await RoboticsProjectStore.purgeStaleSubAgentTask(
            this.projectDir, this._storeSessionId, task.taskId,
          )
        }
      }

      // ── Reconcile worktrees still on disk ────────────────────────────────
      // staleIds = tasks whose worktree/branch no longer exists — purge them.
      const staleIds = await this.gitMgr.reconcileWorktrees(existing.git)
      if (staleIds.length > 0) {
        for (const id of staleIds) {
          await RoboticsProjectStore.purgeStaleSubAgentTask(this.projectDir, this._storeSessionId, id)
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
      // Fresh session — new isolated state file under this.sessionId
      this._storeSessionId = this.sessionId
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

    // ── 2. Workflow: explicit opt-in only ─────────────────────────────────
    // Plain AGENT.md is soft control only. The workflow state machine activates
    // only from .meta-agent/workflows/<mode>.md or a <META-WORKFLOW> block in
    // AGENT.md. If the block exists but is not parseable, a flash side-call may
    // repair it into the canonical phase/gate format.
    const wfDef = await WorkflowLoader.loadWithRepair(
      'robotics',
      this.projectDir,
      this._flashClient ? input => this._repairWorkflowDefinition(input) : undefined,
    )
    if (wfDef) {
      this._workflowDef = wfDef
      const existingWfState = await WorkflowStateStore.readCompatible(this.projectDir, wfDef)
      this._workflowState = existingWfState
        ?? await WorkflowStateStore.initialize(this.projectDir, wfDef)
    }

    // ── 3. Register robotics tools ────────────────────────────────────────
    const roboticsTools = createRoboticsTools({
      bridge: this.bridge,
      projectDir: this.projectDir,
      sessionId: this._storeSessionId,
      robot: this.robot,
      experienceStore: this.store,
      experiencePendingStore: this.pendingExperiences,
      hardwareProfile: this.hwProfile,
      physicalAnchorStore: this.physicalAnchors,
      physicalAnchorPendingStore: this.pendingPhysicalAnchors,
      principleStore: this.principles,
      principlePendingStore: this.pendingPrinciples,
      gitManager: this.gitMgr,
      flashClient: this._flashClient ?? undefined,
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
    // Skill tool — gives the robotics agent access to user-defined skills under
    // ~/.meta-agent/skills/robotics/ and <projectDir>/.meta-agent/skills/
    this.inner.registerTool(await createSkillTool(this.projectDir, 'robotics'))

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
      RoboticsProjectStore.touch(this.projectDir, this._storeSessionId).catch(() => undefined)
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

  async proposePrincipleForExperience(
    experienceId: string,
    reason: 'confidence_threshold' | 'explicit_user_request',
  ): Promise<Awaited<ReturnType<typeof proposePrincipleFromExperience>>> {
    return proposePrincipleFromExperience({
      experienceId,
      experienceStore: this.store,
      anchorStore: this.physicalAnchors,
      pendingStore: this.pendingPrinciples,
      flash: this._flashClient,
      reason,
    })
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
          await RoboticsProjectStore.purgeStaleSubAgentTask(this.projectDir, this._storeSessionId, task.taskId)
        }),
      )
    }

    this.bridge.destroy()

    // Post-session physical anchor extraction (best-effort, ≤8 s).
    // Use the flash model to scan the conversation for stable physical/device
    // facts that should be preserved as anchors.  Results go into the pending
    // queue — nothing is committed until the user runs /anchor review.
    await this._extractAnchorsPostSession().catch(() => undefined)
  }

  /**
   * After the session ends, send the conversation transcript to the flash
   * model and ask it to identify concrete physical/hardware/physics facts that
   * warrant a PhysicalAnchor entry.  Each candidate is added to the pending
   * store for human review — it is never auto-committed.
   *
   * Silently skipped when:
   *   - no FlashClient is available
   *   - fewer than 3 conversation turns (not enough context)
   *   - flash call times out or fails
   */
  private async _extractAnchorsPostSession(): Promise<void> {
    if (!this._flashClient) return
    const messages = this.inner.getMessages()
    // Need at least a few turns of real work before extraction is meaningful
    if (messages.length < 6) return

    // Build a condensed transcript (assistant text only, capped to avoid token bloat)
    const TURN_LIMIT = 12
    const assistantTurns = messages
      .filter(m => m.role === 'assistant')
      .slice(-TURN_LIMIT)
      .map(m => {
        const text = typeof m.content === 'string'
          ? m.content
          : (m.content as Array<{ type: string; text?: string }>)
              .filter(b => b.type === 'text')
              .map(b => b.text ?? '')
              .join(' ')
        return text.slice(0, 400)
      })
      .join('\n---\n')

    if (!assistantTurns.trim()) return

    const systemPrompt =
      'You are a physical-anchor extractor for a robotics AI system. ' +
      'Physical anchors are stable, factual, non-obvious facts about hardware, physics, or device behavior ' +
      'that an LLM might ignore or get wrong without explicit grounding. ' +
      'Good anchors: measured limits, datasheet constraints, observed failure modes, motor/sensor quirks, ROS driver bugs, ' +
      'calibration drift, physical deadbands, thermal effects. ' +
      'Bad anchors: general robotics knowledge, algorithm descriptions, obvious physics, user opinions.\n\n' +
      'Respond with a JSON array (may be empty []) of candidates, each: ' +
      '{"domain":"<one of: motion_planning,perception,manipulation,locomotion,navigation,simulation,hardware_interface,deployment,calibration,general>",' +
      '"scope":"<global|robot|code>",' +
      '"title":"<≤80 chars>",' +
      '"fact":"<concrete fact ≤400 chars>",' +
      '"implication":"<operational implication ≤300 chars>",' +
      '"confidence_tier":"<observed|reproduced|derived|reported|hypothesis>",' +
      '"tags":["tag1","tag2"]}. ' +
      'Output JSON only, no markdown, no prose.'

    const userMsg =
      `Session transcript (recent assistant turns):\n\n${assistantTurns}\n\n` +
      'Identify up to 5 physical/hardware facts from this transcript that warrant anchoring. ' +
      'If none qualify, return [].'

    let raw: string | null = null
    try {
      raw = await this._flashClient.query({
        system: systemPrompt,
        user: userMsg,
        maxTokens: 800,
        timeoutMs: 8_000,
      })
    } catch { return }

    if (!raw) return

    let candidates: unknown[]
    try {
      // Strip markdown fences if present
      const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
      candidates = JSON.parse(cleaned)
      if (!Array.isArray(candidates)) return
    } catch { return }

    for (const c of candidates.slice(0, 5)) {
      if (typeof c === 'object' && c !== null) {
        this.pendingPhysicalAnchors.add(c as Record<string, unknown>)
      }
    }

    await this.pendingPhysicalAnchors.flush().catch(() => undefined)
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

    // ── QueryAnalyzer: fire in parallel with stable section building ──────────
    // Heuristic + flash-model intent analysis (3 s timeout built in). Result
    // drives proactive context pre-loading before the first tool call this turn.
    const queryIntentPromise = this.queryAnalyzer
      ? this.queryAnalyzer.analyze(prompt).catch(() => null)
      : Promise.resolve(null)

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
    const fullStablePrompt = [stablePrompt, this._userAppendPrompt].filter(Boolean).join('\n\n')
    this._lastSystemPrompt = fullStablePrompt

    // Only update inner session's system message when content actually changed.
    if (fullStablePrompt !== this._lastStablePrompt) {
      this.inner.setAppendSystemPrompt(fullStablePrompt)
      this._lastStablePrompt = fullStablePrompt
    }

    // ── Await QueryAnalyzer, pre-load intent-driven context ──────────────────
    // Resolves concurrently with stable section rendering; must complete before
    // volatile section build so any pre-loaded pager slots appear in R2 this turn.
    const intent = await queryIntentPromise

    await this._preloadExperienceWorkingSet(prompt, intent)

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
      await RoboticsProjectStore.touch(this.projectDir, this._storeSessionId).catch(() => undefined)
    } finally {
      this._submitInFlight = false
      // Age TTL counters and evict expired context slots after each completed turn
      this.contextPager.tick(extractReferencedExperienceSlotIds(this.getMessages()))
    }
  }

  registerTool(tool: MetaAgentTool): void {
    this.inner.registerTool(tool)
  }

  interrupt(): void {
    this.inner.interrupt()
  }

  /** Inject a mid-turn user correction. See KernelSession.steer(). */
  steer(text: string): boolean {
    return this.inner.steer(text)
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

  private async _preloadExperienceWorkingSet(prompt: string, intent: QueryIntent | null): Promise<void> {
    if (!intent) return

    const domains = intent.domains.filter(d => d !== 'general')
    const keywords = intent.searchKeywords
      .map(normalizeExperienceKeyword)
      .filter((kw): kw is string => Boolean(kw))
      .slice(0, 8)

    if (domains.length === 0 && keywords.length === 0) return

    const shouldRefresh = this._shouldRefreshExperienceWorkingSet(prompt, domains, keywords)
    if (!shouldRefresh) {
      this._refreshExperienceSlots(this._experienceWorkingSet)
      return
    }

    try {
      const candidates = await this.experienceSource.listExperiences({
        domains: domains.length > 0 ? domains : undefined,
        keywords,
        limit: 18,
      })
      const selected = await this._selectApplicableExperiences(prompt, intent, candidates)
      this._experienceWorkingSet = selected
      this._experienceWorkingSetDomains = new Set(domains)
      this._experienceWorkingSetKeywords = new Set(keywords)
      this._refreshExperienceSlots(selected)
    } catch {
      // Experience preload is opportunistic; failures should not block the turn.
    }
  }

  private _shouldRefreshExperienceWorkingSet(
    prompt: string,
    domains: string[],
    keywords: string[],
  ): boolean {
    if (this._experienceWorkingSetDomains.size === 0 && this._experienceWorkingSetKeywords.size === 0) {
      return true
    }

    const domainOverlap = domains.some(d => this._experienceWorkingSetDomains.has(d))
    if (domains.length > 0 && this._experienceWorkingSetDomains.size > 0 && !domainOverlap) {
      return true
    }

    const taskSwitch = EXPERIENCE_TASK_SWITCH_RE.test(prompt.toLowerCase())
    if (!taskSwitch) return false

    const keywordOverlap = keywords.some(kw => this._experienceWorkingSetKeywords.has(kw))
    return keywords.length > 0 && this._experienceWorkingSetKeywords.size > 0 && !keywordOverlap
  }

  private async _selectApplicableExperiences(
    prompt: string,
    intent: QueryIntent,
    candidates: ExperienceMatch[],
  ): Promise<ExperienceMatch[]> {
    if (candidates.length === 0) return []

    if (!this._flashClient) {
      return candidates
        .filter(e => e.confidenceTier !== 'hypothesis')
        .slice(0, 4)
    }

    const raw = await this._flashClient.query({
      system: EXPERIENCE_RELEVANCE_SYSTEM,
      user: [
        `User task:\n${prompt.slice(0, 800)}`,
        `Intent: ${intent.intent}; risk=${intent.riskLevel}; domains=${intent.domains.join(', ')}`,
        `Search keywords: ${intent.searchKeywords.join(', ')}`,
        `Candidate experiences:\n${candidates.map(formatExperienceCandidate).join('\n\n')}`,
      ].join('\n\n'),
      maxTokens: 220,
      timeoutMs: 4_000,
      cacheKey: `experience-working-set:${createHash('sha256')
        .update([
          prompt.slice(0, 800),
          intent.intent,
          intent.riskLevel,
          intent.domains.join(','),
          intent.searchKeywords.join(','),
          candidates.map(c => c.id).join(','),
        ].join('\n'))
        .digest('hex')}`,
    })

    if (!raw) return []
    const ids = parseApplicableExperienceIds(raw, candidates)
    return candidates.filter(c => ids.has(c.id)).slice(0, 6)
  }

  private _refreshExperienceSlots(experiences: ExperienceMatch[]): void {
    for (const e of experiences) {
      const icon = e.outcome === 'success' ? '✓' : '⚠️'
      const lines = [
        `### ${icon} Past Experience: ${e.title}`,
        `**Domain:** ${e.domain}  **Outcome:** ${e.outcome}`,
        `**Confidence:** ${e.confidenceTier ?? 'observed'}${e.observationCount ? ` (${e.observationCount} observation${e.observationCount === 1 ? '' : 's'})` : ''}`,
        `**Principle:** ${e.abstractPrinciple}`,
        ...(e.failureReason ? [`**Failure detail:** ${e.failureReason}`] : []),
        ...(e.workarounds?.length ? [`**Workarounds:** ${e.workarounds.join(' / ')}`] : []),
      ]
      const content = lines.join('\n')
      this.contextPager.checkout({
        id:       `experience:${e.id}`,
        tag:      `${icon} [EXP] ${e.title.slice(0, 40)}`,
        content,
        tokenEst: estimateTokens(content),
        priority: 'medium',
        ttlTurns: 4,
        source:   'experience',
      })
    }
  }

  async teamInit(github?: string) {
    this.sectionRegistry.invalidate('robotics_team_mode')
    const state = await this.teamStore.init(github)
    this.teamWatcher.start()
    await this.teamWatcher.forceSync(false)
    return state
  }

  async teamJoin(github?: string, human?: string) {
    this.sectionRegistry.invalidate('robotics_team_mode')
    const state = await this.teamStore.join(github, human)
    this.teamWatcher.start()
    await this.teamWatcher.forceSync(false)
    return state
  }

  async teamStatus() {
    return this.teamStore.status()
  }

  async teamTaskAdd(input: TeamTaskAddInput) {
    this.sectionRegistry.invalidate('robotics_team_mode')
    const result = await this.teamStore.addTask(input)
    await this.teamWatcher.forceSync(false)
    return result
  }

  /** Exclusively take a task; throws if owned by another unit. */
  async teamTake(taskId: string) {
    this.sectionRegistry.invalidate('robotics_team_mode')
    const result = await this.teamStore.take(taskId)
    await this.teamWatcher.forceSync(false)
    return result
  }

  /** Release a task you own (no-op if you don't own it). */
  async teamDrop(taskId?: string) {
    this.sectionRegistry.invalidate('robotics_team_mode')
    const result = await this.teamStore.drop(taskId)
    await this.teamWatcher.forceSync(false)
    return result
  }

  /** Force-take a task currently owned by someone else; records audit attempt. */
  async teamSteal(taskId: string, reason?: string) {
    this.sectionRegistry.invalidate('robotics_team_mode')
    const result = await this.teamStore.steal(taskId, reason)
    await this.teamWatcher.forceSync(false)
    return result
  }

  /** Append a single direction+outcome attempt to a task you own. */
  async teamNote(input: TeamNoteInput) {
    this.sectionRegistry.invalidate('robotics_team_mode')
    const result = await this.teamStore.note(input)
    await this.teamWatcher.forceSync(false)
    return result
  }

  async teamTaskStatus(taskId: string, status: TeamTaskStatus) {
    this.sectionRegistry.invalidate('robotics_team_mode')
    const result = await this.teamStore.updateTaskStatus(taskId, status)
    await this.teamWatcher.forceSync(false)
    return result
  }

  async teamSync(): Promise<TeamSyncSummary> {
    this.sectionRegistry.invalidate('robotics_team_mode')
    // /team sync is an explicit user request — bypass the fetch cooldown.
    const summary = await this.teamStore.sync({ forceFetch: true })
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
    // Background poll: let the TeamStore fetch cooldown decide whether a real
    // `git fetch` runs.  Passing fetch=true here only means "attempt", not
    // "force" — TeamStore.sync({fetch:true}) will no-op inside the cooldown.
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
   *   R2  experience_index        — recomputed each turn (disk read)
   *   R3  subagent_tasks          — recomputed each turn (bridge + git query)
   *   R5  progress_notes          — recomputed each turn (state read)
   *   R6  physical_anchors        — recomputed each turn (device/physics facts)
   *   R7  compact_instructions    — preserves task IDs + hardware constraints for compact agent
   *   team_context_boundary       — fixed content once set, but must appear every turn
   */
  private _getVolatileRoboticsExtensions() {
    const sections = [
      buildR2Section(this.store, this.contextPager, this.experienceSource),
      buildR3Section(this.bridge, this.gitMgr, () => this._state),
      buildR5Section(() => this._state, this._resumedAt),
      buildR6Section(this.physicalAnchors, undefined, undefined, this.robot, this.anchorSource, this.pendingPhysicalAnchors.count),
      // R7 — compact instructions: tells the KernelSession auto-compact agent what
      // robotics-specific state must survive context compaction (task IDs, hardware
      // safety constraints, current phase).  Analogous to CampaignSession's
      // buildCompactInstructions() block.
      DANGEROUS_uncachedSystemPromptSection(
        'robotics_compact_instructions',
        async () => {
          let hardwareSummary: string | null = null
          try {
            hardwareSummary = await this.hwProfile.formatForPrompt()
          } catch { /* best-effort */ }
          return buildRoboticsCompactInstructions({
            state: this._state,
            hardwareSummary,
          })
        },
        'Active task IDs and hardware constraints must stay current for the compact agent.',
      ),
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

  private async _repairWorkflowDefinition(input: WorkflowRepairInput): Promise<string | null> {
    if (!this._flashClient) return null
    const contentHash = createHash('sha256').update(input.content).digest('hex')

    return this._flashClient.query({
      system: `\
You convert user-authored META-WORKFLOW content into valid meta-agent workflow markdown.

Required output:
- Markdown only, no prose and no fenced code block.
- Include "Mode: ${input.mode}" and a Version line.
- Include at least one phase header in exactly this format:
  ## Phase: <snake_case_id> | <Chinese name> | <English name>
- Gate lines must use exactly one of:
  - [ ] REQUIRED: <description>
  - [ ] APPROVAL: <description>
  - [ ] SUGGESTED: <description>
- Preserve the user's intended phase order, gates, and constraints.
- If information is incomplete, infer the smallest useful workflow from the content.`,
      user: `Source: ${input.sourceKind} ${input.sourceFile}

META-WORKFLOW content:
${input.content.slice(0, 12000)}`,
      maxTokens: 3000,
      timeoutMs: 8_000,
      cacheKey: `workflow-repair:${input.mode}:${contentHash}`,
    })
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

    // Default is single-agent; only escalate when the flash model recommends
    // multi AND the user explicitly confirms via onEscalationRequest.
    try {
      if (!this._flashClient) {
        // No API key — stay in single-agent mode
        return
      }

      const robotLine = this.robot ? `Robot/platform: ${this.robot}` : 'Robot/platform: unknown'
      const expCount = (await this.store.listIds()).length
      const expLine = `Existing experiences in store: ${expCount}`

      let agentMdLine = 'AGENT.md: not found'
      try {
        const raw = WorkflowLoader.loadAgentDirectives(this.projectDir)
        if (raw) {
          agentMdLine = `AGENT.md (first 800 chars):\n${raw.slice(0, 800)}`
        }
      } catch { /* ignore */ }

      const systemPrompt = `\
You are deciding whether a robotics development task requires multi-agent orchestration.

single — Direct implementation, quick script, simple fix, single focused experiment,
         or tasks completable in under ~10 minutes. No need for parallel work or git
         branch isolation. Sub-agent overhead would outweigh any benefit.

multi  — Complex algorithm development, multiple parallel experiments, hypothesis
         comparison, long-running simulations (>10 min), paper search + implementation
         + validation pipeline, or tasks that genuinely benefit from isolated git branches.

Default to single unless the task clearly requires parallel sub-agents.

Reply with a JSON object: {"mode":"single"|"multi","reason":"<one sentence why>"}`

      const userContent = [
        robotLine,
        expLine,
        agentMdLine,
        `User's first message:\n${firstPrompt.slice(0, 600)}`,
      ].join('\n\n')

      const rawText = await this._flashClient.query({
        system: systemPrompt,
        user: userContent,
        maxTokens: 60,
        timeoutMs: 5_000,
        cacheKey: `robotics-agent-mode:${this.sessionId}:${firstPrompt.slice(0, 120)}`,
      }) ?? ''

      // Parse JSON response; fall back to 'single' on parse error
      let classifiedMode: RoboticsAgentMode = 'single'
      let classifiedReason = ''
      try {
        const jsonMatch = rawText.match(/\{[\s\S]*\}/)
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]) as { mode?: string; reason?: string }
          if (parsed.mode === 'multi') classifiedMode = 'multi'
          classifiedReason = parsed.reason ?? ''
        }
      } catch { /* stay single */ }

      if (classifiedMode === 'multi') {
        // Ask the user for confirmation before escalating
        const confirmed = this._onEscalationRequest
          ? await this._onEscalationRequest(classifiedReason).catch(() => false)
          : false  // no callback → silently stay single

        if (!confirmed) {
          classifiedMode = 'single'
        }
      }

      this._agentMode = classifiedMode

      // Invalidate R1 so next resolveToString() renders the correct variant
      this.sectionRegistry.invalidate('robotics_domain')

      if (this._state) {
        this._state.agentMode = classifiedMode
        // Ensure sessionId in state reflects the store session (resume case)
        this._state.sessionId = this._storeSessionId
        await RoboticsProjectStore.save(this._state).catch(() => undefined)
      }
    } catch {
      // Network error, timeout — stay in single-agent mode (safe default)
    }
  }
}
