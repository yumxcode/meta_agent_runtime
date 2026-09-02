/**
 * cli/prompts — readline question plumbing and workspace confirmation.
 *
 * `askQuestion` is the single place that owns reading a line from the user, so
 * there is never more than one readline interface competing for stdin, and so
 * the thinking-meter spinner is paused before a prompt is drawn.
 *
 * Extracted from cli/index.ts.
 */
import * as readline from 'node:readline'
import { createInterface } from 'node:readline'
import { isAbsolute, resolve } from 'node:path'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { bold, cyan, dim, green, red, yellow, isTTY, pauseActiveThinkingMeter } from './term.js'

// ── Workspace helpers ─────────────────────────────────────────────────────────

/** Prompt the user to confirm or enter a working directory (interactive only) */
export async function confirmWorkspace(suggested: string, existingRl?: readline.Interface): Promise<string> {
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
export function buildWorkspaceSystemPrompt(workspace: string): string {
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

export function isNativeQuestionActive(rl: readline.Interface): boolean {
  return nativeQuestionInterfaces.has(rl)
}

export async function askQuestion(rl: readline.Interface, question: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('interactive input cancelled before it was shown'))
      return
    }
    process.stdin.resume()
    nativeQuestionInterfaces.add(rl)

    // EOF safety net, for BOTH the signal and no-signal paths.
    //
    // readline does not invoke a pending question's callback when the interface
    // closes, so Ctrl+D (or a closed stdin) at a prompt left this promise
    // pending forever. The REPL happened to survive that — its own 'close'
    // handler calls process.exit — but every other caller inherited a silent
    // hang from a keystroke users press all the time. Settle explicitly
    // instead of relying on someone else's exit path.
    //
    // Resolves empty rather than rejecting: every call site already reads an
    // empty answer as "cancelled" (that is what a bare Enter gives them), and
    // Ctrl+D at a prompt means the same thing. Rejecting would turn an ordinary
    // keystroke into an unhandled rejection, which this CLI treats as fatal —
    // trading a silent hang for a spurious `Fatal:` on the way out.
    let settled = false
    const onClose = (): void => {
      if (settled) return
      settled = true
      nativeQuestionInterfaces.delete(rl)
      resolve('')
    }
    rl.once('close', onClose)
    const done = (fn: () => void): void => {
      if (settled) return
      settled = true
      rl.off('close', onClose)
      fn()
    }

    // With a signal, readline cancels the pending question on abort — the
    // callback never fires and the interface is free for the next prompt.
    // Without this, a timed-out ask_user leaves a zombie question that
    // swallows the user's next input line (seen after Distill completion).
    if (signal) {
      const onAbort = (): void => {
        done(() => {
          nativeQuestionInterfaces.delete(rl)
          process.stdout.write('\n')
          reject(new Error('interactive input timed out or was cancelled; treat this question as unresolved'))
        })
      }
      signal.addEventListener('abort', onAbort, { once: true })
      rl.question(question, { signal }, answer => {
        signal.removeEventListener('abort', onAbort)
        done(() => {
          queueMicrotask(() => nativeQuestionInterfaces.delete(rl))
          resolve(answer.trim())
        })
      })
      return
    }
    rl.question(question, answer => {
      done(() => {
        queueMicrotask(() => nativeQuestionInterfaces.delete(rl))
        resolve(answer.trim())
      })
    })
  })
}

