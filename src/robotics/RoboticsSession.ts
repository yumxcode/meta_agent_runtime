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
import { evaluatePromotion, type EvaluatePromotionResult } from './PrincipleConvergence.js'
import { extractKnowledgePostSession } from './postSessionExtract.js'
import { HardwareProfile } from './HardwareProfile.js'
import { GitWorkspaceManager } from '../infra/git/GitWorkspaceManager.js'
import { RoboticsProjectStore } from './persistence/RoboticsProjectStore.js'
import { ContextPager } from '../context/ContextPager.js'
import { estimateTokens } from '../context/TokenEstimator.js'
import { ExperienceSource } from '../context/sources/ExperienceSource.js'
import { createRoboticsRuntimeContext } from './runtimeContext.js'
import type { QueryAnalyzer, QueryIntent } from '../context/QueryAnalyzer.js'
import type { ExperienceMatch } from '../context/sources/IKnowledgeSource.js'
import type { RoboticsAgentMode, RoboticsProjectState } from './types.js'
import { buildR1Section, buildR2Section, buildR3Section, buildR4Section, buildR5Section, buildR6Section, renderR4Snapshot, renderR5Snapshot } from './dynamicSections.js'
import { buildRoboticsCompactInstructions, buildRoboticsDeterministicAnchors } from './compactInstructions.js'
import {
  buildDynamicSections,
  buildVolatileContextSections,
  formatVolatileContext,
} from '../core/dynamicPrompt.js'
import { createRoboticsTools } from './tools/index.js'
import { createFsTools } from '../tools/fs/index.js'
import { createWebFetchTool } from '../tools/network/web_fetch/index.js'
import { createWebSearchTool } from '../tools/network/web_search/index.js'
import { createMcpTools } from '../tools/mcp/index.js'
import { createBashTool } from '../tools/shell/bash/index.js'
import { createSkillTool } from '../tools/system/skill/index.js'
import { createMemoryWriteTool } from '../tools/system/memory_write/index.js'
import { makeSubAgentTools } from '../subagent/tools/index.js'
import { createRunAgentTool } from '../tools/agent/run_agent/index.js'
import { WorkflowLoader } from '../workflow/WorkflowLoader.js'
import { WorkflowStateStore } from '../workflow/WorkflowStateStore.js'
import type { WorkflowDefinition, WorkflowRepairInput, WorkflowState } from '../workflow/types.js'
import { buildW1Section } from '../workflow/dynamicSection.js'
import { createWorkflowTools } from '../workflow/tools/index.js'
import { TeamStore, type TeamNoteInput, type TeamPublishState, type TeamPushResult, type TeamSyncSummary, type TeamTaskAddInput, type TeamTaskStatus } from './team/TeamStore.js'
import { TeamWatcher, type TeamWatcherEvent } from './team/TeamWatcher.js'
import { buildTeamSection } from './team/dynamicSection.js'
import { createTeamTools } from './tools/team/index.js'
import { RoboticsTeamCoordinator } from './team/RoboticsTeamCoordinator.js'
import { ExperienceWorkingSetManager } from './ExperienceWorkingSet.js'
import type { RoboticsCapabilities, RoboticsTeamController } from './contracts.js'
import { createResearchDispatchTool } from '../tools/research/research_dispatch/index.js'
import { buildResearchArtifactAnchors } from '../research/ResearchStore.js'

/**
 * Per-result budget for the MAIN agent's web_fetch. A single unbudgeted fetch
 * (≤100 KB) in the long-lived context is the noise amplifier behind the
 * compact-rework loop; full-text reading goes through research_dispatch.
 */
const MAIN_AGENT_WEB_FETCH_MAX_CHARS = 8_000

/** Join optional anchor/instruction blocks; null when none produced content. */
function composeAnchorBlocks(...blocks: Array<string | null | undefined>): string | null {
  const combined = blocks.filter(Boolean).join('\n\n')
  return combined || null
}

// ── Options ───────────────────────────────────────────────────────────────────

const SINGLE_AGENT_DEFERRED_TOOLS = new Set([
  'spawn_sub_agent',
  'experiment_dispatch',
])

const EXPERIENCE_SLOT_REF_RE = /\bexperience:([A-Za-z0-9_-]+)\b/g
const EXPERIENCE_ID_REF_RE = /\b(exp_[0-9a-z]+_[0-9a-f]{8})\b/g
// Experience candidate-selection constants, helpers and the SelectedExperience
// type moved to ./ExperienceWorkingSet.ts (ExperienceWorkingSetManager).

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
// (normalizeExperienceKeyword / formatExperienceCandidate /
//  parseApplicableExperienceIds moved to ./ExperienceWorkingSet.ts)

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
   * - 'single' — one main coordinator; serial isolated helpers are allowed.
   * - 'multi'  — full parallel orchestration (experiment_dispatch, fan-out, git).
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
  /**
   * The specific stored session to bind to when resuming. When provided (and
   * explicitResume is true), R5 / project state are loaded from THIS session's
   * bucket via findBySession() rather than the most-recently-active session in
   * the workspace (findLatestByProjectDir).  This makes R5 a session-level
   * milestone record bound to the exact session the user picked.
   */
  resumeSessionId?: string
}

// ── RoboticsSession ───────────────────────────────────────────────────────────

export class RoboticsSession implements RoboticsCapabilities {
  private readonly inner: AgenticSession
  /** Team-collaboration half of the unit (extracted out of this class). */
  private readonly teamController: RoboticsTeamCoordinator
  /** Last assembled R-section prompt, exposed for debugging. */
  private _lastSystemPrompt: string | null = null
  /**
   * Sub-agent bridge. Created in init() (NOT the constructor) so a same-process
   * re-resume of the same sessionId can first `await` disposal of any stale
   * bridge still registered under that id — the SubAgentBridge constructor
   * throws on a duplicate sessionId to prevent double-delivered notifications,
   * and disposal is async so it cannot be awaited from a constructor.
   */
  private bridge!: SubAgentBridge
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
  private readonly _domain: string | undefined
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
  /** Experience-recall engine (candidate caching + ranking + flash selection). */
  private readonly experienceWorkingSet: ExperienceWorkingSetManager
  /** Bumped on /anchor review commit; keys the memoized R6 section for incremental refresh. */
  private _anchorVersion = 0
  /** Resolved agent mode. Starts as 'single'; upgraded to 'multi' only on user confirmation. */
  private _agentMode: RoboticsAgentMode = 'single'
  /** Parallel orchestration tools hidden until a session resolves to multi-agent mode. */
  private readonly _deferredMultiAgentTools = new Map<string, MetaAgentTool>()
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
  // Plan-B context-boundary state now lives on the team coordinator
  // (this.teamController.contextBoundary).

  /** Mirrors MetaAgentSession.sessionId */
  readonly sessionId: string

  /** Heartbeat interval: 30 s. If lastActiveAt is older than 3× this, session is stale. */
  static readonly HEARTBEAT_INTERVAL_MS = 30_000
  static readonly STALE_SESSION_TTL_MS  = 3 * RoboticsSession.HEARTBEAT_INTERVAL_MS

  /** Whether the caller explicitly resumed this session (controls R5 visibility). */
  private readonly _explicitResume: boolean

  /** Specific stored session to bind to on resume (session-level R5 binding). */
  private readonly _resumeSessionId?: string

  /**
   * Frozen R5 milestone snapshot string (or null when nothing to show).
   *
   * Refreshed ONLY at session-start moments — init (create/resume) and on
   * compaction — by _refreshR5Snapshot().  Because R5 now lives in the STABLE
   * system prompt and reads from this snapshot, the system prompt changes only
   * at those moments, never every turn.
   */
  private _r5Snapshot: string | null = null

  /**
   * Frozen R4 hardware-profile snapshot string (or null).
   *
   * Refreshed ONLY at session-start moments — init (create/resume) and on
   * compaction — by _refreshR4Snapshot(), mirroring R5.  The underlying profile
   * may be written mid-session via `hardware_profile_write` (LLM) or `/hardware`
   * (user); those updates surface at the next session-start moment, and the
   * rendered section carries a staleness disclaimer.
   */
  private _r4Snapshot: string | null = null

  /**
   * Cached raw hardware summary (the unrendered `hwProfile.formatForPrompt()`
   * output), refreshed alongside _r4Snapshot at session-start moments.
   *
   * Used by the compact-instructions thunk (config.compact.customInstructions),
   * which must run synchronously inside compactConversation() and therefore
   * cannot await the profile. Refreshing it on the compact_start interception
   * guarantees it is current at the moment compaction fires.
   */
  private _hwSummary: string | null = null

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
    // When resuming, reuse the original session ID so SessionStore.append()
    // upserts the existing record instead of creating a new one.
    this.sessionId = config.resumeSessionId ?? randomUUID()
    this.robot = config.robot
    this.projectDir = config.projectDir ?? process.cwd()
    this._domain = config.domain
    this._userAppendPrompt = config.appendSystemPrompt ?? ''
    this._explicitResume = config.explicitResume ?? false
    this._resumeSessionId = config.resumeSessionId
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
    this.teamController = new RoboticsTeamCoordinator(
      this.teamStore,
      this.teamWatcher,
      section => this.sectionRegistry.invalidate(section),
    )
    // NOTE: this.bridge is created in init() (see comment on the field) so a
    // stale bridge for the same resumed sessionId can be awaited-disposed first.

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

    this.experienceWorkingSet = new ExperienceWorkingSetManager({
      experienceSource: this.experienceSource,
      contextPager:     this.contextPager,
      flashClient:      this._flashClient,
      robot:            this.robot,
    })

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
      // Route robotics compact guidance to the compaction side-call as a lazy
      // thunk. Resolved only when auto-compact fires (inside compactConversation),
      // so it lands at the front of the compact prompt ahead of the conversation
      // being summarised — instead of riding in the every-turn volatile prefix
      // (where extractCompactInstructions never saw it and the compact agent was
      // told to discard the <context> block anyway).
      compact: {
        customInstructions: () => this._buildCompactInstructions() ?? undefined,
        // Deterministic robotics state anchors, appended to the summary output in
        // every path (rich/terse/empty-fallback) so active+completed sub-agent
        // task IDs, phase, hardware safety limits and the experience working set
        // survive even when the model under-summarises. Resolved lazily at
        // compaction time to reflect live state.
        deterministicAnchors: () => this._buildDeterministicCompactAnchors() ?? undefined,
        // Robotics summary template: 9 sections + Experiment Ledger / Dead Ends /
        // assumptions, routed through AgenticSession into the kernel compact call.
        promptProfile: 'robotics',
      },
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

    // ── 0. Sub-agent bridge ────────────────────────────────────────────────
    // Bind the bridge here (not in the constructor): when the user re-resumes
    // the SAME session in a still-running process, a previous RoboticsSession
    // may still hold a bridge registered under this.sessionId. The bridge
    // constructor throws on a duplicate sessionId (it would otherwise register a
    // second CampaignEventBus listener and double-deliver notifications). Await
    // disposal of the stale bridge first so the new one binds cleanly — async
    // disposal is exactly why this can't live in the constructor.
    await SubAgentBridge.getBridge(this.sessionId)?.dispose()
    this.bridge = new SubAgentBridge(this.sessionId)

    // #6 fix: once the bridge is registered (static map + CampaignEventBus
    // listener), any later failure in init() must dispose it — the router only
    // stores this session on a SUCCESSFUL init(), so on a half-failure nothing
    // else holds a reference to tear the bridge down. Guard the remainder here.
    try {
    // ── 1. Persistence: try to restore project state ─────────────────────
    //
    // Resume path: when a specific resumeSessionId was supplied, bind to THAT
    // session via findBySession() so R5 is a session-level milestone record for
    // the exact session the user picked.  Otherwise fall back to the most
    // recently active session in this workspace (findLatestByProjectDir).
    // _storeSessionId is set to the resolved session's original UUID so all
    // subsequent store writes go to the same bucket — progress notes accumulate
    // there and are never mixed with other sessions.
    //
    // Fresh path: a brand-new state file is created under this.sessionId,
    // ensuring complete isolation from any prior sessions in this workspace.
    const existing = this._explicitResume
      ? (this._resumeSessionId
          ? await RoboticsProjectStore.findBySession(this.projectDir, this._resumeSessionId)
          : await RoboticsProjectStore.findLatestByProjectDir(this.projectDir))
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
        await this._recoverStaleSubAgentTasks(existing.activeSubAgentTasks)
      }

      // ── Reconcile worktrees still on disk ────────────────────────────────
      // Re-read after crash recovery: using `existing.git` here would restore
      // a worktree we just purged from durable state.
      const stateForReconcile = await RoboticsProjectStore.findBySession(
        this.projectDir,
        this._storeSessionId,
      ) ?? existing
      this._state = stateForReconcile
      // staleIds = tasks whose worktree/branch no longer exists — purge them.
      const staleIds = await this.gitMgr.reconcileWorktrees(stateForReconcile.git)
      if (staleIds.length > 0) {
        for (const id of staleIds) {
          await RoboticsProjectStore.purgeStaleSubAgentTask(this.projectDir, this._storeSessionId, id)
        }
        this._state = await RoboticsProjectStore.findBySession(this.projectDir, this._storeSessionId)
          ?? stateForReconcile
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
      this._registerRuntimeTool(tool)
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
      this._registerRuntimeTool(tool)
    }
    this._registerRuntimeTool(await createBashTool())
    // Generic delegation tools, parallel to robotics' domain dispatchers
    // (experiment_dispatch / paper_search). run_agent is SYNCHRONOUS (blocks
    // until done — use when the next step depends on the result); spawn_sub_agent
    // is ASYNCHRONOUS (fan out several in one turn to run in parallel). The
    // family also provides get_sub_agent_status / _intermediate / cancel / list,
    // which experiment_dispatch's poll-and-collect flow already relies on.
    this._registerRuntimeTool(await createRunAgentTool(this.bridge))
    for (const tool of makeSubAgentTools(this.bridge)) {
      this._registerRuntimeTool(tool)
    }
    // Network tools — required by sub-agents (e.g. PaperSearchAgent) whose
    // allowedTools include 'web_fetch' / 'web_search'. Registering here also
    // makes them resolvable in the bridge's tool registry (wired below).
    //
    // MAIN-agent web_fetch carries a tight per-result budget (8k chars): a
    // single full-text fetch (up to 100 KB) in the long-lived main context is
    // the documented noise amplifier behind compact-rework loops. Full-text
    // reading belongs in isolated research sub-agents — the bridge registry
    // below overrides web_fetch with an unbudgeted variant for sub-agents.
    this._registerRuntimeTool(await createWebFetchTool({ maxResultSizeChars: MAIN_AGENT_WEB_FETCH_MAX_CHARS }))
    // web_search gives the agent a real discovery path so it stops guessing
    // search-page URLs (e.g. github.com/search) that 404. It self-selects a
    // backend at call time — Anthropic web-search when ANTHROPIC_API_KEY is
    // set, else the GLM web-search-prime MCP (ZHIPU_API_KEY) — and returns a
    // clear "configure a backend" error if neither is available, which is
    // still strictly better than fabricating dead URLs.
    this._registerRuntimeTool(await createWebSearchTool())

    // MCP tools — mcp_call / list_mcp_resources / read_mcp_resource. These talk
    // to the process-global MCP client registry (populated by loadMcpConfig()
    // at CLI startup), so both the main agent and any sub-agent that lists them
    // in allowedTools can reach the connected MCP servers — e.g. an MCP-based
    // search server used by paper_search in place of the removed web_search.
    const mcpTools = await createMcpTools()
    for (const tool of mcpTools) {
      this._registerRuntimeTool(tool)
    }
    // Skill tool — gives the robotics agent access to user-defined skills under
    // ~/.meta-agent/skills/robotics/ and <projectDir>/.meta-agent/skills/
    this._registerRuntimeTool(await createSkillTool(this.projectDir, 'robotics'))
    // Memory write tool — allows the robotics agent to propose user/feedback memories.
    // Queued for human review; never auto-committed.
    this._registerRuntimeTool(await createMemoryWriteTool({ mode: 'robotics', domain: this._domain }))
    // Team collaboration tools — the agent half of a "human + meta-agent" unit.
    // team_note writes directly (low-risk lab-notebook append on tasks this
    // unit owns); team_take / team_mark_done are flagged sensitive by the CLI
    // guard so a human confirms each. All three error cleanly when team mode
    // is not initialised, so unconditional registration is safe.
    for (const tool of createTeamTools(this.teamController)) {
      this._registerRuntimeTool(tool)
    }

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
        this._registerRuntimeTool(tool)
      }
    }

    // ── 4a-research. Research dispatch — isolated literature research ─────
    // Searches/fetches/extracts in a sub-agent's own context, persists the
    // report under <projectDir>/.meta-agent/research/, and returns only a one-line
    // conclusion + report path to the main agent. Compact anchors (see
    // _buildDeterministicCompactAnchors) then steer post-compaction recovery
    // to re-READ the report file instead of re-RUNNING the research.
    this._registerRuntimeTool(createResearchDispatchTool({
      dispatcher: this.bridge,
      projectDir: this.projectDir,
      sessionId: this._storeSessionId,
      extraAllowedTools: ['experience_write'],
    }))

    // ── 4b. Wire the sub-agent tool registry ──────────────────────────────
    // CRITICAL: sub-agents resolve their config.allowedTools against the
    // bridge's tool registry. Without this call the registry stays empty, so
    // every sub-agent (paper_search, experiment_dispatch, …) is launched with
    // ZERO tools — the model emits one line and terminates with turnsUsed=0,
    // which surfaces as a hollow "complete" with no real work done.
    // Must run AFTER all main-session tools are registered above.
    //
    // Sub-agents get an UNBUDGETED web_fetch override: their context is
    // isolated and discarded after the run, so full-text reading is exactly
    // where it belongs. The main agent's own web_fetch stays budgeted (8k).
    this.bridge.setToolRegistry(this.inner.getToolRegistry())
    this.bridge.setSubAgentToolOverrides([await createWebFetchTool()])

    // ── 5. Dynamic sections (R1-R5 + W1) ─────────────────────────────────
    // Sections are built lazily on first submit() via _getRoboticsExtensions().
    // No warm-up needed here — resolveToString() caches on first call.
    //
    // R4 hardware-profile + R5 milestone snapshots: capture once now (covers
    // both fresh-create and resume).  Both are refreshed again only when
    // compaction executes.
    this._refreshR5Snapshot()
    await this._refreshR4Snapshot()

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
    } catch (err) {
      // Half-failed init: dispose the bridge we registered above so its static
      // map entry and event listener don't leak, then rethrow for the caller.
      try { await this.bridge?.dispose() } catch { /* best-effort */ }
      throw err
    }
  }

  /**
   * Reconcile tasks left active by an abnormal session exit. A completed
   * branch-backed experiment deliberately remains active until the user merges
   * or discards it, so it must survive the stale-session TTL on the next open.
   */
  private async _recoverStaleSubAgentTasks(
    tasks: readonly import('./types.js').ActiveSubAgentRecord[],
  ): Promise<void> {
    for (const task of tasks) {
      const record = task.branchName
        ? await this.bridge?.getStatus(task.taskId as import('../subagent/types.js').SubAgentTaskId).catch(() => null)
        : null
      if (task.branchName && record?.status === 'completed') continue

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

  /**
   * Refresh the frozen R5 milestone snapshot from current project state.
   *
   * Invoked ONLY at session-start moments: init() (covers fresh-create and
   * resume) and when compaction executes (intercepted in submit()).  The new
   * value is picked up by the next submit()'s stable system-prompt assembly,
   * keeping system-prompt churn to those moments only.
   */
  private _refreshR5Snapshot(): void {
    this._r5Snapshot = renderR5Snapshot(this._state, this._resumedAt)
  }

  /**
   * Refresh the frozen R4 hardware-profile snapshot from the persisted profile.
   *
   * Invoked ONLY at session-start moments: init() (create/resume) and on
   * compaction (intercepted in submit()), mirroring _refreshR5Snapshot().  The
   * profile text is fetched once here so buildR4Section() can read it
   * synchronously from the stable system prompt.
   */
  private async _refreshR4Snapshot(): Promise<void> {
    const formatted = await this.hwProfile.formatForPrompt().catch(() => null)
    this._r4Snapshot = renderR4Snapshot(formatted, this.robot)
    // Cache the raw summary for the synchronous compact-instructions thunk.
    this._hwSummary = formatted
  }

  /**
   * Re-hydrate the in-memory _state snapshot from disk.
   *
   * The store-mutating tools (experiment_dispatch / paper_search / progress_note)
   * write ONLY the on-disk state via RoboticsProjectStore static methods; they
   * never touch this._state. Disk is the single source of truth, so the SYNC
   * consumers of _state — R3 render (buildR3Section getter), the compact anchor
   * thunks (_compactContext), and dispose() worktree cleanup — must re-read it
   * at their async checkpoints or they observe a stale snapshot loaded at init().
   *
   * Re-hydration is lossless: every in-memory write to _state (agentMode in
   * _classifyAgentMode, the fresh-create path) is mirrored to disk, so reloading
   * never drops a mutation. No-op when the read returns null (outside the resume
   * window — kept fresh by the heartbeat — or a transient miss) so a bad read
   * never clobbers a good in-memory copy.
   */
  private async _refreshState(): Promise<void> {
    if (!this._storeSessionId) return
    const fresh = await RoboticsProjectStore
      .findBySession(this.projectDir, this._storeSessionId)
      .catch(() => null)
    if (fresh) this._state = fresh
  }

  /**
   * Build the robotics compact instructions synchronously from live state.
   *
   * Wired into the kernel via config.compact.customInstructions as a thunk, so
   * it is evaluated only when auto-compact fires — not on every turn. Reads the
   * live this._state and the cached raw hardware summary (_hwSummary, refreshed
   * on the compact_start interception just before compaction runs). Returns null
   * when there is nothing worth preserving.
   */
  private _buildCompactInstructions(): string | null {
    return composeAnchorBlocks(
      buildRoboticsCompactInstructions(this._compactContext()),
      buildResearchArtifactAnchors(this.projectDir),
    )
  }

  /**
   * Build the factual deterministic anchor block appended to the compact output
   * in every path. Wired via config.compact.deterministicAnchors as a thunk so
   * it reflects live state at the moment compaction fires.
   */
  private _buildDeterministicCompactAnchors(): string | null {
    return composeAnchorBlocks(
      buildRoboticsDeterministicAnchors(this._compactContext()),
      // Persisted research reports: post-compaction the model must re-READ
      // these files, never re-RUN the research (soft constraint).
      buildResearchArtifactAnchors(this.projectDir),
    )
  }

  /** Shared live-state snapshot for the compact instruction + anchor builders. */
  private _compactContext() {
    return {
      state: this._state,
      hardwareSummary: this._hwSummary,
      experienceWorkingSet: this.experienceWorkingSet.current.map(selection => ({
        id: selection.experience.id,
        title: selection.experience.title,
        appliesBecause: selection.appliesBecause,
        principle: selection.experience.abstractPrinciple,
      })),
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
      principleStore: this.principles,
      flash: this._flashClient,
      reason,
    })
  }

  /**
   * Run the recognition-before-generation pipeline for a freshly-committed
   * experience: claim existing principles (+reinforce), else evaluate mechanism
   * convergence and propose a principle when ≥ N experiences converge.
   * Called from /experience review per committed experience.
   */
  async evaluatePromotionForExperience(experienceId: string): Promise<EvaluatePromotionResult> {
    return evaluatePromotion(experienceId, {
      experienceStore: this.store,
      principleStore: this.principles,
      anchorStore: this.physicalAnchors,
      pendingStore: this.pendingPrinciples,
      flash: this._flashClient,
    })
  }

  /**
   * Reinforce/challenge loop: when a freshly-committed experience cites
   * principleIds, fold its outcome back into those committed principles —
   * a success corroborates (observationCount++), a failure contradicts
   * (contradictionCount++, lowering the principle's retrieval score so a
   * challenged principle sinks and resurfaces for human re-review).
   * Returns the per-principle signals applied (empty when the experience cites
   * no principles).
   */
  async reinforcePrinciplesFromExperience(
    experienceId: string,
  ): Promise<Array<{ principleId: string; signal: 'observation' | 'contradiction' }>> {
    const experience = await this.store.load(experienceId)
    const principleIds = experience?.principleIds ?? []
    if (!experience || principleIds.length === 0) return []
    const signal: 'observation' | 'contradiction' =
      experience.outcome.success ? 'observation' : 'contradiction'
    const applied: Array<{ principleId: string; signal: 'observation' | 'contradiction' }> = []
    for (const principleId of [...new Set(principleIds)]) {
      const updated = await this.principles.recordOutcomeSignal(principleId, signal).catch(() => null)
      if (updated) applied.push({ principleId, signal })
    }
    return applied
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

    // Cancel running sub-agents. The bridge is created in init(); guard with
    // optional chaining so disposing a constructed-but-never-init()ed session
    // (e.g. an init() failure path) doesn't throw on an undefined bridge.
    try {
      await this.bridge?.cancelAll()
    } catch { /* best-effort */ }

    // Clean up active worktrees and purge state records. Re-hydrate first so
    // worktrees registered by tools AFTER init() (which only wrote disk) are
    // visible here and actually removed instead of leaked.
    await this._refreshState()
    const state = this._state
    if (state && state.activeSubAgentTasks.length > 0) {
      await Promise.allSettled(
        state.activeSubAgentTasks.map(async task => {
          const record = await this.bridge?.getStatus(task.taskId as import('../subagent/types.js').SubAgentTaskId).catch(() => null)
          if (record?.status === 'completed' && task.branchName) {
            return
          }
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

    await this.bridge?.dispose().catch(() => undefined)

    // Post-session knowledge extraction (best-effort). One strict flash call
    // scans the transcript for durable experiences AND physical anchors; both
    // default to none. Candidates go to their pending queues for human review
    // (/experience review, /anchor review) — nothing is auto-committed.
    await extractKnowledgePostSession({
      messages: this.inner.getMessages(),
      flash: this._flashClient,
      experiencePending: this.pendingExperiences,
      anchorPending: this.pendingPhysicalAnchors,
    }).catch(() => undefined)

    // Release the inner AgenticSession/KernelSession LAST — after post-session
    // knowledge extraction above, which reads this.inner.getMessages(). Mirrors
    // MetaAgentSession.dispose(): frees the kernel message buffer, FileStateCache,
    // tool closures, and the RuntimeContext/ProvenanceTracker/FlashClient that
    // the tool instrumentation closures otherwise keep pinned for the process
    // lifetime. Without this, a long-lived host that repeatedly opens and closes
    // robotics sessions leaks the full session graph each time. Idempotent.
    try { await this.inner.dispose() } catch { /* best-effort */ }
  }

  /**
   * Bump the anchor knowledge version and drop the memoized R6 section so the
   * next turn re-renders the full committed anchor set. Call after /anchor review
   * commits new anchors so they incrementally appear without breaking the prompt
   * cache mid-session.
   */
  invalidateAnchors(): void {
    this._anchorVersion++
    this.sectionRegistry.invalidate('physical_anchors')
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

    try {
      // ── First submit only: classify agent mode ────────────────────────────────
      if (!this._modeClassified) {
        await this._classifyAgentMode(prompt)
      }

      // ── Re-hydrate _state from disk ───────────────────────────────────────────
      // The store-mutating tools only write disk; reload so this turn's R3
      // (subagent_tasks) reflects tasks dispatched on the previous turn instead
      // of the snapshot captured at init().
      await this._refreshState()

      // ── QueryAnalyzer: fire in parallel with stable section building ──────────
      // Heuristic + flash-model intent analysis. analyze() self-bounds its wait
      // (~5s) and returns heuristics if flash is slow, so this await can never
      // stall the turn on provider latency. Result drives proactive context
      // pre-loading before the first tool call this turn.
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

      await this.experienceWorkingSet.preload(prompt, intent)

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

      for await (const ev of this.inner.submit(effectivePrompt)) {
        // Compaction is a session-start moment for R4 + R5: refresh both
        // snapshots so the post-compact system prompt reflects current state.
        // The refreshed snapshots are applied on the next submit's stable prompt
        // assembly (config is captured at submit time).
        if (ev.type === 'compact_start') {
          // Refresh _state BEFORE the R4/R5 snapshots and before control returns
          // to autoCompactIfNeeded, which synchronously invokes the compact
          // anchor thunks (_buildCompactInstructions / _buildDeterministicCompactAnchors
          // → _compactContext reads this._state). The inner generator is suspended
          // on the compact_start yield (KernelLoop.ts:747) at this point, so this
          // refresh is guaranteed to land before the thunks fire — task_id /
          // on_complete then survive compaction.
          await this._refreshState()
          this._refreshR5Snapshot()
          await this._refreshR4Snapshot()
          this.experienceWorkingSet.forceReload()
        }
        yield ev
      }
      // Touch persistence so lastActiveAt is current
      await RoboticsProjectStore.touch(this.projectDir, this._storeSessionId).catch(() => undefined)
    } finally {
      this._submitInFlight = false
      // Age TTL counters and evict expired context slots after each completed turn
      try {
        this.contextPager.tick(extractReferencedExperienceSlotIds(this.getMessages()))
      } catch {
        // Best-effort cleanup must not mask the submit failure that triggered finally.
      }
    }
  }

  registerTool(tool: MetaAgentTool): void {
    this._registerRuntimeTool(tool)
  }

  private _registerRuntimeTool(tool: MetaAgentTool): void {
    if (this._agentMode === 'single' && SINGLE_AGENT_DEFERRED_TOOLS.has(tool.name)) {
      this._deferredMultiAgentTools.set(tool.name, tool)
      this._syncBridgeToolRegistry()
      return
    }

    this.inner.registerTool(tool)
    this._syncBridgeToolRegistry()
  }

  private _flushDeferredMultiAgentTools(): void {
    if (this._agentMode === 'single' || this._deferredMultiAgentTools.size === 0) return

    const tools = [...this._deferredMultiAgentTools.values()]
    this._deferredMultiAgentTools.clear()
    for (const tool of tools) {
      this.inner.registerTool(tool)
    }
    this._syncBridgeToolRegistry()
  }

  private _syncBridgeToolRegistry(): void {
    if (!this.bridge) return
    this.bridge.setToolRegistry(this.inner.getToolRegistry())
  }

  interrupt(): void {
    this.inner.interrupt()
  }

  /** Inject a mid-turn user correction. See KernelSession.steer(). */
  steer(text: string): boolean {
    return this.inner.steer(text)
  }

  /**
   * Manual compaction (/compact). Mirrors the compact_start interception on
   * the auto path: refresh R4/R5 snapshots and force an experience-candidate
   * reload so the post-compact stable prompt reflects current state.
   */
  async compactNow(): Promise<import('../kernel/index.js').ManualCompactResult> {
    await this._refreshState()
    this._refreshR5Snapshot()
    await this._refreshR4Snapshot()
    this.experienceWorkingSet.forceReload()
    return this.inner.compactNow()
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


  /**
   * The team-collaboration controller for this unit. SessionRouter exposes it to
   * the CLI; the agent-facing team tools use it as their host. The ~20 team
   * operations live on the coordinator now, not this session (cohesion — see
   * architecture-review-2026-06-18.md §3.1).
   */
  getTeamController(): RoboticsTeamController {
    return this.teamController
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
   *   R4  hardware_profile   — hardware snapshot; refreshed only at
   *                            session-start moments (create / resume / compact)
   *   R5  progress_notes     — session milestone snapshot; refreshed only at
   *                            session-start moments (create / resume / compact)
   */
  private _getStableRoboticsExtensions() {
    const sections = [
      buildR1Section(this.robot, () => this._agentMode),
      buildTeamSection(this.teamStore, this.teamWatcher),
      // R4 — hardware-profile snapshot. Stable: reads a frozen snapshot that
      // only changes at session-start moments (create / resume / compact).
      buildR4Section(() => this._r4Snapshot),
      // R5 — session milestone snapshot. Stable: reads a frozen snapshot that
      // only changes at session-start moments (create / resume / compact), so
      // it does not invalidate the KV cache every turn.
      buildR5Section(() => this._r5Snapshot),
      // R6 — physical anchors: full session-scoped set, memoized for cache
      // stability; invalidated only on /anchor review commit (invalidateAnchors).
      buildR6Section(this.physicalAnchors, this.robot, this.anchorSource),
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
   * Ordering is deliberate — sections are read top-to-bottom, so they progress
   * from the most framing/constraining to the most volatile/operational, which
   * reduces the model's tendency to anchor on transient state:
   *   team_context_boundary  — task scope / what NOT to touch (conditional; frames everything)
   *   R6  physical_anchors    — immutable world facts + safety constraints (foundational)
   *   R2  experience_index    — prior knowledge to draw on (reference)
   *   R3  subagent_status     — live sub-agent / git task state (most volatile, read last)
   *
   * R7 (compact instructions) is intentionally NOT here. It is routed to the
   * compaction side-call via config.compact.customInstructions (see
   * _buildCompactInstructions), so it reaches the compact agent at the front of
   * the compact prompt instead of riding in the discarded <context> block.
   */
  private _getVolatileRoboticsExtensions() {
    const sections = [
      // R6 moved to stable extensions (memoized full anchor set) — see
      // _getStableRoboticsExtensions + invalidateAnchors().
      // R2 — experience index: prior knowledge to draw on.
      buildR2Section(this.store, this.contextPager, this.experienceSource),
      // R3 — sub-agent task state: most volatile, read last.
      // R5 moved to stable extensions (snapshot-based) — see _getStableRoboticsExtensions.
      buildR3Section(this.bridge, this.gitMgr, () => this._state),
    ]

    // Context boundary — prepend before other volatile sections so the model
    // reads the task scope immediately after <context>.
    const boundary = this.teamController.contextBoundary
    if (boundary) {
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
      timeoutMs: 30_000,
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
         serial literature survey, or tasks completable in under ~10 minutes.
         Serial context-isolated helpers such as paper_search/run_agent are allowed.
         No need for parallel fan-out or multiple isolated experiment branches.

multi  — Complex algorithm development, multiple parallel experiments, hypothesis
         comparison, long-running simulations (>10 min), paper search + implementation
         + validation pipeline, or tasks that genuinely benefit from isolated git branches.

Default to single unless the task clearly requires parallel sub-agents or branch-isolated
experiment fan-out.

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
        timeoutMs: 30_000,
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
      this._flushDeferredMultiAgentTools()

      // Invalidate R1 so next resolveToString() renders the correct variant
      this.sectionRegistry.invalidate('robotics_domain')

      if (this._state) {
        this._state.agentMode = classifiedMode
        await RoboticsProjectStore.setAgentMode(
          this.projectDir,
          this._storeSessionId,
          classifiedMode,
        ).catch(() => undefined)
      }
    } catch {
      // Network error, timeout — stay in single-agent mode (safe default)
    }
  }
}
