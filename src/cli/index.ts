/**
 * meta-agent CLI
 *
 * Usage:
 *   meta-agent [options] [prompt]
 *
 * Interactive REPL (no prompt given):
 *   meta-agent
 *   meta-agent --mode agentic
 *
 * Single-turn (prompt given):
 *   meta-agent "what is Pareto optimality?"
 *   meta-agent --mode campaign "run a DOE sweep"
 *
 * Options:
 *   -m, --mode <mode>       Session mode: auto|simple_auto|agentic|campaign|robotics (default: agentic)
 *   -k, --api-key <key>     API key (or ANTHROPIC_API_KEY / DEEPSEEK_API_KEY env var)
 *       --model <model>     Model override (default: auto-detected from provider)
 *   -s, --system <prompt>   Custom system prompt
 *       --session-dir <dir> Persist one-shot session history under this folder
 *   -j, --json              Output raw JSON events (for piping)
 *   -y, --yes               Auto-approve sensitive tools in trusted scripts
 *       --auto-worktree-cleanup <preserve|safe|aggressive> Auto worktree cleanup policy
 *   -v, --version           Show version
 *   -h, --help              Show help
 */

import { parseArgs } from 'node:util'
import * as readline from 'node:readline'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import { Writable } from 'node:stream'
import { isAbsolute, resolve, join, basename } from 'node:path'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { SessionRouter } from '../routing/SessionRouter.js'
import { MetaAgentSession } from '../core/MetaAgentSession.js'
import { SubAgentBridge } from '../subagent/SubAgentBridge.js'
import {
  runLoopCli, runLoopScheduler, createDefaultGraphRuntimeCatalog, loadGraphCapabilityPacks,
  createGraphDistillTools,
  ForegroundGraphDistillExecutor, MetaAgentGraphAgentExecutor, reviseLoopGraph,
  readDistillArtifacts, writeDistillArtifacts,
  freezeLoopGraph, validateLoopGraph, lintLoopGraph, formatGraphLintFindings,
  type GraphDistillModelRequest, type GraphDistillPhase, type GraphDistillProgressEvent,
  type DistillGraphResult, type GraphRuntimeCatalog, type GraphProgressEvent, type LoopGraphSpec,
} from '../loop/index.js'
import { isAutonomousMode } from '../core/modes.js'
import type { AutoWorktreeCleanupStrategy } from '../core/auto/AutoWorktreeCoordinator.js'
import { getModelProtocol, resolveProvider } from '../providers/registry.js'
import { RuntimeEnv, ENV_REGISTRY } from '../infra/env/RuntimeEnv.js'
import { META_AGENT_HOME } from '../core/metaAgentHome.js'
import { PasteAccumulator, BRACKETED_PASTE_ENABLE, BRACKETED_PASTE_DISABLE } from './pasteAccumulator.js'
import { ThinkingMeter } from './thinkingMeter.js'
import { sanitizeTerminalPreview, sanitizeTerminalText, TerminalSanitizer } from './terminalSanitizer.js'
import { HardwareProfile } from '../robotics/HardwareProfile.js'
import { ExperiencePendingStore } from '../robotics/ExperiencePendingStore.js'
import { ExperienceStore } from '../robotics/ExperienceStore.js'
import { PhysicalAnchorPendingStore } from '../robotics/PhysicalAnchorPendingStore.js'
import { PhysicalAnchorStore } from '../robotics/PhysicalAnchorStore.js'
import { PrinciplePendingStore } from '../robotics/PrinciplePendingStore.js'
import { PrincipleStore } from '../robotics/PrincipleStore.js'
import { MemoryPendingStore, getMemoryPendingStore, ensureMemoryPendingLoaded } from '../core/memory/MemoryPendingStore.js'
import { listMemoryEntries, deleteMemoryEntry } from '../core/memory/memoryDelete.js'
import {
  getPendingDeletionStore,
  ensurePendingDeletionsLoaded,
  type DeletionMechanism,
} from '../core/deletion/PendingDeletionStore.js'
import {
  TEAM_PLANNER_SYSTEM,
  buildTeamPlannerUserMessage,
  parseTeamPlannerPlan,
  type TeamPlannerPlan,
  type TeamPlannerSnapshot,
} from '../robotics/team/TeamPlanner.js'
import type { TeamWatcherEvent } from '../robotics/team/TeamWatcher.js'
import type {
  TeamState,
  TeamTask,
  TeamTaskKind,
} from '../robotics/team/TeamStore.js'
import { isStaleClaim } from '../robotics/team/TeamStore.js'
import { SessionStore, type SessionMeta } from '../core/SessionStore.js'
import { detectProvider } from '../core/config.js'
import { loadModelConfig } from '../core/config/ConfigService.js'
import { detectSensitiveShellCommand } from '../kernel/permissions/SensitiveCommandPatterns.js'
import { executePlan } from './teamPlannerExecutor.js'
import { resolveTemplate } from './hardwareTemplate.js'
import type { ProfileTemplate, ProfilePreset } from './hardwareTemplate.js'
import type { MetaAgentConfig, BeforeToolCallResult } from '../core/config.js'
import type { RouterOptions } from '../routing/types.js'
import type { SessionMode } from '../core/modes.js'
import type { MetaAgentEvent, MetaAgentResultEvent } from '../core/types.js'
import type { ConversationMessage } from '../core/types.js'
import { createStandardTools } from '../tools/index.js'
import { readAutoCheckpoint } from '../core/auto/AutoCheckpointStore.js'
import { loadMcpConfig, buildMcpServerInstructions } from '../tools/mcp/index.js'
import type { McpServerInstruction } from '../core/dynamicPrompt.js'
import { getMissingBwrapWarning } from './bwrapCheck.js'
import { CLI_VERSION } from './version.js'

// ── Version ───────────────────────────────────────────────────────────────────

const VERSION = CLI_VERSION
const DEFAULT_CLI_MAX_TURNS = 100
// Auto-series (auto / simple_auto) run unattended and carry their
// own bounds (stall guards, budgets, and for plain auto only checkpoint +
// drift/verify gates), so they get a much higher per-message turn cap than
// attended modes.
const AUTO_CLI_MAX_TURNS = 1000
const PASTE_FALLBACK_COALESCE_MS = 80
const PASTE_NOTICE_DEBOUNCE_MS = 250
const PASTE_NOTICE_MIN_CHARS = 80
const PASTE_NOTICE_MIN_LINES = 3
const SHIFT_ENTER_SEQUENCES = [
  '\x1b[13;2u',
  '\x1b[13;2~',
  '\x1b[27;2;13~',
]

// ── ANSI colour helpers ───────────────────────────────────────────────────────

const isTTY = process.stdout.isTTY
const c = {
  reset:    isTTY ? '\x1b[0m'  : '',
  bold:     isTTY ? '\x1b[1m'  : '',
  dim:      isTTY ? '\x1b[2m'  : '',
  cyan:     isTTY ? '\x1b[36m' : '',
  green:    isTTY ? '\x1b[32m' : '',
  yellow:   isTTY ? '\x1b[33m' : '',
  blue:     isTTY ? '\x1b[34m' : '',
  magenta:  isTTY ? '\x1b[35m' : '',
  red:      isTTY ? '\x1b[31m' : '',
  gray:     isTTY ? '\x1b[90m' : '',
}

const dim   = (s: string) => `${c.dim}${s}${c.reset}`
const bold  = (s: string) => `${c.bold}${s}${c.reset}`
const cyan  = (s: string) => `${c.cyan}${s}${c.reset}`
const green = (s: string) => `${c.green}${s}${c.reset}`
const gray  = (s: string) => `${c.gray}${s}${c.reset}`
const red   = (s: string) => `${c.red}${s}${c.reset}`
const yellow = (s: string) => `${c.yellow}${s}${c.reset}`
const terminalText = (input: unknown) => sanitizeTerminalText(input)

class ReadlineOutput extends Writable {
  private muted = false
  private muteDepth = 0
  private passthroughDepth = 0
  private unmuteScheduled = false
  readonly isTTY: boolean | undefined

  constructor(private readonly target: NodeJS.WriteStream) {
    super()
    this.isTTY = target.isTTY
  }

  get columns(): number | undefined { return this.target.columns }
  get rows(): number | undefined { return this.target.rows }

  beginMute(): void {
    this.muteDepth++
  }

  endMute(): void {
    this.muteDepth = Math.max(0, this.muteDepth - 1)
  }

  withPassthrough(fn: () => void): void {
    this.passthroughDepth++
    try {
      fn()
    } finally {
      this.passthroughDepth = Math.max(0, this.passthroughDepth - 1)
    }
  }

  muteForCurrentInput(): void {
    this.muted = true
    if (this.unmuteScheduled) return
    this.unmuteScheduled = true
    setImmediate(() => {
      this.muted = false
      this.unmuteScheduled = false
    })
  }

  _write(
    chunk: string | Buffer,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (this.passthroughDepth === 0 && (this.muted || this.muteDepth > 0)) {
      callback()
      return
    }
    const done = (err?: Error | null) => callback(err ?? undefined)
    if (this.target.write(chunk, encoding)) done()
    else this.target.once('drain', done)
  }
}

// ── Help text ─────────────────────────────────────────────────────────────────

function printHelp(): void {
  console.log(`
${bold('meta-agent')} — Engineering agent runtime CLI  ${dim(`v${VERSION}`)}

${bold('USAGE')}
  meta-agent [options] [prompt]
  meta-agent env [--json]        Print env-var config (name, current value, default)

${bold('MODES')}
  ${cyan('agentic')}    Full tool-use loop (default for all Q&A and engineering tasks)
  ${cyan('auto')}       Autonomous: in-workspace writes/deletes auto-approved (no prompts),
             all file changes hard-confined to the working directory
  ${cyan('simple_auto')} Lightweight autonomous: same workspace jail as auto, but without
             checkpoint / drift / verify — for simple, short unattended tasks
  ${cyan('campaign')}   DOE / multi-objective optimisation campaign
  ${cyan('robotics')}   Robotics session — ExperienceStore + workflow + hardware profiles

${bold('OPTIONS')}
  -m, --mode <mode>       Session mode: agentic|auto|simple_auto|campaign|robotics
      --yolo              Alias for --mode auto (autonomous + workspace jail)
  -w, --workspace <dir>   Working directory — agent ONLY operates within this folder
  -k, --api-key <key>     API key (or set DEEPSEEK_API_KEY / ANTHROPIC_API_KEY env var)
  -b, --base-url <url>    API base URL (default: auto-detected from key)
      --model <model>   Model override (default: deepseek-v4-flash)
      --fallback-model <model>  Model to retry with when primary lacks a feature
  -s, --system <text>   Custom system prompt
  -t, --max-turns <n>   Max agentic turns per message (default: 100; use "infinity" for no cap)
      --max-budget-usd <n>  Whole-session USD budget (auto/simple_auto default: 20)
  -r, --resume <id>     Resume a previous session by ID (or "last" for most recent)
      --session-dir <dir>  Persist one-shot session history under this folder
  -y, --yes             Auto-approve sensitive tools (intended for trusted scripts)
  -d, --debug           Debug mode: log full prompts + responses to stderr each turn
      --show-thinking   Show model thinking deltas in the terminal
      --auto-worktree-cleanup <preserve|safe|aggressive>  Auto worktree cleanup policy
  -j, --json            Output raw JSON events
  -v, --version         Print version
  -h, --help            Show this help

${bold('LOOP RUNTIME (durable graph only)')}
  meta-agent loop distill <需求.md>        Compile, validate, and iteratively refine a LoopGraphSpec
  meta-agent loop create <graph.json>     Freeze capabilities, create an instance, schedule its first wake
  meta-agent loop event <id> <name>       Deliver a durable graph event (--source/--delivery-id enables deduplication)
  meta-agent loop list [--json]            List loop instances in this workspace
  meta-agent loop inspect <id> [--json]    State, diagnostics and Reliability Profile
  meta-agent loop timeline <id> [--json]   Causal timeline derived from the journal
  meta-agent loop events <id> [--json]     Read-only external event inbox view
  meta-agent loop files <instanceId>       Declared inputs/projections and record counts
  meta-agent loop disk <instanceId> [--json] Metadata/worktree disk usage and growth metrics
  meta-agent loop tick [--until-quiescent] Claim due wakes and advance graphs
  meta-agent loop pause|resume|stop <id>   Control lifecycle (resume --run advances immediately)
  meta-agent loop recover <id>             Fork a terminal instance from a failed activation
  meta-agent loop archive <id>             Move a quiescent terminal instance into .loop/archive
  meta-agent loop gc [--apply]              Dry-run/apply terminal wake and optional archive cleanup
  meta-agent loop capabilities             List frozen-capable Functions/Reducers/Effects/Packs
  meta-agent loop-scheduler [options]      Run the loop daemon until idle (unattended driver)
      --poll-ms <n> --idle-exit-ms <n> --max-concurrent-graphs <n>
  (put global flags like -w <dir> BEFORE the loop token: meta-agent -w <dir> loop tick)

${bold('INTERACTIVE COMMANDS')}
  /mode                 Show current session mode
  /workspace            Show current workspace directory
  /hardware             Show bound hardware profile (robotics mode)
  /hardware select      Re-run hardware profile selection wizard
  /team                 Show board + recent attempts (entry guide)
  /team init [github-url]   Create team/ template (GitHub 必绑；origin 指向 GitHub 时可省略)
  /team join [github] [--as <name>]   Join this unit to the team
  /team add "<title>" [--kind algo|exp|deploy]   Create a new task (optional lane)
  /team take <task>     Exclusively claim a task (fails if owned by another)
  /team note <id> "<direction>" :: "<outcome>" [@ref]   Append an attempt
  /team focus <task>    Switch focus among tasks you own (no-arg done/drop target)
  /team drop [task]     Release a task you own (no-arg: focus task)
  /team steal <task> [reason]   Forcibly take a task; records audit attempt
  /team done [task]     Mark task done (only owner)
  /team status / board  Show current board
  /team sync            Fetch remotes and refresh team status
  /team push            Commit & push team/ changes (only team dir) to teammates
  /team pull            Apply remote team/ files only when local team/ is clean
  /team conflicts       Show merge conflict guidance for the current workspace
  /team conflicts resolve  Auto-resolve team.json conflict using --theirs strategy
  /usage                Show token usage & estimated cost
  /sessions             List saved sessions; pick one to resume
  /sessions clear       Delete sessions (pick one or delete all)
  /experience           Show pending experience queue (robotics mode)
  /experience review    Interactively review & commit pending experiences
  /experience delete    Pick & permanently delete a committed experience
  /experience delete review  Review & apply AI-proposed experience deletions
  /principle            Show pending principle queue (robotics mode)
  /principle review     Interactively review & commit pending principles
  /principle delete     Pick & permanently delete a committed principle
  /principle delete review   Review & apply AI-proposed principle deletions
  /anchor               Show pending physical anchor queue (robotics mode)
  /anchor review        Interactively review & commit pending physical anchors
  /anchor delete        Pick & permanently delete a committed physical anchor
  /anchor delete review      Review & apply AI-proposed anchor deletions
  /memory               Show pending memory queue (all modes)
  /memory review        Interactively review & commit pending memories
  /memory delete        Pick & permanently delete a committed memory
  /memory delete review      Review & apply AI-proposed memory deletions
  /compact              Compact the conversation context now (manual; same
                        pipeline as auto-compact — summary + keep-set + anchors)
  /clear                Start a new session (same workspace/hardware)
  /exit  or  Ctrl+D     Quit

${bold('DURING A TURN')}
  Ctrl+G                Pause output and inject a correction (steers the model
                        at the next step boundary — does NOT abort generation)
  Ctrl+C                Interrupt the current turn (press twice to quit)

${bold('ENVIRONMENT VARIABLES')}
  ZHIPU_API_KEY         GLM coding plan key  ${dim('← default provider (glm-5.2)')}
  DEEPSEEK_API_KEY      DeepSeek API key
  ANTHROPIC_API_KEY     Anthropic API key
  QWEN_API_KEY          Qwen API key

  Priority: ZHIPU_API_KEY > DEEPSEEK_API_KEY > QWEN_API_KEY > ANTHROPIC_API_KEY

${bold('CONFIG FILE')}
  ${cyan('~/.meta-agent/config.json')}
  Pins model selection without env vars or flags. All fields optional:
    {
      "LLM": {
        "mainModel":     "glm-5.2",
        "fallbackModel": "glm-4.7",
        "flashModel":    "glm-4.5-air",
        "compactModel":  "glm-5.2",
        "apiKey":        "...",
        "baseURL":       "https://open.bigmodel.cn/api/anthropic"
      },
      "web_search": {
        "tavilyApiKey":  "tvly-..."
      }
    }
  (legacy flat format with the same keys at top level is still accepted)
  Precedence: config file > CLI flags > built-in defaults.

${bold('EXAMPLES')}
  ${gray('# Set key once, then use freely')}
  export DEEPSEEK_API_KEY="sk-..."
  meta-agent

  ${gray('# Single-turn question (uses deepseek-v4-flash by default)')}
  meta-agent "解释一下 Pareto 最优"

  ${gray('# Heavier reasoning — switch to R1')}
  meta-agent --model deepseek-v4-pro "run a DOE sweep over x=[0,10], y=[0,5]"

  ${gray('# Campaign mode')}
  meta-agent --mode campaign "做参数扫描，找 Pareto 前沿"

  ${gray('# Robotics mode')}
  meta-agent --mode robotics "帮我调 PID 参数"

  ${gray('# One-shot with explicit key')}
  meta-agent -k sk-... "什么是 LHS 采样？"

  ${gray('# 指定工作目录（推荐！限制 agent 只能操作该目录）')}
  meta-agent --workspace ~/projects/my-robot
  meta-agent -w ~/projects/my-robot --mode agentic "重构代码结构"
`)
}

// ── Argument parsing ──────────────────────────────────────────────────────────

interface CliOptions {
  mode: SessionMode
  modeExplicit: boolean
  workspace: string | undefined   // resolved absolute path, set after confirmation
  hardwareId: string | undefined  // selected hardware profile name, robotics mode only
  apiKey: string | undefined
  baseUrl: string | undefined
  model: string | undefined
  fallbackModel: string | undefined
  system: string | undefined
  json: boolean
  debug: boolean                  // --debug: log full prompts + responses to stderr
  showThinking: boolean           // --show-thinking: stream thinking deltas to terminal
  yes: boolean                    // --yes: auto-approve sensitive tool calls
  autoWorktreeCleanup: AutoWorktreeCleanupStrategy | undefined
  prompt: string | null
  maxTurns: number | undefined    // --max-turns override; undefined → CLI default
  maxBudgetUsd: number | undefined // --max-budget-usd override; undefined → mode default
  resume: string | undefined      // --resume <sessionId>: preload history from saved session
  sessionDir: string | undefined  // --session-dir <dir>: one-shot persistence root
  /** `loop <cmd>` / `loop-scheduler` (v2 loop runtime, L2). Args pass through verbatim. */
  loopCommand: { name: 'loop' | 'loop-scheduler'; args: string[] } | null
}

function parseCliArgs(): CliOptions {
  // v2 loop runtime (L2): `meta-agent loop <cmd>` and `meta-agent loop-scheduler`
  // carry their OWN sub-flags (--id / --until-quiescent / --version N / --out …)
  // that the strict global parser would reject, so split them off up front.
  // Global flags (-w/-k/-b/--model) go BEFORE the `loop` token.
  const rawArgs = process.argv.slice(2)
  const loopIdx = rawArgs.findIndex(a => a === 'loop' || a === 'loop-scheduler')
  if (loopIdx !== -1) {
    return buildLoopCliOptions(
      rawArgs[loopIdx] as 'loop' | 'loop-scheduler',
      rawArgs.slice(0, loopIdx),
      rawArgs.slice(loopIdx + 1),
    )
  }

  let parsed: ReturnType<typeof parseArgs>
  try {
    parsed = parseArgs({
      args: process.argv.slice(2),
      options: {
        mode:         { type: 'string',  short: 'm' },
        yolo:         { type: 'boolean', default: false },
        workspace:    { type: 'string',  short: 'w' },
        'api-key':    { type: 'string',  short: 'k' },
        'base-url':   { type: 'string',  short: 'b' },
        model:        { type: 'string' },
        'fallback-model': { type: 'string' },
        system:       { type: 'string',  short: 's' },
        'max-turns':  { type: 'string',  short: 't' },
        'max-budget-usd': { type: 'string' },
        resume:       { type: 'string',  short: 'r' },
        'session-dir': { type: 'string' },
        yes:          { type: 'boolean', short: 'y', default: false },
        debug:        { type: 'boolean', short: 'd', default: false },
        'show-thinking': { type: 'boolean', default: false },
        'auto-worktree-cleanup': { type: 'string' },
        json:         { type: 'boolean', short: 'j', default: false },
        version:      { type: 'boolean', short: 'v', default: false },
        help:         { type: 'boolean', short: 'h', default: false },
      },
      allowPositionals: true,
    })
  } catch (err) {
    const msg = terminalText(err instanceof Error ? err.message : String(err))
    console.error(red(`Error: ${msg}`))
    process.exit(1)
  }

  if (parsed.values['help']) { printHelp(); process.exit(0) }
  if (parsed.values['version']) { console.log(`meta-agent v${VERSION}`); process.exit(0) }

  // `meta-agent env` — print the environment-variable config surface (name,
  // current effective value, default, description) from the single registry.
  if (parsed.positionals[0] === 'env') {
    printEnvTable(parsed.values['json'] === true)
    process.exit(0)
  }

  // --yolo is an alias for --mode auto (autonomous + hard workspace jail).
  const modeExplicit = parsed.values['yolo'] === true || parsed.values['mode'] !== undefined
  const rawMode = (parsed.values['yolo'] ? 'auto' : ((parsed.values['mode'] as string | undefined) ?? 'agentic')).toLowerCase()
  // Mode selection is explicit. Omitting --mode uses agentic; specialist modes
  // must be entered intentionally.
  // 'auto_orch' (v1 graph engine) is fully retired (spec D16): long-horizon loops
  // run on the loop v2 runtime (`meta-agent loop …`).
  const validModes = ['auto', 'simple_auto', 'agentic', 'campaign', 'robotics']
  if (!validModes.includes(rawMode)) {
    console.error(red(`Error: unknown mode "${rawMode}". Valid: ${validModes.join(', ')}`))
    process.exit(1)
  }

  const promptParts = parsed.positionals
  const rawWorkspace = parsed.values['workspace'] as string | undefined
  const rawSessionDir = parsed.values['session-dir'] as string | undefined
  let workspace: string | undefined
  if (rawWorkspace) {
    workspace = resolve(rawWorkspace)
    if (!existsSync(workspace) || !statSync(workspace).isDirectory()) {
      console.error(red(`Error: workspace "${workspace}" does not exist or is not a directory.`))
      process.exit(1)
    }
  }
  let sessionDir: string | undefined
  if (rawSessionDir) {
    sessionDir = resolve(rawSessionDir)
    if (existsSync(sessionDir) && !statSync(sessionDir).isDirectory()) {
      console.error(red(`Error: session-dir "${sessionDir}" exists but is not a directory.`))
      process.exit(1)
    }
  }
  const rawMaxTurns = parsed.values['max-turns'] as string | undefined
  const rawMaxBudgetUsd = parsed.values['max-budget-usd'] as string | undefined
  const rawCleanup = parsed.values['auto-worktree-cleanup'] as string | undefined
  if (rawCleanup && !['preserve', 'safe', 'aggressive'].includes(rawCleanup)) {
    console.error(red(`Error: --auto-worktree-cleanup must be preserve, safe, or aggressive (got "${rawCleanup}")`))
    process.exit(1)
  }
  let maxTurns: number | undefined
  if (rawMaxTurns) {
    if (rawMaxTurns.toLowerCase() === 'infinity' || rawMaxTurns === '∞') {
      maxTurns = Infinity
    } else {
      maxTurns = parseInt(rawMaxTurns, 10)
      if (isNaN(maxTurns) || maxTurns < 1) {
        console.error(red(`Error: --max-turns must be a positive integer or "infinity" (got "${rawMaxTurns}")`))
        process.exit(1)
      }
    }
  }
  let maxBudgetUsd: number | undefined
  if (rawMaxBudgetUsd) {
    maxBudgetUsd = Number.parseFloat(rawMaxBudgetUsd)
    if (!Number.isFinite(maxBudgetUsd) || maxBudgetUsd <= 0) {
      console.error(red(`Error: --max-budget-usd must be a positive number (got "${rawMaxBudgetUsd}")`))
      process.exit(1)
    }
  }

  return {
    mode:       rawMode as SessionMode,
    modeExplicit,
    workspace,
    hardwareId: undefined,   // set later via interactive selection
    apiKey:     parsed.values['api-key']  as string | undefined,
    baseUrl:    parsed.values['base-url'] as string | undefined,
    model:      parsed.values['model']    as string | undefined,
    fallbackModel: parsed.values['fallback-model'] as string | undefined,
    system:     parsed.values['system']   as string | undefined,
    json:       parsed.values['json']     as boolean,
    debug:      parsed.values['debug']    as boolean,
    showThinking: parsed.values['show-thinking'] as boolean,
    yes:        parsed.values['yes']      as boolean,
    autoWorktreeCleanup: rawCleanup as AutoWorktreeCleanupStrategy | undefined,
    prompt:     promptParts.length > 0 ? promptParts.join(' ') : null,
    maxTurns,
    maxBudgetUsd,
    resume:     parsed.values['resume']   as string | undefined,
    sessionDir,
    loopCommand: null,
  }
}

/**
 * Build CliOptions for a `loop` / `loop-scheduler` invocation. Only the backend
 * essentials are parsed from the pre-`loop` global flags; everything after the
 * `loop` token is handed verbatim to runLoopCli, which does its own flag parsing.
 */
function buildLoopCliOptions(
  name: 'loop' | 'loop-scheduler',
  globalArgs: string[],
  loopArgs: string[],
): CliOptions {
  let g: ReturnType<typeof parseArgs>
  try {
    g = parseArgs({
      args: globalArgs,
      options: {
        workspace:  { type: 'string', short: 'w' },
        'api-key':  { type: 'string', short: 'k' },
        'base-url': { type: 'string', short: 'b' },
        model:      { type: 'string' },
        json:       { type: 'boolean', short: 'j', default: false },
      },
      strict: false,
      allowPositionals: true,
    })
  } catch (err) {
    console.error(red(`Error: ${terminalText(err instanceof Error ? err.message : String(err))}`))
    process.exit(1)
  }
  const rawWorkspace = g.values['workspace'] as string | undefined
  let workspace: string | undefined
  if (rawWorkspace) {
    workspace = resolve(rawWorkspace)
    if (!existsSync(workspace) || !statSync(workspace).isDirectory()) {
      console.error(red(`Error: workspace "${workspace}" does not exist or is not a directory.`))
      process.exit(1)
    }
  }
  return {
    mode: 'auto',   // loop seats run unattended on the auto base
    modeExplicit: true,
    workspace,
    hardwareId: undefined,
    apiKey:  g.values['api-key']  as string | undefined,
    baseUrl: g.values['base-url'] as string | undefined,
    model:   g.values['model']    as string | undefined,
    fallbackModel: undefined,
    system: undefined,
    json:   g.values['json'] as boolean,
    debug: false,
    showThinking: false,
    yes: true,
    autoWorktreeCleanup: undefined,
    prompt: null,
    maxTurns: undefined,
    maxBudgetUsd: undefined,
    resume: undefined,
    sessionDir: undefined,
    loopCommand: { name, args: loopArgs },
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Strip surrounding quotes and non-ASCII chars that break HTTP headers */
function sanitizeKey(key: string): string {
  // Remove Unicode curly quotes, regular quotes, and leading/trailing whitespace
  return key.replace(/^[“”‘’"'\s]+|[“”‘’"'\s]+$/g, '')
}

/**
 * Sanitize and validate a single key string.
 * Returns the cleaned key, or exits the process on invalid characters.
 */
function validateKey(raw: string, label: string): string {
  const clean = sanitizeKey(raw)
  if (clean !== raw) {
    console.warn(yellow(`⚠  ${label} 含有首尾引号/空白，已自动清除。`))
  }
  for (let i = 0; i < clean.length; i++) {
    if (clean.charCodeAt(i) > 255) {
      console.error(red(
        `Error: ${label} 包含无效字符（位置 ${i}, ` +
        `U+${clean.charCodeAt(i).toString(16).toUpperCase()}）。` +
        `请重新导出 API key，不要包含引号。`,
      ))
      process.exit(1)
    }
  }
  return clean
}

/**
 * Sanitize all provider API key env vars in-place so detectProvider()
 * reads clean values without routing interference.
 * Also handles the explicit --api-key CLI flag.
 *
 * Rule: env-var keys stay in process.env — detectProvider() reads them
 * directly for correct provider + baseURL selection.
 * Only an explicit --api-key flag is forwarded as cfg.apiKey.
 */
function sanitizeEnvKeys(): void {
  for (const k of ['ZHIPU_API_KEY', 'ZAI_API_KEY', 'GLM_API_KEY', 'DEEPSEEK_API_KEY', 'ANTHROPIC_API_KEY', 'QWEN_API_KEY'] as const) {
    const raw = process.env[k]
    if (raw) process.env[k] = validateKey(raw, k)
  }
}

/**
 * Return an explicit --api-key value for cfg.apiKey injection.
 * Returns undefined when the key came only from env vars — in that case
 * detectProvider() will pick up the correct provider and baseURL automatically.
 */
function resolveExplicitApiKey(opts: CliOptions): string | undefined {
  if (!opts.apiKey) return undefined
  return validateKey(opts.apiKey, '--api-key')
}

function assertApiKeyConfigured(opts: CliOptions): void {
  const explicitApiKey = resolveExplicitApiKey(opts)
  if (explicitApiKey) opts.apiKey = explicitApiKey
  // Mirror resolveConfig()'s precedence (file > CLI/env): the global config file
  // (~/.meta-agent/config.json) may supply apiKey / baseURL / model. Without
  // folding it in here, a valid config-file key would be wrongly rejected at the
  // startup gate even though the session would later resolve it fine.
  const file = loadModelConfig({ projectDir: opts.workspace })
  const detected = detectProvider({
    apiKey:  file.apiKey  ?? explicitApiKey,
    baseURL: file.baseURL ?? opts.baseUrl,
    model:   file.mainModel ?? opts.model,
  })
  if (detected.apiKey) return

  console.error(
    red('Error: API key is required before starting a session.') + '\n' +
    dim('Set one of these environment variables, or pass --api-key:') + '\n' +
    `  ${cyan('export ZHIPU_API_KEY="..."')} ${dim('(default provider — glm-5.2)')}\n` +
    `  ${cyan('export DEEPSEEK_API_KEY="sk-..."')}\n` +
    `  ${cyan('export QWEN_API_KEY="sk-..."')}\n` +
    `  ${cyan('export ANTHROPIC_API_KEY="sk-..."')}\n` +
    `  ${cyan('meta-agent --api-key sk-... "your prompt"')}\n`,
  )
  process.exit(1)
}

// ── Workspace helpers ─────────────────────────────────────────────────────────

/** Prompt the user to confirm or enter a working directory (interactive only) */
async function confirmWorkspace(suggested: string, existingRl?: readline.Interface): Promise<string> {
  const ownRl = existingRl == null
  if (ownRl) process.stdin.resume()
  const rl = existingRl ?? createInterface({ input: process.stdin, output: process.stdout, terminal: isTTY })
  try {
    process.stdout.write(
      `\n${yellow('⚠  工作目录未指定')}\n` +
      `Agent 将只能在指定目录内读写文件。\n\n` +
      `${dim('当前目录:')} ${cyan(suggested)}\n`,
    )
    const line = await askQuestion(rl, `直接回车确认，或输入其他路径: `)
    const input = line.trim()
    if (!input) return suggested
    const abs = resolve(input)
    if (!existsSync(abs) || !statSync(abs).isDirectory()) {
      console.error(red(`路径不存在或不是目录: ${abs}`))
      process.exit(1)
    }
    return abs
  } finally {
    if (ownRl) rl.close()
  }
}

/** Build the workspace constraint block injected into system prompt */
function buildWorkspaceSystemPrompt(workspace: string): string {
  return [
    `## 工作目录约束 (WORKSPACE CONSTRAINT)`,
    ``,
    `你的工作目录被严格限定为：`,
    `  ${workspace}`,
    ``,
    `**强制规则：**`,
    `- 所有文件读写、创建、删除操作必须在此目录内进行`,
    `- 禁止访问或修改此目录以外的任何文件`,
    `- 禁止使用绝对路径指向此目录以外的位置`,
    `- 禁止使用 "../" 等方式跳出工作目录`,
    `- 如需操作当前目录外的文件，必须明确告知用户并请求确认`,
    ``,
    `违反以上规则被视为高危操作，必须拒绝执行。`,
  ].join('\n')
}

// ── Hardware profile helpers ──────────────────────────────────────────────────

/** Ask the user a question and return their answer */
const nativeQuestionInterfaces = new WeakSet<readline.Interface>()

function isNativeQuestionActive(rl: readline.Interface): boolean {
  return nativeQuestionInterfaces.has(rl)
}

async function askQuestion(rl: readline.Interface, question: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('interactive input cancelled before it was shown'))
      return
    }
    process.stdin.resume()
    nativeQuestionInterfaces.add(rl)
    // With a signal, readline cancels the pending question on abort — the
    // callback never fires and the interface is free for the next prompt.
    // Without this, a timed-out ask_user leaves a zombie question that
    // swallows the user's next input line (seen after Distill completion).
    if (signal) {
      const onAbort = (): void => {
        nativeQuestionInterfaces.delete(rl)
        process.stdout.write('\n')
        reject(new Error('interactive input timed out or was cancelled; treat this question as unresolved'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      rl.question(question, { signal }, answer => {
        signal.removeEventListener('abort', onAbort)
        queueMicrotask(() => nativeQuestionInterfaces.delete(rl))
        resolve(answer.trim())
      })
      return
    }
    rl.question(question, answer => {
      queueMicrotask(() => nativeQuestionInterfaces.delete(rl))
      resolve(answer.trim())
    })
  })
}

/**
 * Interactively select or create a hardware profile for a robotics session.
 * Loads the active ProfileTemplate (project → global → default).
 * Returns the profile name that was selected/created, plus formatted text for prompt injection.
 *
 * @param existingRl - Pass the REPL's readline interface when calling from inside the REPL
 *   loop so we never have two readline instances sharing stdin simultaneously.  When omitted
 *   (e.g. the initial call before the loop starts) a new interface is created and closed.
 */
async function selectHardwareProfile(
  hp: HardwareProfile,
  projectDir?: string,
  existingRl?: readline.Interface,
): Promise<{ name: string; profileText: string }> {
  const [profiles, template] = await Promise.all([
    hp.list(),
    resolveTemplate(projectDir),
  ])

  // Re-use the caller's readline interface if provided — creating a second interface
  // on the same stdin while one is already active causes both to fight over input and
  // the wizard exits immediately without reading any keystrokes.
  const ownRl = existingRl == null
  if (ownRl) process.stdin.resume()
  const rl = existingRl ?? createInterface({ input: process.stdin, output: process.stdout, terminal: isTTY })

  try {
    if (profiles.length === 0) {
      // No profiles — must create one
      console.log(
        `\n${yellow('⚠  暂无硬件配置文件')}\n` +
        `robotics 模式需要绑定一个硬件配置。\n` +
        `请填写以下信息创建第一个配置（* 为必填，其余直接回车跳过）：\n`,
      )
      return createHardwareProfile(rl, hp, template)
    }

    if (profiles.length === 1) {
      // Single profile — auto-select with confirmation
      const name = profiles[0]!
      const profileText = await hp.formatForPrompt(name)
      console.log(`\n${dim('检测到唯一硬件配置:')} ${cyan(name)}`)
      const confirm = await askQuestion(rl, `使用此配置？[Y/n] `)
      if (confirm.toLowerCase() === 'n') {
        // Offer to create a new one instead
        const createNew = await askQuestion(rl, `新建一个配置？[y/N] `)
        if (createNew.toLowerCase() === 'y') {
          return createHardwareProfile(rl, hp, template)
        }
        console.log(dim('已跳过，将在无硬件约束下运行。'))
        return { name: '', profileText: '' }
      }
      console.log(green(`✓ 已绑定硬件配置: ${name}\n`))
      return { name, profileText }
    }

    // Multiple profiles — show numbered list
    console.log(`\n${bold('选择此会话使用的硬件配置:')}\n`)
    profiles.forEach((name, i) => {
      console.log(`  ${cyan(String(i + 1))}.  ${name}`)
    })
    console.log(`  ${cyan(String(profiles.length + 1))}.  ${dim('新建配置')}`)
    console.log(`  ${cyan('0')}.  ${dim('跳过（不绑定硬件）')}\n`)

    const answer = await askQuestion(rl, `请输入序号 [0-${profiles.length + 1}]: `)
    const idx = parseInt(answer, 10)

    if (idx === 0 || isNaN(idx)) {
      console.log(dim('\n已跳过硬件绑定。\n'))
      return { name: '', profileText: '' }
    }

    if (idx === profiles.length + 1) {
      return createHardwareProfile(rl, hp, template)
    }

    if (idx >= 1 && idx <= profiles.length) {
      const name = profiles[idx - 1]!
      const profileText = await hp.formatForPrompt(name)
      console.log(green(`\n✓ 已绑定硬件配置: ${name}\n`))
      return { name, profileText }
    }

    console.log(yellow('无效输入，跳过硬件绑定。'))
    return { name: '', profileText: '' }
  } finally {
    // Only close if we created the interface ourselves
    if (ownRl) rl.close()
  }
}

/**
 * Guided wizard to create a new HardwareProfileData and persist it.
 * Uses a ProfileTemplate so field prompts, defaults and presets are configurable.
 * Returns name + formatted text.
 */
async function createHardwareProfile(
  rl: readline.Interface,
  hp: HardwareProfile,
  template: ProfileTemplate,
): Promise<{ name: string; profileText: string }> {
  console.log(`\n${bold('新建硬件配置')} ${dim('(* 必填，直接回车使用括号内默认值)')}\n`)

  // ── Step 1: optional preset selection ──────────────────────────────────────
  const presets = template.presets ?? []
  let presetDefaults: Record<string, unknown> = {}

  if (presets.length > 0) {
    console.log(`${dim('可选预设（选择后自动填充字段，仍可逐项覆盖）:')}\n`)
    presets.forEach((p, i) => console.log(`  ${cyan(String(i + 1))}.  ${p.label}`))
    // Always show an explicit "custom" option so it's clear you can type freely
    const customIdx = presets.length + 1
    console.log(`  ${cyan(String(customIdx))}.  ${dim('自定义（手动填写所有字段）')}`)
    console.log()
    const choice = await askQuestion(rl, `选择预设 [1-${customIdx}，回车跳过]: `)
    const idx = parseInt(choice, 10)
    if (!isNaN(idx) && idx >= 1 && idx <= presets.length) {
      presetDefaults = (presets[idx - 1] as ProfilePreset).defaults as Record<string, unknown>
      console.log(dim(`\n已载入预设「${presets[idx - 1]!.label}」，可逐字段覆盖。\n`))
    } else if (!isNaN(idx) && idx === customIdx) {
      console.log(dim('\n自定义模式：请逐字段手动填写。\n'))
      // presetDefaults stays empty — all fields filled from scratch
    }
    // else Enter / invalid → no preset, manual fill (same as custom)
  }

  // ── Step 2: field-by-field input driven by template ────────────────────────
  const collected: Record<string, unknown> = { ...presetDefaults }

  for (const field of template.fields) {
    const type     = field.type ?? 'text'
    const required = field.required ?? false
    const presetVal = presetDefaults[field.key]

    if (type === 'kv') {
      // key:value pairs, blank to finish
      const existing = (presetVal as Record<string, string> | undefined) ?? {}
      const kv: Record<string, string> = { ...existing }

      if (Object.keys(existing).length > 0) {
        console.log(dim(`  ${field.label} (已预填，继续添加或直接回车结束):`))
        for (const [k, v] of Object.entries(existing)) {
          console.log(dim(`    ${k}: ${v}`))
        }
      } else {
        const hint = field.hint ? ` (${dim(field.hint)})` : ''
        console.log(dim(`  ${field.label}${hint}:`))
      }
      for (;;) {
        const entry = await askQuestion(rl, `    > `)
        if (!entry) break
        const colonIdx = entry.indexOf(':')
        if (colonIdx < 1) { console.log(yellow('    格式应为 key:value，已跳过')); continue }
        kv[entry.slice(0, colonIdx).trim()] = entry.slice(colonIdx + 1).trim()
      }
      if (Object.keys(kv).length === 0) kv['limit'] = 'unset'
      collected[field.key] = kv

    } else if (type === 'csv') {
      const hint = field.hint ? ` (${dim(field.hint)})` : ''
      const prefix = required ? `${red('*')} ` : '  '
      const raw = await askQuestion(rl, `${prefix}${field.label}${hint}: `)
      const arr = raw ? raw.split(',').map(s => s.trim()).filter(Boolean) : []
      collected[field.key] = arr.length > 0 ? arr : undefined

    } else {
      // plain text — show preset default in brackets if available
      const defVal = typeof presetVal === 'string' ? presetVal : (field.default ?? '')
      const bracket = defVal ? ` ${dim(`[${defVal}]`)}` : ''
      const hint    = field.hint && !defVal ? ` ${dim(`(如 ${field.hint})`)}` : ''
      const prefix  = required ? `${red('*')} ` : '  '

      let value: string
      for (;;) {
        value = await askQuestion(rl, `${prefix}${field.label}${hint}${bracket}: `)
        if (!value && defVal)  { value = defVal; break }
        if (!value && required) { console.log(yellow(`    「${field.label}」为必填项，不能为空`)); continue }
        break
      }
      collected[field.key] = value || undefined
    }
  }

  // ── Step 3: validate name ───────────────────────────────────────────────────
  const name = collected['name'] as string | undefined
  if (!name) {
    console.log(yellow('\n名称为空，跳过硬件绑定。\n'))
    return { name: '', profileText: '' }
  }

  // ── Step 4: build & persist ─────────────────────────────────────────────────
  await hp.write({
    name,
    platform:     (collected['platform']     as string) || 'unknown',
    compute:      (collected['compute']      as string) || 'unknown',
    os:           (collected['os']           as string) || undefined,
    actuators:    (collected['actuators']    as string) || undefined,
    sensors:      (collected['sensors']      as string) || undefined,
    safetyLimits: (collected['safetyLimits'] as Record<string, string>) ?? { limit: 'unset' },
    knownIssues:  (collected['knownIssues']  as string[]) || undefined,
    notes:        buildExtraNotes(collected, template),
  })

  console.log(green(`\n✓ 硬件配置 "${name}" 已保存并绑定到本会话。\n`))
  const profileText = await hp.formatForPrompt(name)
  return { name, profileText }
}

/**
 * Any fields in the template that aren't native HardwareProfileData keys
 * are serialised as "key: value" lines and appended to notes.
 */
const NATIVE_KEYS = new Set([
  'name','platform','compute','os','actuators','sensors','safetyLimits','knownIssues','notes',
])
function buildExtraNotes(
  collected: Record<string, unknown>,
  template: ProfileTemplate,
): string | undefined {
  const baseNotes = (collected['notes'] as string | undefined) ?? ''
  const extras: string[] = []
  for (const field of template.fields) {
    if (NATIVE_KEYS.has(field.key)) continue
    const v = collected[field.key]
    if (v !== undefined && v !== '' && v !== null) {
      extras.push(`${field.label}: ${Array.isArray(v) ? v.join(', ') : String(v)}`)
    }
  }
  const combined = [baseNotes, ...extras].filter(Boolean).join('\n')
  return combined || undefined
}

/** Build the hardware profile block for injection into the system prompt */
function buildHardwareSystemPrompt(profileText: string): string {
  return [
    `## 当前会话硬件配置 (HARDWARE PROFILE — SESSION-BOUND)`,
    ``,
    `以下硬件规格在本会话中固定，所有代码、参数、安全建议须以此为准：`,
    ``,
    profileText,
    ``,
    `**重要：** 本会话仅操作上述硬件，不得假设其他硬件特性。`,
  ].join('\n')
}

// ── Sensitive operation guard ─────────────────────────────────────────────────
//
// Before executing a bash command that matches any pattern below, the CLI
// pauses and shows a three-option confirmation dialog:
//   1. 允许  — proceed
//   2. 拒绝  — block; model retries with another approach
//   3. 告诉 AI 怎么做 — user provides alternative instructions; model replans
//
// The guard is only active in interactive TTY sessions (never in --json / pipe).

/**
 * Check if a tool call should trigger the interactive guard.
 * Returns the matched label, or null if no sensitive pattern matched.
 *
 * Also catches workspace boundary violations: if `workspace` is set and the
 * bash command contains an absolute path that escapes the workspace root,
 * it is flagged as a sensitive op so the user can decide.
 */
function detectSensitiveOp(
  toolName: string,
  input: Record<string, unknown>,
  workspace?: string,
): string | null {
  if (toolName === 'write_file') return toolName
  // edit_file: in-place edits INSIDE the workspace run without confirmation
  // (the kernel permission policy still hard-denies paths outside the
  // workspace). Only guard when the target path escapes the workspace.
  if (toolName === 'edit_file') {
    const filePath = input['file_path']
    if (
      workspace &&
      typeof filePath === 'string' && filePath &&
      !filePath.startsWith(workspace) && !filePath.startsWith('/tmp')
    ) {
      return `edit_file 工作目录外路径 (${filePath.slice(0, 60)})`
    }
    return null
  }
  if (toolName === 'notebook_edit') return toolName
  // Team board mutations that change what teammates see — a human confirms
  // each. team_note is deliberately NOT here (lab-notebook append on a task
  // this unit already owns; the agent writes it directly).
  if (toolName === 'team_take') return 'team_take（领取团队任务）'
  if (toolName === 'team_mark_done') return 'team_mark_done（标记团队任务完成）'
  if (toolName !== 'bash' && toolName !== 'powershell') return null
  const cmd = String(input['command'] ?? '')
  const sensitiveLabel = detectSensitiveShellCommand(cmd)
  if (sensitiveLabel) return sensitiveLabel
  // Workspace boundary check: absolute paths that escape the workspace root
  if (workspace) {
    const cwd = input['cwd']
    if (typeof cwd === 'string' && cwd && !cwd.startsWith(workspace)) {
      return `工作目录外 cwd (${cwd.slice(0, 60)})`
    }
    const absPathPattern = /(?:^|\s|['"])(\/([\w.\-]+\/)+[\w.\-]*)/g
    let m: RegExpExecArray | null
    while ((m = absPathPattern.exec(cmd)) !== null) {
      const p = m[1]!
      if (!p.startsWith(workspace) && !p.startsWith('/tmp') && !p.startsWith('/dev')) {
        return `工作目录外路径 (${p.slice(0, 60)})`
      }
    }
  }
  return null
}

// Note: v2.0 team mode removed the path-based write guard entirely.
// Collaboration is signalled via the board (🔒 markers) rather than enforced
// by denying tool calls — see src/robotics/team/README design notes.

/**
 * Interactive three-option dialog for sensitive tool calls.
 *
 * Uses the existing REPL readline interface so there is never more than
 * one readline instance competing for stdin.
 *
 * Returns BeforeToolCallResult that MetaAgentSession will act on.
 */
async function confirmToolCall(
  rl: readline.Interface,
  toolName: string,
  input: Record<string, unknown>,
  opLabel: string,
): Promise<BeforeToolCallResult> {
  const cmd = sanitizeTerminalPreview(input['command'] ?? JSON.stringify(input), 240)
  const label = terminalText(opLabel)

  process.stdout.write(
    `\n${yellow('⚠')}  ${bold('检测到敏感操作')} ${dim(`[${label}]`)}\n` +
    `${dim('命令预览:')} ${cyan(cmd)}\n\n` +
    `  ${green('1')}. ${bold('允许')}         — 执行此操作\n` +
    `  ${red('2')}. ${bold('拒绝')}         — 跳过，让 AI 换个方式\n` +
    `  ${cyan('3')}. ${bold('告诉 AI 怎么做')} — 提供替代指导，AI 将按你的说明重新规划\n\n`,
  )

  const choice = await askQuestion(rl, `请选择 [1/2/3，回车默认允许]: `)

  if (choice.trim() === '2') {
    process.stdout.write(`${dim('已拒绝。AI 将尝试其他方式。')}\n`)
    return { action: 'deny', reason: '用户手动拒绝了此操作。' }
  }

  if (choice.trim() === '3') {
    process.stdout.write(
      `\n${dim('请输入替代指导，例如：')}\n` +
      `${dim('  "conda x1 环境中已有所需包，请用 conda run -n x1 python3 ..."')}\n` +
      `${dim('  "不要 pip install，直接 import，模块已全局安装"')}\n\n`,
    )
    const instructions = await askQuestion(rl, `你的指导 > `)
    if (instructions.trim()) {
      process.stdout.write(`\n${dim('已记录。AI 将按你的指导重新规划。')}\n`)
      return { action: 'redirect', instructions: instructions.trim() }
    }
    // Empty → fall through to allow
    process.stdout.write(`${dim('指导为空，视为允许。')}\n`)
  }

  process.stdout.write(`${dim('已允许执行。')}\n`)
  return { action: 'allow' }
}


// ── Router factory ────────────────────────────────────────────────────────────

function makeRouter(
  opts: CliOptions,
  _hardwareProfileText?: string,  // kept for call-site compat; R4 now loads hardware via cfg.robot
  rl?: readline.Interface,
  initialMessages?: ConversationMessage[],
  getRouter?: () => SessionRouter | undefined,
  /**
   * REPL-provided line reader that pulls the next user line from the REPL's
   * shared input queue. Passed so mid-turn confirmations (e.g. the multi-agent
   * escalation prompt) never read raw stdin behind readline's back — doing so
   * loses the keystroke to readline's own 'line' handler and hangs the turn.
   */
  promptLine?: (question: string) => Promise<string | null>,
  /**
   * Id of the robotics session being resumed.  Forwarded so RoboticsSession
   * binds R5 / project state to this exact session via findBySession().
   */
  resumeSessionId?: string,
): SessionRouter {
  const cfg: MetaAgentConfig & RouterOptions = {}
  // Only forward explicit --api-key; env-var keys are read by detectProvider() itself
  // so it can correctly select the provider's baseURL (DeepSeek / Qwen / Anthropic).
  const apiKey = resolveExplicitApiKey(opts)
  if (apiKey)          cfg.apiKey       = apiKey
  if (opts.baseUrl)    cfg.baseURL      = opts.baseUrl
  if (opts.model)      cfg.model        = opts.model
  if (opts.fallbackModel) cfg.fallbackModel = opts.fallbackModel
  cfg.mode = opts.mode
  // Graph tick/scheduler already enforce node, Activation-lifetime and graph
  // aggregate spend durably. Keep auto's jail, but do not reinterpret the
  // entire daemon lifetime as one $10 auto-session child budget.
  if (opts.loopCommand) cfg.subAgentBudgetOwner = 'caller'

  // Apply maxTurns: explicit flag wins; otherwise cap each user turn so a
  // single prompt cannot run for hours without a checkpoint. Auto-series modes
  // run unattended (no human to "continue" at the cap) and already have their
  // own bounds (checkpoint + drift/verify gates + AutoStallGuard + budget), so
  // they get a much higher default; attended modes (incl. robotics/campaign)
  // stay at 100.
  cfg.maxTurns =
    opts.maxTurns ?? (isAutonomousMode(cfg.mode) ? AUTO_CLI_MAX_TURNS : DEFAULT_CLI_MAX_TURNS)
  if (opts.maxBudgetUsd !== undefined) cfg.maxBudgetUsd = opts.maxBudgetUsd

  // Debug mode
  if (opts.debug) cfg.debugMode = true
  if (opts.autoWorktreeCleanup) cfg.autoWorktreeCleanup = opts.autoWorktreeCleanup

  // Robot hardware binding — forwarded to RoboticsSession so it can load the
  // hardware profile JSON and inject it via the R4 dynamic section.
  // (hardwareProfileText is no longer injected into the static system prompt to
  //  avoid duplication with R4; the robot name is enough for R4 to load it.)
  if (opts.hardwareId) cfg.robot = opts.hardwareId
  if (opts.workspace) cfg.projectDir = opts.workspace

  // Session resume: pre-load conversation history
  if (initialMessages && initialMessages.length > 0) {
    cfg.initialMessages = initialMessages
    // Signal to RoboticsSession that this is an explicit resume so R5 shows
    // the resume banner and prior progress notes.
    cfg.explicitResume = true
    // Bind R5 to the exact picked session (session-level milestone record).
    if (resumeSessionId) cfg.resumeSessionId = resumeSessionId
  }

  // Multi-agent escalation confirmation — shown when flash classifier suggests 'multi'.
  // Interrupts the streaming turn with a yes/no prompt before the first API call.
  cfg.onEscalationRequest = async (reason: string): Promise<boolean> => {
    if (opts.json) return false  // non-interactive mode: always deny
    if (opts.yes) return true    // auto-approve mode: always allow

    const banner =
      `\n${yellow('⚡ Multi-Agent 升级请求')}\n` +
      `   ${dim('理由：')}${reason}\n\n` +
      `   Multi-Agent 模式将启用并行子 Agent 编排、独立 Git 分支隔离和实验调度。\n` +
      `   单次任务费用和延迟会相应增加。\n\n` +
      `   是否升级到 Multi-Agent 模式？ ${dim('[y/N]')} `

    // Preferred path: read through the REPL's shared input queue so the answer
    // arrives via readline's normal 'line' event. Reading raw stdin here would
    // race readline for the keystroke (the prompt would hang) and leave the TTY
    // in raw mode so Ctrl-C bypasses the SIGINT handler and kills the process.
    if (promptLine) {
      const answer = await promptLine(banner)
      const confirmed = (answer ?? '').trim().toLowerCase().startsWith('y')
      process.stdout.write(confirmed ? `${green('  → 升级')}\n\n` : `${dim('  → 保持单 Agent')}\n\n`)
      return confirmed
    }

    // Fallback (no REPL readline, e.g. piped/headless): raw stdin one-shot read.
    process.stdout.write(banner)
    return new Promise<boolean>(resolve => {
      process.stdin.setRawMode?.(true)
      process.stdin.resume()
      process.stdin.setEncoding('utf8')
      const onKey = (key: string) => {
        process.stdin.setRawMode?.(false)
        process.stdin.pause()
        process.stdin.removeListener('data', onKey)
        const confirmed = key.trim().toLowerCase() === 'y'
        process.stdout.write(confirmed ? `${green('y')}\n\n` : `${dim('N')}\n\n`)
        resolve(confirmed)
      }
      process.stdin.once('data', onKey)
    })
  }

  // Build composite stable prompt suffix: workspace constraint + user system.
  // Keep the runtime's default static prompt intact; replacing systemPrompt here
  // would drop the Meta-Agent identity, execution discipline, and tool protocol.
  // NOTE: hardware profile is intentionally omitted here — RoboticsSession's R4
  // dynamic section loads it from the JSON store using cfg.robot, which avoids
  // the duplication+contradiction that occurred when both paths injected hardware.
  const workspaceBlock  = opts.workspace ? buildWorkspaceSystemPrompt(opts.workspace) : ''
  const userSystem      = opts.system ?? ''
  const composed        = [workspaceBlock, userSystem].filter(Boolean).join('\n\n')
  if (composed) cfg.appendSystemPrompt = composed

  // Change process cwd to workspace so relative paths work correctly
  if (opts.workspace) {
    try { process.chdir(opts.workspace) } catch { /* ignore */ }
  }

  if (opts.yes) {
    cfg.beforeToolCall = async () => ({ action: 'allow' })
  }

  // Register interactive tool guard — only in interactive TTY sessions.
  // Uses the REPL's existing readline interface so stdin is never double-owned.
  // v2.0 team mode no longer denies writes; coordination is observed on the board.
  if (!opts.yes && rl && !opts.json && isTTY) {
    const workspace = opts.workspace
    cfg.beforeToolCall = async (toolName, input) => {
      const opLabel = toolName === 'bash' || toolName === 'powershell'
        ? (detectSensitiveOp(toolName, input, workspace) ?? 'shell command')
        : detectSensitiveOp(toolName, input, workspace)
      if (!opLabel) return { action: 'allow' }
      return confirmToolCall(rl, toolName, input, opLabel)
    }
  }

  // Wire the ask_user tool → terminal prompt. When the model calls ask_user, the
  // CLI renders the question (+ numbered options) and reads the human's answer
  // via the REPL's readline, feeding it straight back to the model. Without this
  // the tool only returns a text placeholder (no prompt). Interactive TTY only
  // (never --json/pipe). Independent of --yes: an explicit question to the human
  // is not a "sensitive op" that auto-approve should silence.
  if (rl && !opts.json && isTTY) {
    cfg.askUser = async (question: string, options?: string[], signal?: AbortSignal) => {
      const choices = options ?? []
      process.stdout.write(
        `\n${cyan('❓')}  ${bold('AI 需要你的输入')}\n${terminalText(question)}\n`,
      )
      try {
        if (choices.length > 0) {
          process.stdout.write(
            choices.map((o, i) => `  ${green(String(i + 1))}. ${terminalText(o)}`).join('\n') + '\n\n',
          )
          const ans = await askQuestion(rl, `请选择 [1-${choices.length}] 或直接输入回答: `, signal)
          const n = Number.parseInt(ans, 10)
          if (Number.isInteger(n) && n >= 1 && n <= choices.length) return choices[n - 1]!
          return ans
        }
        return await askQuestion(rl, `你的回答 > `, signal)
      } catch (error) {
        process.stdout.write(`${yellow('⚠')} 输入等待已取消（超时或中断），该问题按未回答处理。\n`)
        throw error
      }
    }
  }

  // Inject MCP server tool-name summary into D5 (progressive disclosure).
  if (_mcpServerInstructions.length > 0) {
    cfg.mcpServers = _mcpServerInstructions
  }

  return new SessionRouter(cfg)
}

// ── Experience summary side-call ──────────────────────────────────────────────
//
// Calls the LLM in a completely isolated session (no tools, no history) to
// summarise newly proposed experience entries and guide the user toward review.
//
// This mirrors the compact side-call pattern: a fresh Anthropic client,
// client.messages.stream() with the summary task as system prompt, nothing
// written into the main session's message history.

const EXPERIENCE_SUMMARY_SYSTEM = `你是一个精炼知识的助理。
用户的 AI agent 刚刚在本轮任务中提议了若干条新的"经验条目"，尚未提交到共享知识库，需要人工审核。
你的任务：
1. 简洁地概括这些经验的核心价值与适用场景（每条一两句）
2. 判断哪些条目结论足够明确、值得提交，哪些可能还不成熟
3. 提醒用户运行 /experience review 进行逐条审核，自行决定是否提交
不要重复原始数据，只做价值判断和行动引导。回复保持简短（100-200字）。`

/**
 * Fire a one-shot LLM call to explain newly proposed experience entries.
 * Uses the same provider/apiKey as the main session but a completely separate
 * Anthropic client instance — the response is streamed to stdout only and
 * NEVER appended to the main session's message history.
 *
 * Falls back silently if no client is available or the call fails.
 */
async function streamExperienceSummary(
  router: SessionRouter,
  entries: Array<{ pendingId: string; input: Record<string, unknown> }>,
): Promise<void> {
  // Entire function is wrapped in a single try/catch so NO exception — including
  // those from getSideCallClient(), getProviderConfig(), dynamic import, or
  // entries.map() — can escape to the caller and become an unhandled rejection
  // that kills the process.
  try {
    // Build a concise JSON summary of the entries for the LLM
    const entrySummaries = entries.map((e, i) => {
      const inp = e.input
      return {
        index:   i + 1,
        title:   inp['title']   ?? '(untitled)',
        domain:  inp['domain']  ?? 'general',
        success: inp['success'] ?? true,
        problem: String(inp['problem'] ?? '').slice(0, 200),
        solution: String(inp['solution'] ?? '').slice(0, 200),
      }
    })

    const userMessage = `新提议的经验条目（共 ${entries.length} 条）：\n\n` +
      JSON.stringify(entrySummaries, null, 2)

    const { apiKey, baseURL, flashModel } = router.getProviderConfig()
    if (!apiKey) return

    if (getModelProtocol(flashModel, baseURL) === 'openai') {
      const OpenAI = (await import('openai')).default
      const client = new OpenAI({ apiKey, baseURL: baseURL ?? 'https://api.deepseek.com', maxRetries: 1, timeout: 30_000 })
      const stream = await client.chat.completions.create({
        model:      flashModel,
        max_tokens: 512,
        stream:     true,
        messages: [
          { role: 'system', content: EXPERIENCE_SUMMARY_SYSTEM },
          { role: 'user', content: userMessage },
        ],
      })

      let summaryText = ''
      for await (const chunk of stream) {
        summaryText += chunk.choices[0]?.delta?.content ?? ''
      }
      const safeSummaryText = terminalText(summaryText)
      if (safeSummaryText.trim()) {
        process.stdout.write(`\n${dim('─── 经验提议摘要 (side-call) ───────────────────────────────────')}\n`)
        process.stdout.write(safeSummaryText)
        process.stdout.write(`\n${dim('─────────────────────────────────────────────────────────────')}\n\n`)
      }
      return
    }

    // Prefer the existing side-call client (already has correct timeout/retries).
    // Fall back to building our own from the provider config.
    let client = router.getSideCallClient()
    if (!client) {
      client = new (await import('@anthropic-ai/sdk')).default({
        apiKey,
        baseURL,
        timeout:    30_000,
        maxRetries: 1,
      })
    }

    const stream = await client.messages.stream({
      model:      flashModel,
      max_tokens: 512,
      system:     EXPERIENCE_SUMMARY_SYSTEM,
      messages:   [{ role: 'user', content: userMessage }],
    })

    // Buffer output first — only print header/footer if there is actual content.
    let summaryText = ''
    for await (const event of stream) {
      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta'
      ) {
        summaryText += event.delta.text
      }
    }
    const safeSummaryText = terminalText(summaryText)
    if (safeSummaryText.trim()) {
      process.stdout.write(`\n${dim('─── 经验提议摘要 (side-call) ───────────────────────────────────')}\n`)
      process.stdout.write(safeSummaryText)
      process.stdout.write(`\n${dim('─────────────────────────────────────────────────────────────')}\n\n`)
    }
  } catch { /* best-effort — side-call failure must NEVER crash the REPL */ }
}

// ── Abnormal-termination diagnosis (flash side-call) ─────────────────────────
//
// When an unattended (auto-series) run ends in a NON-success terminal state
// (max_turns / budget / verify-exhausted / no-progress / runtime error), a bare
// reason code like "max turns" is useless to the operator — especially when the
// CLI is driven programmatically and nobody is watching the stream. We fire one
// isolated LLM call to turn the goal + termination reason + the agent's recent
// activity into a concrete "what happened / root cause / what's needed next"
// diagnosis. Same isolation as streamExperienceSummary: separate client, never
// touches the main session history, fully best-effort (returns null on any
// failure so the caller can fall back to the raw reason).

const TERMINATION_DIAGNOSIS_SYSTEM = `你是一个自主 Agent 运行的"终态诊断助手"。一次无人值守(auto)运行异常结束了。请基于【原始目标】【终止原因】【Agent 最近输出与工具轨迹】，给出简洁、可执行的诊断，而不是复述错误码。

用中文输出三段，每段 1-3 句：
1. 发生了什么：一句话说清实际卡点（不是错误码字面意思）。
2. 根因：为什么这样结束——方法在死循环、缺少外部输入(凭证/账号/权限/网络)、任务过大超步数、verify 未通过，还是真的失败。
3. 下一步：给用户最小可行动作（需要提供什么、或如何调整指令/参数重跑）。

具体、克制，不要空话，不要复述本提示或原始数据。总长控制在 200 字以内。`

/** Human-readable label for a non-success result subtype, used in the diagnosis prompt. */
function terminationReasonLabel(subtype: string): string {
  switch (subtype) {
    case 'error_max_turns':      return '达到最大步数上限（max_turns）'
    case 'error_max_budget_usd': return '超出预算/费用上限（max_budget）'
    case 'error_max_output_tokens': return '模型输出达到上限（max_output_tokens）'
    case 'error_blocking_limit': return '达到阻塞操作上限（blocking_limit）'
    case 'error_during_execution':
      return '执行中止（可能是无进展死循环、verify 未通过、被外部依赖阻塞，或运行时错误）'
    default: return subtype
  }
}

/**
 * Run a one-shot LLM diagnosis of an abnormal termination. Returns the analysis
 * text, or null if no client is available / the call fails. Prints nothing — the
 * caller decides how to surface it (text block vs JSON event).
 */
async function analyzeAbnormalTermination(
  router: SessionRouter,
  opts: { goal: string; subtype: string; recentText: string; toolTrail: string[] },
): Promise<string | null> {
  try {
    const { apiKey, baseURL, flashModel } = router.getProviderConfig()
    if (!apiKey) return null

    const trail = opts.toolTrail.length ? opts.toolTrail.slice(-30).join('\n') : '（无）'
    const recent = opts.recentText.trim() ? opts.recentText.slice(-4000) : '（无可见输出）'
    const userMessage =
      `【原始目标】\n${opts.goal.slice(0, 2000)}\n\n` +
      `【终止原因】\n${terminationReasonLabel(opts.subtype)}\n\n` +
      `【Agent 最近输出（截断）】\n${recent}\n\n` +
      `【最近工具调用轨迹（截断）】\n${trail}`

    let text = ''
    if (getModelProtocol(flashModel, baseURL) === 'openai') {
      const OpenAI = (await import('openai')).default
      const client = new OpenAI({ apiKey, baseURL: baseURL ?? 'https://api.deepseek.com', maxRetries: 1, timeout: 30_000 })
      const res = await client.chat.completions.create({
        model: flashModel,
        max_tokens: 600,
        messages: [
          { role: 'system', content: TERMINATION_DIAGNOSIS_SYSTEM },
          { role: 'user', content: userMessage },
        ],
      })
      text = res.choices[0]?.message?.content ?? ''
    } else {
      let client = router.getSideCallClient()
      if (!client) {
        client = new (await import('@anthropic-ai/sdk')).default({ apiKey, baseURL, timeout: 30_000, maxRetries: 1 })
      }
      const res = await client.messages.create({
        model: flashModel,
        max_tokens: 600,
        system: TERMINATION_DIAGNOSIS_SYSTEM,
        messages: [{ role: 'user', content: userMessage }],
      })
      text = res.content.map(b => (b.type === 'text' ? b.text : '')).join('')
    }
    const safe = terminalText(text).trim()
    return safe || null
  } catch {
    return null // best-effort — diagnosis failure must NEVER crash the run
  }
}

// ── Session title generation (flash side-call) ───────────────────────────────
//
// The session picker previously showed the raw first user prompt (often a long
// rambling sentence). A flash side-call distills the session into a ≤16-char
// title after the first turn, refreshed every 40 messages as the task evolves.
// Same isolation pattern as streamExperienceSummary: separate client, nothing
// enters the main session history; failures are silently ignored.

const SESSION_TITLE_SYSTEM = `你是会话标题生成器。根据给出的工程会话内容，输出一个简短中文标题，概括这个会话的**任务目标**——用户最终想达成什么，而不是聊天话题或第一句话的复述。
要求：不超过 16 个字；优先"对象+目标"结构（如"双足步态对称性优化"、"机械臂抓取成功率提升"）；
只输出标题本身——不要引号、书名号、句号、解释或任何前后缀。`

function sanitizeSessionTitle(raw: string): string | null {
  const firstLine = raw.split('\n').map(l => l.trim()).find(Boolean) ?? ''
  const stripped = firstLine
    .replace(/^["'《【「『\s]+|["'》】」』。．.\s]+$/g, '')
    .replace(/\s+/g, ' ')
  if (!stripped) return null
  return sanitizeTerminalText(stripped.slice(0, 32))
}

/**
 * Deterministic fallback when the flash side-call fails: take the first real
 * user message and cut it at the first sentence boundary (then clause
 * boundary), clamped to 20 chars. Guarantees every session gets SOME concise
 * title even with no flash model available.
 */
function fallbackSessionTitle(messages: readonly ConversationMessage[]): string | null {
  for (const m of messages) {
    if (m.role !== 'user') continue
    const text = renderPromptContent(m.content)
    if (!text || text.startsWith('[Local resume summary]') || text.startsWith('[tool_')) continue
    let candidate = text.split(/[。！？!?\n]/)[0] ?? ''
    if (candidate.length > 20) candidate = candidate.split(/[，,；;：:]/)[0] ?? candidate
    candidate = candidate.replace(/\s+/g, ' ').trim().slice(0, 20)
    return candidate ? sanitizeTerminalText(candidate) : null
  }
  return null
}

async function generateSessionTitle(router: SessionRouter): Promise<string | null> {
  try {
    const messages = router.getMessages()
    const userTexts: string[] = []
    let lastAssistant = ''
    for (const m of messages) {
      const text = renderPromptContent(m.content)
      if (!text || text.startsWith('[Local resume summary]') || text.startsWith('[tool_')) continue
      if (m.role === 'user') userTexts.push(text)
      else if (m.role === 'assistant') lastAssistant = text
    }
    if (userTexts.length === 0) return null

    const input = [
      `首条用户消息：${userTexts[0]!.slice(0, 300)}`,
      ...(userTexts.length > 1
        ? [`最近用户消息：${userTexts.slice(-3).map(t => t.slice(0, 150)).join(' / ')}`]
        : []),
      ...(lastAssistant ? [`最近助手回复（摘）：${lastAssistant.slice(0, 200)}`] : []),
    ].join('\n')

    const { apiKey, baseURL, flashModel } = router.getProviderConfig()
    if (!apiKey) return null

    if (getModelProtocol(flashModel, baseURL) === 'openai') {
      const OpenAI = (await import('openai')).default
      const client = new OpenAI({ apiKey, baseURL: baseURL ?? 'https://api.deepseek.com', maxRetries: 1, timeout: 30_000 })
      const response = await client.chat.completions.create({
        model: flashModel,
        max_tokens: 48,
        messages: [
          { role: 'system', content: SESSION_TITLE_SYSTEM },
          { role: 'user', content: input },
        ],
      })
      return sanitizeSessionTitle(response.choices[0]?.message?.content ?? '')
    }

    let client = router.getSideCallClient()
    if (!client) {
      client = new (await import('@anthropic-ai/sdk')).default({ apiKey, baseURL, timeout: 30_000, maxRetries: 1 })
    }
    const response = await client.messages.create({
      model: flashModel,
      max_tokens: 48,
      system: SESSION_TITLE_SYSTEM,
      messages: [{ role: 'user', content: input }],
    })
    const text = response.content
      .filter(b => b.type === 'text')
      .map(b => (b as { type: 'text'; text: string }).text).join('')
    return sanitizeSessionTitle(text)
  } catch {
    return null   // best-effort — title generation must never disturb the REPL
  }
}

/** Picker display: prefer the generated title; fall back to the prompt preview. */
function sessionDisplayTitle(s: SessionMeta, previewLimit: number): string {
  const title = s.title?.trim()
  if (title) return sanitizeTerminalText(title)
  return sessionPromptPreview(s.firstPrompt, previewLimit)
}

// ── Stream a single prompt ────────────────────────────────────────────────────

const DEFAULT_CLI_MAX_VISIBLE_CHARS = 50_000

function getCliMaxVisibleChars(): number {
  return RuntimeEnv.cliMaxVisibleChars(DEFAULT_CLI_MAX_VISIBLE_CHARS)
}

/** Mask credential-like values so `env` never prints a secret in full. */
function maskEnvValue(name: string, value: string): string {
  if (/KEY|TOKEN|SECRET|PASSWORD/i.test(name)) {
    return value.length <= 4 ? '****' : `${value.slice(0, 2)}…${value.slice(-2)} (set)`
  }
  return value
}

/**
 * Print the environment-variable config surface from ENV_REGISTRY: the single
 * source of truth (name / type / current effective value / default / purpose).
 * Env vars are read live from process.env — they are NOT stored in any file.
 */
function printEnvTable(asJson: boolean): void {
  const rows = ENV_REGISTRY.map(e => {
    const raw = process.env[e.name]
    const current = raw === undefined || raw === '' ? null : maskEnvValue(e.name, raw)
    return { name: e.name, type: e.type, current, default: e.default, description: e.description }
  })

  if (asJson) {
    console.log(JSON.stringify(rows, null, 2))
    return
  }

  const headers = ['ENV VAR', 'TYPE', 'CURRENT', 'DEFAULT', 'DESCRIPTION']
  const data = rows.map(r => [r.name, r.type, r.current ?? '(unset)', r.default, r.description])
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...data.map(row => row[i]!.length)),
  )
  // Pad on RAW strings (ANSI escapes would corrupt width math), THEN colorize.
  const pad = (s: string, w: number): string => s + ' '.repeat(Math.max(0, w - s.length))

  console.log(bold('meta-agent environment variables') +
    dim('  (read live from process.env — not stored in any file)'))
  console.log()
  console.log(cyan(headers.map((h, i) => pad(h, widths[i]!)).join('  ').trimEnd()))
  console.log(dim(widths.map(w => '─'.repeat(w)).join('  ')))
  for (const row of data) {
    const c = row.map((cell, i) => pad(cell!, widths[i]!))
    const isSet = row[2] !== '(unset)'
    console.log([
      c[0],
      dim(c[1]!),
      isSet ? c[2] : dim(c[2]!),
      c[3],
      dim(c[4]!),
    ].join('  ').trimEnd())
  }
  console.log()
  console.log(dim('Set via the shell/launcher (e.g. export META_AGENT_TOOL_TIMEOUT_MS=60000). ' +
    'Provider keys (ZHIPU_API_KEY, …) are resolved separately by the provider registry.'))
}

async function safeStdoutWrite(text: string): Promise<void> {
  if (!text) return
  if (process.stdout.write(text)) return
  await once(process.stdout, 'drain')
}

/**
 * Hooks that let the REPL steer the model mid-turn (Ctrl+G). The CLI's stdin
 * listener arms a correction; streamPrompt pauses output (without aborting the
 * stream), reads one line of guidance, and forwards it to router.steer().
 */
interface SteerHooks {
  /** Resolves when a steer has been armed (Ctrl+G); immediate if already armed. */
  waitArmed: () => Promise<void>
  /** Synchronous armed check, so an already-armed steer can pre-empt a resolved
   *  pending event instead of losing the Promise.race to it. */
  isArmed: () => boolean
  /** Clear the armed flag after servicing a steer prompt. */
  consume: () => void
  /**
   * Hand the input line over to readline with a `steer ›` prompt and render it.
   * Required so readline owns the prompt — otherwise its own `you ›` prompt
   * redraws over a manually printed one the moment the user types.
   */
  beginInput: () => void
  /** Read one line of correction text (null on EOF). */
  read: () => Promise<string | null>
  /** Restore the normal `you ›` prompt after the correction line is read. */
  endInput: () => void
}

// ── Active thinking-meter registry ────────────────────────────────────────────
// streamPrompt owns a ThinkingMeter that redraws an in-place status line on a
// 120ms timer. When an interactive prompt must appear mid-turn (e.g. the
// multi-agent escalation confirmation), that timer erases the prompt on its next
// tick — the user is left staring at the "等待模型响应…" spinner with no visible
// question, and a blind <Enter> silently declines. streamPrompt registers its
// meter here so any mid-turn prompt reader can pause the spinner first; the
// stream's own event handlers re-show it when the next model event arrives.
let _activeThinkingMeter: ThinkingMeter | null = null
let _suppressActiveThinkingMeter = false
function pauseActiveThinkingMeter(): void {
  _activeThinkingMeter?.hide()
}
function setActiveThinkingMeterSuppressed(suppressed: boolean): void {
  _suppressActiveThinkingMeter = suppressed
  if (suppressed) pauseActiveThinkingMeter()
}
function canShowActiveThinkingMeter(): boolean {
  return !_suppressActiveThinkingMeter
}

interface StreamPromptSession {
  submit(prompt: string): AsyncGenerator<MetaAgentEvent>
  steer(text: string): boolean
  getEstimatedCost(): number
  readonly mode: SessionMode | null
}

interface StreamPromptResult {
  text: string
  result?: MetaAgentResultEvent
}

async function streamPrompt(
  router: StreamPromptSession,
  prompt: string,
  jsonMode: boolean,
  showThinking = false,
  steerHooks?: SteerHooks,
): Promise<StreamPromptResult> {
  const gen = router.submit(prompt)
  const steering = steerHooks ?? null
  let hasText = false
  let thinkingOpen = false   // whether we're currently inside a thinking block
  // Captured for abnormal-termination diagnosis (auto-series): the agent's
  // recent narration + a compact trail of tool calls, fed to a one-shot LLM
  // analysis when the run ends in a non-success terminal state. Accumulated in
  // BOTH json and text paths (see the event loop below).
  let recentAgentText = ''
  let capturedText = ''
  let terminalResult: MetaAgentResultEvent | undefined
  const recentToolTrail: string[] = []
  let visibleChars = 0
  let visibleTruncated = false
  const visibleLimit = getCliMaxVisibleChars()
  const outputSanitizer = new TerminalSanitizer()

  // ── Live reasoning indicator ──────────────────────────────────────────────
  // Reasoning models stream their chain of thought before any visible answer.
  // When that text is hidden the terminal would otherwise look frozen during a
  // long reasoning phase, so we draw a single in-place status line (spinner +
  // elapsed time + estimated reasoning tokens). A timer advances the spinner so
  // it stays alive even while waiting for the first token. Disabled outside an
  // interactive TTY (and in --json mode) so it never pollutes piped output.
  const meterEnabled = isTTY && !jsonMode
  const meter = new ThinkingMeter({ enabled: meterEnabled })
  let meterTimer: ReturnType<typeof setInterval> | null = null
  if (meterEnabled) {
    if (canShowActiveThinkingMeter()) meter.show()
    meterTimer = setInterval(() => {
      if (canShowActiveThinkingMeter()) meter.tick()
    }, 120)
    if (typeof meterTimer.unref === 'function') meterTimer.unref()
  }
  // Expose this turn's meter so mid-turn interactive prompts can pause the
  // spinner before printing (otherwise the timer redraws over the question).
  _activeThinkingMeter = meter

  async function writeVisible(text: string): Promise<void> {
    if (!text || visibleTruncated) return
    const safeText = outputSanitizer.sanitize(text)
    if (!safeText) return
    const remaining = visibleLimit - visibleChars
    if (remaining <= 0) {
      visibleTruncated = true
      await safeStdoutWrite(`\n${yellow('⚠')}  ${yellow('本轮终端输出已达到显示上限，后续内容已隐藏。')} ${dim('完整上下文仍保留在会话历史中。')}\n`)
      return
    }
    const chunk = safeText.length > remaining ? safeText.slice(0, remaining) : safeText
    visibleChars += chunk.length
    await safeStdoutWrite(chunk)
    if (chunk.length < safeText.length) {
      visibleTruncated = true
      await safeStdoutWrite(`\n${yellow('⚠')}  ${yellow('本轮终端输出已达到显示上限，后续内容已隐藏。')} ${dim('完整上下文仍保留在会话历史中。')}\n`)
    }
  }

  // ── Thinking block helpers ────────────────────────────────────────────────
  async function openThinkingBlock(): Promise<void> {
    if (thinkingOpen) return
    await safeStdoutWrite(
      `\n${dim('┌─ 思考中 ──────────────────────────────────────────────────────')}\n`,
    )
    thinkingOpen = true
  }
  async function closeThinkingBlock(): Promise<void> {
    if (!thinkingOpen) return
    await safeStdoutWrite(
      `\n${dim('└───────────────────────────────────────────────────────────────')}\n`,
    )
    thinkingOpen = false
  }

  try {
    // Manual drive (instead of `for await`) so a Ctrl+G steer can be serviced
    // even while we're blocked waiting for the next event during a long
    // reasoning phase. We race the pending event against the steer signal; if
    // steering wins we pause, collect a correction, inject it, then re-race the
    // SAME pending event — so the model is never aborted, only back-pressured.
    let pending = gen.next()
    while (true) {
      // An already-armed steer must pre-empt the next event. During a heavy
      // reasoning phase `pending` is almost always already resolved, so a plain
      // Promise.race would keep choosing it (it sits first in the array) and the
      // armed steer would be starved — the symptom being a flickering meter and a
      // `steer ›` prompt that never holds. Check the armed flag synchronously
      // first; only race when nothing is armed yet.
      const raced = steering
        ? (steering.isArmed()
            ? ('__steer__' as const)
            : await Promise.race([pending, steering.waitArmed().then(() => '__steer__' as const)]))
        : await pending

      if (raced === '__steer__') {
        steering!.consume()
        meter.hide()
        await safeStdoutWrite(
          `\n${yellow('⏸ 已暂停输出')} ${dim('输入纠正指令并回车注入（直接回车取消）:')}\n`,
        )
        // Hand the line to readline with a `steer ›` prompt so it renders and
        // owns the input — otherwise readline's own `you ›` prompt redraws over
        // a manually printed one the instant the user types.
        steering!.beginInput()
        let correction: string | null
        try {
          correction = await steering!.read()
        } finally {
          steering!.endInput()
        }
        const trimmed = (correction ?? '').trim()
        if (trimmed) {
          const ok = router.steer(trimmed)
          await safeStdoutWrite(
            ok
              ? `${green('✓')} ${dim('纠正已加入队列，将在下个步骤边界注入，不中断当前生成。')}\n`
              : `${yellow('·')} ${dim('当前没有进行中的回合，已忽略该纠正。')}\n`,
          )
        } else {
          await safeStdoutWrite(`${dim('已取消，继续。')}\n`)
        }
        if (meterEnabled && canShowActiveThinkingMeter()) meter.show()
        continue
      }

      const step = raced
      if (step.done) break
      const event = step.value
      pending = gen.next()

      // Accumulate recent agent activity for abnormal-termination diagnosis
      // (runs in BOTH json and text modes, before any mode-specific handling).
      if (event.type === 'text') {
        capturedText += event.text
        recentAgentText += event.text
        if (recentAgentText.length > 8000) recentAgentText = recentAgentText.slice(-8000)
      } else if (event.type === 'tool_use') {
        recentToolTrail.push(`${event.toolName} ${JSON.stringify(event.toolInput).slice(0, 80)}`)
        if (recentToolTrail.length > 40) recentToolTrail.shift()
      }

      if (jsonMode) {
        console.log(JSON.stringify(event))
        // Programmatic callers (e.g. a remote orchestrator) otherwise get only a
        // bare reason code on abnormal exit. Emit a follow-up diagnosis event so
        // they receive the same LLM analysis a human would see.
        if (
          event.type === 'result' && event.subtype !== 'success' &&
          isAutonomousMode(router.mode)
        ) {
          const analysis = router instanceof SessionRouter ? await analyzeAbnormalTermination(router, {
            goal: prompt, subtype: event.subtype,
            recentText: recentAgentText, toolTrail: recentToolTrail,
          }) : null
          if (analysis) {
            console.log(JSON.stringify({
              type: 'termination_analysis',
              subtype: event.subtype,
              analysis,
              sessionId: event.sessionId,
            }))
          }
        }
        continue
      }
      switch (event.type) {
        case 'thinking_delta': {
          meter.note(event.delta)
          if (showThinking) {
            meter.hide()
            await openThinkingBlock()
            await writeVisible(dim(event.delta))
          } else {
            // Keep the compact live indicator visible (it now shows a token count).
            if (canShowActiveThinkingMeter()) meter.show()
          }
          break
        }
        case 'text': {
          meter.hide()
          // Close any open thinking block before the first reply text
          await closeThinkingBlock()
          if (!hasText) {
            await safeStdoutWrite(`\n${bold(green('agent'))} › `)
            hasText = true
          }
          await writeVisible(event.text)
          break
        }
        case 'tool_use': {
          meter.hide()
          const toolName = sanitizeTerminalText(event.toolName)
          const preview = sanitizeTerminalPreview(JSON.stringify(event.toolInput), 80)
          await safeStdoutWrite(
            `\n${dim('⚙')}  ${cyan(toolName)} ${gray(preview)}\n`,
          )
          break
        }
        case 'tool_result': {
          meter.hide()
          const preview = sanitizeTerminalPreview(event.content, 120)
          await safeStdoutWrite(
            `   ${dim('→')} ${gray(preview)}${preview.length >= 120 ? gray('…') : ''}\n`,
          )
          break
        }
        case 'api_retry': {
          meter.hide()
          await safeStdoutWrite(
            `\n${yellow('⚠')}  retrying (attempt ${event.attempt}/${event.maxRetries}, delay ${event.retryDelayMs}ms)\n`,
          )
          break
        }
        case 'system_message': {
          meter.hide()
          const icon = event.subtype === 'warning' ? yellow('⚠') : dim('ℹ')
          const text = sanitizeTerminalPreview(event.text, 300)
          await safeStdoutWrite(
            `\n${icon}  ${event.subtype === 'warning' ? yellow(text) : dim(text)}\n`,
          )
          break
        }
        case 'compact_start': {
          meter.hide()
          await safeStdoutWrite(`\n${dim('🗜  会话压缩中…')}\n`)
          break
        }
        case 'compact_boundary': {
          meter.hide()
          const prev = event.previousTokens ?? 0
          const after = event.summaryTokens ?? 0
          const freed = Math.max(0, prev - after)
          const k = (n: number) => `${(n / 1000).toFixed(1)}k`
          await safeStdoutWrite(
            `${dim(`🗜  压缩完成 ${k(prev)} → ${k(after)}（释放 ${k(freed)}）`)}\n`,
          )
          break
        }
        case 'compact_failed': {
          meter.hide()
          const attempt = typeof event.attempt === 'number' ? event.attempt : 0
          const err = sanitizeTerminalPreview(event.error ?? 'unknown error', 120)
          await safeStdoutWrite(
            `\n${yellow('⚠')}  ${yellow(`会话压缩失败（第 ${attempt}/3 次），继续使用当前上下文。`)} ${dim(err)}\n`,
          )
          break
        }
        case 'result': {
          terminalResult = event
          meter.hide()
          await closeThinkingBlock()
          if (hasText) await safeStdoutWrite('\n')
          // Show explicit warnings for non-success result subtypes so the user
          // is never silently left wondering why the agent stopped.
          if (event.subtype === 'error_max_turns') {
            await safeStdoutWrite(
              `\n${yellow('⚠')}  ${yellow('已达到本轮最大步数上限。')} ` +
              `${dim('继续输入以接着分析，或用 --max-turns <n> 提高上限。')}\n`,
            )
          } else if (event.subtype === 'error_max_budget') {
            await safeStdoutWrite(
              `\n${yellow('⚠')}  ${yellow('已超出 token 预算上限。')} ` +
              `${dim('任务已提前终止。可继续输入或拆分为更小的子任务。')}\n`,
            )
          } else if (event.subtype === 'error_max_output_tokens') {
            await safeStdoutWrite(
              `\n${yellow('⚠')}  ${yellow('模型输出连续达到上限，结果可能不完整。')} ` +
              `${dim('请缩小任务范围、提高输出上限或继续该任务。')}\n`,
            )
          } else if (event.subtype === 'error_during_execution') {
            const errDetails = sanitizeTerminalText((event as { errors?: string[] }).errors?.join('\n  ') ?? '')
            await safeStdoutWrite(
              `\n${red('✗')}  ${red('执行过程中发生错误。')} ` +
              `${dim('请检查以下错误信息，调整指令后重试。')}\n` +
              (errDetails ? `${red('  错误详情：')} ${errDetails}\n` : ''),
            )
          }
          // Auto-series abnormal exit: replace the bare reason with an actual
          // LLM diagnosis (what happened / root cause / what's needed next).
          if (event.subtype !== 'success' && isAutonomousMode(router.mode)) {
            const analysis = router instanceof SessionRouter ? await analyzeAbnormalTermination(router, {
              goal: prompt, subtype: event.subtype,
              recentText: recentAgentText, toolTrail: recentToolTrail,
            }) : null
            if (analysis) {
              await safeStdoutWrite(
                `\n${dim('─── 终态诊断 (LLM) ───────────────────────────────────────────')}\n` +
                `${analysis}\n` +
                `${dim('─────────────────────────────────────────────────────────────')}\n`,
              )
            }
          }
          const usage = event.usage
          const cost  = router.getEstimatedCost()
          const mode  = router.mode ?? 'agentic'
          const modeTag = mode === 'campaign' ? cyan(mode)
                        : mode === 'agentic'  ? green(mode)
                        : mode === 'robotics' ? `${c.magenta}${mode}${c.reset}`
                        : mode === 'auto'     ? yellow(mode)
                        : mode === 'simple_auto' ? yellow(mode)
                        : gray(mode)
          const thinkTag = meter.charCount > 0
            ? `  ${gray(`think:~${meter.tokenEstimate}`)}`
            : ''
          await safeStdoutWrite(
            `\n${gray('─'.repeat(56))}\n` +
            `${modeTag}  ` +
            `${gray(`in:${usage.inputTokens} out:${usage.outputTokens}`)}${thinkTag}  ` +
            `${gray(`$${cost.toFixed(4)}`)}\n`,
          )
          break
        }
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ERR_STREAM_PREMATURE_CLOSE') return { text: capturedText, ...(terminalResult ? { result: terminalResult } : {}) }
    throw err
  } finally {
    // Always tear down the spinner timer and wipe any lingering status line —
    // including on interrupt/error paths — so it never bleeds into the prompt.
    if (meterTimer) clearInterval(meterTimer)
    meter.hide()
    if (_activeThinkingMeter === meter) _activeThinkingMeter = null
    setActiveThinkingMeterSuppressed(false)
  }
  return { text: capturedText, ...(terminalResult ? { result: terminalResult } : {}) }
}

// ── Session resume picker ─────────────────────────────────────────────────────

/**
 * Show the last N sessions and let the user choose one to resume.
 * Returns the loaded ConversationMessage[] (empty if user declines).
 */
async function runSessionPicker(
  rl: readline.Interface,
  workspace: string | undefined,
): Promise<{ sessionId: string; messages: ConversationMessage[]; mode: string } | null> {
  const sessions = await SessionStore.listSessions(8, { workspace })
  if (sessions.length === 0) return null

  console.log(`\n${bold('历史会话:')} ${dim('(仅显示当前 workspace，选择一个以继续上次对话)')}\n`)
  sessions.forEach((s, i) => {
    const ago = formatAge(Date.now() - s.lastActivity)
    const preview = sessionDisplayTitle(s, 60)
    console.log(
      `  ${cyan(String(i + 1))}. ${bold(s.mode.padEnd(10))} ` +
      `${dim(ago.padEnd(12))} ${dim(`[${s.messageCount} 条]`)}  ${preview}`,
    )
  })
  console.log(`  ${cyan('0')}.  ${dim('新建会话')}\n`)

  const choice = await askQuestion(rl, `请选择 [0-${sessions.length}，回车新建]: `)
  const idx = parseInt(choice, 10)
  if (!choice.trim() || idx === 0 || isNaN(idx) || idx < 1 || idx > sessions.length) {
    return null
  }

  const selected = sessions[idx - 1]!
  console.log(`\n${dim('加载历史会话...')}\n`)
  const messages = await SessionStore.loadHistory(selected.sessionId)
  if (messages.length === 0) {
    console.log(yellow('⚠  找不到历史记录，将新建会话。\n'))
    return null
  }
  console.log(green(`✓ 已加载 ${messages.length} 条历史消息，继续上次 ${selected.mode} 模式会话。\n`))
  return { sessionId: selected.sessionId, messages, mode: selected.mode }
}

function sessionPromptPreview(firstPrompt: string, limit: number): string {
  return sanitizeTerminalPreview(extractPromptPreviewText(firstPrompt), limit)
}

function extractPromptPreviewText(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as unknown
    const rendered = renderPromptContent(parsed)
    if (rendered) return rendered
  } catch {
    const rendered = renderTruncatedJsonPromptPreview(raw)
    if (rendered) return rendered
  }
  return raw
}

function renderTruncatedJsonPromptPreview(raw: string): string {
  const textMatch = raw.match(/"type"\s*:\s*"text"\s*,\s*"text"\s*:\s*"((?:\\.|[^"\\])*)/)
  if (textMatch?.[1]) {
    try {
      return JSON.parse(`"${textMatch[1]}"`) as string
    } catch {
      return textMatch[1]
    }
  }
  if (/"type"\s*:\s*"tool_result"/.test(raw)) return '[tool_result] historical tool output'
  if (/"type"\s*:\s*"tool_use"/.test(raw)) return '[tool_use] historical tool call'
  return ''
}

function firstPromptFromMessage(message: ConversationMessage | undefined, fallback: string): string {
  if (!message) return fallback.slice(0, 80)
  return renderPromptContent(message.content).slice(0, 80) || fallback.slice(0, 80)
}

function findSessionPreviewMessage(messages: readonly ConversationMessage[]): ConversationMessage | undefined {
  const realUser = messages.find(message => {
    if (message.role !== 'user') return false
    const meta = message as unknown as Record<string, unknown>
    if (meta['isCompactSummary'] || meta['isCompactBoundary'] || meta['sourceToolAssistantUUID']) return false
    const text = renderPromptContent(message.content)
    return text.length > 0 && !text.startsWith('[Local resume summary]')
  })
  if (realUser) return realUser

  return messages.find(message => {
    if (message.role !== 'user') return false
    return renderPromptContent(message.content).length > 0
  })
}

interface PersistSessionSnapshotOptions {
  router: SessionRouter
  opts: CliOptions
  currentInput: string
  savedMessageCount: number
  sessionRoot?: string
  skipJson?: boolean
}

async function persistSessionSnapshot({
  router,
  opts,
  currentInput,
  savedMessageCount,
  sessionRoot,
  skipJson = false,
}: PersistSessionSnapshotOptions): Promise<number> {
  if (skipJson && opts.json) return savedMessageCount
  try {
    const sessionId = router.getSessionId()
    if (!sessionId) return savedMessageCount
    const messages = router.getMessages()
    const firstUserMsg = findSessionPreviewMessage(messages)
    const firstPromptText = firstPromptFromMessage(firstUserMsg, currentInput)
    const meta = {
      mode:          router.mode ?? opts.mode,
      startTime:     Date.now(),
      lastActivity:  Date.now(),
      messageCount:  messages.length,
      firstPrompt:   firstPromptText,
      workspace:     opts.workspace,
    }
    const storeOptions = {
      ...(sessionRoot ? { rootDir: sessionRoot } : {}),
      expectedMessageCount: savedMessageCount,
    }
    if (messages.length < savedMessageCount) {
      await SessionStore.replace(sessionId, meta, messages, storeOptions)
    } else if (messages.length > savedMessageCount) {
      await SessionStore.append(sessionId, meta, messages, savedMessageCount, storeOptions)
    } else {
      return savedMessageCount
    }
    return messages.length
  } catch {
    // session save is best-effort — never crash the active run
    return savedMessageCount
  }
}

function renderPromptContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  const parts = content.map(block => {
    if (!block || typeof block !== 'object') return ''
    const item = block as Record<string, unknown>
    if (item['type'] === 'text' && typeof item['text'] === 'string') return item['text']
    if (item['type'] === 'tool_use') {
      const name = typeof item['name'] === 'string' ? item['name'] : 'tool'
      return `[tool_use: ${name}]`
    }
    if (item['type'] === 'tool_result') {
      const result = item['content']
      if (typeof result === 'string') return `[tool_result] ${result}`
      return '[tool_result]'
    }
    return ''
  }).filter(Boolean)

  return parts.join(' ').replace(/\s+/g, ' ').trim()
}

function formatAge(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60)    return `${s}秒前`
  const m = Math.floor(s / 60)
  if (m < 60)    return `${m}分钟前`
  const h = Math.floor(m / 60)
  if (h < 24)    return `${h}小时前`
  return `${Math.floor(h / 24)}天前`
}

// ── Experience review ─────────────────────────────────────────────────────────

/**
 * Interactive review of pending experience entries.
 * Shows each entry in turn; user can approve (y), discard (n), or skip (s).
 * Returns the count of committed entries.
 */
async function reviewPendingExperiences(
  rl: readline.Interface,
  pending: ExperiencePendingStore,
  store: ExperienceStore,
  onCommitted?: (experienceId: string) => Promise<void>,
): Promise<number> {
  const entries = [...pending.list()]
  if (entries.length === 0) {
    console.log(dim('\n暂无待审经验条目。\n'))
    return 0
  }

  console.log(
    `\n${bold('经验审核')} ${dim(`(${entries.length} 条待审)`)}\n` +
    `${dim('每条经验由 AI 在本次会话中提议，需要你审核后才会写入共享知识库。')}\n`,
  )

  let committed = 0
  for (const entry of entries) {
    const input = entry.input
    const title   = String(input['title'] ?? '(无标题)')
    const problem = String(input['problem'] ?? '').slice(0, 200)
    const solution = String(input['solution'] ?? '').slice(0, 200)
    const success = Boolean(input['success'])
    const domain  = String(input['domain'] ?? 'general')
    const tags    = (input['tags'] as string[] | undefined)?.join(', ') ?? ''

    console.log(
      `\n${'─'.repeat(60)}\n` +
      `${bold(title)} ${dim(`[${domain}]`)} ${success ? green('✅ 成功') : red('❌ 失败')}\n` +
      `${dim('问题:')} ${problem}\n` +
      `${dim('方案:')} ${solution}\n` +
      (tags ? `${dim('标签:')} ${tags}\n` : '') +
      `${'─'.repeat(60)}\n`,
    )

    const choice = await askQuestion(rl, `提交 [y=是 / n=丢弃 / s=跳过]: `)
    if (choice.toLowerCase() === 'y' || choice.toLowerCase() === 'yes') {
      const id = await pending.commit(entry.pendingId, store)
      if (id) {
        console.log(green(`  ✓ 已提交 (ID: ${id})`))
        await onCommitted?.(id)
        committed++
      } else {
        console.log(red('  ✗ 提交失败'))
      }
    } else if (choice.toLowerCase() === 'n') {
      pending.remove(entry.pendingId)
      console.log(dim('  已丢弃'))
    } else {
      console.log(dim('  已跳过 (保留在待审队列)'))
    }
  }

  const remaining = pending.count
  if (committed > 0 || remaining > 0) {
    console.log(
      `\n${green(`✓ 已提交 ${committed} 条`)}` +
      (remaining > 0 ? `  ${yellow(`剩余 ${remaining} 条待审`)}` : '') +
      '\n',
    )
  }
  return committed
}

// ── Memory review ──────────────────────────────────────────────────────────────

/**
 * Interactive review of pending memory entries (global, all modes).
 * Each proposal was queued either by the `memory_write` tool or the
 * post-session auto-writer. Only approved entries are written to the global
 * memory directory. Returns the count of committed entries.
 */
async function reviewPendingMemories(
  rl: readline.Interface,
  pending: MemoryPendingStore,
): Promise<number> {
  const entries = [...pending.list()]
  if (entries.length === 0) {
    console.log(dim('\n暂无待审记忆条目。\n'))
    return 0
  }

  console.log(
    `\n${bold('记忆审核')} ${dim(`(${entries.length} 条待审)`)}\n` +
    `${dim('记忆仅存储用户画像 (user) 与反馈 (feedback)，需要你审核后才会写入。')}\n`,
  )

  let committed = 0
  for (const entry of entries) {
    const p = entry.proposal
    const origin = entry.origin === 'auto' ? '自动提取' : 'AI 主动'
    console.log(
      `\n${'─'.repeat(60)}\n` +
      `${bold(p.name)} ${dim(`[${p.type}]`)} ${dim(`(${origin})`)}\n` +
      `${dim('摘要:')} ${p.description}\n` +
      `${dim('正文:')} ${p.body.slice(0, 300)}${p.body.length > 300 ? '…' : ''}\n` +
      `${dim('文件:')} ${p.filename}\n` +
      `${'─'.repeat(60)}\n`,
    )

    const choice = await askQuestion(rl, `提交 [y=是 / n=丢弃 / s=跳过]: `)
    const c = choice.trim().toLowerCase()
    if (c === 'y' || c === 'yes') {
      const result = await pending.commit(entry.pendingId)
      if (result.ok) {
        console.log(green(`  ✓ 已写入记忆 (${result.filename})`))
        committed++
      } else if (result.reason === 'duplicate' || result.reason === 'exists') {
        console.log(yellow(`  ⚠ 已存在同名记忆 (${result.detail ?? p.filename})，是否覆盖更新？`))
        const overwriteChoice = await askQuestion(rl, `  覆盖 [y=覆盖 / n=丢弃]: `)
        const oc = overwriteChoice.trim().toLowerCase()
        if (oc === 'y' || oc === 'yes') {
          const overwriteResult = await pending.commit(entry.pendingId, undefined, true)
          if (overwriteResult.ok) {
            console.log(green(`  ✓ 已覆盖更新记忆 (${overwriteResult.filename})`))
            committed++
          } else {
            console.log(red(`  ✗ 覆盖失败${overwriteResult.detail ? `: ${overwriteResult.detail}` : ''}`))
          }
        } else {
          pending.remove(entry.pendingId)
          console.log(dim('  已丢弃'))
        }
      } else {
        console.log(red(`  ✗ 写入失败${result.detail ? `: ${result.detail}` : ''}`))
      }
    } else if (c === 'n') {
      pending.remove(entry.pendingId)
      console.log(dim('  已丢弃'))
    } else {
      console.log(dim('  已跳过 (保留在待审队列)'))
    }
  }
  await pending.flush()

  const remaining = pending.count
  if (committed > 0 || remaining > 0) {
    console.log(
      `\n${green(`✓ 已提交 ${committed} 条`)}` +
      (remaining > 0 ? `  ${yellow(`剩余 ${remaining} 条待审`)}` : '') +
      '\n',
    )
  }
  return committed
}

// ── Deletion (human direct + AI-proposed review) ─────────────────────────────

/**
 * Mechanism-specific glue for the generic delete handlers. Lets one pair of
 * handlers serve memory / experience / principle / anchor.
 */
interface DeletionAdapter {
  mechanism: DeletionMechanism
  /** Chinese display noun, e.g. "经验". */
  noun: string
  /** Base command, e.g. "/experience". */
  command: string
  /** List committed entries available for deletion. */
  listCommitted(): Promise<{ id: string; title: string; meta?: string }[]>
  /** Permanently delete one committed entry. Returns true on success. */
  deleteById(id: string): Promise<boolean>
}

function makeDeletionAdapter(mechanism: DeletionMechanism): DeletionAdapter {
  switch (mechanism) {
    case 'memory':
      return {
        mechanism, noun: '记忆', command: '/memory',
        async listCommitted() {
          const entries = await listMemoryEntries()
          return entries.map(e => ({ id: e.filename, title: e.name, meta: e.type || undefined }))
        },
        async deleteById(id) {
          const r = await deleteMemoryEntry(id)
          return r.ok
        },
      }
    case 'experience': {
      const store = new ExperienceStore()
      return {
        mechanism, noun: '经验', command: '/experience',
        async listCommitted() {
          const ids = await store.listIds()
          const out: { id: string; title: string; meta?: string }[] = []
          for (const id of ids) {
            const e = await store.load(id)
            if (e) out.push({ id, title: e.title, meta: e.domain })
          }
          return out
        },
        deleteById: id => store.delete(id),
      }
    }
    case 'principle': {
      const store = new PrincipleStore()
      return {
        mechanism, noun: '原则', command: '/principle',
        async listCommitted() {
          const ids = await store.listIds()
          const out: { id: string; title: string; meta?: string }[] = []
          for (const id of ids) {
            const e = await store.load(id)
            if (e) out.push({ id, title: e.title, meta: e.domains?.join(',') })
          }
          return out
        },
        deleteById: id => store.delete(id),
      }
    }
    case 'anchor': {
      const store = new PhysicalAnchorStore()
      return {
        mechanism, noun: '物理锚点', command: '/anchor',
        async listCommitted() {
          const ids = await store.listIds()
          const out: { id: string; title: string; meta?: string }[] = []
          for (const id of ids) {
            const e = await store.load(id)
            if (e) out.push({ id, title: e.title, meta: e.domain })
          }
          return out
        },
        deleteById: id => store.delete(id),
      }
    }
  }
}

/**
 * Human-driven deletion: list committed entries, pick one, confirm, delete now.
 * The human has direct authority — no review queue.
 */
async function handleDirectDelete(rl: readline.Interface, adapter: DeletionAdapter): Promise<void> {
  const entries = await adapter.listCommitted()
  if (entries.length === 0) {
    console.log(dim(`\n暂无已提交的${adapter.noun}可删除。\n`))
    return
  }
  console.log(`\n${bold(`删除${adapter.noun}`)} ${dim(`(${entries.length} 条；输入序号删除，回车取消)`)}\n`)
  entries.forEach((e, i) => {
    const meta = e.meta ? dim(` [${e.meta}]`) : ''
    console.log(`  ${cyan(String(i + 1))}. ${bold(e.title)}${meta}  ${dim(e.id)}`)
  })
  console.log()
  const choice = await askQuestion(rl, `请选择 [1-${entries.length}，回车取消]: `)
  const trimmed = choice.trim()
  if (!trimmed) { console.log(dim('\n已取消。\n')); return }
  const idx = parseInt(trimmed, 10)
  if (!(idx >= 1 && idx <= entries.length)) { console.log(yellow('\n无效选择。\n')); return }
  const target = entries[idx - 1]!
  const confirm = await askQuestion(rl, `${yellow('⚠  确认永久删除 ')}${bold(target.title)}${yellow(' ？此操作不可撤销 [y/N] ')}`)
  if (confirm.trim().toLowerCase() !== 'y') { console.log(dim('\n已取消。\n')); return }
  const ok = await adapter.deleteById(target.id)
  if (ok) console.log(green(`\n✓ 已删除${adapter.noun}: ${dim(target.title)}\n`))
  else console.log(red(`\n✗ 删除失败（条目可能已不存在）。\n`))
}

/**
 * Review AI-proposed deletions: each entry was queued by a `*_delete` tool and
 * is applied only after the user approves it here.
 */
async function handleDeleteReview(rl: readline.Interface, adapter: DeletionAdapter): Promise<void> {
  await ensurePendingDeletionsLoaded(adapter.mechanism)
  const store = getPendingDeletionStore(adapter.mechanism)
  const entries = [...store.list()]
  if (entries.length === 0) {
    console.log(dim(`\n暂无待审${adapter.noun}删除请求。\n`))
    return
  }
  console.log(
    `\n${bold(`${adapter.noun}删除审核`)} ${dim(`(${entries.length} 条待审)`)}\n` +
    `${dim('以下删除由 AI 提议，确认后才会真正删除。')}\n`,
  )
  let deleted = 0
  for (const entry of entries) {
    console.log(
      `\n${'─'.repeat(60)}\n` +
      `${bold(entry.label)}  ${dim(entry.targetId)}\n` +
      (entry.reason ? `${dim('理由:')} ${entry.reason}\n` : '') +
      `${'─'.repeat(60)}\n`,
    )
    const choice = await askQuestion(rl, `删除 [y=确认删除 / n=驳回 / s=跳过]: `)
    const c = choice.trim().toLowerCase()
    if (c === 'y' || c === 'yes') {
      const ok = await adapter.deleteById(entry.targetId)
      if (ok) {
        store.remove(entry.pendingId)
        console.log(green(`  ✓ 已删除`))
        deleted++
      } else {
        store.remove(entry.pendingId)
        console.log(yellow(`  ⚠ 目标已不存在，已从队列移除`))
      }
    } else if (c === 'n') {
      store.remove(entry.pendingId)
      console.log(dim('  已驳回'))
    } else {
      console.log(dim('  已跳过 (保留在待审队列)'))
    }
  }
  await store.flush()
  const remaining = store.count
  console.log(
    `\n${green(`✓ 已删除 ${deleted} 条`)}` +
    (remaining > 0 ? `  ${yellow(`剩余 ${remaining} 条待审`)}` : '') + '\n',
  )
}

/**
 * Dispatch the `delete` / `delete review` sub-commands shared by the memory /
 * experience / principle / anchor REPL commands. Returns true if handled.
 * `available` gates robotics-only mechanisms.
 */
async function handleDeleteSubcommand(
  rl: readline.Interface,
  mechanism: DeletionMechanism,
  subTokens: string[],
  available: boolean,
): Promise<boolean> {
  if (subTokens[0] !== 'delete') return false
  const adapter = makeDeletionAdapter(mechanism)
  if (!available) {
    console.log(yellow(`\n${adapter.command} delete 仅在 robotics 模式下可用。\n`))
    return true
  }
  if (subTokens[1] === 'review') {
    await handleDeleteReview(rl, adapter)
  } else {
    await handleDirectDelete(rl, adapter)
  }
  return true
}

// ── Principle review ─────────────────────────────────────────────────────────

async function reviewPendingPrinciples(
  rl: readline.Interface,
  pending: PrinciplePendingStore,
  store: PrincipleStore,
  experienceStore?: ExperienceStore,
  anchorStore?: PhysicalAnchorStore,
): Promise<number> {
  const entries = [...pending.list()]
  if (entries.length === 0) {
    console.log(dim('\n暂无待审原则。\n'))
    return 0
  }

  console.log(
    `\n${bold('原则审核')} ${dim(`(${entries.length} 条待审)`)}\n` +
    `${dim('Principle 是由经验和物理锚点抽象出的可迁移机制；提交前需要你审核边界是否明确。')}\n`,
  )

  let committed = 0
  for (const entry of entries) {
    const input = entry.input
    const title = String(input['title'] ?? '(无标题)')
    const statement = String(input['statement'] ?? '').slice(0, 300)
    const mechanism = String(input['mechanism'] ?? '').slice(0, 220)
    const domains = (input['domains'] as string[] | undefined)?.join(', ') ?? 'general'
    const confidence = String(input['confidence_tier'] ?? 'observed')
    const reason = String(input['promotion_reason'] ?? 'unknown')
    const firstPrinciples = (input['first_principles_support'] as string[] | undefined)?.slice(0, 3).join('; ') ?? ''
    const bounds = (input['applicability_bounds'] as string[] | undefined)?.slice(0, 3).join('; ') ?? ''
    const exclusions = (input['non_applicable_when'] as string[] | undefined)?.slice(0, 3).join('; ') ?? ''
    // Surface the evidence chain and any counterexamples so the reviewer can
    // judge fabrication / overgeneralization before approving (the promotion
    // model is told "do not invent measurements", but only review enforces it).
    const evidence = (input['evidence_refs'] as string[] | undefined)?.slice(0, 4).join('; ') ?? ''
    const counterExamples = (input['counter_examples'] as string[] | undefined)?.slice(0, 3).join('; ') ?? ''

    console.log(
      `\n${'─'.repeat(60)}\n` +
      `${bold(title)} ${dim(`[${domains}]`)} ${dim(`conf:${confidence}`)} ${dim(`trigger:${reason}`)}\n` +
      `${dim('原则:')} ${statement}\n` +
      `${dim('机制:')} ${mechanism}\n` +
      (firstPrinciples ? `${dim('第一性原理支撑:')} ${firstPrinciples}\n` : '') +
      (bounds ? `${dim('适用边界:')} ${bounds}\n` : '') +
      (exclusions ? `${dim('不适用:')} ${exclusions}\n` : '') +
      (evidence ? `${dim('证据:')} ${evidence}\n` : `${yellow('⚠ 无证据引用')}\n`) +
      (counterExamples ? `${dim('反例:')} ${counterExamples}\n` : '') +
      `${'─'.repeat(60)}\n`,
    )

    const choice = await askQuestion(rl, `提交 [y=是 / n=丢弃 / s=跳过]: `)
    if (choice.toLowerCase() === 'y' || choice.toLowerCase() === 'yes') {
      const id = await pending.commit(entry.pendingId, store, experienceStore, anchorStore)
      if (id) {
        console.log(green(`  ✓ 已提交 (ID: ${id})`))
        committed++
      } else {
        console.log(red('  ✗ 提交失败（字段校验未通过）'))
      }
    } else if (choice.toLowerCase() === 'n') {
      pending.remove(entry.pendingId)
      console.log(dim('  已丢弃'))
    } else {
      console.log(dim('  已跳过 (保留在待审队列)'))
    }
  }

  const remaining = pending.count
  if (committed > 0 || remaining > 0) {
    console.log(
      `\n${green(`✓ 已提交 ${committed} 条原则`)}` +
      (remaining > 0 ? `  ${yellow(`剩余 ${remaining} 条待审`)}` : '') +
      '\n',
    )
  }
  return committed
}

// ── Physical anchor review ─────────────────────────────────────────────────────

/**
 * Interactive review of pending physical anchor proposals.
 * Shows each candidate; user can approve (y), discard (n), or skip (s).
 * Returns the count of committed anchors.
 */
async function reviewPendingPhysicalAnchors(
  rl: readline.Interface,
  pending: PhysicalAnchorPendingStore,
  store: PhysicalAnchorStore,
): Promise<number> {
  const entries = [...pending.list()]
  if (entries.length === 0) {
    console.log(dim('\n暂无待审物理锚点。\n'))
    return 0
  }

  console.log(
    `\n${bold('物理锚点审核')} ${dim(`(${entries.length} 条待审)`)}\n` +
    `${dim('每个锚点由 AI 在本次会话中提议（或会话结束时自动提取），需要你审核后才会写入跨 session 知识库。')}\n`,
  )

  let committed = 0
  for (const entry of entries) {
    const inp = entry.input
    const title       = String(inp['title'] ?? '(无标题)')
    const domain      = String(inp['domain'] ?? 'general')
    const scope       = String(inp['scope'] ?? 'code')
    const fact        = String(inp['fact'] ?? '').slice(0, 300)
    const implication = String(inp['implication'] ?? '').slice(0, 200)
    const confidence  = String(inp['confidence_tier'] ?? 'observed')
    const tags        = (inp['tags'] as string[] | undefined)?.join(', ') ?? ''
    const proposed    = new Date(entry.proposedAt).toLocaleTimeString()

    const scopeLabel  = scope === 'global' ? green(scope) : scope === 'robot' ? cyan(scope) : dim(scope)

    console.log(
      `\n${'─'.repeat(60)}\n` +
      `${bold(title)} ${dim(`[${domain}]`)} ${scopeLabel} ${dim(`conf:${confidence}`)}\n` +
      `${dim('事实:')} ${fact}\n` +
      `${dim('含义:')} ${implication}\n` +
      (tags ? `${dim('标签:')} ${tags}\n` : '') +
      `${dim('提议时间:')} ${proposed}\n` +
      `${'─'.repeat(60)}\n`,
    )

    const choice = await askQuestion(rl, `提交 [y=是 / n=丢弃 / s=跳过]: `)
    if (choice.toLowerCase() === 'y' || choice.toLowerCase() === 'yes') {
      const id = await pending.commit(entry.pendingId, store)
      if (id) {
        console.log(green(`  ✓ 已提交 (ID: ${id})`))
        committed++
      } else {
        console.log(red('  ✗ 提交失败（字段校验未通过）'))
      }
    } else if (choice.toLowerCase() === 'n') {
      pending.remove(entry.pendingId)
      console.log(dim('  已丢弃'))
    } else {
      console.log(dim('  已跳过 (保留在待审队列)'))
    }
  }

  const remaining = pending.count
  if (committed > 0 || remaining > 0) {
    console.log(
      `\n${green(`✓ 已提交 ${committed} 条物理锚点`)}` +
      (remaining > 0 ? `  ${yellow(`剩余 ${remaining} 条待审`)}` : '') +
      '\n',
    )
  }
  return committed
}

// ── Robotics team mode CLI ───────────────────────────────────────────────────

type TeamCliController = NonNullable<ReturnType<SessionRouter['getRoboticsTeamController']>>

function relAgo(iso?: string): string {
  if (!iso) return ''
  const ms = Date.now() - Date.parse(iso)
  if (Number.isNaN(ms) || ms < 0) return ''
  const m = Math.floor(ms / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function formatTeamState(state: TeamState | null | undefined): string {
  if (!state) return `\n${dim('Team mode 尚未初始化。使用 /team init 创建模板。')}\n`

  const owned = state.tasks.filter(t => t.ownerUnit && t.status !== 'done')
  const paused = state.tasks.filter(t => t.status === 'paused')
  const open = state.tasks.filter(t => !t.ownerUnit && t.status === 'open')
  const done = state.tasks.filter(t => t.status === 'done')

  const lines: string[] = ['', bold('Team Mode (v2.0 — 协作日志)')]
  lines.push(state.github ? `${dim('GitHub:')} ${cyan(terminalText(state.github))}` : `${dim('GitHub:')} ${dim('(not set)')}`)
  lines.push(`${dim('Updated:')} ${terminalText(state.updatedAt)}`)
  lines.push('')

  lines.push(bold('Goals'))
  if (state.goals.length === 0) lines.push(`  ${dim('none')}`)
  else state.goals.forEach(g => lines.push(`  - ${terminalText(g)}`))
  lines.push('')

  lines.push(bold('进行中（锁定）'))
  if (owned.length === 0) {
    lines.push(`  ${dim('none')}`)
  } else {
    for (const t of owned) {
      const stale = isStaleClaim(t)
      const marker = stale ? yellow('⚠') : '🔒'
      const claim = t.claimedAt ? ` ${dim(`claimed ${relAgo(t.claimedAt)}`)}` : ''
      lines.push(`  ${marker} ${cyan(terminalText(t.id))} ${terminalText(t.title)} · ${terminalText(t.ownerUnit)}${claim} · ${dim(`${t.attempts.length} attempts`)}`)
    }
  }
  lines.push('')

  if (paused.length > 0) {
    lines.push(bold('暂停'))
    for (const t of paused) {
      const owner = t.ownerUnit ? ` · ${terminalText(t.ownerUnit)}` : ''
      lines.push(`  - ${cyan(terminalText(t.id))} ${terminalText(t.title)}${owner} · ${dim(`${t.attempts.length} attempts`)}`)
    }
    lines.push('')
  }

  lines.push(bold('待领'))
  if (open.length === 0) lines.push(`  ${dim('none')}`)
  else open.forEach(t => lines.push(`  - ${cyan(terminalText(t.id))} ${terminalText(t.title)}`))
  lines.push('')

  if (done.length > 0) {
    lines.push(bold('已完成'))
    for (const t of done.slice(-5)) {
      lines.push(`  - ${dim(terminalText(t.id))} ${dim(terminalText(t.title))} ${dim(`(${t.attempts.length} attempts)`)}`)
    }
    lines.push('')
  }

  if (state.units.length > 0) {
    lines.push(bold('Units'))
    for (const u of state.units) {
      const cur = u.currentTask ? ` task=${terminalText(u.currentTask)}` : ''
      lines.push(`  - ${cyan(terminalText(u.id))} ${dim(terminalText(u.status))} last=${relAgo(u.lastSeen)}${cur}`)
    }
    lines.push('')
  }

  return `${lines.join('\n')}\n`
}

function formatTeamLog(state: TeamState | null | undefined, limit = 8): string {
  if (!state) return ''
  type Row = { at: string; taskId: string; title: string; unit: string; direction: string; outcome: string; ref?: string }
  const rows: Row[] = []
  for (const t of state.tasks) {
    for (const a of t.attempts) rows.push({ at: a.at, taskId: t.id, title: t.title, unit: a.unit, direction: a.direction, outcome: a.outcome, ref: a.ref })
  }
  rows.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
  if (rows.length === 0) return `${bold('Recent attempts')}\n  ${dim('none — 使用 /team note 追加')}\n`
  const lines: string[] = [bold(`Recent attempts (latest ${Math.min(limit, rows.length)})`)]
  for (const r of rows.slice(0, limit)) {
    lines.push(`  - ${dim(relAgo(r.at))} ${cyan(terminalText(r.taskId))} ${terminalText(r.unit)}`)
    lines.push(`      ${dim('方向:')} ${terminalText(r.direction)}`)
    lines.push(`      ${dim('结果:')} ${terminalText(r.outcome)}`)
    if (r.ref) lines.push(`      ${dim('ref:')} ${terminalText(r.ref)}`)
  }
  return `${lines.join('\n')}\n`
}

function formatTeamWatcherEvents(events: TeamWatcherEvent[] | undefined): string {
  if (!events || events.length === 0) return ''
  const lines = ['', bold('Watcher'), ...events.slice(-5).map(e => `  - ${dim(terminalText(e.at))} ${terminalText(e.message)}`), '']
  return `${lines.join('\n')}\n`
}

function teamEventKey(event: TeamWatcherEvent): string {
  return `${event.at}|${event.message}`
}

async function buildTeamPlannerSnapshot(controller: TeamCliController): Promise<TeamPlannerSnapshot> {
  const state = await controller.teamStatus?.().catch(() => null) ?? null
  const recentAttempts: unknown[] = []
  if (state) {
    type R = { at: string; taskId: string; unit: string; direction: string; outcome: string; ref?: string }
    const rows: R[] = []
    for (const t of state.tasks) {
      for (const a of t.attempts) rows.push({ at: a.at, taskId: t.id, unit: a.unit, direction: a.direction, outcome: a.outcome, ref: a.ref })
    }
    rows.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    recentAttempts.push(...rows.slice(0, 12))
  }
  return {
    state,
    recentAttempts,
    events: controller.teamWatcherEvents?.() ?? [],
  }
}

async function callTeamPlanner(router: SessionRouter, input: string, snapshot: TeamPlannerSnapshot): Promise<TeamPlannerPlan | null> {
  try {
    const { apiKey, baseURL, flashModel } = router.getProviderConfig()
    if (!apiKey) return null

    if (getModelProtocol(flashModel, baseURL) === 'openai') {
      const OpenAI = (await import('openai')).default
      const client = new OpenAI({ apiKey, baseURL: baseURL ?? 'https://api.deepseek.com', maxRetries: 1, timeout: 30_000 })
      const message = await client.chat.completions.create({
        model:      flashModel,
        max_tokens: 900,
        messages: [
          { role: 'system', content: TEAM_PLANNER_SYSTEM },
          { role: 'user', content: buildTeamPlannerUserMessage(input, snapshot) },
        ],
      })
      return parseTeamPlannerPlan(message.choices[0]?.message?.content ?? '')
    }

    let client = router.getSideCallClient()
    if (!client) {
      client = new (await import('@anthropic-ai/sdk')).default({
        apiKey,
        baseURL,
        timeout:    30_000,
        maxRetries: 1,
      })
    }

    const message = await client.messages.create({
      model:      flashModel,
      max_tokens: 900,
      system:     TEAM_PLANNER_SYSTEM,
      messages:   [{ role: 'user', content: buildTeamPlannerUserMessage(input, snapshot) }],
    })
    const text = message.content
      .map(block => block.type === 'text' ? block.text : '')
      .join('')
      .trim()
    return parseTeamPlannerPlan(text)
  } catch {
    // Side-call failure (network error, rate limit, SDK init error) must never
    // crash the REPL — return null so the caller falls back to no-plan mode.
    return null
  }
}

async function runTeamEntryGuide(
  router: SessionRouter,
  opts: CliOptions,
  rl: readline.Interface,
  setInteractiveActive?: (v: boolean) => void,
): Promise<void> {
  const controller = await getTeamController(router, opts)
  if (!controller) return

  // Block team-reminder stdout output while we're in an interactive prompt chain.
  // Without this guard the 45-second timer fires mid-readline and garbles the input line.
  setInteractiveActive?.(true)
  try {
    await _runTeamEntryGuideInner(controller, router, opts, rl)
  } finally {
    setInteractiveActive?.(false)
  }
}

async function _runTeamEntryGuideInner(
  controller: TeamCliController,
  router: SessionRouter,
  _opts: CliOptions,
  rl: readline.Interface,
): Promise<void> {
  // Initialise / join — no path-based guidance, just basic onboarding.
  let state: TeamState | null | undefined = await controller.teamStatus?.()
  if (!state) {
    const answer = await askQuestion(rl, `尚未初始化 team/ 模板。现在初始化并加入？[Y/n] `)
    if (/^(n|no|否)$/i.test(answer.trim())) return
    try {
      state = await controller.teamJoin?.()
    } catch (err) {
      // GitHub is the team SSOT — when origin isn't a GitHub remote we must
      // ask for the repo URL explicitly before any team state is created.
      if ((err as Error)?.name !== 'TeamGithubRequiredError') throw err
      console.log(yellow('\nteam 模式以 GitHub 仓库为唯一事实源（未能从 origin 自动检测到 GitHub 地址）。'))
      const url = (await askQuestion(rl, `请输入 GitHub 仓库地址（如 https://github.com/org/repo，回车取消）: `)).trim()
      if (!url) { console.log(dim('已取消 team 初始化。')); return }
      state = await controller.teamJoin?.(url)
    }
    console.log(green('\n✓ team 已初始化并加入。'))
    // Entry guide already holds setInteractiveActive — don't toggle it here.
    await offerTeamPush(controller, _opts, rl, undefined)
  } else {
    // unitId is exposed via controller indirectly; for simplicity treat absence
    // as "not joined" only when there are zero units (otherwise the watcher's
    // sync will refresh presence on the next tick anyway).
    if (state.units.length === 0) {
      const answer = await askQuestion(rl, `当前还没有 unit。现在加入？[Y/n] `)
      if (!/^(n|no|否)$/i.test(answer.trim())) {
        state = await controller.teamJoin?.(state.github)
        console.log(green('\n✓ 已加入 team。'))
        await offerTeamPush(controller, _opts, rl, undefined)
      }
    }
  }

  // Refresh remote state first (fetch bounded by the 10-min cooldown) so the
  // board reflects teammates' latest takes/notes before we display it.
  await controller.teamWatcherPoll?.().catch(() => undefined)
  state = await controller.teamStatus?.() ?? state

  // Show the board + recent attempts — the primary collaboration view.
  console.log(formatTeamState(state))
  console.log(formatTeamLog(state))

  // Ask the planner for natural-language guidance.  Any concrete actions it
  // proposes go through executePlan() which prompts for confirmation.
  const snapshot = await buildTeamPlannerSnapshot(controller)
  const plan = await callTeamPlanner(
    router,
    '用户输入 /team，进入协作入口。请只给出当前可做之事的简短中文建议（30 字内），可选地提议读取类动作；任何修改 team 状态的动作必须 requiresConfirmation=true。',
    snapshot,
  )
  if (plan?.guidance || plan?.summary) {
    console.log(`\n${bold('Team Guide')}`)
    if (plan.summary) console.log(`${dim('判断:')} ${terminalText(plan.summary)}`)
    if (plan.guidance) console.log(`${dim('建议:')} ${terminalText(plan.guidance)}`)
  }
  if (plan?.risk === 'blocked') {
    console.log(red(`\n⚠ Planner 判断存在阻塞，已跳过任何写入建议。`))
  } else if (plan && plan.actions.length > 0) {
    await executePlan(controller, plan, q => askQuestion(rl, q), {
      onAction: (action, status, detail) => {
        const tag = status === 'done' ? green('✓') : status === 'failed' ? red('✗') : status === 'skipped' ? yellow('-') : dim('→')
        const note = detail ? ` ${dim(terminalText(detail))}` : ''
        console.log(`  ${tag} ${terminalText(action.type)}${action.taskId ? ` ${cyan(terminalText(action.taskId))}` : ''}${note}`)
      },
    })
  }

  // Optional context boundary if there's prior conversation in this session
  // and the user has just taken a task during this entry guide.
  const afterState = await controller.teamStatus?.()
  const claimedTaskId = afterState?.tasks.find(t => t.ownerUnit && t.status !== 'done')?.id ?? null
  if (claimedTaskId && router.getMessages().length > 0) {
    const msgCount = router.getMessages().length
    console.log(`\n${bold('检测到历史对话')} ${dim(`（本 session 共 ${msgCount} 条消息）`)}`)
    console.log(`这些对话与 ${cyan(claimedTaskId)} 是什么关系？`)
    console.log(`  ${cyan('1')}. 是该任务的起源背景`)
    console.log(`  ${cyan('2')}. 与该任务无关`)
    const bChoice = await askQuestion(rl, `请选择 [1/2，回车=1]: `)
    const bMode: 'background' | 'unrelated' = bChoice.trim() === '2' ? 'unrelated' : 'background'
    await controller.teamSetContextBoundary?.(bMode, claimedTaskId)
    console.log(dim(`  ✓ ${bMode === 'background' ? '已标记为任务背景' : '已设置边界'}。`))
  }

  console.log(dim('\n协作命令：/team take <id>、/team note <id> ... 、/team drop、/team done、/team steal <id> [reason]。\n'))
}

function nextTeamTaskId(tasks: TeamTask[]): string {
  const nums = tasks
    .map(task => task.id.match(/^TASK-(\d+)$/)?.[1])
    .filter((n): n is string => Boolean(n))
    .map(n => Number.parseInt(n, 10))
    .filter(Number.isFinite)
  const next = nums.length > 0 ? Math.max(...nums) + 1 : 1
  return `TASK-${String(next).padStart(3, '0')}`
}

/**
 * Parse `/team note <task-id> "<direction>" :: "<outcome>" [@ref]`.
 *
 * Accepts both with and without quotes.  The `::` separator distinguishes
 * direction from outcome.  An optional trailing `@ref` becomes the artifact
 * pointer.
 *
 * Examples:
 *   note TASK-001 "试 ResNet" :: "失败，real -2%"
 *   note TASK-001 试用更大学习率 :: 成功 step 稳定性 +12% @ wandb.ai/run-3f2
 */
function parseTeamNoteArgs(text: string): { taskId: string; direction: string; outcome: string; ref?: string } | null {
  const trimmed = text.trim()
  const taskMatch = trimmed.match(/^(TASK-[A-Z0-9._-]+)\s+(.+)$/i)
  if (!taskMatch) return null
  const taskId = taskMatch[1]!.toUpperCase()
  let body = (taskMatch[2] ?? '').trim()

  // Strip trailing "@ref"
  let ref: string | undefined
  const refMatch = body.match(/\s+@\s*(\S+(?:\s+\S+)*)$/)
  if (refMatch) {
    ref = refMatch[1]!.trim()
    body = body.slice(0, refMatch.index).trim()
  }

  // Split on "::" separator
  const sepIdx = body.indexOf('::')
  if (sepIdx < 0) return null
  const direction = body.slice(0, sepIdx).trim().replace(/^['"]|['"]$/g, '')
  const outcome   = body.slice(sepIdx + 2).trim().replace(/^['"]|['"]$/g, '')
  if (!direction || !outcome) return null
  return { taskId, direction, outcome, ref }
}

async function getTeamController(router: SessionRouter, opts: CliOptions): Promise<TeamCliController | null> {
  if (opts.mode !== 'robotics' && router.mode !== 'robotics') {
    console.log(`\n${yellow('/team 仅在 robotics mode 中可用。')} 使用 ${cyan('--mode robotics')} 启动后再执行。\n`)
    return null
  }
  await router.ensureReady('/team command')
  const controller = router.getRoboticsTeamController()
  if (!controller) {
    console.log(`\n${yellow('无法初始化 robotics team controller。')}\n`)
    return null
  }
  return controller
}

/**
 * After init/join (when the board is brand-new or presence changed), offer to
 * publish immediately — in the initialisation flow this is almost always the
 * next step, so asking beats hinting. Falls back to the passive hint in
 * non-interactive contexts or when the user declines.
 */
async function offerTeamPush(
  controller: TeamCliController,
  opts: CliOptions,
  rl?: readline.Interface,
  setInteractiveActive?: (v: boolean) => void,
): Promise<void> {
  try {
    const s = await controller.teamPublishState?.()
    if (!s) return
    if (!s.isGitRepo) {
      console.log(dim('  （当前项目不是 git 仓库，team 状态暂无法发布到 GitHub。）'))
      return
    }
    if (s.dirty.length === 0 && s.unpushedCommits === 0) return
    if (!rl || opts.json || !isTTY) {
      await printTeamPublishHint(controller)
      return
    }
    setInteractiveActive?.(true)
    let answer: string
    try {
      answer = await askQuestion(rl, `  现在发布到 GitHub（仅 commit + push team/ 目录）？[Y/n] `)
    } finally {
      setInteractiveActive?.(false)
    }
    if (/^(n|no|否)$/i.test(answer.trim())) {
      await printTeamPublishHint(controller)
      return
    }
    process.stdout.write(dim('  正在发布 team/ 变更…'))
    const result = await controller.teamPush?.()
    process.stdout.write('\r')
    if (result?.pushed) {
      console.log(green(`  ✓ ${result.message}`) + dim('  队友执行 /team pull 后可见。'))
    } else {
      console.log(yellow(`  ⚠ ${result?.message ?? 'push 失败'}`) + dim('  可稍后用 /team push 重试。'))
    }
  } catch { /* advisory only — never block the init/join flow */ }
}

/** Print a one-line hint when local team/ changes haven't been pushed yet. */
async function printTeamPublishHint(controller: TeamCliController): Promise<void> {
  try {
    const s = await controller.teamPublishState?.()
    if (!s || !s.isGitRepo) return
    if (s.dirty.length > 0 || s.unpushedCommits > 0) {
      console.log(
        dim(`  ⇡ 本地 team/ 有未发布变更（未提交=${s.dirty.length}, 未推送 commit=${s.unpushedCommits}）— 运行 `) +
        cyan('/team push') + dim(' 发布给队友。'),
      )
    }
  } catch { /* advisory only */ }
}

async function handleTeamCommand(
  input: string,
  router: SessionRouter,
  opts: CliOptions,
  rl?: readline.Interface,
  setInteractiveActive?: (v: boolean) => void,
): Promise<void> {
  const controller = await getTeamController(router, opts)
  if (!controller) return

  const [, rawSub = '', ...rest] = input.split(/\s+/)
  if (!rawSub) {
    if (!opts.json && isTTY) {
      if (rl) await runTeamEntryGuide(router, opts, rl, setInteractiveActive)
      else {
        const state = await controller.teamStatus?.()
        console.log(formatTeamState(state))
        console.log(formatTeamLog(state))
      }
    } else {
      const state = await controller.teamStatus?.()
      console.log(formatTeamState(state))
      console.log(formatTeamLog(state))
    }
    return
  }
  const sub = rawSub.toLowerCase()
  const arg = rest.join(' ').trim() || undefined

  try {
    switch (sub) {
      case 'init': {
        const state = await controller.teamInit?.(arg)
        console.log(green('\n✓ team 模板已初始化。') + dim('  文件位于 team/，team.json 为唯一事实源（SSOT: GitHub）。'))
        console.log(formatTeamState(state))
        await offerTeamPush(controller, opts, rl, setInteractiveActive)
        break
      }
      case 'join': {
        // /team join [github] [--as 张三]
        const asIdx = rest.findIndex(t => t === '--as')
        const human = asIdx >= 0 ? rest.slice(asIdx + 1).join(' ').trim() || undefined : undefined
        const githubArg = (asIdx >= 0 ? rest.slice(0, asIdx) : rest).join(' ').trim() || undefined
        const state = await controller.teamJoin?.(githubArg, human)
        console.log(green('\n✓ 已加入 team。') + (human ? dim(`  (human: ${human})`) : ''))
        console.log(formatTeamState(state))
        await offerTeamPush(controller, opts, rl, setInteractiveActive)
        break
      }
      case 'add': {
        if (!arg) {
          console.log(`\n${yellow('用法:')} ${cyan('/team add "<task title>"')}\n`)
          break
        }
        const state = await controller.teamStatus?.()
        const id = nextTeamTaskId(state?.tasks ?? [])
        // /team add "<title>" [--kind algo|exp|deploy]
        const kindMatch = arg.match(/\s--kind\s+(algo|exp|deploy)\s*$/i)
        const kind = kindMatch ? kindMatch[1]!.toLowerCase() as TeamTaskKind : undefined
        const rawTitle = kindMatch ? arg.slice(0, kindMatch.index) : arg
        const title = rawTitle.replace(/^['"]|['"]$/g, '').trim()
        if (!title) {
          console.log(`\n${yellow('用法:')} ${cyan('/team add "<task title>" [--kind algo|exp|deploy]')}\n`)
          break
        }
        const result = await controller.teamTaskAdd?.({ id, title, ...(kind ? { kind } : {}) })
        const kindNote = kind ? dim(`  [${kind}]`) : ''
        console.log(green(`\n✓ 已新增 ${result?.task.id ?? id}: ${title}。`) + kindNote)
        console.log(formatTeamState(result?.state))
        await printTeamPublishHint(controller)
        break
      }
      case 'take': {
        if (!arg) {
          console.log(`\n${yellow('用法:')} ${cyan('/team take TASK-001')}\n`)
          break
        }
        // Double-claim guard: fetch remote state first; if the remote team/
        // has changes we haven't pulled, a teammate may already own this task.
        process.stdout.write(dim('领取前同步远端 team 状态…'))
        const preSync = await controller.teamSync?.({ updatePresence: false }).catch(() => undefined)
        process.stdout.write('\r')
        if (preSync && preSync.remoteTeamChanges.length > 0) {
          console.log(
            `${yellow('⚠ 远端 team/ 有未拉取的变更，已中止领取（避免双领）。')}\n` +
            `${dim('先运行')} ${cyan('/team pull')} ${dim('应用远端状态，再重新 take。')}`,
          )
          preSync.remoteTeamChanges.slice(0, 5).forEach(change => console.log(dim(`  - ${change}`)))
          break
        }
        // WIP soft limit: holding several active tasks is legal (waiting on a
        // training run while calibrating is real life) but hoarding hurts the
        // team — confirm before the 3rd concurrent claim.
        const ownedBefore = await controller.teamOwnedTasks?.()
        if (rl && isTTY && !opts.json && (ownedBefore?.owned.length ?? 0) >= 2) {
          const ids = ownedBefore!.owned.map(t => t.id).join(', ')
          setInteractiveActive?.(true)
          let confirm: string
          try {
            confirm = await askQuestion(rl, `  你已持有 ${ownedBefore!.owned.length} 个任务（${ids}），确认再领 ${arg}？[y/N] `)
          } finally {
            setInteractiveActive?.(false)
          }
          if (!/^(y|yes|是|确认)$/i.test(confirm.trim())) {
            console.log(dim('已取消领取。'))
            break
          }
        }
        const result = await controller.teamTake?.(arg)
        const focusNote = (ownedBefore?.owned.length ?? 0) > 0 ? dim('  (focus 已切换至该任务)') : ''
        console.log(green(`\n✓ 已领取 ${result?.task.id ?? arg}。`) + focusNote)
        console.log(formatTeamState(result?.state))
        await printTeamPublishHint(controller)
        break
      }
      case 'drop': {
        const result = await controller.teamDrop?.(arg)
        console.log(green(`\n✓ 已释放 ${result?.task.id ?? '(当前任务)'}。`))
        console.log(formatTeamState(result?.state))
        await printTeamPublishHint(controller)
        break
      }
      case 'steal': {
        const [taskIdArg, ...reasonParts] = rest
        if (!taskIdArg) {
          console.log(`\n${yellow('用法:')} ${cyan('/team steal TASK-001 [reason]')}\n`)
          break
        }
        const reason = reasonParts.join(' ').trim() || undefined
        const result = await controller.teamSteal?.(taskIdArg, reason)
        const from = result?.previousOwner ? ` (from ${result.previousOwner})` : ''
        console.log(green(`\n✓ 已 steal ${result?.task.id ?? taskIdArg}${from}。`))
        if (result?.task.attempts.length) {
          const last = result.task.attempts[result.task.attempts.length - 1]!
          console.log(dim(`  audit: ${last.direction} — ${last.outcome}`))
        }
        console.log(formatTeamState(result?.state))
        await printTeamPublishHint(controller)
        break
      }
      case 'note': {
        const parsed = parseTeamNoteArgs(rest.join(' '))
        if (!parsed) {
          console.log(
            `\n${yellow('用法:')} ${cyan('/team note TASK-001 "<direction>" :: "<outcome>" [@ref]')}\n` +
            `${dim('示例:')} ${cyan('/team note TASK-001 试 ResNet :: 失败 real -2% @ wandb.ai/run-3f2')}\n`,
          )
          break
        }
        const result = await controller.teamNote?.(parsed)
        console.log(green(`\n✓ 已记录 ${result?.task.id ?? parsed.taskId} 的一条尝试。`))
        console.log(dim(`  方向: ${parsed.direction}`))
        console.log(dim(`  结果: ${parsed.outcome}`))
        if (parsed.ref) console.log(dim(`  ref: ${parsed.ref}`))
        await printTeamPublishHint(controller)
        break
      }
      case 'focus': {
        if (!arg) {
          const owned = await controller.teamOwnedTasks?.()
          if (!owned || owned.owned.length === 0) {
            console.log(`\n${dim('你当前没有持有任何任务。')}\n`)
          } else {
            console.log(`\n${bold('你持有的任务:')}`)
            owned.owned.forEach(t => console.log(`  ${t.id === owned.focusId ? cyan('★') : ' '} ${t.id} ${t.title}`))
            console.log(`\n${dim('用法:')} ${cyan('/team focus TASK-001')} ${dim('切换焦点（done/drop 无参时作用于焦点任务）')}\n`)
          }
          break
        }
        const result = await controller.teamFocus?.(arg)
        console.log(green(`\n✓ focus 已切换到 ${result?.task.id ?? arg}: ${result?.task.title ?? ''}。`))
        break
      }
      case 'done': {
        // Resolve MY task: explicit id → focus → single-owned → clear error.
        // (The old code picked the first ACTIVE task owned by ANYONE — with
        // multi-task ownership it could mark the wrong task done.)
        let taskId: string
        try {
          taskId = await controller.teamResolveOwnTaskId?.(arg) ?? ''
        } catch (resolveErr) {
          console.log(`\n${yellow(terminalText(resolveErr instanceof Error ? resolveErr.message : String(resolveErr)))}\n`)
          break
        }
        if (!taskId) {
          console.log(`\n${yellow('没有当前任务。')} 使用 ${cyan('/team done TASK-001')}。\n`)
          break
        }
        const result = await controller.teamTaskStatus?.(taskId, 'done')
        console.log(green(`\n✓ ${result?.task.id ?? taskId} -> done。`))
        console.log(formatTeamState(result?.state))
        await printTeamPublishHint(controller)
        break
      }
      case 'pause': {
        if (!arg) {
          console.log(`\n${yellow('用法:')} ${cyan('/team pause TASK-001')}\n`)
          break
        }
        const result = await controller.teamTaskStatus?.(arg, 'paused')
        console.log(green(`\n✓ ${result?.task.id ?? arg} -> paused。`))
        console.log(formatTeamState(result?.state))
        break
      }
      case 'sync': {
        process.stdout.write(dim('正在同步 team 状态并拉取远端…'))
        const _syncStart = Date.now()
        const summary = await controller.teamSync?.()
        const _elapsed = Date.now() - _syncStart
        process.stdout.write('\r')
        console.log(green('✓ team sync 完成。') + ` ${dim(`git fetch=${summary?.gitFetched ? 'ok' : 'skipped/failed'} (${_elapsed}ms)`)}`)
        if (summary?.currentBranch) console.log(`${dim('Branch:')} ${cyan(summary.currentBranch)}`)
        if (summary?.upstreamBranch) console.log(`${dim('Upstream:')} ${cyan(summary.upstreamBranch)} ${dim(`behind=${summary.behind ?? 0} ahead=${summary.ahead ?? 0}`)}`)
        if (summary?.remoteSummary) console.log(`${dim('Git:')} ${summary.remoteSummary.split('\n')[0]}`)
        if (summary?.remoteTeamChanges.length) {
          console.log(`${yellow('Remote team changes:')}`)
          summary.remoteTeamChanges.slice(0, 8).forEach(change => console.log(`  - ${change}`))
        }
        console.log(formatTeamState(summary?.state))
        console.log(formatTeamWatcherEvents(controller.teamWatcherEvents?.()))
        break
      }
      case 'push': {
        process.stdout.write(dim('正在发布 team/ 变更…'))
        const pushResult = await controller.teamPush?.()
        process.stdout.write('\r')
        if (pushResult?.pushed) {
          console.log(green('✓ ' + pushResult.message) + dim('  队友执行 /team pull 后可见。'))
        } else {
          console.log(yellow('⚠ ' + (pushResult?.message ?? 'push 不可用（robotics 模式未激活？）')))
        }
        break
      }
      case 'pull': {
        const result = await controller.teamPull?.()
        if (result?.applied) {
          const count = result.changedFiles.length
          console.log(green('\n✓ remote team/ 已应用到本地。') + ` ${dim(`files=${count}`)}`)
          if (count > 0) result.changedFiles.slice(0, 8).forEach(change => console.log(`  - ${change}`))
        } else {
          console.log(yellow('\n/team pull 已阻止。') + ` ${result?.reason ?? 'unknown reason'}`)
          ;(result?.changedFiles ?? []).slice(0, 8).forEach(change => console.log(`  - ${change}`))
        }
        if (result?.sync.upstreamBranch) console.log(`${dim('Upstream:')} ${cyan(result.sync.upstreamBranch)} ${dim(`behind=${result.sync.behind ?? 0} ahead=${result.sync.ahead ?? 0}`)}`)
        // Auto-detect merge conflicts after pull and show guidance if any
        const pullConflictReport = await controller.teamConflicts?.()
        if (pullConflictReport?.hasConflicts) {
          console.log(`\n${yellow('⚠ 检测到合并冲突')} — 运行 ${cyan('/team conflicts')} 查看详细引导。`)
        }
        console.log(formatTeamState(result?.state))
        console.log(formatTeamWatcherEvents(controller.teamWatcherEvents?.()))
        break
      }
      case 'conflicts': {
        const resolveMode = arg === 'resolve'
        if (resolveMode) {
          // Auto-resolve team.json conflict using --theirs strategy
          const resolveResult = await controller.teamResolveTeamJson?.()
          if (resolveResult?.resolved) {
            console.log(green('\n✓ team.json 冲突已自动解决。'))
            console.log(dim(resolveResult.message))
          } else if (resolveResult?.strategy === 'none') {
            console.log(dim('\n' + (resolveResult.message ?? 'team.json 无冲突。')))
          } else {
            console.log(red('\n✗ 自动解决失败。'))
            console.log(yellow(resolveResult?.message ?? '请手动解决冲突。'))
          }
          // Show remaining conflicts after resolution attempt
          const afterReport = await controller.teamConflicts?.()
          if (afterReport?.hasConflicts) {
            console.log(`\n${yellow('仍有未解决冲突：')}`)
            afterReport.guidance.forEach(line => console.log(line))
          } else {
            console.log(green('\n✓ 所有合并冲突已解决。'))
          }
        } else {
          // Show conflict report with guidance
          const report = await controller.teamConflicts?.()
          if (!report) {
            console.log(dim('\n无法获取冲突信息。'))
            break
          }
          if (!report.hasConflicts) {
            console.log(green('\n✓ 工作区无 git 合并冲突。'))
          } else {
            console.log(`\n${red('⚠ 合并冲突引导')}`)
            report.guidance.forEach(line => {
              if (line.startsWith('▶')) console.log(`\n${yellow(line)}`)
              else if (line.startsWith('  $')) console.log(cyan(line))
              else if (line.startsWith('  ')) console.log(dim(line))
              else console.log(line)
            })
            if (report.teamJsonConflicted) {
              console.log(`\n${dim('提示：运行')} ${cyan('/team conflicts resolve')} ${dim('自动应用 --theirs 策略解决 team.json 冲突。')}`)
            }
          }
        }
        break
      }
      case 'status':
      case 'board':
      case 'log':
      default: {
        const state = await controller.teamStatus?.()
        console.log(formatTeamState(state))
        if (sub === 'log') {
          console.log(formatTeamLog(state, 30))
        } else {
          console.log(formatTeamLog(state))
        }
        console.log(formatTeamWatcherEvents(controller.teamWatcherEvents?.()))
        if (!['status', 'board', 'log'].includes(sub)) {
          console.log(dim(`未知 team 子命令 "${terminalText(sub)}"。可用: init, join, add, take, focus, note, drop, steal, done, pause, status, board, log, sync, push, pull, conflicts.\n`))
        }
        break
      }
    }
  } catch (err) {
    const msg = terminalText(err instanceof Error ? err.message : String(err))
    console.log(`\n${red('team error:')} ${msg}\n`)
  }
}

// ── Interactive REPL ──────────────────────────────────────────────────────────

async function runRepl(opts: CliOptions): Promise<void> {
  let hardwareProfileText = ''

  // ── Workspace confirmation (REPL only, single-turn skips for scripting) ──
  if (!opts.json && isTTY) {
    const needsStartupPrompt = !opts.workspace || opts.mode === 'robotics'
    const startupRl = needsStartupPrompt
      ? createInterface({ input: process.stdin, output: process.stdout, terminal: isTTY })
      : undefined
    try {
      if (!opts.workspace) {
        opts.workspace = await confirmWorkspace(process.cwd(), startupRl)
      }
      console.log(green(`✓ 工作目录: ${opts.workspace}\n`))

      // ── Auto-mode resume banner ───────────────────────────────────────────
      // Surface the prior auto checkpoint (goal / pending todos / active
      // sub-agents) so a resumed unattended run shows where it left off.
      if (opts.mode === 'auto' && opts.resume && opts.resume !== 'last') {
        const cp = readAutoCheckpoint(opts.workspace, opts.resume)
        if (cp) {
          const lines = [yellow('↻ 恢复 auto 会话 — 上次进度:')]
          if (cp.goal) lines.push(`  目标: ${cp.goal.slice(0, 200)}`)
          if (cp.stopReason) lines.push(`  上次停因: ${cp.stopReason}`)
          if (cp.pendingTodos?.length) lines.push(`  待办(${cp.pendingTodos.length}): ${cp.pendingTodos.slice(0, 5).join('；')}`)
          if (cp.activeSubAgentIds?.length) lines.push(`  活跃子代理: ${cp.activeSubAgentIds.join(', ')}`)
          if (typeof cp.turnCount === 'number') lines.push(`  已进行轮次: ${cp.turnCount}`)
          console.log(lines.join('\n') + '\n')
        }
      }

      // ── Hardware profile selection (robotics mode only) ───────────────────
      if (opts.mode === 'robotics') {
        const hp = new HardwareProfile()
        const selected = await selectHardwareProfile(hp, opts.workspace, startupRl)
        opts.hardwareId      = selected.name || undefined
        hardwareProfileText  = selected.profileText
      }
    } finally {
      startupRl?.close()
    }
  } else if (!opts.workspace) {
    // Non-TTY / json mode: default to cwd silently
    opts.workspace = process.cwd()
  }

  if (!opts.json) {
    const debugDir = opts.debug
      ? join(META_AGENT_HOME, 'debug', '<sessionId>')
      : ''
    console.log(
      `${bold('meta-agent')}  ${dim(`v${VERSION}`)}\n` +
      `Mode: ${cyan(opts.mode)}` +
      (opts.hardwareId ? `  ${dim('hw:')} ${cyan(opts.hardwareId)}` : '') +
      (opts.yes ? `  ${yellow('[AUTO-APPROVE]')}` : '') +
      (opts.debug ? `  ${yellow('[DEBUG]')}` : '') +
      `  ${dim('(type /help for commands, Ctrl+D to quit)')}\n`,
    )
    if (opts.debug) {
      console.log(
        `${yellow('⚙  调试模式已启用')} — 每轮 LLM 完整输入/输出写入：\n` +
        `   ${cyan(debugDir)}\n` +
        `   ${dim('(<sessionId> 在首次提交后确定)')}\n`,
      )
    }
  }

  // Create rl BEFORE router so makeRouter can capture it in beforeToolCall.
  // The guard hook uses this interface; creating it later would mean the first
  // router is built without a guard (before the first `/clear`).
  const PROMPT_YOU = `\n${bold(cyan('you'))} › `
  const rlOutput = new ReadlineOutput(process.stdout)
  const rl = createInterface({
    input:  process.stdin,
    output: rlOutput,
    prompt: PROMPT_YOU,
    terminal: isTTY,
    historySize: 100,
  })

  // ── Session resume ────────────────────────────────────────────────────────
  let resumedMessages: ConversationMessage[] = []
  // The picked session's id — forwarded to RoboticsSession as resumeSessionId so
  // R5 binds to THIS exact session's milestone bucket (findBySession) rather than
  // the most recently active session in the workspace.
  let resumedSessionId: string | undefined
  if (!opts.json && isTTY) {
    if (opts.resume) {
      // Explicit --resume <id> or --resume last
      let targetId = opts.resume
      if (targetId === 'last') {
        const sessions = await SessionStore.listSessions(1, { workspace: opts.workspace })
        targetId = sessions[0]?.sessionId ?? ''
      }
      if (targetId) {
        const meta = await SessionStore.getSession(targetId)
        if (meta && meta.workspace !== opts.workspace) {
          console.log(
            yellow(`⚠  会话 ${targetId.slice(0, 8)}… 属于其他 workspace，已拒绝恢复。`) + '\n' +
            dim(`当前: ${opts.workspace ?? '(unset)'}`) + '\n' +
            dim(`会话: ${meta.workspace ?? '(unknown)'}`) + '\n',
          )
        } else {
          resumedMessages = await SessionStore.loadHistory(targetId)
          resumedSessionId = targetId
          // Restore the mode from the saved session. An autonomous mode (auto /
          // simple_auto) must never run over a history produced in a
          // NON-autonomous mode (agentic / campaign / robotics): the workspace
          // jail, auto-approval, and tool-set posture differ from what the saved
          // turns assumed. Use isAutonomousMode on BOTH sides so the rule covers
          // every autonomous flavour, not just 'auto'.
          if (
            meta?.mode &&
            (!opts.modeExplicit || (isAutonomousMode(opts.mode) && !isAutonomousMode(meta.mode)))
          ) {
            opts.mode = meta.mode as CliOptions['mode']
            opts.modeExplicit = true
          }
        }
        if (resumedMessages.length > 0) {
          console.log(green(`✓ 已恢复会话 ${targetId.slice(0, 8)}… (${resumedMessages.length} 条历史)\n`))
        } else if (!meta || meta.workspace === opts.workspace) {
          console.log(yellow(`⚠  找不到会话 ${targetId}，将新建会话。\n`))
        }
      }
    } else {
      // Auto-show session picker if recent sessions exist
      const sessions = await SessionStore.listSessions(1, { workspace: opts.workspace })
      if (sessions.length > 0) {
        const resumed = await runSessionPicker(rl, opts.workspace)
        if (resumed) {
          resumedMessages = resumed.messages
          resumedSessionId = resumed.sessionId
          // Restore the mode from the saved session so the router starts in the
          // correct mode instead of starting the resumed history in default agentic.
          // Same rule as above: never run an autonomous mode (auto / simple_auto /
          // simple_auto) over a non-autonomous history.
          if (
            resumed.mode &&
            (!opts.modeExplicit || (isAutonomousMode(opts.mode) && !isAutonomousMode(resumed.mode)))
          ) {
            opts.mode = resumed.mode as CliOptions['mode']
            opts.modeExplicit = true
          }
        }
      }
    }
  }

  let router: SessionRouter
  const getCurrentRouter = () => router
  router = makeRouter(opts, hardwareProfileText || undefined, rl, resumedMessages.length > 0 ? resumedMessages : undefined, getCurrentRouter, _promptLineInline, resumedSessionId)

  // Register standard tools for agentic/campaign/auto modes.
  // Robotics mode registers its own tools internally (RoboticsSession.init).
  if (opts.mode !== 'robotics') {
    const tools = await createStandardTools({
      // planModeRef MUST be the router's shared ref so enter_plan_mode /
      // exit_plan_mode flip the same object the backend's kernel permission
      // policy reads — otherwise plan mode never gates writes.
      system: {
        cwd: opts.workspace,
        mode: opts.mode,
        planModeRef: router.planModeRef,
      },
      // Main-session web_fetch is result-budgeted: full-text reading belongs in
      // isolated research sub-agents (research_dispatch), not the long-lived
      // main context. Sub-agents get an unbudgeted override via the bridge.
      network: { webFetch: { maxResultSizeChars: 8_000 } },
      // Mode-specific tool selection (auto mode excludes ask_user/send_message).
      mode: opts.mode,
    })
    for (const tool of tools) {
      router.registerTool(tool)
    }
  }
  let interrupted = false
  // Track how many messages we've already saved so append writes only new ones.
  let savedMessageCount = resumedMessages.length
  // ── Session title state ──
  // One session = one goal = one title:
  //   - NEW session → flash side-call generates the goal title after turn 1.
  //   - RESUMED session → the old title is carried over verbatim; flash is
  //     never re-invoked (re-entering a session means continuing its goal).
  //   - Flash failure → deterministic local fallback (first clause of the
  //     first user message) is written immediately so the picker always shows
  //     something concise; later flash attempts (≤3 total) may upgrade it.
  const TITLE_FLASH_MAX_ATTEMPTS = 3
  let sessionTitle: string | null = null
  let titleSource: 'flash' | 'fallback' | 'carried' | null = null
  let titleFlashAttempts = 0
  let titleGenInFlight = false
  /** sessionId the current title was last written to (resume → new id). */
  let titlePersistedFor: string | null = null
  let titlePersistedValue: string | null = null
  const resetTitleState = (): void => {
    sessionTitle = null
    titleSource = null
    titleFlashAttempts = 0
    titlePersistedFor = null
    titlePersistedValue = null
  }
  const maybeGenerateSessionTitle = (): void => {
    if (opts.json || titleGenInFlight) return
    const sessionId = router.getSessionId()
    if (!sessionId) return
    const count = router.getMessages().length
    const needFlash =
      titleSource !== 'carried' &&            // resumed sessions keep their goal title
      titleSource !== 'flash' &&              // flash title is final
      titleFlashAttempts < TITLE_FLASH_MAX_ATTEMPTS &&
      count >= 2
    const needPersist =
      sessionTitle !== null &&
      (titlePersistedFor !== sessionId || titlePersistedValue !== sessionTitle)
    if (!needFlash && !needPersist) return
    titleGenInFlight = true
    void (async () => {
      try {
        if (needFlash) {
          titleFlashAttempts++
          const title = await generateSessionTitle(router)
          if (title) {
            sessionTitle = title
            titleSource = 'flash'
          } else if (titleSource === null) {
            const fb = fallbackSessionTitle(router.getMessages())
            if (fb) {
              sessionTitle = fb
              titleSource = 'fallback'   // flash may upgrade on a later turn
            }
          }
        }
        if (sessionTitle !== null &&
            (titlePersistedFor !== sessionId || titlePersistedValue !== sessionTitle)) {
          await SessionStore.updateTitle(sessionId, sessionTitle, count)
          titlePersistedFor = sessionId
          titlePersistedValue = sessionTitle
        }
      } catch { /* best-effort */ }
      finally { titleGenInFlight = false }
    })()
  }
  // Resumed session: carry the old goal title over to the new session entry.
  if (resumedSessionId) {
    const resumedMeta = await SessionStore.getSession(resumedSessionId)
    const carried = resumedMeta?.title?.trim()
    if (carried) {
      sessionTitle = carried
      titleSource = 'carried'
    }
  }
  // Track whether the real debug dir has been printed (becomes known after first submit)
  let debugDirShown = false
  // Bounded: a weeks-long robotics session polls every 45s and would otherwise
  // accumulate one key per team event forever. When the cap is hit the oldest
  // half is pruned (Set preserves insertion order); re-notifying a months-old
  // event once is harmless, unbounded growth is not.
  const MAX_SEEN_TEAM_EVENTS = 2_000
  const seenTeamReminderEvents = new Set<string>()
  const pruneSeenTeamEvents = (): void => {
    if (seenTeamReminderEvents.size <= MAX_SEEN_TEAM_EVENTS) return
    const dropCount = Math.floor(MAX_SEEN_TEAM_EVENTS / 2)
    let dropped = 0
    for (const key of seenTeamReminderEvents) {
      if (dropped++ >= dropCount) break
      seenTeamReminderEvents.delete(key)
    }
  }
  let teamReminderInitialized = false
  let teamReminderRunning = false
  // Only show Team 动态 notifications after the user explicitly uses a /team command
  // in this session. Prevents noise for users with a team.json who aren't using team mode.
  let teamModeUsed = false
  // Guards against showing the hardware-binding prompt more than once per session
  // (set to true after the first prompt, even if the user skips it).
  let hardwareBindingPrompted = false
  const persistCurrentSession = async (currentInput: string): Promise<void> => {
    savedMessageCount = await persistSessionSnapshot({
      router,
      opts,
      currentInput,
      savedMessageCount,
      skipJson: true,
    })
  }
  let interactiveInputActive = false
  const setInteractiveActive = (v: boolean) => { interactiveInputActive = v }
  const teamReminderTimer = (!opts.json && isTTY)
    ? setInterval(() => {
        if (exiting || teamReminderRunning || interactiveInputActive || !router.ready || router.mode !== 'robotics') return
        const controller = router.getRoboticsTeamController()
        if (!controller?.teamWatcherPoll) return
        teamReminderRunning = true
        void (async () => {
          try {
            const events = await controller.teamWatcherPoll?.() ?? []
            const fresh = events.filter(event => {
              const key = teamEventKey(event)
              const seen = seenTeamReminderEvents.has(key)
              seenTeamReminderEvents.add(key)
              return !seen
            })
            pruneSeenTeamEvents()
            if (!teamReminderInitialized) {
              teamReminderInitialized = true
              return
            }
            if (fresh.length > 0 && teamModeUsed) {
              process.stdout.write(`\n${yellow('Team 动态')}\n`)
              fresh.slice(-5).forEach(event => {
                process.stdout.write(`  - ${sanitizeTerminalText(event.message)}\n`)
              })
              process.stdout.write(`${dim('使用 /team status、/team sync 或 /team pull 查看详情。')}\n`)
              rl.prompt(true)
            }
          } catch {
            // Advisory reminder only; never disrupt the REPL.
          } finally {
            teamReminderRunning = false
          }
        })()
      }, 45_000)
    : null
  if (teamReminderTimer?.unref) teamReminderTimer.unref()

  // Handle Ctrl+C: first press interrupts, second exits
  let ctrlCPressed = false
  let exiting = false
  /**
   * Timestamp until which incoming readline lines should be silently discarded.
   *
   * When the user presses Ctrl+C to interrupt an in-flight LLM call, the
   * readline buffer may already contain lines that were pasted BEFORE the
   * interrupt (e.g. the remaining lines of a multi-line paste).  Without this
   * drain window those buffered lines fire immediately after the interrupt
   * clears, causing the REPL to auto-submit them — which looks like the CLI
   * is "sending messages on its own" after Ctrl+C.
   *
   * Set to Date.now() + 300 ms on every SIGINT so the main loop skips any
   * lines that arrive within that window.  300 ms is well above the ~0 ms
   * that buffered paste lines need to drain, yet well below the ~500+ ms
   * a human needs to type the next keystroke.
   */
  let ignoreInputUntil = 0
  // ── Multi-line paste accumulator ─────────────────────────────────────────
  //
  // A terminal delivers pasted text to stdin with its internal \n bytes intact,
  // and readline cannot tell those apart from the \n produced by pressing
  // Enter — so it fires a 'line' event for every embedded newline.  We
  // distinguish the two by inspecting the raw stdin chunk that triggered each
  // 'line' event, with a short fallback coalesce window for terminals that
  // split a markerless paste so a paste-internal newline arrives alone:
  //
  //   • Bare Enter  — the chunk is ONLY \r / \n.  Can only come from the user
  //                   pressing Enter → submit everything accumulated so far.
  //   • Paste line  — the chunk also contains text, so its newline was pasted,
  //                   not typed → accumulate and keep waiting for a real Enter.
  //
  // This replaces an earlier 300 ms debounce that auto-submitted a paste ending
  // in \n.  That timer raced the user: pausing >300 ms after a paste and then
  // typing more caused the paste to submit on its own and the typed tail to
  // submit as a second message (the "auto-replied before I pressed Enter /
  // replied twice" bug). Waiting for an explicit bare Enter, then holding only
  // ambiguous markerless flushes for a few milliseconds, removes the race while
  // normal typing is unaffected because its first Enter is always an
  // unambiguous bare-newline chunk with no buffered pasted content.
  //
  // We prepend the stdin 'data' listener so onData() records the chunk BEFORE
  // readline emits the resulting 'line' event(s) in the same call stack.
  // The SIGINT drain window (ignoreInputUntil) is honored in both handlers.

  let _pendingOrderedSubmit: string | null = null
  const _paste = new PasteAccumulator({
    coalesceMs: PASTE_FALLBACK_COALESCE_MS,
    onDeferredSubmit: (submit) => {
      if (Date.now() < ignoreInputUntil) return
      const orderedSubmit = _pendingOrderedSubmit ?? submit
      finishPasteNotice()
      restorePromptAfterPasteFlush()
      _enqueueInput(orderedSubmit)
    },
  })
  type PasteDisplaySegment = {
    placeholder: string
    chars: number
    text: string
    visibleTail: string
  }

  let _pasteNoticeChars = 0
  let _pasteNoticeTimer: ReturnType<typeof setTimeout> | null = null
  let _pasteOutputMuted = false
  let _pasteApplySerial = 0
  let _pasteCollecting = false
  let _pendingPasteTail = ''
  let _pendingPasteText = ''
  let _activePasteSegment: PasteDisplaySegment | null = null
  const _pasteSegments: PasteDisplaySegment[] = []
  /**
   * Snapshot of readline's line/cursor taken the instant a paste collection
   * starts (from the PREPENDED stdin listener, i.e. before readline ingests the
   * chunk). A MULTI-LINE paste makes readline consume that pre-paste line —
   * typed prefix and any earlier segment placeholders — into an intermediate
   * 'line' event, leaving only the paste tail in rl.line. Without this snapshot
   * the placeholder renderer overwrites the line with a bare [已粘贴N字] (typed
   * chars vanish from display) AND the Enter-time ordered submit — which
   * expands placeholders from the restored line and DISCARDS the accumulator
   * copy — silently drops the typed prefix from the submitted message.
   */
  let _prePasteLine = ''
  let _prePasteCursor = 0

  function beginPasteOutputMute(): void {
    if (_pasteOutputMuted) return
    rlOutput.beginMute()
    _pasteOutputMuted = true
  }

  function endPasteOutputMute(): void {
    if (!_pasteOutputMuted) return
    rlOutput.endMute()
    _pasteOutputMuted = false
  }

  function charCount(text: string): number {
    return Array.from(text).length
  }

  function pasteTail(text: string): string {
    const parts = text.split(/\r\n|\r|\n/)
    return parts[parts.length - 1] ?? ''
  }

  function recordPasteDisplayText(text: string): void {
    if (!_pasteCollecting) {
      _pasteCollecting = true
      _pasteNoticeChars = 0
      _pendingPasteTail = ''
      _pendingPasteText = ''
      _activePasteSegment = null
      // This runs from the prepended stdin listener, BEFORE readline ingests
      // the paste chunk — rl.line still holds exactly what preceded the paste.
      const rlm = mutableReadline()
      _prePasteLine = rlm.line ?? ''
      _prePasteCursor = Math.min(rlm.cursor ?? _prePasteLine.length, _prePasteLine.length)
    }
    _pasteNoticeChars += charCount(text)
    _pendingPasteText += text
    const nextTail = /[\r\n]/.test(text)
      ? pasteTail(text)
      : `${_pendingPasteTail}${text}`
    _pendingPasteTail = nextTail
    if (_activePasteSegment) {
      _activePasteSegment.chars = _pasteNoticeChars
      _activePasteSegment.text = _pendingPasteText
      _activePasteSegment.visibleTail = nextTail
    }
  }

  function ensureActivePasteSegment(): PasteDisplaySegment {
    if (_activePasteSegment) return _activePasteSegment
    const segment: PasteDisplaySegment = {
      placeholder: '',
      chars: _pasteNoticeChars,
      text: _pendingPasteText,
      visibleTail: _pendingPasteTail,
    }
    _pasteSegments.push(segment)
    _activePasteSegment = segment
    return segment
  }

  function lineBreakCount(text: string): number {
    return (text.match(/\r\n|\r|\n/g) ?? []).length
  }

  function shouldShowPasteNotice(pasteInfo: { source: string; text: string }): boolean {
    if (pasteInfo.source === 'none') return false
    if (pasteInfo.source === 'markerless-bare-newline') return _pasteNoticeChars > 0
    const textChars = charCount(pasteInfo.text)
    if (_pasteNoticeChars >= PASTE_NOTICE_MIN_CHARS) return true
    if (textChars >= PASTE_NOTICE_MIN_CHARS) return true
    return lineBreakCount(pasteInfo.text) >= PASTE_NOTICE_MIN_LINES
  }

  function isPostPasteImeCommit(pasteInfo: { source: string; text: string }): boolean {
    return _pasteSegments.length > 0 &&
      !_pasteCollecting &&
      !_pasteOutputMuted &&
      pasteInfo.source === 'bracketed' &&
      charCount(pasteInfo.text) < PASTE_NOTICE_MIN_CHARS &&
      lineBreakCount(pasteInfo.text) === 0
  }

  function schedulePasteNotice(text: string): void {
    if (charCount(text) === 0 && _pasteNoticeChars === 0) return
    if (_activePasteSegment?.placeholder) {
      const serial = ++_pasteApplySerial
      setImmediate(() => {
        if (serial === _pasteApplySerial && _activePasteSegment) {
          applyPastePlaceholder(_activePasteSegment)
        }
      })
      return
    }
    if (_pasteNoticeTimer) clearTimeout(_pasteNoticeTimer)
    _pasteNoticeTimer = setTimeout(() => { renderPasteNotice() }, PASTE_NOTICE_DEBOUNCE_MS)
    _pasteNoticeTimer.unref?.()
  }

  function renderPasteNotice(): void {
    if (_pasteNoticeTimer) clearTimeout(_pasteNoticeTimer)
    _pasteNoticeTimer = null
    if (_pasteNoticeChars <= 0 || Date.now() < ignoreInputUntil) return
    applyPastePlaceholder(ensureActivePasteSegment())
  }

  function applyPastePlaceholder(segment: PasteDisplaySegment): void {
    const mutableRl = rl as readline.Interface & {
      line?: string
      cursor?: number
      _refreshLine?: () => void
    }
    const current = mutableRl.line ?? ''
    const nextPlaceholder = `[已粘贴${segment.chars}字]`
    let cursorAt = -1
    if (segment.placeholder && current.includes(segment.placeholder)) {
      mutableRl.line = current.replace(segment.placeholder, nextPlaceholder)
    } else {
      let visiblePasteChars = 0
      const max = Math.min(current.length, segment.visibleTail.length)
      for (let len = max; len > 0; len--) {
        if (current.slice(current.length - len) === segment.visibleTail.slice(0, len)) {
          visiblePasteChars = len
          break
        }
      }
      let prefix = visiblePasteChars > 0
        ? current.slice(0, current.length - visiblePasteChars)
        : current
      let suffix = ''
      // Multi-line paste: readline consumed the pre-paste line (typed prefix +
      // earlier placeholders) into an intermediate 'line' event, so `current`
      // holds only the paste tail. Re-anchor the placeholder inside the
      // snapshotted pre-paste line — otherwise the typed prefix vanishes from
      // the display AND from the ordered submit (the accumulator copy that
      // still contains it is discarded in favour of the restored line).
      if (lineBreakCount(segment.text) > 0 && _prePasteLine && !prefix.includes(_prePasteLine)) {
        suffix = _prePasteLine.slice(_prePasteCursor)
        prefix = `${_prePasteLine.slice(0, _prePasteCursor)}${prefix}`
      }
      mutableRl.line = `${prefix}${nextPlaceholder}${suffix}`
      // Keep the insertion point right after the pasted block (before any text
      // that sat after the cursor when the paste began).
      cursorAt = `${prefix}${nextPlaceholder}`.length
    }
    segment.placeholder = nextPlaceholder
    mutableRl.cursor = cursorAt >= 0 ? cursorAt : mutableRl.line.length
    rlOutput.withPassthrough(() => { mutableRl._refreshLine?.() })
  }

  function restoreHiddenPasteLine(line: string): string {
    let restored = line
    for (const segment of _pasteSegments) {
      if (!segment.placeholder || !restored.includes(segment.placeholder)) continue
      restored = restored.replace(segment.placeholder, segment.text)
    }
    return restored
  }

  // ── Placeholder-aware editing ─────────────────────────────────────────────
  //
  // The [已粘贴N字] placeholder is literal text in readline's buffer, but it
  // STANDS FOR the hidden pasted content — so it must edit like a single
  // token. Without this, backspace eats the placeholder one CHARACTER at a
  // time: the user "deletes" for a while, the hidden paste text is never
  // dropped, and once the placeholder string is damaged the Enter-time
  // restore no longer matches — the submit silently carries the mangled
  // literal "[已粘贴50" instead of either the paste or its deletion.
  //
  //   • Backspace / forward-delete touching a placeholder deletes the WHOLE
  //     block (placeholder + hidden text + its accumulator lines).
  //   • Any other edit that leaves a placeholder partially damaged is undone
  //     (line restored) — corruption is never representable.
  //   • An edit that removes a placeholder cleanly (e.g. kill-line) drops the
  //     segment with it.

  const BACKSPACE_CHUNKS = new Set(['\x7f', '\b'])
  const FORWARD_DELETE_CHUNK = '\x1b[3~'

  /** The placeholder span a BS/DEL keypress at `cursor` should atomically remove. */
  function placeholderSpanFor(
    line: string,
    cursor: number,
    kind: 'bs' | 'del',
  ): { segment: PasteDisplaySegment; start: number; end: number } | null {
    for (const segment of _pasteSegments) {
      if (!segment.placeholder) continue
      let start = line.indexOf(segment.placeholder)
      while (start !== -1) {
        const end = start + segment.placeholder.length
        // BS deletes the char BEFORE the cursor → fires when that char is any
        // part of the placeholder; DEL deletes AT the cursor → same, shifted.
        if (kind === 'bs' ? cursor > start && cursor <= end : cursor >= start && cursor < end) {
          return { segment, start, end }
        }
        start = line.indexOf(segment.placeholder, start + 1)
      }
    }
    return null
  }

  function dropPasteSegment(segment: PasteDisplaySegment): void {
    const i = _pasteSegments.indexOf(segment)
    if (i >= 0) _pasteSegments.splice(i, 1)
    // The paste's intermediate lines live in the accumulator (multi-line paste);
    // deleting the block must delete them too, or Enter would resurrect them.
    _paste.clear()
  }

  /**
   * Runs in the prepended stdin listener (BEFORE readline edits the line), so
   * the pre-edit line/cursor can be captured; the correction is applied on
   * setImmediate, after readline has processed the same chunk.
   */
  function handlePasteAwareEditChunk(chunk: string): void {
    if (_pasteSegments.length === 0) return
    const before = mutableReadline()
    const beforeLine = before.line ?? ''
    const beforeCursor = Math.min(before.cursor ?? beforeLine.length, beforeLine.length)
    if (!_pasteSegments.some(s => s.placeholder && beforeLine.includes(s.placeholder))) return
    const kind = BACKSPACE_CHUNKS.has(chunk) ? 'bs' : chunk === FORWARD_DELETE_CHUNK ? 'del' : null
    const hit = kind ? placeholderSpanFor(beforeLine, beforeCursor, kind) : null
    setImmediate(() => {
      const rlm = mutableReadline()
      if (hit) {
        // Atomic delete: one keypress removes the whole pasted block.
        rlm.line = beforeLine.slice(0, hit.start) + beforeLine.slice(hit.end)
        rlm.cursor = hit.start
        dropPasteSegment(hit.segment)
        rlOutput.withPassthrough(() => { rlm._refreshLine?.() })
        return
      }
      // Integrity guard for every other editing key.
      const line = rlm.line ?? ''
      for (const segment of [..._pasteSegments]) {
        if (!segment.placeholder || !beforeLine.includes(segment.placeholder)) continue
        if (line.includes(segment.placeholder)) continue
        if (beforeLine.replace(segment.placeholder, '') === line) {
          dropPasteSegment(segment)   // clean removal (e.g. kill-line on a lone block)
          continue
        }
        // Partial damage — undo the edit rather than let a mangled placeholder
        // corrupt the submit.
        rlm.line = beforeLine
        rlm.cursor = beforeCursor
        rlOutput.withPassthrough(() => { rlm._refreshLine?.() })
        return
      }
    })
  }

  function mutableReadline(): readline.Interface & {
    line?: string
    cursor?: number
    _refreshLine?: () => void
  } {
    return rl as readline.Interface & {
      line?: string
      cursor?: number
      _refreshLine?: () => void
    }
  }

  function insertReadlineText(text: string): void {
    const mutableRl = mutableReadline()
    const line = mutableRl.line ?? ''
    const cursor = mutableRl.cursor ?? line.length
    mutableRl.line = `${line.slice(0, cursor)}${text}${line.slice(cursor)}`
    mutableRl.cursor = cursor + text.length
    mutableRl._refreshLine?.()
  }

  function removeShiftEnterSequencesFromReadline(): void {
    const mutableRl = mutableReadline()
    const line = mutableRl.line ?? ''
    let cleaned = line
    for (const seq of SHIFT_ENTER_SEQUENCES) cleaned = cleaned.split(seq).join('')
    if (cleaned === line) return
    mutableRl.line = cleaned
    mutableRl.cursor = Math.min(mutableRl.cursor ?? cleaned.length, cleaned.length)
  }

  function handleShiftEnterChunk(chunk: string): boolean {
    let count = 0
    for (const seq of SHIFT_ENTER_SEQUENCES) {
      let idx = chunk.indexOf(seq)
      while (idx !== -1) {
        count++
        idx = chunk.indexOf(seq, idx + seq.length)
      }
    }
    if (count === 0) return false
    const before = mutableReadline()
    const beforeLine = before.line ?? ''
    const beforeCursor = before.cursor ?? beforeLine.length
    rlOutput.muteForCurrentInput()
    setImmediate(() => {
      const mutableRl = mutableReadline()
      mutableRl.line = beforeLine
      mutableRl.cursor = beforeCursor
      insertReadlineText('\n'.repeat(count))
      removeShiftEnterSequencesFromReadline()
    })
    return true
  }

  function finishPasteNotice(): void {
    if (pasteNoticeActive()) renderPasteNotice()
    _pasteNoticeTimer = null
    _pasteNoticeChars = 0
    _pendingPasteTail = ''
    _pendingPasteText = ''
    _prePasteLine = ''
    _prePasteCursor = 0
    _pasteCollecting = false
    _activePasteSegment = null
    _pasteSegments.length = 0
    _pendingOrderedSubmit = null
    _pasteApplySerial++
    endPasteOutputMute()
  }

  function clearPasteNotice(): void {
    if (_pasteNoticeTimer) clearTimeout(_pasteNoticeTimer)
    _pasteNoticeTimer = null
    _pasteNoticeChars = 0
    _pendingPasteTail = ''
    _pendingPasteText = ''
    _prePasteLine = ''
    _prePasteCursor = 0
    _pasteCollecting = false
    _activePasteSegment = null
    _pasteSegments.length = 0
    _pendingOrderedSubmit = null
    _pasteApplySerial++
    endPasteOutputMute()
  }

  function endCurrentPasteDisplaySegment(): void {
    if (_pasteNoticeTimer) clearTimeout(_pasteNoticeTimer)
    _pasteNoticeTimer = null
    _pasteNoticeChars = 0
    _pendingPasteTail = ''
    _pendingPasteText = ''
    _prePasteLine = ''
    _prePasteCursor = 0
    _pasteCollecting = false
    _activePasteSegment = null
    _pasteApplySerial++
    endPasteOutputMute()
  }

  function discardCurrentPasteCandidate(): void {
    if (_pasteNoticeTimer) clearTimeout(_pasteNoticeTimer)
    _pasteNoticeTimer = null
    _pasteNoticeChars = 0
    _pendingPasteTail = ''
    _pendingPasteText = ''
    _prePasteLine = ''
    _prePasteCursor = 0
    _pasteCollecting = false
    _activePasteSegment = null
    _pasteApplySerial++
    endPasteOutputMute()
  }

  function pasteNoticeActive(): boolean {
    return _pasteNoticeTimer !== null || _pasteOutputMuted
  }

  // Ask the terminal to wrap pastes in ESC[200~ / ESC[201~ markers so pasted
  // newlines can be told apart from a typed Enter with certainty. Restore the
  // terminal's default on every exit path so we never leave the mode dangling.
  let _bracketedPasteOn = false
  const enableBracketedPaste = (): void => {
    if (isTTY && !_bracketedPasteOn) {
      process.stdout.write(BRACKETED_PASTE_ENABLE)
      _bracketedPasteOn = true
    }
  }
  const disableBracketedPaste = (): void => {
    if (_bracketedPasteOn) {
      process.stdout.write(BRACKETED_PASTE_DISABLE)
      _bracketedPasteOn = false
    }
  }
  enableBracketedPaste()

  const _inputQueue: string[] = []
  const _inputResolvers: Array<(v: string | null) => void> = []
  let _rlClosed = false

  // ── Mid-turn steering (Ctrl+G) ────────────────────────────────────────────
  // While a turn is streaming, Ctrl+G (BEL, 0x07) arms a one-shot "correction"
  // prompt. The byte is delivered immediately because readline keeps the TTY in
  // raw mode, so the stdin 'data' listener below sees it the instant it's typed.
  // We never abort the model — the correction is injected at the next kernel
  // loop boundary via router.steer().
  let _isStreaming = false
  let _steerArmed = false
  let _steerNotify: (() => void) | null = null
  // True only while readline owns the `steer ›` prompt during a steer input, so
  // the paste-driven prompt sync below doesn't clobber it back to `you ›`.
  let _steerInputActive = false
  // True while a wizard (e.g. the hardware-profile prompts) owns the line via
  // rl.question(). Unlike interactiveInputActive (used by _promptLineInline,
  // which reads through the shared paste queue), a wizard reads input NATIVELY
  // through readline — so the stdin 'data' handler must NOT feed the paste
  // accumulator or reset the prompt while it's set, and the 'line' handler must
  // not enqueue. Otherwise the data handler clobbers the wizard's question
  // prompt with `you ›` on every keystroke, and the accumulator is left in a
  // half-buffered state that swallows the first real line afterward (the
  // "wizard hint vanishes, then the prompt freezes" bug).
  let _wizardActive = false
  const _armSteer = (): void => {
    _steerArmed = true
    const notify = _steerNotify
    _steerNotify = null
    notify?.()
  }
  const _steerPrompt = `${bold(cyan('steer'))} › `
  const steerHooks = {
    waitArmed: (): Promise<void> =>
      _steerArmed ? Promise.resolve() : new Promise<void>(resolve => { _steerNotify = resolve }),
    isArmed: (): boolean => _steerArmed,
    consume: (): void => { _steerArmed = false; _steerNotify = null },
    beginInput: (): void => {
      // readline now renders + redraws THIS prompt as the user types, so the
      // line stays a `steer ›` line instead of reverting to `you ›`.
      _steerInputActive = true
      setInteractiveActive(true)
      rl.setPrompt(_steerPrompt)
      rl.prompt()
    },
    read: (): Promise<string | null> => _nextInput(),
    endInput: (): void => {
      _steerInputActive = false
      setInteractiveActive(false)
      rl.setPrompt(PROMPT_YOU)
    },
  }

  function _enqueueInput(combined: string): void {
    if (_inputResolvers.length > 0) {
      _inputResolvers.shift()!(combined)
    } else {
      _inputQueue.push(combined)
    }
  }

  function _nextInput(): Promise<string | null> {
    if (_rlClosed && _inputQueue.length === 0) return Promise.resolve(null)
    if (_inputQueue.length > 0) return Promise.resolve(_inputQueue.shift()!)
    return new Promise<string | null>(resolve => _inputResolvers.push(resolve))
  }

  function restorePromptAfterPasteFlush(): void {
    if (isTTY && !_steerInputActive && !interactiveInputActive) rl.setPrompt(PROMPT_YOU)
  }

  // Inline confirmation reader for mid-turn prompts (e.g. multi-agent escalation).
  // Prints the question and reads the next line through the SAME shared queue the
  // main loop uses, so the keystroke is never lost to a competing raw-stdin read.
  // Marks input active so the team-reminder timer doesn't fire over the prompt.
  async function _promptLineInline(question: string): Promise<string | null> {
    // Pause the streaming spinner first — its 120ms redraw timer would otherwise
    // erase this question on the next tick, hiding the prompt entirely. The
    // stream's event handlers re-show the meter on the next model event.
    pauseActiveThinkingMeter()
    setInteractiveActive(true)
    try {
      process.stdout.write(question)
      return await _nextInput()
    } finally {
      setInteractiveActive(false)
      if (isTTY && !_steerInputActive) rl.setPrompt(PROMPT_YOU)
    }
  }

  // Run an interactive wizard that reads input natively via rl.question() (the
  // hardware-profile prompts). While it runs we suspend the paste accumulator
  // and prompt-sync (see _wizardActive), then clear any stale chunk state and
  // restore the `you ›` prompt so the main loop's next line is classified fresh
  // and actually reaches _nextInput().
  async function runWizard<T>(fn: () => Promise<T>): Promise<T> {
    _wizardActive = true
    setInteractiveActive(true)   // also silence the team-reminder timer
    try {
      return await fn()
    } finally {
      _wizardActive = false
      setInteractiveActive(false)
      _paste.clear()
      if (isTTY) rl.setPrompt(PROMPT_YOU)
    }
  }

  // Must be prepended so it fires BEFORE readline's own 'data' handler — this
  // guarantees the chunk is recorded before any resulting 'line' event fires.
  process.stdin.prependListener('data', (buf: Buffer) => {
    // Ctrl+G during a streaming turn arms a steering correction (handled by
    // streamPrompt). Outside a turn it's ignored. We still feed the chunk to the
    // paste accumulator below — readline does not insert a BEL into the buffer.
    if (_isStreaming && buf.includes(0x07)) _armSteer()
    if (Date.now() < ignoreInputUntil) {
      _paste.resetChunk()   // SIGINT drain — don't classify against this chunk
      return
    }
    // A native readline question owns the line: let readline render and read it
    // natively. Touching the paste state or prompt here would overwrite the
    // question prompt with `you ›` and corrupt the accumulator.
    if (_wizardActive || isNativeQuestionActive(rl)) return
    if (handleShiftEnterChunk(buf.toString())) {
      _paste.resetChunk()
      return
    }
    const pasteInfo = _paste.onData(buf.toString())
    if (pasteInfo.isPaste) {
      const postPasteImeCommit = isPostPasteImeCommit(pasteInfo)
      if (postPasteImeCommit) {
        _pasteApplySerial++
        endPasteOutputMute()
      } else {
        recordPasteDisplayText(pasteInfo.text)
      }
      if (!postPasteImeCommit && shouldShowPasteNotice(pasteInfo)) {
        beginPasteOutputMute()
        rlOutput.muteForCurrentInput()
        schedulePasteNotice(pasteInfo.text)
      }
    } else if (pasteNoticeActive()) {
      renderPasteNotice()
      endCurrentPasteDisplaySegment()
      handlePasteAwareEditChunk(buf.toString())
    } else if (!_paste.buffering && _pasteCollecting) {
      discardCurrentPasteCandidate()
      handlePasteAwareEditChunk(buf.toString())
    } else {
      // Ordinary keystroke while placeholders are on the line: keep the pasted
      // blocks atomic under backspace/delete and immune to partial damage.
      handlePasteAwareEditChunk(buf.toString())
    }
    // While a multi-line paste is still being collected, blank readline's prompt
    // so the trailing partial line isn't redrawn with a second `you ›` prefix on
    // the next keystroke. Restored to PROMPT_YOU once the buffer flushes.
    if (isTTY && _steerInputActive) {
      // Some editing keys force readline to refresh the current line. Keep the
      // active prompt locked to `steer ›` for the whole correction input.
      rl.setPrompt(_steerPrompt)
    } else if (isTTY && !interactiveInputActive) {
      rl.setPrompt(_paste.buffering ? '' : PROMPT_YOU)
    }
  })

  rl.on('line', (rawLine) => {
    if (Date.now() < ignoreInputUntil) return   // SIGINT drain — silently discard
    // Native rl.question consumers handle the line via their own callback; this listener
    // must stay out of the way so it doesn't double-handle or enqueue them.
    if (_wizardActive || isNativeQuestionActive(rl)) return
    // Returns a complete message only on a bare Enter; null means "still a
    // paste in progress — accumulate and wait for the user's explicit Enter".
    const restoredLine = restoreHiddenPasteLine(rawLine)
    _pendingOrderedSubmit = _pasteSegments.length > 0 ? restoredLine : null
    const submit = _paste.onLine(restoredLine)
    if (submit !== null) {
      // Buffer flushed — restore the normal prompt for the next turn (the data
      // handler blanked it while the paste was being collected).
      const orderedSubmit = _pasteSegments.length > 0 ? restoredLine : submit
      finishPasteNotice()
      restorePromptAfterPasteFlush()
      _enqueueInput(orderedSubmit)
    }
  })

  rl.on('SIGINT', () => {
    if (ctrlCPressed) { rl.close(); return }
    ctrlCPressed = true
    router.interrupt()
    interrupted = true
    // Drain any lines already in the readline buffer so they don't auto-fire
    // as new prompts after the interrupt clears.
    ignoreInputUntil = Date.now() + 300
    // Clear any paste accumulator state so buffered content before the
    // interrupt is not submitted after the drain window expires.
    _paste.clear()
    clearPasteNotice()
    if (isTTY) rl.setPrompt(PROMPT_YOU)   // paste-collection may have blanked it
    process.stdout.write(`\n${yellow('Interrupted')} ${dim('(press Ctrl+C again to exit)')}\n`)
    setTimeout(() => { ctrlCPressed = false }, 2000)
    rl.prompt()
  })

  rl.on('close', () => {
    disableBracketedPaste()
    clearPasteNotice()
    // Signal EOF to the accumulator queue so _nextInput() unblocks
    _rlClosed = true
    // Recover any paste left in the buffer at EOF (e.g. Ctrl+D after a paste).
    const _pasteTail = _paste.drain()
    if (_pasteTail !== null) _enqueueInput(_pasteTail)
    for (const resolve of _inputResolvers) resolve(null)
    _inputResolvers.length = 0

    if (exiting) return
    exiting = true
    if (teamReminderTimer) clearInterval(teamReminderTimer)
    // Hard-exit fuse for the EOF/Ctrl+D path — same rationale as disposeAndExit.
    const hardExit = setTimeout(() => process.exit(0), 15_000)
    hardExit.unref?.()
    void (async () => {
      try {
        if (!opts.json) {
          // Show LLM-guided experience summary at session end (not per-turn).
          const pending = router.getPendingExperiences()
          const pendingCount = pending?.count ?? 0
          if (pendingCount > 0 && pending) {
            await streamExperienceSummary(router, [...pending.list()])
            console.log(
              `${yellow(`⏸  ${pendingCount} 条经验待审核`)} — ` +
              `${dim('下次在同一项目启动 robotics 模式后，可用 /experience review 继续审核。')}\n`,
            )
          }
          // Show pending physical anchor count (populated after dispose() extraction).
          // Note: we can only read the count that was already in queue before dispose();
          // the post-session Flash extraction runs inside dispose() below.
          const pendingAnchors = router.getPendingPhysicalAnchors()
          const anchorCount = pendingAnchors?.count ?? 0
          if (anchorCount > 0) {
            console.log(
              `${yellow(`⚓  ${anchorCount} 条物理锚点待审核`)} — ` +
              `${dim('下次在同一项目启动 robotics 模式后，可用 /anchor review 审核提交。')}\n`,
            )
          }
          const pendingPrinciples = router.getPendingPrinciples()
          const principleCount = pendingPrinciples?.count ?? 0
          if (principleCount > 0) {
            console.log(
              `${yellow(`⏸  ${principleCount} 条原则待审核`)} — ` +
              `${dim('下次在同一项目启动 robotics 模式后，可用 /principle review 审核提交。')}\n`,
            )
          }
          // Memory is global (all modes). Surface tool-proposed memories queued
          // this session; the post-session auto-writer runs inside dispose()
          // below and its proposals are surfaced via /memory on next launch.
          const memoryCount = getMemoryPendingStore().count
          if (memoryCount > 0) {
            console.log(
              `${yellow(`⏸  ${memoryCount} 条记忆待审核`)} — ` +
              `${dim('使用 /memory review 审核提交。')}\n`,
            )
          }
          console.log(`\n${dim('Goodbye.')}\n`)
        }
      } catch { /* best-effort — close-path errors must not block process exit */ }
      try { await router.dispose() } catch { /* best-effort */ }
      process.exit(0)
    })()
  })

  // ── Process-level cleanup handlers ───────────────────────────────────────
  // Called on graceful shutdown (SIGTERM) or unhandled crashes.
  // We await router.dispose() so RoboticsSession can cancel sub-agents,
  // stop heartbeat timers, and purge git worktrees before the process exits.
  // `router` is a `let` so the handlers always see the current router even
  // after `/clear` or `/hardware select` rebuilt it.
  const disposeAndExit = async (code: number, err?: unknown): Promise<void> => {
    if (exiting) return
    exiting = true
    // Hard-exit fuse: if router.dispose() hangs (stuck git worktree purge,
    // wedged sub-agent teardown, …) the process must still terminate.
    // unref() keeps the timer from holding the event loop open itself.
    const hardExit = setTimeout(() => process.exit(code), 15_000)
    hardExit.unref?.()
    if (teamReminderTimer) clearInterval(teamReminderTimer)
    disableBracketedPaste()
    if (err) console.error(`\n${red('Fatal:')} ${terminalText(err instanceof Error ? err.message : String(err))}\n`)
    try { await router.dispose() } catch { /* best-effort */ }
    try { rl.close() } catch { /* best-effort */ }
    process.exit(code)
  }
  process.once('SIGTERM',            () => { void disposeAndExit(0) })
  process.once('uncaughtException',  (e) => { void disposeAndExit(1, e) })
  process.once('unhandledRejection', (e) => { void disposeAndExit(1, e) })

  rl.prompt()

  while (true) {
    const rawInput = await _nextInput()
    if (rawInput === null) break   // rl closed (EOF / Ctrl+D)

    const input = rawInput.trim()
    if (!input) { rl.prompt(); continue }

    // ── Built-in slash commands ──
    if (input.startsWith('/')) {
      const cmd = input.split(/\s+/)[0]!.toLowerCase()
      switch (cmd) {
        case '/exit':
        case '/quit':
          rl.close()
          return
        case '/mode':
          console.log(`\nSession mode: ${cyan(router.mode ?? 'not yet determined')}\n`)
          break
        case '/workspace':
          console.log(`\nWorkspace: ${cyan(opts.workspace ?? '(unset — no file restrictions)')}\n`)
          break
        case '/hardware': {
          const subCmd = input.split(/\s+/).slice(1).join(' ').toLowerCase()
          if (subCmd === 'select') {
            // /hardware select — re-run hardware selection wizard
            if (opts.mode !== 'robotics') {
              console.log(`\n${yellow('硬件选择仅在 robotics 模式下可用。')}\n`)
            } else {
              const hp = new HardwareProfile()
              const selected = await runWizard(() => selectHardwareProfile(hp, opts.workspace, rl))
              opts.hardwareId     = selected.name || undefined
              hardwareProfileText = selected.profileText
              // Rebuild router with the new hardware binding (keeps same workspace/key/model)
              await router.dispose().catch(() => undefined)
              router = makeRouter(opts, hardwareProfileText || undefined, rl, undefined, getCurrentRouter, _promptLineInline)
              savedMessageCount = 0
              console.log(green('\n✓ 硬件配置已更新，新会话已启动。\n'))
            }
          } else {
            // /hardware — show current binding
            if (opts.hardwareId) {
              const hp = new HardwareProfile()
              const text = await hp.formatForPrompt(opts.hardwareId)
              console.log(`\n${text}\n`)
            } else if (opts.mode === 'robotics') {
              console.log(`\n${yellow('未绑定硬件配置。')} 使用 ${cyan('/hardware select')} 选择。\n`)
            } else {
              console.log(`\n${dim('硬件配置仅在 robotics 模式下可用。')}\n`)
            }
          }
          break
        }
        case '/usage': {
          const u = router.getUsage()
          const cost = router.getEstimatedCost()
          const autoCost = router.getAutoCostBreakdown()
          const costDetail = autoCost
            ? `Estimated cost: $${cost.toFixed(5)}  ` +
              `(main: $${autoCost.mainCostUsd.toFixed(5)}, sub-agents: $${autoCost.subAgentCostUsd.toFixed(5)}, ` +
              `reserved: $${autoCost.reservedSubAgentBudgetUsd.toFixed(5)}, ` +
              `budget: $${autoCost.budgetUsd.toFixed(5)})\n`
            : `Estimated cost: $${cost.toFixed(5)}\n`
          console.log(
            `\nTokens — in: ${u.inputTokens}  out: ${u.outputTokens}  ` +
            `cache_read: ${u.cacheReadInputTokens ?? 0}\n` +
            costDetail,
          )
          break
        }
        case '/sessions': {
          const sessionsSub = input.split(/\s+/).slice(1).join(' ').toLowerCase().trim()

          if (sessionsSub === 'clear') {
            // ── /sessions clear — delete sessions ───────────────────────────
            const sessions = await SessionStore.listSessions(50, { workspace: opts.workspace })
            if (sessions.length === 0) {
              console.log(dim('\n当前 workspace 暂无历史会话。\n'))
              break
            }
            console.log(`\n${bold('选择要删除的会话:')} ${dim('(仅当前 workspace；输入序号删除，all 删除全部，回车取消)')}\n`)
            sessions.forEach((s, i) => {
              const ago = formatAge(Date.now() - s.lastActivity)
              const preview = sessionDisplayTitle(s, 60)
              console.log(
                `  ${cyan(String(i + 1))}. ${bold(s.mode.padEnd(10))} ` +
                `${dim(ago.padEnd(12))} ${dim(`[${s.messageCount} 条]`)}  ${preview}`,
              )
            })
            console.log()
            const choice = await askQuestion(rl, `请选择 [1-${sessions.length} / all / 回车取消]: `)
            const choiceTrimmed = choice.trim().toLowerCase()
            if (!choiceTrimmed) {
              // cancelled
            } else if (choiceTrimmed === 'all') {
              const confirm = await askQuestion(rl, `${yellow('⚠  确认删除当前 workspace 的全部 ')}${sessions.length}${yellow(' 条历史会话？[y/N] ')}`)
              if (confirm.trim().toLowerCase() === 'y') {
                // Delete ONLY the sessions we listed for THIS workspace. The
                // earlier deleteAllSessions() wiped every workspace's history
                // despite the "当前 workspace" prompt — deleteSessions() filters
                // the index atomically (no last-writer-wins race) while staying
                // scoped to the listed IDs.
                await SessionStore.deleteSessions(sessions.map(s => s.sessionId))
                console.log(green(`\n✓ 已删除当前 workspace 的 ${sessions.length} 条历史会话。\n`))
              } else {
                console.log(dim('\n已取消。\n'))
              }
            } else {
              const idx = parseInt(choiceTrimmed, 10)
              if (idx >= 1 && idx <= sessions.length) {
                const selected = sessions[idx - 1]!
                await SessionStore.deleteSession(selected.sessionId)
                const preview = sessionDisplayTitle(selected, 50)
                console.log(green(`\n✓ 已删除会话: ${dim(preview)}\n`))
              } else {
                console.log(yellow('\n无效选择。\n'))
              }
            }
          } else {
            // ── /sessions — list & resume ────────────────────────────────────
              const sessions = await SessionStore.listSessions(8, { workspace: opts.workspace })
              if (sessions.length === 0) {
                console.log(dim('\n当前 workspace 暂无历史会话。\n'))
              } else {
                console.log(`\n${bold('历史会话:')} ${dim('(仅当前 workspace；输入序号加载并继续上次对话)')}\n`)
              sessions.forEach((s, i) => {
                const ago = formatAge(Date.now() - s.lastActivity)
                const preview = sessionDisplayTitle(s, 60)
                console.log(
                  `  ${cyan(String(i + 1))}. ${bold(s.mode.padEnd(10))} ` +
                  `${dim(ago.padEnd(12))} ${dim(`[${s.messageCount} 条]`)}  ${preview}`,
                )
              })
              console.log(`  ${cyan('0')}.  ${dim('取消')}\n`)
              const choice = await askQuestion(rl, `请选择 [0-${sessions.length}，回车取消]: `)
              const idx = parseInt(choice, 10)
              if (choice.trim() && idx >= 1 && idx <= sessions.length) {
                const selected = sessions[idx - 1]!
                console.log(dim('\n加载历史会话...\n'))
                const messages = await SessionStore.loadHistory(selected.sessionId)
                if (messages.length === 0) {
                  console.log(yellow('⚠  找不到历史记录。\n'))
                } else {
                  console.log(green(`✓ 已加载 ${messages.length} 条历史消息，继续 ${selected.mode} 模式。\n`))
                  opts.mode = selected.mode as CliOptions['mode']
                  await router.dispose().catch(() => undefined)
                  router = makeRouter(opts, hardwareProfileText || undefined, rl, messages, getCurrentRouter, _promptLineInline, selected.sessionId)
                  savedMessageCount = messages.length
                }
              }
            }
          }
          break
        }
        case '/experience': {
          const subCmd = input.split(/\s+/).slice(1).join(' ').toLowerCase()
          const subTokens = input.split(/\s+/).slice(1).map(t => t.toLowerCase())
          if (await handleDeleteSubcommand(rl, 'experience', subTokens, opts.mode === 'robotics' || router.mode === 'robotics')) break
          let pending = router.getPendingExperiences()
          // The robotics session is created lazily on the first message, so
          // before any prompt is sent `getPendingExperiences()` is null even in
          // robotics mode. Pending experiences are disk-persisted per project,
          // so load them directly to support "resume → review" without first
          // having to send a message.
          if (!pending && (opts.mode === 'robotics' || router.mode === 'robotics')) {
            const diskStore = new ExperiencePendingStore(opts.workspace)
            await diskStore.load()
            pending = diskStore
          }
          if (subCmd === 'review') {
            if (!pending) {
              console.log(yellow('\n/experience review 仅在 robotics 模式下可用。\n'))
            } else if (pending.count === 0) {
              console.log(`\n${dim('暂无待审经验。')}\n`)
            } else {
              const store = new ExperienceStore()
              // v1: commit only. Principle promotion / anchor claim / propagation
              // are deferred (code retained, not wired) — see
              // docs/knowledge-v1-experience-anchor.md.
              await reviewPendingExperiences(rl, pending, store)
            }
          } else {
            const count = pending?.count ?? 0
            if (count > 0) {
              console.log(`\n${yellow(`⏸  ${count} 条经验待审核`)} — 使用 ${cyan('/experience review')} 审核提交\n`)
            } else {
              console.log(`\n${dim('暂无待审经验。')}\n`)
            }
          }
          break
        }
        case '/principle': {
          const subCmd = input.split(/\s+/).slice(1).join(' ').toLowerCase()
          const subTokens = input.split(/\s+/).slice(1).map(t => t.toLowerCase())
          if (await handleDeleteSubcommand(rl, 'principle', subTokens, opts.mode === 'robotics' || router.mode === 'robotics')) break
          const pendingPrinciples = router.getPendingPrinciples()
          if (subCmd === 'review') {
            if (!pendingPrinciples) {
              console.log(yellow('\n/principle review 仅在 robotics 模式下可用。\n'))
            } else {
              const store = new PrincipleStore()
              await reviewPendingPrinciples(rl, pendingPrinciples, store, new ExperienceStore(), new PhysicalAnchorStore())
            }
          } else {
            const count = pendingPrinciples?.count ?? 0
            if (count > 0) {
              console.log(`\n${yellow(`⏸  ${count} 条原则待审核`)} — 使用 ${cyan('/principle review')} 审核提交\n`)
            } else {
              console.log(`\n${dim('暂无待审原则。')}\n`)
            }
          }
          break
        }
        case '/anchor': {
          const subCmd = input.split(/\s+/).slice(1).join(' ').toLowerCase()
          const subTokens = input.split(/\s+/).slice(1).map(t => t.toLowerCase())
          if (await handleDeleteSubcommand(rl, 'anchor', subTokens, opts.mode === 'robotics' || router.mode === 'robotics')) break
          const pendingAnchors = router.getPendingPhysicalAnchors()
          if (subCmd === 'review') {
            if (!pendingAnchors) {
              console.log(yellow('\n/anchor review 仅在 robotics 模式下可用。\n'))
            } else {
              const store = new PhysicalAnchorStore()
              const committed = await reviewPendingPhysicalAnchors(rl, pendingAnchors, store)
              // Newly committed anchors → refresh the memoized R6 set next turn.
              if (committed > 0) router.invalidateAnchors()
            }
          } else {
            const count = pendingAnchors?.count ?? 0
            if (count > 0) {
              console.log(`\n${yellow(`⏸  ${count} 条物理锚点待审核`)} — 使用 ${cyan('/anchor review')} 审核提交\n`)
            } else {
              console.log(`\n${dim('暂无待审物理锚点。')}\n`)
            }
          }
          break
        }
        case '/memory': {
          const subCmd = input.split(/\s+/).slice(1).join(' ').toLowerCase()
          const subTokens = input.split(/\s+/).slice(1).map(t => t.toLowerCase())
          if (await handleDeleteSubcommand(rl, 'memory', subTokens, true)) break
          // Memory is global (all modes); load the process-wide queue from disk.
          await ensureMemoryPendingLoaded()
          const pendingMemories = getMemoryPendingStore()
          if (subCmd === 'review') {
            if (pendingMemories.count === 0) {
              console.log(`\n${dim('暂无待审记忆。')}\n`)
            } else {
              await reviewPendingMemories(rl, pendingMemories)
            }
          } else {
            const count = pendingMemories.count
            if (count > 0) {
              console.log(`\n${yellow(`⏸  ${count} 条记忆待审核`)} — 使用 ${cyan('/memory review')} 审核提交\n`)
            } else {
              console.log(`\n${dim('暂无待审记忆。')}\n`)
            }
          }
          break
        }
        case '/team': {
          const [, rawTeamSub = ''] = input.split(/\s+/)
          const teamSub = rawTeamSub.toLowerCase()
          if (teamSub === 'off' || teamSub === 'exit') {
            console.log(`\n${dim('已退出 team 入口引导；当前仍是正常 robot mode。再次输入 /team 可重新选择工作。')}\n`)
            break
          }
          teamModeUsed = true   // user explicitly entered team mode — enable notifications
          await handleTeamCommand(input, router, opts, rl, setInteractiveActive)
          break
        }
        case '/compact': {
          // Manual compaction — same pipeline as auto-compact (summary +
          // keep-set + deterministic anchors + quality gate), forced now.
          console.log(dim('\n🗜  正在压缩会话上下文…'))
          const compactResult = await router.compactNow()
          if (compactResult.compacted) {
            const prev = ((compactResult.previousTokens ?? 0) / 1000).toFixed(1)
            const post = ((compactResult.postTokens ?? 0) / 1000).toFixed(1)
            console.log(green(`🗜  压缩完成 ${prev}k → ${post}k tokens\n`))
            // Persist the compacted history so resume sees the compact form.
            await persistCurrentSession(input).catch(() => undefined)
            savedMessageCount = router.getMessages().length
          } else {
            console.log(yellow(`未压缩：${compactResult.reason ?? '未知原因'}\n`))
          }
          break
        }
        case '/clear':
          await router.dispose().catch(() => undefined)
          router = makeRouter(opts, undefined, rl, undefined, getCurrentRouter, _promptLineInline)
          savedMessageCount = 0
          resetTitleState()
          console.log(green('\nNew session started.\n'))
          break
        case '/help':
          printHelp()
          break
        default:
          console.log(`\n${yellow('Unknown command:')} ${cmd}  ${dim('(try /help)')}\n`)
      }
      rl.prompt()
      continue
    }

    // ── Normal prompt ──
    interrupted = false

    // Snapshot pending counts before this turn so we can detect new additions
    const pendingCountBefore = router.getPendingExperiences()?.count ?? 0
    const anchorCountBefore = router.getPendingPhysicalAnchors()?.count ?? 0

    // Enable Ctrl+G steering only in an interactive TTY (and not in --json mode).
    const _steerEnabled = isTTY && !opts.json
    if (_steerEnabled) {
      _steerArmed = false
      _steerNotify = null
      _isStreaming = true
    }
    try {
      await streamPrompt(
        router, input, opts.json, opts.showThinking,
        _steerEnabled ? steerHooks : undefined,
      )
    } catch (err) {
      if (!interrupted) {
        const msg = terminalText(err instanceof Error ? err.message : String(err))
        console.error(`\n${red('Error:')} ${msg}\n`)
      }
    } finally {
      // Disarm steering so a stray Ctrl+G at the idle prompt does nothing.
      _isStreaming = false
      _steerArmed = false
      _steerNotify = null
    }

    // ── Post-turn: nudge for newly queued physical anchors ───────────────────
    if (!opts.json) {
      const anchorCountAfter = router.getPendingPhysicalAnchors()?.count ?? 0
      const newAnchors = anchorCountAfter - anchorCountBefore
      if (newAnchors > 0) {
        process.stdout.write(
          `\n${yellow(`⚓  ${newAnchors} 条新物理锚点待审核`)} — ` +
          `${dim('使用 /anchor review 审核并提交至知识库。')}\n`,
        )
      }
    }
    void pendingCountBefore // suppress unused-variable lint

    // ── Show real debug dir once we have a sessionId ──────────────────────────
    if (opts.debug && !debugDirShown) {
      const sid = router.getSessionId()
      if (sid) {
        const realDir = join(META_AGENT_HOME, 'debug', sid)
        console.log(`\n${dim('调试日志目录:')} ${cyan(realDir)}\n`)
        debugDirShown = true
      }
    }

    // ── Post-turn: hardware binding catch-up ─────────────────────────────────
    // If a robotics router exists without hardware binding, prompt so subsequent
    // turns get hardware context.
    if (
      !interrupted && !opts.json && isTTY &&
      router.mode === 'robotics' && !opts.hardwareId && !hardwareBindingPrompted
    ) {
      hardwareBindingPrompted = true
      console.log(
        `\n${c.magenta}robotics${c.reset} 模式已激活，请绑定硬件配置以优化后续回复。\n`,
      )
      const hp = new HardwareProfile()
      const selected = await runWizard(() => selectHardwareProfile(hp, opts.workspace, rl))
      opts.hardwareId     = selected.name || undefined
      hardwareProfileText = selected.profileText
      if (hardwareProfileText) {
        await persistCurrentSession(input)
        opts.mode = 'robotics'
        await router.dispose().catch(() => undefined)
        router = makeRouter(opts, hardwareProfileText, rl, undefined, getCurrentRouter, _promptLineInline)
        savedMessageCount = 0
      }
      if (opts.hardwareId) {
        console.log(green(`✓ 硬件配置 "${opts.hardwareId}" 已绑定，后续回复将包含硬件上下文。\n`))
      }
    }

    // ── Persist session after each turn ──────────────────────────────────────
    // Append only the new messages (since savedMessageCount) so the file grows
    // incrementally rather than being rewritten on every turn.
    await persistCurrentSession(input)

    // Fire-and-forget: generate (new sessions) or persist (carried titles).
    maybeGenerateSessionTitle()

    rl.prompt()
  }
}

// ── Single-turn mode ──────────────────────────────────────────────────────────

async function runSingleTurn(opts: CliOptions): Promise<void> {
  const storeOptions = opts.sessionDir ? { rootDir: opts.sessionDir } : undefined
  let resumedMessages: ConversationMessage[] = []
  let resumedSessionId: string | undefined
  let savedMessageCount = 0

  if (opts.resume) {
    let targetId = opts.resume
    if (targetId === 'last') {
      const sessions = await SessionStore.listSessions(1, {
        ...(opts.workspace ? { workspace: opts.workspace } : {}),
        ...storeOptions,
      })
      targetId = sessions[0]?.sessionId ?? ''
    }
    if (targetId) {
      const meta = await SessionStore.getSession(targetId, storeOptions)
      if (meta && opts.workspace && meta.workspace && meta.workspace !== opts.workspace) {
        throw new Error(
          `Session ${targetId} belongs to another workspace. ` +
          `current=${opts.workspace}; session=${meta.workspace}`,
        )
      }
      resumedMessages = await SessionStore.loadHistory(targetId, storeOptions)
      if (resumedMessages.length > 0) {
        resumedSessionId = targetId
        savedMessageCount = resumedMessages.length
        // Restore the saved mode when (a) the caller did not explicitly pass
        // --mode, or (b) the caller asked for an autonomous mode (auto / simple_auto)
        // but the saved history is non-autonomous — running a jailed,
        // auto-approving loop over agentic/campaign/robotics history is exactly
        // what this guard prevents. isAutonomousMode covers every flavour.
        if (
          meta?.mode &&
          !isAutonomousMode(meta.mode) &&
          (!opts.modeExplicit || isAutonomousMode(opts.mode))
        ) {
          opts.mode = meta.mode as CliOptions['mode']
          opts.modeExplicit = true
        }
      } else if (!opts.json) {
        process.stderr.write(`${yellow(`Warning: session ${targetId} was not found; starting a new one-shot session.`)}\n`)
      }
    }
  }

  const router = makeRouter(
    opts,
    undefined,
    undefined,
    resumedMessages.length > 0 ? resumedMessages : undefined,
    undefined,
    undefined,
    resumedSessionId,
  )

  // Register standard tools (robotics registers its own)
  if (opts.mode !== 'robotics') {
    const tools = await createStandardTools({
      // planModeRef MUST be the router's shared ref so enter_plan_mode /
      // exit_plan_mode flip the same object the backend's kernel permission
      // policy reads — otherwise plan mode never gates writes.
      system: { cwd: opts.workspace, mode: (opts.mode === 'campaign' ? 'campaign' : 'agentic'), planModeRef: router.planModeRef },
      // Main-session web_fetch is result-budgeted: full-text reading belongs in
      // isolated research sub-agents (research_dispatch), not the long-lived
      // main context. Sub-agents get an unbudgeted override via the bridge.
      network: { webFetch: { maxResultSizeChars: 8_000 } },
      // Apply the same auto capability boundary in non-interactive/single-turn
      // runs as in the REPL.
      mode: opts.mode,
    })
    for (const tool of tools) {
      router.registerTool(tool)
    }
  }

  try {
    await streamPrompt(router, opts.prompt!, opts.json, opts.showThinking)
  } catch (err) {
    const msg = terminalText(err instanceof Error ? err.message : String(err))
    console.error(red(`Error: ${msg}`))
    process.exitCode = 1
  } finally {
    if (opts.sessionDir || resumedSessionId) {
      await persistSessionSnapshot({
        router,
        opts,
        currentInput: opts.prompt!,
        savedMessageCount,
        sessionRoot: opts.sessionDir,
      })
    }
    await router.dispose().catch(() => undefined)
  }
}

// ── Loop runtime (v2, L2) ─────────────────────────────────────────────────────

/**
 * Dispatch `meta-agent loop <cmd>` and `meta-agent loop-scheduler`.
 *
 * Pure-code graph subcommands run directly. `tick`, `distill`, and the
 * scheduler may spawn Agent nodes, so they prewarm an `auto` backend
 * (unattended base = autonomy jail + workspace confinement for spawned seats)
 * and hand its SubAgentBridge to the loop runtime.
 */
async function runLoopCommand(opts: CliOptions): Promise<void> {
  const { name, args: rawLoopArgs } = opts.loopCommand!
  const projectDir = resolve(opts.workspace ?? process.cwd())
  const graphOptions = extractRepeatedOption(rawLoopArgs, '--graph-pack')
  // `--json` is a global flag before the `loop` token, while the loop operator
  // commands also accept it locally. Forward the global form so both
  // `meta-agent --json loop inspect …` and `meta-agent loop inspect … --json`
  // have the same machine-readable contract.
  const args = opts.json && !graphOptions.args.includes('--json')
    ? [...graphOptions.args, '--json']
    : graphOptions.args
  const graphCatalog = createDefaultGraphRuntimeCatalog()
  if (graphOptions.plugins.length > 0) {
    await loadGraphCapabilityPacks({
      modulePaths: graphOptions.plugins.map(path => resolve(projectDir, path)),
      target: graphCatalog,
      registry: graphCatalog.packs,
      allowedRoots: [projectDir],
    })
  }
  // One concrete graph_agent capability set must govern the whole lifecycle.
  // Distill used to validate against the interactive Agentic toolset while
  // Create used DEFAULT_GRAPH_AGENT_TOOLS and Tick registered Auto tools. That
  // allowed a graph to be reported as validated and then rejected by the very
  // next `loop create` command. DEFAULT_GRAPH_AGENT_TOOLS is the single
  // canonical graph_agent catalog (docs, library default, tests); here we only
  // verify it against the tools the unattended runtime actually provides, so a
  // graph frozen by this CLI validates identically from every other entrypoint.
  // Session-only conveniences (sleep, todo_write, …) stay out of the catalog:
  // durable waiting belongs to wait nodes and agent timer hard-park.
  const graphAgentTools = await createStandardTools({
    system: { cwd: projectDir, mode: 'agentic', planModeRef: { active: false } },
    network: { webFetch: { maxResultSizeChars: 8_000 } },
    mode: 'auto',
  })
  const runtimeToolNames = new Set(graphAgentTools.map(tool => tool.name))
  const unavailableCatalogTools = [...graphCatalog.agentTools].filter(name => !runtimeToolNames.has(name))
  if (unavailableCatalogTools.length) {
    console.error(`warning: graph_agent catalog tools unavailable in this runtime were removed: ${unavailableCatalogTools.join(', ')}`)
    graphCatalog.agentTools = new Set([...graphCatalog.agentTools].filter(name => runtimeToolNames.has(name)))
  }
  const sub = args[0]
  const isDistill = name === 'loop' && (sub === 'distill' || sub === 'distill-graph')
  const runLifecycle = (sub === 'resume' || sub === 'recover') && args.includes('--run')
  const needsGraphAgent = name === 'loop-scheduler' || sub === 'tick' || runLifecycle
  const modelConfig = loadModelConfig({ projectDir })
  const configuredProviderId = resolveProvider({
    apiKey: modelConfig.apiKey ?? opts.apiKey,
    baseURL: modelConfig.baseURL ?? opts.baseUrl,
    model: modelConfig.mainModel ?? opts.model,
  }).provider

  if (!isDistill && !needsGraphAgent) {
    // create / list / inspect / lifecycle — deterministic, no LLM.
    console.log(await runLoopCli(args, { projectDir, graphCatalog, providerId: configuredProviderId }))
    return
  }

  assertApiKeyConfigured(opts)
  const abort = new AbortController()
  process.once('SIGINT', () => abort.abort(new Error('process received SIGINT')))
  process.once('SIGTERM', () => abort.abort(new Error('process received SIGTERM')))

  if (isDistill) {
    const interactiveDistill = Boolean(process.stdin.isTTY && isTTY && !opts.json && !args.includes('--non-interactive'))
    const distillRl = interactiveDistill ? createInterface({ input: process.stdin, output: process.stdout }) : undefined
    const standardTools = await createStandardTools({
      system: { cwd: projectDir, mode: 'agentic', planModeRef: { active: false } },
      network: { webFetch: { maxResultSizeChars: 8_000 } },
      mode: 'agentic',
    })
    let validatedGraphThisCall: LoopGraphSpec | undefined
    const distillTools = createGraphDistillTools(graphCatalog, {
      onValidatedGraph: graph => { validatedGraphThisCall = graph },
    })
    const toolsByName = new Map([...standardTools, ...distillTools].map(tool => [tool.name, tool]))
    const reporter = createForegroundDistillReporter()
    const distillExecutor = new ForegroundGraphDistillExecutor({
      createSession: request => {
        const session = new MetaAgentSession(foregroundDistillConfig(opts, projectDir, request, distillRl))
        for (const toolName of request.allowedTools) {
          const tool = toolsByName.get(toolName)
          if (!tool) throw new Error(`foreground Distill tool '${toolName}' is unavailable`)
          session.registerTool(tool)
        }
        return session
      },
      runSession: async (session, request) => {
        validatedGraphThisCall = undefined
        const rendered = await streamPrompt({
          submit: prompt => session.submit(prompt),
          steer: text => session.steer(text),
          getEstimatedCost: () => session.getEstimatedCost(),
          mode: 'agentic',
        }, request.taskDescription, opts.json, opts.showThinking)
        if (request.signal.aborted) return {
          status: 'cancelled', output: rendered.text || undefined, error: 'Distill interrupted',
          validatedGraph: validatedGraphThisCall,
        }
        const terminal = rendered.result
        if (!terminal) return {
          status: 'failed', output: rendered.text || undefined,
          error: 'agentic Distill session ended without a terminal result', validatedGraph: validatedGraphThisCall,
        }
        const output = rendered.text.trim() || terminal.result
        return terminal.subtype === 'success' && !terminal.isError
          ? { status: 'completed', output, summary: terminal.result, validatedGraph: validatedGraphThisCall }
          : {
              status: 'failed', output: output || undefined,
              error: terminal.errors?.join('; ') || `agentic Distill session ended with ${terminal.subtype}`,
              validatedGraph: validatedGraphThisCall,
            }
      },
    })
    try {
      console.log(await runLoopCli(args, {
        projectDir,
        distillExecutor,
        signal: abort.signal,
        graphCatalog,
        onDistillProgress: reporter.onProgress,
      }))
      if (interactiveDistill && distillRl) {
        await runDistillSession({
          args, projectDir, executor: distillExecutor, graphCatalog,
          signal: abort.signal, reporter, rl: distillRl,
        })
      }
    } finally {
      await distillExecutor.dispose()
      distillRl?.close()
    }
    return
  }

  await ensureMcpServerInstructions()
  const router = makeRouter(
    // Preserve loopCommand: makeRouter uses it to mark the durable Graph Kernel
    // as aggregate child-budget owner. Clearing it here silently reinstates the
    // auto session's default $10 bridge cap.
    { ...opts, mode: 'auto', modeExplicit: true, workspace: projectDir, prompt: null },
    undefined, undefined, undefined, undefined, undefined, undefined,
  )
  // Register the standard tool set into the backend so spawned Graph Agent
  // seats can resolve read_file/grep/glob/bash/etc. — without this
  // the bridge's tool registry is empty and every seat fails "No tools resolved".
  for (const tool of graphAgentTools) router.registerTool(tool)
  const stamp = (): string => new Date().toISOString().slice(11, 19)
  try {
    const warmed = await router.prewarmBackend()
    if (!warmed) throw new Error('could not create the loop backend (auto mode)')
    const dispatcher = SubAgentBridge.getBridge(router.getSessionId())
    if (!dispatcher) throw new Error('loop backend produced no sub-agent dispatcher')
    const providerConfig = router.getProviderConfig()
    const providerId = resolveProvider(providerConfig).provider
    const graphAgent = new MetaAgentGraphAgentExecutor(dispatcher, undefined, { providerId })
    const onGraphProgress = createGraphProgressReporter()

    if (name === 'loop-scheduler') {
      const schedulerNumber = (flag: string, fallback: number): number => {
        const index = args.indexOf(flag)
        if (index < 0) return fallback
        const value = Number(args[index + 1])
        if (!Number.isFinite(value) || value < 0) throw new Error(`${flag} requires a non-negative number`)
        return value
      }
      console.log(`${dim(`[loop ${stamp()}]`)} scheduler start (workspace ${projectDir})`)
      const result = await runLoopScheduler({
        graphAgent, projectDir, signal: abort.signal, graphCatalog, onGraphProgress,
        pollMs: schedulerNumber('--poll-ms', 2_000),
        idleExitMs: schedulerNumber('--idle-exit-ms', 60_000),
        maxConcurrentGraphs: schedulerNumber('--max-concurrent-graphs', 4),
        // Without onTick, per-wake errors from tickOnce (outcomes[].error) are
        // silently dropped in scheduler mode — `loop tick` prints them, so the
        // daemon must too, or spawn failures become invisible.
        onTick: tick => {
          for (const o of tick.outcomes) {
            if (o.error) console.log(`${dim(`[loop ${stamp()}]`)} ${red('✗')} ${o.loopId}: ${o.error}`)
          }
        },
      })
      console.log(`${dim(`[loop ${stamp()}]`)} scheduler exit (${result.exitReason}); ` +
        `${result.graphTicksRun} graph tick(s) over ${result.ticks} poll(s).`)
    } else {
      console.log(await runLoopCli(args, {
        projectDir,
        dispatcher,
        graphAgent,
        signal: abort.signal,
        graphCatalog,
        onGraphProgress,
        providerId,
      }))
    }
  } finally {
    await router.dispose().catch(() => undefined)
  }
}

function createGraphProgressReporter(): (event: GraphProgressEvent) => void {
  return event => {
    const time = new Date(event.at).toISOString().slice(11, 19)
    const loopId = event.instanceId.length > 18 ? `${event.instanceId.slice(0, 15)}…` : event.instanceId
    const prefix = dim(`[${time}] [${loopId}/${event.nodeId} a${event.attempt}:s${event.segment}]`)
    const detail = (value: string): string => terminalText(value.replace(/\s+/g, ' ').trim().slice(0, 300))
    if (event.type === 'phase_started') {
      const verb = event.resumed ? '恢复' : '开始'
      const reason = event.resumeReason ? `；此前挂起原因：${detail(event.resumeReason)}` : ''
      console.log(`${prefix} ${cyan('▶')} ${verb}：${detail(event.phase)}${reason}`)
      return
    }
    if (event.type === 'phase_completed') {
      const usage = event.usage
        ? dim(`  turns=${event.usage.turns} cost=$${event.usage.costUsd.toFixed(4)}`)
        : ''
      const marker = event.outcome === 'failure' ? red('✗') : green('✓')
      console.log(`${prefix} ${marker} 结束（${detail(event.outcome)}）：${detail(event.summary)}${usage}`)
      return
    }
    if (event.type === 'phase_retrying') {
      const timing = event.wakeAt ? `；${new Date(event.wakeAt).toISOString()} 后重试` : '；等待重新调度'
      console.log(`${prefix} ${yellow('↻')} ${event.replay ? '重放' : '重试'}：${detail(event.reason)}${timing}`)
      return
    }
    if (event.type === 'phase_parked') {
      const target = event.wakeAt
        ? `至 ${new Date(event.wakeAt).toISOString()}`
        : event.eventName ? `等待事件 ${detail(event.eventName)}` : '等待恢复'
      console.log(`${prefix} ${yellow('⏸')} 挂起${target}：${detail(event.reason)}`)
      return
    }
    if (event.type === 'phase_blocked') {
      const usage = event.usage
        ? dim(`  turns=${event.usage.turns} cost=$${event.usage.costUsd.toFixed(4)}`)
        : ''
      console.log(`${prefix} ${yellow('⏸')} 基础设施阻塞，实例已暂停并保留重放点：${detail(event.reason)}${usage}`)
      return
    }
    console.log(`${prefix} ${red('✗')} 终止：${detail(event.reason)}`)
  }
}

async function runDistillSession(options: {
  args: string[]
  projectDir: string
  executor: ForegroundGraphDistillExecutor
  graphCatalog: GraphRuntimeCatalog
  signal: AbortSignal
  reporter: ReturnType<typeof createForegroundDistillReporter>
  rl: readline.Interface
}): Promise<void> {
  const requirementArg = distillRequirementArg(options.args)
  if (!requirementArg) throw new Error('interactive Distill lost the requirement document path')
  const outArg = loopOptionValue(options.args, '--out') ?? 'loop.graph.json'
  const source = { requirement: requirementArg, projectDir: options.projectDir }
  let current: DistillGraphResult = await readDistillArtifacts(options.projectDir, outArg)
  const feedback: string[] = []
  console.log(`\n${bold(green('Distill session'))}`)
  printDistillDraft(current, outArg)
  console.log(dim('检查已生成文件；有问题就直接输入补充或纠正，当前 turn 验证通过后会覆盖草图；/show 查看摘要；/reload 载入手工编辑；/validate 重新校验；/exit 结束。'))
  while (!options.signal.aborted) {
    const line = await questionLine(options.rl, `${bold(cyan('distill'))} › `)
    if (line === null) break
    const input = line.trim()
    if (!input) continue
    if (input === '/quit' || input === '/exit') {
      console.log(`${dim(`Distill exited; current files remain on disk. Next: meta-agent loop create ${outArg}`)}`)
      return
    }
    if (input === '/show') {
      printDistillDraft(current, outArg)
      continue
    }
    if (input === '/reload') {
      try {
        current = await readDistillArtifacts(options.projectDir, outArg)
        console.log(`${green('✓')} Reloaded ${outArg} from disk.`)
        printDistillDraft(current, outArg)
      } catch (error) {
        console.log(`${red('✗')} Could not reload the draft: ${sanitizeTerminalPreview(error instanceof Error ? error.message : String(error), 300)}`)
      }
      continue
    }
    if (input === '/validate') {
      try {
        const errors = validateLoopGraph(current.graph, options.graphCatalog)
        if (errors.length) {
          console.log(`${yellow('⚠')} ${errors.length} validation issue(s):`)
          for (const error of errors) console.log(`  ${dim('·')} ${sanitizeTerminalPreview(error, 300)}`)
        } else {
          freezeLoopGraph(current.graph, options.graphCatalog, 0)
          console.log(`${green('✓')} Structural and Freeze validation passed.`)
          const lint = formatGraphLintFindings(lintLoopGraph(current.graph))
          if (lint.length) {
            console.log(`${yellow('⚠')} ${lint.length} lint finding(s) — Distill 会阻断这些，请修复后再 create:`)
            for (const finding of lint) console.log(`  ${dim('·')} ${sanitizeTerminalPreview(finding, 300)}`)
          }
        }
      } catch (error) {
        console.log(`${red('✗')} Freeze validation failed: ${sanitizeTerminalPreview(error instanceof Error ? error.message : String(error), 400)}`)
      }
      continue
    }

    console.log(`${dim('[distill]')} continuing the same compiler conversation…`)
    try {
      const nextFeedback = [...feedback, input]
      const revised = await reviseLoopGraph(source, current, nextFeedback.map((item, index) => `${index + 1}. ${item}`).join('\n'), {
        executor: options.executor,
        catalog: options.graphCatalog,
        signal: options.signal,
        onProgress: options.reporter.onProgress,
      })
      feedback.push(input)
      current = revised
      await writeDistillArtifacts(options.projectDir, outArg, revised)
      console.log(`${green('✓')} Updated ${outArg}, loop.design.md, and loop.semantic-review.md`)
      printDistillDraft(current, outArg)
    } catch (error) {
      console.log(`${red('✗')} Revision was not applied; current draft is unchanged.`)
      console.log(`  ${sanitizeTerminalPreview(error instanceof Error ? error.message : String(error), 500)}`)
    }
  }
}

function printDistillDraft(result: Pick<DistillGraphResult, 'graph' | 'taskSpec' | 'constraints' | 'semanticReview'>, out: string): void {
  const graph = result.graph
  const workspaceWrites = Object.values(graph.lanes).reduce((sum, lane) => sum + (lane.workspace.write?.length ?? 0), 0)
  console.log(`${bold('draft')} ${out}  graph=${graph.id}@v${graph.version}  constraints=${result.constraints.constraints.length}  nodes=${Object.keys(graph.nodes).length}  transitions=${graph.transitions.length}  lanes=${Object.keys(graph.lanes).length}  workspace-writes=${workspaceWrites}  review=${result.semanticReview.accepted ? 'accepted' : 'rejected'}`)
  for (const warning of result.semanticReview.warnings ?? []) console.log(`${yellow('warning:')} ${sanitizeTerminalPreview(warning, 300)}`)
  if (result.taskSpec.trim()) console.log(`${dim('compiler note:')}\n${result.taskSpec.trim()}`)
}

function distillRequirementArg(args: readonly string[]): string | undefined {
  for (let index = 1; index < args.length; index++) {
    const value = args[index]!
    if (value === '--out') { index++; continue }
    if (value === '--non-interactive') continue
    if (!value.startsWith('--')) return value
  }
  return undefined
}

function loopOptionValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

function questionLine(rl: readline.Interface, prompt: string): Promise<string | null> {
  return new Promise(resolveLine => {
    let settled = false
    const finish = (value: string | null): void => {
      if (settled) return
      settled = true
      rl.removeListener('close', onClose)
      resolveLine(value)
    }
    const onClose = (): void => finish(null)
    rl.once('close', onClose)
    rl.question(prompt, answer => finish(answer))
  })
}

function foregroundDistillConfig(
  opts: CliOptions,
  projectDir: string,
  request: GraphDistillModelRequest,
  rl?: readline.Interface,
): MetaAgentConfig {
  const allowed = new Set(request.allowedTools)
  const config: MetaAgentConfig = {
    projectDir,
    promptMode: 'agentic',
    externalPromptAssembly: true,
    skipMemoryRecall: true,
    systemPrompt: request.systemPrompt,
    maxTurns: request.maxTurns,
    maxBudgetUsd: opts.maxBudgetUsd ?? request.maxBudgetUsd,
    ...(request.thinkingBudgetTokens === undefined
      ? {}
      : { thinkingConfig: request.thinkingBudgetTokens === 0
          ? { type: 'disabled' as const }
          : { type: 'enabled' as const, budgetTokens: request.thinkingBudgetTokens } }),
    ...(request.maxOutputTokens === undefined ? {} : { maxTokens: request.maxOutputTokens }),
    // A structured compiler response must fit in its phase budget. Kernel's
    // normal 64k escalation/recovery would defeat that bound and can turn a
    // simple lowering into a many-minute runaway generation.
    recoverMaxOutputTokens: false,
    debugMode: opts.debug,
    beforeToolCall: async toolName => allowed.has(toolName)
      ? { action: 'allow' }
      : { action: 'deny', reason: `foreground Distill does not allow tool '${toolName}'` },
  }
  if (rl && !opts.json && isTTY) {
    config.askUser = async (question: string, options?: string[], signal?: AbortSignal) => {
      const choices = options ?? []
      process.stdout.write(`\n${cyan('❓')}  ${bold('Distill 需要你的输入')}\n${terminalText(question)}\n`)
      try {
        if (choices.length > 0) {
          process.stdout.write(choices.map((choice, index) => `  ${green(String(index + 1))}. ${terminalText(choice)}`).join('\n') + '\n\n')
          const answer = await askQuestion(rl, `请选择 [1-${choices.length}] 或直接输入回答: `, signal)
          const selected = Number.parseInt(answer, 10)
          if (Number.isInteger(selected) && selected >= 1 && selected <= choices.length) return choices[selected - 1]!
          return answer
        }
        return await askQuestion(rl, '你的回答 > ', signal)
      } catch (error) {
        process.stdout.write(`${yellow('⚠')} 输入等待已取消（超时或中断），Distill 会把该问题记入 unresolved。\n`)
        throw error
      }
    }
  }
  const apiKey = resolveExplicitApiKey(opts)
  if (apiKey) config.apiKey = apiKey
  if (opts.baseUrl) config.baseURL = opts.baseUrl
  if (opts.model) config.model = opts.model
  if (opts.fallbackModel) config.fallbackModel = opts.fallbackModel
  return config
}

function createForegroundDistillReporter(): {
  onProgress(event: GraphDistillProgressEvent): void
} {
  const phaseLabel = (phase: GraphDistillPhase): string =>
    phase === 'architect' ? 'architect' : phase === 'compiler' ? 'compiler' : 'reviewer'
  return {
    onProgress(event): void {
      if (event.type === 'checkpoint_resumed') {
        console.log(`${green('✓')} ${dim('[distill]')} resumed validated Architect checkpoint`)
      } else if (event.type === 'phase_started') {
        const attempt = event.phase !== 'semantic_review' ? ` attempt ${event.attempt}/${event.maxAttempts}` : ''
        console.log(`${dim('[distill]')} ${phaseLabel(event.phase)}${attempt} started on agentic session`)
      } else if (event.type === 'phase_completed') {
        console.log(`${dim('[distill]')} ${phaseLabel(event.phase)} response received`)
      } else if (event.type === 'validation_passed') {
        console.log(`${green('✓')} ${dim('[distill]')} structural and Freeze validation passed`)
      } else if (event.type === 'validation_failed') {
        console.log(`${yellow('⚠')} ${dim('[distill]')} ${phaseLabel(event.phase)} output rejected with ${event.issues.length} issue(s)`)
        for (const issue of event.issues.slice(0, 8)) console.log(`  ${dim('·')} ${sanitizeTerminalPreview(issue, 240)}`)
      } else if (event.type === 'semantic_review_accepted') {
        console.log(`${green('✓')} ${dim('[distill]')} semantic review accepted`)
      } else {
        console.log(`${yellow('⚠')} ${dim('[distill]')} semantic review rejected`)
        for (const issue of event.issues.slice(0, 8)) console.log(`  ${dim('·')} ${sanitizeTerminalPreview(issue, 240)}`)
      }
    },
  }
}

function extractRepeatedOption(
  args: readonly string[],
  name: string,
): { args: string[]; plugins: string[] } {
  const kept: string[] = []
  const plugins: string[] = []
  for (let index = 0; index < args.length; index++) {
    if (args[index] !== name) {
      kept.push(args[index]!)
      continue
    }
    const value = args[++index]
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a module specifier`)
    plugins.push(value)
  }
  return { args: kept, plugins }
}

// ── Entry point ───────────────────────────────────────────────────────────────

/**
 * Process-wide MCP server instructions for D5 injection.
 * Populated once at startup after all MCP clients are registered.
 * makeRouter() reads this to inject into cfg.mcpServers.
 */
let _mcpServerInstructions: McpServerInstruction[] = []
let _mcpInstructionsReady = false

/**
 * Register MCP clients only when a command will actually start an LLM session.
 * Help, version, validation failures, and pure `loop` commands must stay local
 * and usable while an optional MCP endpoint is down.
 */
async function ensureMcpServerInstructions(): Promise<void> {
  if (_mcpInstructionsReady) return
  _mcpInstructionsReady = true
  loadMcpConfig()
  _mcpServerInstructions = await buildMcpServerInstructions()
}

async function main(): Promise<void> {
  // Sanitize env-var API keys once so detectProvider() receives clean values
  sanitizeEnvKeys()
  const opts = parseCliArgs()
  const bwrapWarning = getMissingBwrapWarning()
  if (bwrapWarning) {
    process.stderr.write(`${yellow(bwrapWarning)}\n`)
  }
  // Loop runtime dispatch first: its pure-code subcommands (list/inspect/…) must
  // work without an API key; runLoopCommand asserts the key only when it needs a
  // backend (tick/distill/loop-scheduler).
  if (opts.loopCommand) {
    await runLoopCommand(opts)
    return
  }

  assertApiKeyConfigured(opts)
  await ensureMcpServerInstructions()

  if (opts.prompt !== null) {
    if (opts.sessionDir) mkdirSync(opts.sessionDir, { recursive: true })
    await runSingleTurn(opts)
  } else {
    if (opts.sessionDir) {
      console.error(red('Error: --session-dir is only supported for one-shot prompt runs.'))
      process.exit(1)
    }
    await runRepl(opts)
  }
}

main().catch(err => {
  console.error(red(`Fatal: ${terminalText(err instanceof Error ? err.message : String(err))}`))
  process.exit(1)
})
