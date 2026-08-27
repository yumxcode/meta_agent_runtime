/**
 * cli/args — command-line surface: help text, flag parsing, and the CliOptions
 * shape every command module consumes.
 *
 * Extracted from cli/index.ts. Pure and side-effect free apart from reading
 * process.argv, so it is trivially testable and imports no other CLI module
 * except ./term for colours.
 */
import { parseArgs } from 'node:util'
import { isAbsolute, resolve } from 'node:path'
import { existsSync, statSync } from 'node:fs'
import type { SessionMode } from '../core/modes.js'
import type { AutoWorktreeCleanupStrategy } from '../core/auto/AutoWorktreeCoordinator.js'
import { CLI_VERSION } from './version.js'
import { bold, cyan, dim, gray, red, terminalText } from './term.js'
import { printEnvTable } from './env.js'

export const VERSION = CLI_VERSION

// ── Help text ─────────────────────────────────────────────────────────────────

export function printHelp(): void {
  console.log(`
${bold('meta-agent')} — Engineering agent runtime CLI  ${dim(`v${VERSION}`)}

${bold('USAGE')}
  meta-agent [options] [prompt]
  meta-agent ui [options] [prompt]  Run with the local MCP Apps browser host
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
      --attached         In one-shot auto, wait and resume self_timer in this terminal
  -y, --yes             Auto-approve sensitive tools (intended for trusted scripts)
  -d, --debug           Debug mode: log full prompts + responses to stderr each turn
      --show-thinking   Show model thinking deltas in the terminal
      --ui-port <port>  Port for meta-agent ui (default: random loopback port)
      --no-open         With meta-agent ui, print the URL without opening a browser
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
      --poll-ms <n> --max-concurrent-graphs <n>
      --idle-exit-ms <n>    ${dim('Exit once the workspace has NO live graphs left (default 60s; 0 = stay up)')}
  (put global flags like -w <dir> BEFORE the loop token: meta-agent -w <dir> loop tick)

${bold('AUTO SCHEDULER (plain auto self_timer)')}
  meta-agent -w <dir> auto-scheduler       Resume due durable Auto sessions
      --poll-ms <n> --max-concurrent <n> [--once]
      --idle-exit-ms <n>    ${dim('Exit once the workspace has NO wakes left (default 60s; 0 = stay up)')}
      --stale-wake-ms <n>   ${dim('Retire a wake left unexecuted this long past due (default 7d; 0 = never)')}
  meta-agent tasks [list|show <id>]        See every Auto task, finished included
      --active --json --workspace <dir>  ${dim('Alive? parked? ORPHANED? No API key needed.')}
      ${dim('`show <id>` also lists the run\'s artifact paths; --active hides finished tasks.')}
  meta-agent -w <dir> --mode auto --attached "goal"
      Keep the original terminal attached across repeated self_timer wakes.
  By default self_timer persists state and exits; --attached instead keeps
  that terminal as the durable wake lease holder.
  meta-agent -w <dir> steer <sessionId> "<text>"
      Inject a correction into a running unattended session (see STEERING below).

${bold('TRAJECTORIES (A3 audit store)')}
  meta-agent trajectory inspect <id>       Show an ordinal causal timeline
  meta-agent trajectory tail <id>          Read a suffix (--after N --limit N)
  meta-agent trajectory verify <id>        Verify schema, ordinals and references
  meta-agent trajectory reindex --clean    Rebuild disposable metadata projections
  meta-agent trajectory list [--search Q]  Search title/prompt/mode/workspace metadata
  meta-agent trajectory disk               Show canonical/index disk usage
  meta-agent trajectory telemetry          Incrementally project historical telemetry (--clean rebuilds)
  meta-agent trajectory parity             Compare canonical resume with legacy history (--clean resets evidence)
  meta-agent trajectory corpus             Survey how many runs could become re-executable eval cases
  meta-agent trajectory gc                 Safe dry-run retention audit (apply disabled until lifecycle proof)
  meta-agent sessions --search <text>       Search trajectory-backed session metadata

${bold('EVAL SETS (G1 controlled re-execution)')}
  meta-agent evalset extract [--limit N]   Read-only: recover case candidates from task chains
                                           ${dim('Reports what each draft is still missing; writes nothing.')}
  meta-agent evalset list                  List eval sets
  meta-agent evalset show <id>             Cases, split counts, and leakage check
  meta-agent evalset freeze <id>           Freeze a set (refuses if any split leaks)

${bold('TRAJECTORY REVIEWER (manual, isolated)')}
  meta-agent reviewer run [--all|--limit N] [--max-cases N]
      [--max-turns-per-case N] [--max-budget-usd N] [--force]
                                              Run task-level retrospective Kernel sessions
                                              over root + child trajectory TaskCases
  meta-agent reviewer reports                List complete TaskReview retrospectives
  meta-agent reviewer report <id>            Show outcome, dimensions, criteria and findings
  meta-agent reviewer list                  List proposals awaiting or past human review
  meta-agent reviewer review                Interactively approve/reject pending proposals
  meta-agent reviewer approve|reject <id>   Record an explicit human decision
  meta-agent reviewer candidates            List human-approved ExperienceCandidate records
  meta-agent reviewer rate [--all|--limit N] Label whether each task was actually completed
                                            ${dim('Human acceptance = the only T3 evidence in the system.')}
  meta-agent reviewer ratings [--json]      Acceptance counts, including stale labels

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
                        ${dim('Available in the REPL and in --attached runs.')}
  Ctrl+C                Interrupt the current turn (press twice to quit)

${bold('STEERING AN UNATTENDED RUN')}
  ${dim('`auto-scheduler` has no keyboard (often detached, no TTY), so corrections')}
  ${dim('go through the filesystem and are delivered at the next step boundary:')}
  meta-agent steer --list                    List sessions you can steer
  meta-agent steer <sessionId> "<text>"      Queue a correction
  meta-agent steer --clear <sessionId>       Drop queued corrections

${bold('ENVIRONMENT VARIABLES')}
  ZHIPU_API_KEY         GLM coding plan key  ${dim('← default provider (glm-5.2)')}
  DEEPSEEK_API_KEY      DeepSeek API key
  ANTHROPIC_API_KEY     Anthropic API key
  QWEN_API_KEY          Qwen API key
  META_AGENT_CONFIG_FILE  Select an alternate global model config file

  Priority: ZHIPU_API_KEY > DEEPSEEK_API_KEY > QWEN_API_KEY > ANTHROPIC_API_KEY

${bold('CONFIG FILE')}
  ${cyan('~/.meta-agent/config.json')}
  ${cyan('~/.meta-agent/glm_config.json')}  ${dim('(selected automatically by meta-agent-glm)')}
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

export interface CliOptions {
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
  attached: boolean               // --attached: keep one-shot auto in this terminal
  mcpApps: boolean                // `meta-agent ui`: enable the local browser sidecar
  mcpAppsPort: number             // 0 asks the OS for an available loopback port
  mcpAppsOpen: boolean            // open the sidecar URL in the default browser
  /** Durable runtime subcommands. Args pass through verbatim. */
  loopCommand: {
    name: 'loop' | 'loop-scheduler' | 'auto-scheduler' | 'steer' | 'tasks' | 'trajectory' | 'sessions' | 'reviewer' | 'evalset'
    args: string[]
  } | null
}

export function parseCliArgs(): CliOptions {
  // v2 loop runtime (L2): `meta-agent loop <cmd>` and `meta-agent loop-scheduler`
  // carry their OWN sub-flags (--id / --until-quiescent / --version N / --out …)
  // that the strict global parser would reject, so split them off up front.
  // Global flags (-w/-k/-b/--model) go BEFORE the `loop` token.
  const rawArgs = process.argv.slice(2)
  // `steer` rides the same passthrough path: its payload is free-form user text
  // that the strict global parser would try to interpret as flags.
  const loopIdx = rawArgs.findIndex(a =>
    a === 'loop' || a === 'loop-scheduler' || a === 'auto-scheduler' ||
    a === 'steer' || a === 'tasks' || a === 'trajectory' || a === 'sessions' || a === 'reviewer' ||
    a === 'evalset')
  if (loopIdx !== -1) {
    return buildLoopCliOptions(
      rawArgs[loopIdx] as 'loop' | 'loop-scheduler' | 'auto-scheduler' | 'steer' | 'tasks' | 'trajectory' | 'sessions' | 'reviewer' | 'evalset',
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
        attached:     { type: 'boolean', default: false },
        yes:          { type: 'boolean', short: 'y', default: false },
        debug:        { type: 'boolean', short: 'd', default: false },
        'show-thinking': { type: 'boolean', default: false },
        'ui-port':      { type: 'string' },
        'no-open':      { type: 'boolean', default: false },
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

  // `meta-agent ui [prompt]` — the browser-sidecar subcommand.
  //
  // Treated as a subcommand ONLY when `ui` is the sole positional or is followed
  // by one of its own flags. `meta-agent ui redesign the login page` is a prompt
  // that happens to start with the word "ui", and swallowing that first word
  // would silently change what the user asked for. Quote the prompt or pass
  // `--ui-port`/`--no-open` to get the subcommand with a prompt attached.
  const uiFlagsPresent =
    parsed.values['ui-port'] !== undefined || parsed.values['no-open'] === true
  const mcpApps = parsed.positionals[0] === 'ui' && (parsed.positionals.length === 1 || uiFlagsPresent)
  const promptParts = mcpApps ? parsed.positionals.slice(1) : parsed.positionals
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
  const rawUiPort = parsed.values['ui-port'] as string | undefined
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
  let mcpAppsPort = 0
  if (rawUiPort !== undefined) {
    mcpAppsPort = Number.parseInt(rawUiPort, 10)
    if (!/^\d+$/.test(rawUiPort) || mcpAppsPort < 0 || mcpAppsPort > 65_535) {
      console.error(red(`Error: --ui-port must be an integer in [0, 65535] (got "${rawUiPort}")`))
      process.exit(1)
    }
  }
  if (!mcpApps && (rawUiPort !== undefined || parsed.values['no-open'] === true)) {
    console.error(red('Error: --ui-port and --no-open require the `meta-agent ui` command.'))
    process.exit(1)
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
    attached:    parsed.values['attached'] as boolean,
    mcpApps,
    mcpAppsPort,
    mcpAppsOpen: parsed.values['no-open'] !== true,
    loopCommand: null,
  }
}

/**
 * Build CliOptions for a `loop` / `loop-scheduler` invocation. Only the backend
 * essentials are parsed from the pre-`loop` global flags; everything after the
 * `loop` token is handed verbatim to runLoopCli, which does its own flag parsing.
 */
export function buildLoopCliOptions(
  name: 'loop' | 'loop-scheduler' | 'auto-scheduler' | 'steer' | 'tasks' | 'trajectory' | 'sessions' | 'reviewer' | 'evalset',
  globalArgs: string[],
  loopArgs: string[],
): CliOptions {
  // `--debug` / `--show-thinking` are global observability flags, but they read
  // as trailing options, so users naturally type them AFTER the `loop` token —
  // where the split above routes them into loopArgs and they vanish. Worse,
  // positionalValues() treats any unknown `--flag` as value-taking and would
  // swallow the following positional (`loop distill --debug f1_loop.md` loses
  // the requirement path). Hoist them out of the subcommand args first so
  // placement never silently disables debug capture.
  const hoistedDebug = takeBooleanFlag(loopArgs, ['--debug', '-d'])
  const hoistedThinking = takeBooleanFlag(hoistedDebug.args, ['--show-thinking'])
  const passthroughLoopArgs = hoistedThinking.args
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
        // Declared explicitly: under `strict: false` an undeclared `-d` lands
        // in values['d'], never values['debug'].
        debug:      { type: 'boolean', short: 'd', default: false },
        'show-thinking': { type: 'boolean', default: false },
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
    debug: (g.values['debug'] as boolean) || hoistedDebug.present,
    showThinking: (g.values['show-thinking'] as boolean) || hoistedThinking.present,
    yes: true,
    autoWorktreeCleanup: undefined,
    prompt: null,
    maxTurns: undefined,
    maxBudgetUsd: undefined,
    resume: undefined,
    sessionDir: undefined,
    attached: false,
    mcpApps: false,
    mcpAppsPort: 0,
    mcpAppsOpen: false,
    loopCommand: { name, args: passthroughLoopArgs },
  }
}

/** Remove every occurrence of `names` from `args` without disturbing the order
 * of what remains. Used to lift global boolean flags out of `loop` subcommand
 * args, which are otherwise passed through verbatim. */
function takeBooleanFlag(args: string[], names: readonly string[]): { args: string[]; present: boolean } {
  const kept = args.filter(arg => !names.includes(arg))
  return { args: kept, present: kept.length !== args.length }
}
