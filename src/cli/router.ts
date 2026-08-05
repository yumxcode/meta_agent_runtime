/**
 * cli/router — assembles the SessionRouter from parsed CLI options.
 *
 * The one place that maps flags → RouterOptions/MetaAgentConfig, so the REPL
 * and single-turn paths cannot drift in how a session is configured.
 *
 * Extracted from cli/index.ts.
 */
import * as readline from 'node:readline'
import { SessionRouter } from '../routing/SessionRouter.js'
import { isAutonomousMode } from '../core/modes.js'
import { RuntimeEnv } from '../infra/env/RuntimeEnv.js'
import { getModelProtocol } from '../providers/registry.js'
import type { MetaAgentConfig, BeforeToolCallResult } from '../core/config.js'
import type { RouterOptions } from '../routing/types.js'
import type { ConversationMessage } from '../core/types.js'
import { bold, cyan, dim, green, isTTY, yellow, terminalText } from './term.js'
import { detectSensitiveOp, confirmToolCall } from './guards.js'
import { resolveExplicitApiKey } from './keys.js'
import { buildWorkspaceSystemPrompt, askQuestion } from './prompts.js'
import { getMcpServerInstructions } from './mcpInstructions.js'
import { DEFAULT_CLI_MAX_TURNS, AUTO_CLI_MAX_TURNS } from './limits.js'
import type { CliOptions } from './args.js'

// ── Router factory ────────────────────────────────────────────────────────────

export function makeRouter(
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
  if (getMcpServerInstructions().length > 0) {
    cfg.mcpServers = getMcpServerInstructions()
  }

  return new SessionRouter(cfg)
}

