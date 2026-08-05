/**
 * cli/guards — the interactive sensitive-operation confirmation.
 *
 * This is a UX gate, not a security boundary: the kernel PermissionPolicy is
 * what actually denies out-of-workspace work. Containment questions are
 * delegated to tools/fs/workspaceGuard so this file cannot drift from the
 * kernel's answer — it previously carried its own `startsWith` check that
 * treated `/home/u/proj-backup` as inside `/home/u/proj`.
 *
 * Extracted from cli/index.ts.
 */
import * as readline from 'node:readline'
import { detectSensitiveShellCommand } from '../kernel/permissions/SensitiveCommandPatterns.js'
import { isInsideWorkspace } from '../tools/fs/workspaceGuard.js'
import { sanitizeTerminalPreview } from './terminalSanitizer.js'
import type { BeforeToolCallResult } from '../core/config.js'
import { bold, cyan, dim, green, red, yellow, terminalText } from './term.js'
import { askQuestion } from './prompts.js'

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
export function detectSensitiveOp(
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
      !isWorkspaceLocalPath(filePath, workspace)
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
    if (typeof cwd === 'string' && cwd && !isWorkspaceLocalPath(cwd, workspace)) {
      return `工作目录外 cwd (${cwd.slice(0, 60)})`
    }
    const absPathPattern = /(?:^|\s|['"])(\/([\w.\-]+\/)+[\w.\-]*)/g
    let m: RegExpExecArray | null
    while ((m = absPathPattern.exec(cmd)) !== null) {
      const p = m[1]!
      if (!isWorkspaceLocalPath(p, workspace)) {
        return `工作目录外路径 (${p.slice(0, 60)})`
      }
    }
  }
  return null
}

/**
 * "Is this path inside the workspace (or a benign temp/device location)?" for
 * the CONFIRMATION guard.
 *
 * Delegates containment to `isInsideWorkspace` — the shared guard the kernel
 * policy and the bash tool use — instead of the bare `path.startsWith(workspace)`
 * this function used to do. That prefix test had two failure modes:
 *   • sibling directories passed as "inside": with workspace `/home/u/proj`,
 *     `/home/u/proj-backup/secret` startsWith the root, so NO confirmation was
 *     shown for a write outside the project;
 *   • no symlink resolution, so a symlinked path escaped unnoticed.
 * The kernel still hard-denies such paths, so this was defence-in-depth
 * degrading silently — precisely the drift workspaceGuard.ts exists to stop.
 */
function isWorkspaceLocalPath(path: string, workspace: string): boolean {
  if (isInsideWorkspace(path, workspace)) return true
  // Temp and standard device files are noise, not workspace escapes; the kernel
  // policy applies the same carve-outs (allowTmp + the /dev allowlist).
  return /^\/(?:tmp|private\/tmp|var\/tmp)\//.test(path) ||
    /^\/dev\/(?:null|zero|full|random|urandom|tty|std(?:in|out|err)|fd\/\d+)$/.test(path)
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
export async function confirmToolCall(
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


