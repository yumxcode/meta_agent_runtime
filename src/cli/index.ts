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
 *   -m, --mode <mode>       Session mode: auto|agentic|campaign|robotics (default: auto)
 *   -k, --api-key <key>     API key (or ANTHROPIC_API_KEY / DEEPSEEK_API_KEY env var)
 *       --model <model>     Model override (default: auto-detected from provider)
 *   -s, --system <prompt>   Custom system prompt
 *   -j, --json              Output raw JSON events (for piping)
 *   -y, --yes               Auto-approve sensitive tools in trusted scripts
 *   -v, --version           Show version
 *   -h, --help              Show help
 */

import { parseArgs } from 'node:util'
import * as readline from 'node:readline'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import { isAbsolute, resolve, join } from 'node:path'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { SessionRouter } from '../routing/SessionRouter.js'
import { HardwareProfile } from '../robotics/HardwareProfile.js'
import { ExperiencePendingStore } from '../robotics/ExperiencePendingStore.js'
import { ExperienceStore } from '../robotics/ExperienceStore.js'
import { PhysicalAnchorPendingStore } from '../robotics/PhysicalAnchorPendingStore.js'
import { PhysicalAnchorStore } from '../robotics/PhysicalAnchorStore.js'
import { PrinciplePendingStore } from '../robotics/PrinciplePendingStore.js'
import { PrincipleStore } from '../robotics/PrincipleStore.js'
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
} from '../robotics/team/TeamStore.js'
import { isStaleClaim } from '../robotics/team/TeamStore.js'
import { SessionStore } from '../core/SessionStore.js'
import { detectProvider } from '../core/config.js'
import { detectSensitiveShellCommand } from '../kernel/permissions/SensitiveCommandPatterns.js'
import { executePlan } from './teamPlannerExecutor.js'
import { resolveTemplate } from './hardwareTemplate.js'
import type { ProfileTemplate, ProfilePreset } from './hardwareTemplate.js'
import type { SessionModeHint } from '../routing/types.js'
import type { MetaAgentConfig, BeforeToolCallResult } from '../core/config.js'
import type { RouterOptions } from '../routing/types.js'
import type { MetaAgentEvent } from '../core/types.js'
import type { ConversationMessage } from '../core/types.js'
import { createStandardTools } from '../tools/index.js'

// ── Version ───────────────────────────────────────────────────────────────────

const VERSION = '0.2.1'
const DEFAULT_CLI_MAX_TURNS = 50

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

// ── Help text ─────────────────────────────────────────────────────────────────

function printHelp(): void {
  console.log(`
${bold('meta-agent')} — Engineering agent runtime CLI  ${dim(`v${VERSION}`)}

${bold('USAGE')}
  meta-agent [options] [prompt]

${bold('MODES')}
  ${cyan('auto')}       Detect mode from prompt context (default)
  ${cyan('agentic')}    Full tool-use loop (default for all Q&A and engineering tasks)
  ${cyan('campaign')}   DOE / multi-objective optimisation campaign
  ${cyan('robotics')}   Robotics session — ExperienceStore + workflow + hardware profiles

${bold('OPTIONS')}
  -m, --mode <mode>       Session mode: auto|agentic|campaign|robotics
  -w, --workspace <dir>   Working directory — agent ONLY operates within this folder
  -k, --api-key <key>     API key (or set DEEPSEEK_API_KEY / ANTHROPIC_API_KEY env var)
  -b, --base-url <url>    API base URL (default: auto-detected from key)
      --model <model>   Model override (default: deepseek-v4-flash)
      --fallback-model <model>  Model to retry with when primary lacks a feature
  -s, --system <text>   Custom system prompt
  -t, --max-turns <n>   Max agentic turns per message (default: 50; use "infinity" for no cap)
  -r, --resume <id>     Resume a previous session by ID (or "last" for most recent)
  -y, --yes             Auto-approve sensitive tools (intended for trusted scripts)
  -d, --debug           Debug mode: log full prompts + responses to stderr each turn
      --show-thinking   Show model thinking deltas in the terminal
  -j, --json            Output raw JSON events
  -v, --version         Print version
  -h, --help            Show this help

${bold('INTERACTIVE COMMANDS')}
  /mode                 Show current session mode
  /workspace            Show current workspace directory
  /hardware             Show bound hardware profile (robotics mode)
  /hardware select      Re-run hardware profile selection wizard
  /team                 Show board + recent attempts (entry guide)
  /team init [github]   Create team/ collaboration template
  /team join [github]   Join this unit to the team
  /team add "<title>"   Create a new task
  /team take <task>     Exclusively claim a task (fails if owned by another)
  /team note <id> "<direction>" :: "<outcome>" [@ref]   Append an attempt
  /team drop [task]     Release a task you own
  /team steal <task> [reason]   Forcibly take a task; records audit attempt
  /team done [task]     Mark task done (only owner)
  /team status / board  Show current board
  /team sync            Fetch remotes and refresh team status
  /team pull            Apply remote team/ files only when local team/ is clean
  /team conflicts       Show merge conflict guidance for the current workspace
  /team conflicts resolve  Auto-resolve team.json conflict using --theirs strategy
  /usage                Show token usage & estimated cost
  /sessions             List saved sessions; pick one to resume
  /sessions clear       Delete sessions (pick one or delete all)
  /experience           Show pending experience queue (robotics mode)
  /experience review    Interactively review & commit pending experiences
  /principle            Show pending principle queue (robotics mode)
  /principle review     Interactively review & commit pending principles
  /anchor               Show pending physical anchor queue (robotics mode)
  /anchor review        Interactively review & commit pending physical anchors
  /clear                Start a new session (same workspace/hardware)
  /exit  or  Ctrl+D     Quit

${bold('ENVIRONMENT VARIABLES')}
  DEEPSEEK_API_KEY      DeepSeek API key  ${dim('← default provider')}
  ANTHROPIC_API_KEY     Anthropic API key
  QWEN_API_KEY          Qwen API key

  Priority: DEEPSEEK_API_KEY > QWEN_API_KEY > ANTHROPIC_API_KEY

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
  mode: SessionModeHint
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
  prompt: string | null
  maxTurns: number | undefined    // --max-turns override; undefined → CLI default
  resume: string | undefined      // --resume <sessionId>: preload history from saved session
}

function parseCliArgs(): CliOptions {
  let parsed: ReturnType<typeof parseArgs>
  try {
    parsed = parseArgs({
      args: process.argv.slice(2),
      options: {
        mode:         { type: 'string',  short: 'm', default: 'auto' },
        workspace:    { type: 'string',  short: 'w' },
        'api-key':    { type: 'string',  short: 'k' },
        'base-url':   { type: 'string',  short: 'b' },
        model:        { type: 'string' },
        'fallback-model': { type: 'string' },
        system:       { type: 'string',  short: 's' },
        'max-turns':  { type: 'string',  short: 't' },
        resume:       { type: 'string',  short: 'r' },
        yes:          { type: 'boolean', short: 'y', default: false },
        debug:        { type: 'boolean', short: 'd', default: false },
        'show-thinking': { type: 'boolean', default: false },
        json:         { type: 'boolean', short: 'j', default: false },
        version:      { type: 'boolean', short: 'v', default: false },
        help:         { type: 'boolean', short: 'h', default: false },
      },
      allowPositionals: true,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(red(`Error: ${msg}`))
    process.exit(1)
  }

  if (parsed.values['help']) { printHelp(); process.exit(0) }
  if (parsed.values['version']) { console.log(`meta-agent v${VERSION}`); process.exit(0) }

  const rawMode = (parsed.values['mode'] as string).toLowerCase()
  const validModes = ['auto', 'agentic', 'campaign', 'robotics']
  if (!validModes.includes(rawMode)) {
    console.error(red(`Error: unknown mode "${rawMode}". Valid: ${validModes.join(', ')}`))
    process.exit(1)
  }

  const promptParts = parsed.positionals
  const rawWorkspace = parsed.values['workspace'] as string | undefined
  let workspace: string | undefined
  if (rawWorkspace) {
    workspace = resolve(rawWorkspace)
    if (!existsSync(workspace) || !statSync(workspace).isDirectory()) {
      console.error(red(`Error: workspace "${workspace}" does not exist or is not a directory.`))
      process.exit(1)
    }
  }
  const rawMaxTurns = parsed.values['max-turns'] as string | undefined
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

  return {
    mode:       rawMode === 'auto' ? 'auto' : rawMode as SessionModeHint,
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
    prompt:     promptParts.length > 0 ? promptParts.join(' ') : null,
    maxTurns,
    resume:     parsed.values['resume']   as string | undefined,
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
  for (const k of ['DEEPSEEK_API_KEY', 'ANTHROPIC_API_KEY', 'QWEN_API_KEY'] as const) {
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
  const detected = detectProvider({
    apiKey: explicitApiKey,
    baseURL: opts.baseUrl,
    model: opts.model,
  })
  if (detected.apiKey) return

  console.error(
    red('Error: API key is required before starting a session.') + '\n' +
    dim('Set one of these environment variables, or pass --api-key:') + '\n' +
    `  ${cyan('export DEEPSEEK_API_KEY="sk-..."')} ${dim('(default provider)')}\n` +
    `  ${cyan('export QWEN_API_KEY="sk-..."')}\n` +
    `  ${cyan('export ANTHROPIC_API_KEY="sk-..."')}\n` +
    `  ${cyan('meta-agent --api-key sk-... "your prompt"')}\n`,
  )
  process.exit(1)
}

// ── Workspace helpers ─────────────────────────────────────────────────────────

/** Prompt the user to confirm or enter a working directory (interactive only) */
async function confirmWorkspace(suggested: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise(resolveP => {
    process.stdout.write(
      `\n${yellow('⚠  工作目录未指定')}\n` +
      `Agent 将只能在指定目录内读写文件。\n\n` +
      `${dim('当前目录:')} ${cyan(suggested)}\n` +
      `直接回车确认，或输入其他路径: `,
    )
    rl.once('line', line => {
      rl.close()
      const input = line.trim()
      if (!input) { resolveP(suggested); return }
      const abs = resolve(input)
      if (!existsSync(abs) || !statSync(abs).isDirectory()) {
        console.error(red(`路径不存在或不是目录: ${abs}`))
        process.exit(1)
      }
      resolveP(abs)
    })
  })
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
async function askQuestion(rl: readline.Interface, question: string): Promise<string> {
  return new Promise(resolve => {
    rl.question(question, answer => resolve(answer.trim()))
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
  const rl = existingRl ?? createInterface({ input: process.stdin, output: process.stdout })

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
  if (toolName === 'write_file' || toolName === 'edit_file') return toolName
  if (toolName === 'notebook_edit') return toolName
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
  const cmd = String(input['command'] ?? JSON.stringify(input)).slice(0, 240)

  process.stdout.write(
    `\n${yellow('⚠')}  ${bold('检测到敏感操作')} ${dim(`[${opLabel}]`)}\n` +
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
): SessionRouter {
  const cfg: MetaAgentConfig & RouterOptions = {}
  // Only forward explicit --api-key; env-var keys are read by detectProvider() itself
  // so it can correctly select the provider's baseURL (DeepSeek / Qwen / Anthropic).
  const apiKey = resolveExplicitApiKey(opts)
  if (apiKey)          cfg.apiKey       = apiKey
  if (opts.baseUrl)    cfg.baseURL      = opts.baseUrl
  if (opts.model)      cfg.model        = opts.model
  if (opts.fallbackModel) cfg.fallbackModel = opts.fallbackModel
  if (opts.mode !== 'auto') cfg.mode    = opts.mode

  // Apply maxTurns: explicit flag wins; otherwise cap each user turn so a
  // single prompt cannot run for hours without a checkpoint.
  cfg.maxTurns = opts.maxTurns ?? DEFAULT_CLI_MAX_TURNS

  // Debug mode
  if (opts.debug) cfg.debugMode = true

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
  }

  // Multi-agent escalation confirmation — shown when flash classifier suggests 'multi'.
  // Interrupts the streaming turn with a yes/no prompt before the first API call.
  cfg.onEscalationRequest = async (reason: string): Promise<boolean> => {
    if (opts.json) return false  // non-interactive mode: always deny
    if (opts.yes) return true    // auto-approve mode: always allow

    process.stdout.write(
      `\n${yellow('⚡ Multi-Agent 升级请求')}\n` +
      `   ${dim('理由：')}${reason}\n\n` +
      `   Multi-Agent 模式将启用并行子 Agent 编排、独立 Git 分支隔离和实验调度。\n` +
      `   单次任务费用和延迟会相应增加。\n\n` +
      `   是否升级到 Multi-Agent 模式？ ${dim('[y/N]')} `,
    )

    return new Promise<boolean>(resolve => {
      // Use raw stdin so we don't disturb the outer readline interface
      process.stdin.setRawMode?.(true)
      process.stdin.resume()
      process.stdin.setEncoding('utf8')
      const onKey = (key: string) => {
        process.stdin.setRawMode?.(false)
        process.stdin.pause()
        process.stdin.removeListener('data', onKey)
        const answer = key.trim().toLowerCase()
        const confirmed = answer === 'y'
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

    if (flashModel.startsWith('deepseek-')) {
      const OpenAI = (await import('openai')).default
      const client = new OpenAI({ apiKey, baseURL: baseURL ?? 'https://api.deepseek.com', maxRetries: 1 })
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
      if (summaryText.trim()) {
        process.stdout.write(`\n${dim('─── 经验提议摘要 (side-call) ───────────────────────────────────')}\n`)
        process.stdout.write(summaryText)
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
        timeout:    8_000,
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
    if (summaryText.trim()) {
      process.stdout.write(`\n${dim('─── 经验提议摘要 (side-call) ───────────────────────────────────')}\n`)
      process.stdout.write(summaryText)
      process.stdout.write(`\n${dim('─────────────────────────────────────────────────────────────')}\n\n`)
    }
  } catch { /* best-effort — side-call failure must NEVER crash the REPL */ }
}

// ── Stream a single prompt ────────────────────────────────────────────────────

const DEFAULT_CLI_MAX_VISIBLE_CHARS = 200_000

function getCliMaxVisibleChars(): number {
  const raw = process.env['META_AGENT_CLI_MAX_VISIBLE_CHARS']
  if (!raw) return DEFAULT_CLI_MAX_VISIBLE_CHARS
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) return DEFAULT_CLI_MAX_VISIBLE_CHARS
  return Math.min(2_000_000, Math.max(10_000, parsed))
}

async function safeStdoutWrite(text: string): Promise<void> {
  if (!text) return
  if (process.stdout.write(text)) return
  await once(process.stdout, 'drain')
}

async function streamPrompt(
  router: SessionRouter,
  prompt: string,
  jsonMode: boolean,
  showThinking = false,
): Promise<void> {
  const gen = router.submit(prompt)
  let hasText = false
  let thinkingOpen = false   // whether we're currently inside a thinking block
  let visibleChars = 0
  let visibleTruncated = false
  const visibleLimit = getCliMaxVisibleChars()

  async function writeVisible(text: string): Promise<void> {
    if (!text || visibleTruncated) return
    const remaining = visibleLimit - visibleChars
    if (remaining <= 0) {
      visibleTruncated = true
      await safeStdoutWrite(`\n${yellow('⚠')}  ${yellow('本轮终端输出已达到显示上限，后续内容已隐藏。')} ${dim('完整上下文仍保留在会话历史中。')}\n`)
      return
    }
    const chunk = text.length > remaining ? text.slice(0, remaining) : text
    visibleChars += chunk.length
    await safeStdoutWrite(chunk)
    if (chunk.length < text.length) {
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
    for await (const event of gen) {
      if (jsonMode) {
        console.log(JSON.stringify(event))
        continue
      }
      switch (event.type) {
        case 'thinking_delta': {
          if (showThinking) {
            await openThinkingBlock()
            await writeVisible(dim(event.delta))
          }
          break
        }
        case 'text': {
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
          await safeStdoutWrite(
            `\n${dim('⚙')}  ${cyan(event.toolName)} ${gray(JSON.stringify(event.toolInput).slice(0, 80))}\n`,
          )
          break
        }
        case 'tool_result': {
          const preview = String(event.content ?? '').slice(0, 120)
          await safeStdoutWrite(
            `   ${dim('→')} ${gray(preview)}${preview.length >= 120 ? gray('…') : ''}\n`,
          )
          break
        }
        case 'api_retry': {
          await safeStdoutWrite(
            `\n${yellow('⚠')}  retrying (attempt ${event.attempt}/${event.maxRetries}, delay ${event.retryDelayMs}ms)\n`,
          )
          break
        }
        case 'result': {
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
          } else if (event.subtype === 'error_during_execution') {
            const errDetails = (event as { errors?: string[] }).errors?.join('\n  ')
            await safeStdoutWrite(
              `\n${red('✗')}  ${red('执行过程中发生错误。')} ` +
              `${dim('请检查以下错误信息，调整指令后重试。')}\n` +
              (errDetails ? `${red('  错误详情：')} ${errDetails}\n` : ''),
            )
          }
          const usage = event.usage
          const cost  = router.getEstimatedCost()
          const mode  = router.mode ?? 'auto'
          const modeTag = mode === 'campaign' ? cyan(mode)
                        : mode === 'agentic'  ? green(mode)
                        : mode === 'robotics' ? `${c.magenta}${mode}${c.reset}`
                        : gray(mode)
          await safeStdoutWrite(
            `\n${gray('─'.repeat(56))}\n` +
            `${modeTag}  ` +
            `${gray(`in:${usage.inputTokens} out:${usage.outputTokens}`)}  ` +
            `${gray(`$${cost.toFixed(4)}`)}\n`,
          )
          break
        }
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ERR_STREAM_PREMATURE_CLOSE') return
    throw err
  }
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
    const preview = s.firstPrompt.slice(0, 60)
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

// ── Principle review ─────────────────────────────────────────────────────────

async function reviewPendingPrinciples(
  rl: readline.Interface,
  pending: PrinciplePendingStore,
  store: PrincipleStore,
  experienceStore?: ExperienceStore,
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

    console.log(
      `\n${'─'.repeat(60)}\n` +
      `${bold(title)} ${dim(`[${domains}]`)} ${dim(`conf:${confidence}`)} ${dim(`trigger:${reason}`)}\n` +
      `${dim('原则:')} ${statement}\n` +
      `${dim('机制:')} ${mechanism}\n` +
      (firstPrinciples ? `${dim('第一性原理支撑:')} ${firstPrinciples}\n` : '') +
      (bounds ? `${dim('适用边界:')} ${bounds}\n` : '') +
      (exclusions ? `${dim('不适用:')} ${exclusions}\n` : '') +
      `${'─'.repeat(60)}\n`,
    )

    const choice = await askQuestion(rl, `提交 [y=是 / n=丢弃 / s=跳过]: `)
    if (choice.toLowerCase() === 'y' || choice.toLowerCase() === 'yes') {
      const id = await pending.commit(entry.pendingId, store, experienceStore)
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
  lines.push(state.github ? `${dim('GitHub:')} ${cyan(state.github)}` : `${dim('GitHub:')} ${dim('(not set)')}`)
  lines.push(`${dim('Updated:')} ${state.updatedAt}`)
  lines.push('')

  lines.push(bold('Goals'))
  if (state.goals.length === 0) lines.push(`  ${dim('none')}`)
  else state.goals.forEach(g => lines.push(`  - ${g}`))
  lines.push('')

  lines.push(bold('进行中（锁定）'))
  if (owned.length === 0) {
    lines.push(`  ${dim('none')}`)
  } else {
    for (const t of owned) {
      const stale = isStaleClaim(t)
      const marker = stale ? yellow('⚠') : '🔒'
      const claim = t.claimedAt ? ` ${dim(`claimed ${relAgo(t.claimedAt)}`)}` : ''
      lines.push(`  ${marker} ${cyan(t.id)} ${t.title} · ${t.ownerUnit}${claim} · ${dim(`${t.attempts.length} attempts`)}`)
    }
  }
  lines.push('')

  if (paused.length > 0) {
    lines.push(bold('暂停'))
    for (const t of paused) {
      const owner = t.ownerUnit ? ` · ${t.ownerUnit}` : ''
      lines.push(`  - ${cyan(t.id)} ${t.title}${owner} · ${dim(`${t.attempts.length} attempts`)}`)
    }
    lines.push('')
  }

  lines.push(bold('待领'))
  if (open.length === 0) lines.push(`  ${dim('none')}`)
  else open.forEach(t => lines.push(`  - ${cyan(t.id)} ${t.title}`))
  lines.push('')

  if (done.length > 0) {
    lines.push(bold('已完成'))
    for (const t of done.slice(-5)) {
      lines.push(`  - ${dim(t.id)} ${dim(t.title)} ${dim(`(${t.attempts.length} attempts)`)}`)
    }
    lines.push('')
  }

  if (state.units.length > 0) {
    lines.push(bold('Units'))
    for (const u of state.units) {
      const cur = u.currentTask ? ` task=${u.currentTask}` : ''
      lines.push(`  - ${cyan(u.id)} ${dim(u.status)} last=${relAgo(u.lastSeen)}${cur}`)
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
    lines.push(`  - ${dim(relAgo(r.at))} ${cyan(r.taskId)} ${r.unit}`)
    lines.push(`      ${dim('方向:')} ${r.direction}`)
    lines.push(`      ${dim('结果:')} ${r.outcome}`)
    if (r.ref) lines.push(`      ${dim('ref:')} ${r.ref}`)
  }
  return `${lines.join('\n')}\n`
}

function formatTeamWatcherEvents(events: TeamWatcherEvent[] | undefined): string {
  if (!events || events.length === 0) return ''
  const lines = ['', bold('Watcher'), ...events.slice(-5).map(e => `  - ${dim(e.at)} ${e.message}`), '']
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

    if (flashModel.startsWith('deepseek-')) {
      const OpenAI = (await import('openai')).default
      const client = new OpenAI({ apiKey, baseURL: baseURL ?? 'https://api.deepseek.com', maxRetries: 1 })
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
        timeout:    12_000,
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
    state = await controller.teamJoin?.()
    console.log(green('\n✓ team 已初始化并加入。'))
  } else {
    // unitId is exposed via controller indirectly; for simplicity treat absence
    // as "not joined" only when there are zero units (otherwise the watcher's
    // sync will refresh presence on the next tick anyway).
    if (state.units.length === 0) {
      const answer = await askQuestion(rl, `当前还没有 unit。现在加入？[Y/n] `)
      if (!/^(n|no|否)$/i.test(answer.trim())) {
        state = await controller.teamJoin?.(state.github)
        console.log(green('\n✓ 已加入 team。'))
      }
    }
  }

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
    if (plan.summary) console.log(`${dim('判断:')} ${plan.summary}`)
    if (plan.guidance) console.log(`${dim('建议:')} ${plan.guidance}`)
  }
  if (plan?.risk === 'blocked') {
    console.log(red(`\n⚠ Planner 判断存在阻塞，已跳过任何写入建议。`))
  } else if (plan && plan.actions.length > 0) {
    await executePlan(controller, plan, q => askQuestion(rl, q), {
      onAction: (action, status, detail) => {
        const tag = status === 'done' ? green('✓') : status === 'failed' ? red('✗') : status === 'skipped' ? yellow('-') : dim('→')
        const note = detail ? ` ${dim(detail)}` : ''
        console.log(`  ${tag} ${action.type}${action.taskId ? ` ${cyan(action.taskId)}` : ''}${note}`)
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
        console.log(green('\n✓ team 模板已初始化。') + dim('  文件位于 team/，请提交 team.json 到 GitHub。'))
        console.log(formatTeamState(state))
        break
      }
      case 'join': {
        const state = await controller.teamJoin?.(arg)
        console.log(green('\n✓ 已加入 team。'))
        console.log(formatTeamState(state))
        break
      }
      case 'add': {
        if (!arg) {
          console.log(`\n${yellow('用法:')} ${cyan('/team add "<task title>"')}\n`)
          break
        }
        const state = await controller.teamStatus?.()
        const id = nextTeamTaskId(state?.tasks ?? [])
        const title = arg.replace(/^['"]|['"]$/g, '').trim()
        const result = await controller.teamTaskAdd?.({ id, title })
        console.log(green(`\n✓ 已新增 ${result?.task.id ?? id}: ${title}。`))
        console.log(formatTeamState(result?.state))
        break
      }
      case 'take': {
        if (!arg) {
          console.log(`\n${yellow('用法:')} ${cyan('/team take TASK-001')}\n`)
          break
        }
        const result = await controller.teamTake?.(arg)
        console.log(green(`\n✓ 已领取 ${result?.task.id ?? arg}。`))
        console.log(formatTeamState(result?.state))
        break
      }
      case 'drop': {
        const result = await controller.teamDrop?.(arg)
        console.log(green(`\n✓ 已释放 ${result?.task.id ?? '(当前任务)'}。`))
        console.log(formatTeamState(result?.state))
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
        break
      }
      case 'done': {
        const state = await controller.teamStatus?.()
        const myTask = state?.tasks.find(t => t.ownerUnit && t.status !== 'done')
        const taskId = arg || myTask?.id || ''
        if (!taskId) {
          console.log(`\n${yellow('没有当前任务。')} 使用 ${cyan('/team done TASK-001')}。\n`)
          break
        }
        const result = await controller.teamTaskStatus?.(taskId, 'done')
        console.log(green(`\n✓ ${result?.task.id ?? taskId} -> done。`))
        console.log(formatTeamState(result?.state))
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
          console.log(dim(`未知 team 子命令 "${sub}"。可用: init, join, add, take, note, drop, steal, done, pause, status, board, log, sync, pull, conflicts.\n`))
        }
        break
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`\n${red('team error:')} ${msg}\n`)
  }
}

// ── Interactive REPL ──────────────────────────────────────────────────────────

async function runRepl(opts: CliOptions): Promise<void> {
  // ── Workspace confirmation (REPL only, single-turn skips for scripting) ──
  if (!opts.json && isTTY) {
    if (!opts.workspace) {
      opts.workspace = await confirmWorkspace(process.cwd())
    }
    console.log(green(`✓ 工作目录: ${opts.workspace}\n`))
  } else if (!opts.workspace) {
    // Non-TTY / json mode: default to cwd silently
    opts.workspace = process.cwd()
  }

  // ── Hardware profile selection (robotics mode only) ───────────────────────
  let hardwareProfileText = ''
  if (opts.mode === 'robotics' && !opts.json && isTTY) {
    const hp = new HardwareProfile()
    const selected = await selectHardwareProfile(hp, opts.workspace)
    opts.hardwareId      = selected.name || undefined
    hardwareProfileText  = selected.profileText
  }

  if (!opts.json) {
    const debugDir = opts.debug
      ? join(homedir(), '.meta-agent', 'debug', '<sessionId>')
      : ''
    console.log(
      `${bold('meta-agent')}  ${dim(`v${VERSION}`)}\n` +
      `Mode: ${cyan(opts.mode === 'auto' ? 'auto-detect' : opts.mode)}` +
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
  const rl = createInterface({
    input:  process.stdin,
    output: process.stdout,
    prompt: `\n${bold(cyan('you'))} › `,
    terminal: isTTY,
    historySize: 100,
  })

  // ── Session resume ────────────────────────────────────────────────────────
  let resumedMessages: ConversationMessage[] = []
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
          // Restore the mode from the saved session.
          if (meta && opts.mode === 'auto' && meta.mode && meta.mode !== 'auto') {
            opts.mode = meta.mode as CliOptions['mode']
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
          // Restore the mode from the saved session so the router starts in the
          // correct mode instead of re-detecting it from the first user message.
          if (opts.mode === 'auto' && resumed.mode && resumed.mode !== 'auto') {
            opts.mode = resumed.mode as CliOptions['mode']
          }
        }
      }
    }
  }

  let router: SessionRouter
  const getCurrentRouter = () => router
  router = makeRouter(opts, hardwareProfileText || undefined, rl, resumedMessages.length > 0 ? resumedMessages : undefined, getCurrentRouter)

  // Register standard tools for agentic/campaign/auto modes.
  // Robotics mode registers its own tools internally (RoboticsSession.init).
  if (opts.mode !== 'robotics') {
    const tools = await createStandardTools({
      system: { cwd: opts.workspace, mode: (opts.mode === 'campaign' ? 'campaign' : 'agentic') },
    })
    for (const tool of tools) {
      router.registerTool(tool)
    }
  }
  let interrupted = false
  // Track how many messages we've already saved so append writes only new ones.
  let savedMessageCount = resumedMessages.length
  // Track whether the real debug dir has been printed (becomes known after first submit)
  let debugDirShown = false
  const seenTeamReminderEvents = new Set<string>()
  let teamReminderInitialized = false
  let teamReminderRunning = false
  // Only show Team 动态 notifications after the user explicitly uses a /team command
  // in this session. Prevents noise for users with a team.json who aren't using team mode.
  let teamModeUsed = false
  // Guards against showing the hardware-binding prompt more than once per session
  // (set to true after the first prompt, even if the user skips it).
  let hardwareBindingPrompted = false
  const persistCurrentSession = async (currentInput: string): Promise<void> => {
    if (opts.json) return
    try {
      const sessionId = router.getSessionId()
      if (!sessionId) return
      const messages = router.getMessages()
      if (messages.length <= savedMessageCount) return
      const firstUserMsg = messages.find(m => m.role === 'user')
      const firstPromptText = firstUserMsg
        ? (typeof firstUserMsg.content === 'string'
            ? firstUserMsg.content
            : JSON.stringify(firstUserMsg.content)
          ).slice(0, 80)
        : currentInput.slice(0, 80)
      await SessionStore.append(
        sessionId,
        {
          mode:          router.mode ?? (opts.mode === 'auto' ? 'agentic' : opts.mode),
          startTime:     Date.now(),
          lastActivity:  Date.now(),
          messageCount:  messages.length,
          firstPrompt:   firstPromptText,
          workspace:     opts.workspace,
        },
        messages,
        savedMessageCount,
      )
      savedMessageCount = messages.length
    } catch {
      // session save is best-effort — never crash the REPL
    }
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
            if (!teamReminderInitialized) {
              teamReminderInitialized = true
              return
            }
            if (fresh.length > 0 && teamModeUsed) {
              process.stdout.write(`\n${yellow('Team 动态')}\n`)
              fresh.slice(-5).forEach(event => {
                process.stdout.write(`  - ${event.message}\n`)
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
  // Core insight: we can reliably distinguish "user pressed Enter to submit"
  // from "newline embedded in pasted text" by inspecting the raw stdin data
  // chunk that triggers each readline 'line' event:
  //
  //   • Bare Enter     — the data chunk contains ONLY \r / \n characters.
  //                      The user explicitly hit Enter → submit immediately.
  //   • Paste chunk    — the data chunk contains actual text.  Two sub-cases:
  //       a) chunk ends with \n (no buffered tail)  → use a 300 ms debounce
  //          so all same-chunk lines are flushed together.
  //       b) chunk has text after the last \n       → readline buffered that
  //          tail; it will only emit a 'line' event for it when the user
  //          eventually presses Enter.  Set NO timer — wait indefinitely.
  //          When Enter arrives (even minutes later) it comes as a bare Enter
  //          chunk and flushes everything accumulated so far.
  //
  // We use process.stdin.prependListener so our 'data' handler runs BEFORE
  // readline's own 'data' handler — ensuring _lastStdinData is set before any
  // 'line' events fire within the same call stack.
  //
  // The SIGINT drain window (ignoreInputUntil) is checked in both handlers.

  const PASTE_FLUSH_MS = 300   // debounce for paste-with-trailing-newline

  const _pasteLines: string[] = []
  let _pasteTimer: ReturnType<typeof setTimeout> | null = null
  let _lastStdinData = ''
  let _hasBufferedTail = false   // true when paste chunk has content after last \n

  const _inputQueue: string[] = []
  const _inputResolvers: Array<(v: string | null) => void> = []
  let _rlClosed = false

  function _flushPaste(): void {
    if (_pasteTimer) { clearTimeout(_pasteTimer); _pasteTimer = null }
    const combined = _pasteLines.join('\n')
    _pasteLines.length = 0
    _enqueueInput(combined)
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

  // Must be prepended so it fires BEFORE readline's own 'data' handler.
  process.stdin.prependListener('data', (buf: Buffer) => {
    if (Date.now() < ignoreInputUntil) {
      _lastStdinData = ''
      _hasBufferedTail = false
      return
    }
    const s = buf.toString()
    _lastStdinData = s
    // Does the chunk leave content buffered in readline (text after last \n)?
    const lastNl = s.lastIndexOf('\n')
    _hasBufferedTail = lastNl >= 0 && lastNl < s.length - 1

    // If a paste-flush timer is pending and this looks like a keyboard keystroke
    // (no newlines, ≤4 bytes — covers ASCII keys, UTF-8 multi-byte chars, arrow
    // key escape sequences), cancel the timer so we don't flush mid-word.
    // The flush will happen naturally when the user presses Enter.
    if (_pasteTimer && !s.includes('\n') && buf.length <= 4) {
      clearTimeout(_pasteTimer)
      _pasteTimer = null
    }
  })

  rl.on('line', (rawLine) => {
    if (Date.now() < ignoreInputUntil) return   // SIGINT drain — silently discard

    // "Bare Enter": stdin chunk was purely \r / \n → user explicitly submitted.
    const isBareEnter = /^[\r\n]+$/.test(_lastStdinData)

    _pasteLines.push(rawLine)
    if (_pasteTimer) clearTimeout(_pasteTimer)

    if (isBareEnter) {
      // Explicit submit — flush immediately regardless of wait time.
      _flushPaste()
    } else if (_hasBufferedTail) {
      // Paste chunk still has content buffered in readline waiting for Enter.
      // Do not start any timer — wait indefinitely for the user's Enter.
      _pasteTimer = null
    } else {
      // Paste chunk with trailing \n (no buffered tail) — short debounce so
      // all lines from the same chunk are flushed together.
      _pasteTimer = setTimeout(_flushPaste, PASTE_FLUSH_MS)
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
    _pasteLines.length = 0
    if (_pasteTimer) { clearTimeout(_pasteTimer); _pasteTimer = null }
    process.stdout.write(`\n${yellow('Interrupted')} ${dim('(press Ctrl+C again to exit)')}\n`)
    setTimeout(() => { ctrlCPressed = false }, 2000)
    rl.prompt()
  })

  rl.on('close', () => {
    // Signal EOF to the accumulator queue so _nextInput() unblocks
    _rlClosed = true
    if (_pasteTimer) {
      clearTimeout(_pasteTimer)
      _pasteTimer = null
      if (_pasteLines.length > 0) {
        _enqueueInput(_pasteLines.join('\n'))
        _pasteLines.length = 0
      }
    }
    for (const resolve of _inputResolvers) resolve(null)
    _inputResolvers.length = 0

    if (exiting) return
    exiting = true
    if (teamReminderTimer) clearInterval(teamReminderTimer)
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
    if (teamReminderTimer) clearInterval(teamReminderTimer)
    if (err) console.error(`\n${red('Fatal:')} ${err instanceof Error ? err.message : String(err)}\n`)
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
              const selected = await selectHardwareProfile(hp, opts.workspace, rl)
              opts.hardwareId     = selected.name || undefined
              hardwareProfileText = selected.profileText
              // Rebuild router with the new hardware binding (keeps same workspace/key/model)
              await router.dispose().catch(() => undefined)
              router = makeRouter(opts, hardwareProfileText || undefined, rl, undefined, getCurrentRouter)
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
          console.log(
            `\nTokens — in: ${u.inputTokens}  out: ${u.outputTokens}  ` +
            `cache_read: ${u.cacheReadInputTokens ?? 0}\n` +
            `Estimated cost: $${cost.toFixed(5)}\n`,
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
              const preview = s.firstPrompt.slice(0, 60)
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
                // Use deleteAllSessions() instead of concurrent deleteSession() calls.
                // Concurrent calls each read → filter → write the same index file,
                // causing a last-writer-wins race where only one session is removed.
                // deleteAllSessions() clears the index in one atomic write.
                await SessionStore.deleteAllSessions()
                console.log(green(`\n✓ 已删除全部 ${sessions.length} 条历史会话。\n`))
              } else {
                console.log(dim('\n已取消。\n'))
              }
            } else {
              const idx = parseInt(choiceTrimmed, 10)
              if (idx >= 1 && idx <= sessions.length) {
                const selected = sessions[idx - 1]!
                await SessionStore.deleteSession(selected.sessionId)
                const preview = selected.firstPrompt.slice(0, 50)
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
                const preview = s.firstPrompt.slice(0, 60)
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
                  router = makeRouter(opts, hardwareProfileText || undefined, rl, messages, getCurrentRouter)
                  savedMessageCount = messages.length
                }
              }
            }
          }
          break
        }
        case '/experience': {
          const subCmd = input.split(/\s+/).slice(1).join(' ').toLowerCase()
          const pending = router.getPendingExperiences()
          if (subCmd === 'review') {
            if (!pending) {
              console.log(yellow('\n/experience review 仅在 robotics 模式下可用。\n'))
            } else {
              const store = new ExperienceStore()
              await reviewPendingExperiences(rl, pending, store, async id => {
                const result = await router.proposePrincipleForExperience(id, 'confidence_threshold') as
                  | { promoted?: boolean; pendingId?: string; reason?: string; score?: number }
                  | null
                if (result?.promoted) {
                  console.log(yellow(`  ⏸ 已生成待审原则 (pending ID: ${result.pendingId}, score: ${result.score ?? 'n/a'})`))
                  console.log(dim(`  使用 /principle review 审核是否提交。`))
                }
              })
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
          const pendingPrinciples = router.getPendingPrinciples()
          if (subCmd === 'review') {
            if (!pendingPrinciples) {
              console.log(yellow('\n/principle review 仅在 robotics 模式下可用。\n'))
            } else {
              const store = new PrincipleStore()
              await reviewPendingPrinciples(rl, pendingPrinciples, store, new ExperienceStore())
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
          const pendingAnchors = router.getPendingPhysicalAnchors()
          if (subCmd === 'review') {
            if (!pendingAnchors) {
              console.log(yellow('\n/anchor review 仅在 robotics 模式下可用。\n'))
            } else {
              const store = new PhysicalAnchorStore()
              await reviewPendingPhysicalAnchors(rl, pendingAnchors, store)
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
        case '/clear':
          await router.dispose().catch(() => undefined)
          router = makeRouter(opts, undefined, rl, undefined, getCurrentRouter)
          savedMessageCount = 0
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

    // ── Auto-mode hardware check (BEFORE streaming) ───────────────────────────
    // Run mode detection ahead of the first LLM call so we can prompt for a
    // hardware profile before the AI responds — ensuring the first turn already
    // has hardware context in the system prompt.
    // primeMode() is a no-op after the first submit(), so this only fires once.
    if (opts.mode === 'auto' && !opts.hardwareId && !hardwareBindingPrompted && !opts.json && isTTY) {
      const primed = await router.primeMode(input)
      if (primed === 'robotics') {
        hardwareBindingPrompted = true
        console.log(
          `\n${c.magenta}robotics${c.reset} 模式已激活。` +
          `在继续之前，请绑定一个硬件配置。\n`,
        )
        const hp = new HardwareProfile()
        const selected = await selectHardwareProfile(hp, opts.workspace, rl)
        opts.hardwareId     = selected.name || undefined
        hardwareProfileText = selected.profileText
        // Lock mode so the new router skips re-detection (no second flash model call)
        opts.mode = 'robotics'
        await router.dispose().catch(() => undefined)
        router = makeRouter(opts, hardwareProfileText || undefined, rl, undefined, getCurrentRouter)
        if (opts.hardwareId) {
          console.log(green(`✓ 硬件配置 "${opts.hardwareId}" 已绑定。\n`))
        }
      }
    }

    // Snapshot pending counts before this turn so we can detect new additions
    const pendingCountBefore = router.getPendingExperiences()?.count ?? 0
    const anchorCountBefore = router.getPendingPhysicalAnchors()?.count ?? 0

    try {
      await streamPrompt(router, input, opts.json, opts.showThinking)
    } catch (err) {
      if (!interrupted) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`\n${red('Error:')} ${msg}\n`)
      }
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
        const realDir = join(homedir(), '.meta-agent', 'debug', sid)
        console.log(`\n${dim('调试日志目录:')} ${cyan(realDir)}\n`)
        debugDirShown = true
      }
    }

    // ── Post-turn: hardware binding catch-up ─────────────────────────────────
    // If primeMode() didn't detect robotics but the AI response upgraded the
    // mode internally, prompt for hardware here so subsequent turns get context.
    if (
      !interrupted && !opts.json && isTTY &&
      router.mode === 'robotics' && !opts.hardwareId && !hardwareBindingPrompted
    ) {
      hardwareBindingPrompted = true
      console.log(
        `\n${c.magenta}robotics${c.reset} 模式已激活，请绑定硬件配置以优化后续回复。\n`,
      )
      const hp = new HardwareProfile()
      const selected = await selectHardwareProfile(hp, opts.workspace, rl)
      opts.hardwareId     = selected.name || undefined
      hardwareProfileText = selected.profileText
      if (hardwareProfileText) {
        await persistCurrentSession(input)
        opts.mode = 'robotics'
        await router.dispose().catch(() => undefined)
        router = makeRouter(opts, hardwareProfileText, rl, undefined, getCurrentRouter)
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

    rl.prompt()
  }
}

// ── Single-turn mode ──────────────────────────────────────────────────────────

async function runSingleTurn(opts: CliOptions): Promise<void> {
  const router = makeRouter(opts)

  // Register standard tools (robotics registers its own)
  if (opts.mode !== 'robotics') {
    const tools = await createStandardTools({
      system: { cwd: opts.workspace, mode: (opts.mode === 'campaign' ? 'campaign' : 'agentic') },
    })
    for (const tool of tools) {
      router.registerTool(tool)
    }
  }

  try {
    await streamPrompt(router, opts.prompt!, opts.json, opts.showThinking)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(red(`Error: ${msg}`))
    process.exitCode = 1
  } finally {
    await router.dispose().catch(() => undefined)
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Sanitize env-var API keys once so detectProvider() receives clean values
  sanitizeEnvKeys()

  const opts = parseCliArgs()
  assertApiKeyConfigured(opts)

  if (opts.prompt !== null) {
    await runSingleTurn(opts)
  } else {
    await runRepl(opts)
  }
}

main().catch(err => {
  console.error(red(`Fatal: ${err instanceof Error ? err.message : String(err)}`))
  process.exit(1)
})
