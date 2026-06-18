/**
 * VerifyJudge — the auto-mode completion gate implementation.
 *
 * `makeAutoVerifyGate` returns a VerifyGateFn (the kernel-layer contract) that,
 * when the executor declares itself done, asks an INDEPENDENT judge sub-agent
 * whether the original goal is actually met. Design, per the agreed spec:
 *
 *   • Pure goal       — the raw, frozen first user prompt (read lazily via
 *                       getGoal, since it's captured after backend creation).
 *                       The judge NEVER sees the executor's narrative or claims.
 *   • Self-investigate— the judge runs in an isolated context with READ-ONLY
 *                       tools (read_file/grep/glob/bash) and must cite evidence
 *                       for every "done" claim — no rubber-stamping.
 *   • Safe isolation  — it inspects a throwaway git snapshot of the current
 *                       state, so its bash can't corrupt real source.
 *   • Fail-open       — any internal failure resolves to done:true (+ note) so a
 *                       broken verifier can never wedge a finished run.
 */
import type { ISubAgentDispatcher } from '../../../subagent/ISubAgentDispatcher.js'
import { TERMINAL_STATUSES } from '../../../subagent/types.js'
import type { VerifyGateFn, VerifyVerdict } from '../../../kernel/loop/VerifyGate.js'
import { withReadonlySnapshot } from './JudgeSnapshot.js'

export interface AutoVerifyGateDeps {
  /** Spawns the isolated judge sub-agent. */
  dispatcher: ISubAgentDispatcher
  /** Workspace / jail root. */
  projectDir: string
  /** Lazily reads the pure frozen goal (SessionRouter._autoGoal). */
  getGoal: () => string | null
}

/**
 * Toolset the judge may use when inspecting a THROWAWAY git snapshot worktree:
 * bash is included because any write it performs lands in the disposable
 * snapshot (projectDir + sandbox writeAllowPaths are bound to it), never the
 * real source.
 */
const JUDGE_TOOLS = ['read_file', 'grep', 'glob', 'bash']

/**
 * Toolset when NO snapshot could be made and the judge must inspect the LIVE
 * tree (non-git workspace, or a git step failed). bash is dropped: on the live
 * tree the auto jail auto-approves in-workspace writes, so a bash-capable judge
 * could mutate real source despite the read-only rubric. read/grep/glob cover
 * file-content verification while closing the only write vector.
 */
const JUDGE_TOOLS_READONLY = ['read_file', 'grep', 'glob']

const JUDGE_RUBRIC = `\
你是一个独立的"完成度审核 Agent"。你处在一个隔离上下文中：你**没有**看到执行 Agent 的推理过程或它自称做了什么，这是刻意为之——你的判断必须独立。

你的唯一职责：判断【原始目标】是否已经被真正满足。

工作方式（强制）：
1. 你只有只读工具（read_file / grep / glob / bash）。**不要修改任何文件**；bash 仅用于查看（cat/ls/grep/git log 等）。
2. 必须亲自到工作区取证来对照目标——不要凭空判断，也不要轻信任何"已完成"的说法。
3. verify 不运行 typecheck/test/lint；你必须仅基于原始目标和亲自读取到的代码/产物作出 LLM 审核判断。
4. 对每一条判断都要给出具体证据（文件:行号，或只读命令输出）。给不出证据的"完成"不成立。

输出（关键）：在你最后一条消息里，只输出一个 JSON 代码块，schema 如下，不要有多余文字：
\`\`\`json
{
  "done": true 或 false,
  "unfinished": ["未完成项1（具体、可执行）", "..."],
  "evidence": ["证据1（file:line 或 命令+退出码）", "..."],
  "note": "可选：无法判断时的说明"
}
\`\`\`
done=true 时 unfinished 必须为空数组。`

/** Build the judge's task: pure goal + where to inspect. */
function buildJudgeTask(goal: string, snapshotPath: string | null): string {
  const location = snapshotPath
    ? `待审核的代码位于这个只读快照目录（请只在此目录内取证）：\n  ${snapshotPath}`
    : `（无法创建 git 快照，请直接在工作区只读查证，切勿修改任何文件。）`
  return [
    '【原始目标】',
    goal,
    '',
    '【取证位置】',
    location,
    '',
    '现在开始查证，并按要求只在最后输出 JSON 裁决。',
  ].join('\n')
}

/** Extract the last JSON object from the judge's summary text. */
export function parseVerdict(text: string): VerifyVerdict | null {
  if (!text) return null
  // Prefer a fenced ```json block; fall back to the last {...} span.
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map(m => m[1] ?? '')
  const candidates = fences.length ? fences : []
  // Also try the last balanced-looking object as a fallback.
  const lastBrace = text.lastIndexOf('{')
  if (lastBrace !== -1) candidates.push(text.slice(lastBrace))

  for (let i = candidates.length - 1; i >= 0; i--) {
    const raw = candidates[i]?.trim()
    if (!raw) continue
    try {
      const obj = JSON.parse(raw) as Partial<VerifyVerdict>
      if (typeof obj.done !== 'boolean') continue
      return {
        done: obj.done,
        unfinished: Array.isArray(obj.unfinished) ? obj.unfinished.map(String) : [],
        evidence: Array.isArray(obj.evidence) ? obj.evidence.map(String) : [],
        note: typeof obj.note === 'string' ? obj.note : undefined,
      }
    } catch {
      // try the next candidate
    }
  }
  return null
}

/** Spawn the judge and block until terminal, returning its summary text. */
async function runJudge(
  deps: AutoVerifyGateDeps,
  taskDescription: string,
  signal: AbortSignal,
  snapshotPath: string | null,
): Promise<string | null> {
  const rec = await deps.dispatcher.spawnSubAgent({
    config: {
      taskDescription,
      systemPrompt: JUDGE_RUBRIC,
      // With a snapshot, bash writes are confined to the throwaway worktree; on
      // the live tree (no snapshot) bash is dropped to remove the write vector.
      allowedTools: snapshotPath ? JUDGE_TOOLS : JUDGE_TOOLS_READONLY,
      maxTurns: 12,
      maxBudgetUsd: 0.4,
      requireHumanApproval: false,
      useEventDriven: false,
      pollIntervalMs: 500,
      checkpointEveryNTurns: 0,
      // Reserved side lane: the completion gate must never be starved (or
      // silently disabled) by research/worker sub-agents that share the bridge.
      internal: true,
      workspaceMode: snapshotPath ? 'ephemeral_snapshot' : 'shared_readonly',
      ...(snapshotPath ? {
        projectDir: snapshotPath,
        sandbox: { writeAllowPaths: [snapshotPath], network: 'none' as const },
      } : {}),
    },
    abortSignal: signal,
  })

  // Poll to terminal. Bounded so a stuck judge can't hang the gate forever.
  const POLL_MS = 500
  const MAX_WAIT_MS = 12 * 2 * 60 * 1000   // mirror run_agent's 2 min/turn ceiling
  const deadline = Date.now() + MAX_WAIT_MS
  let status = rec.status
  let latest = rec
  while (!TERMINAL_STATUSES.has(status)) {
    if (signal.aborted || Date.now() > deadline) break
    await new Promise(r => setTimeout(r, POLL_MS))
    const polled = await deps.dispatcher.getStatus(rec.taskId)
    if (!polled) break
    latest = polled
    status = polled.status
  }
  if (latest.status !== 'completed') return null
  return latest.result?.summary ?? null
}

/**
 * Build the verify gate for an auto session. Returns undefined inputs handled
 * via fail-open: the gate always resolves (never rejects), defaulting to
 * done:true with an explanatory note whenever it cannot reach a real verdict.
 */
export function makeAutoVerifyGate(deps: AutoVerifyGateDeps): VerifyGateFn {
  return async ({ signal }) => {
    const passOpen = (note: string): VerifyVerdict =>
      ({ done: true, unfinished: [], evidence: [], note, skipped: true })

    const goal = deps.getGoal()
    if (!goal || !goal.trim()) return passOpen('verify skipped: 无可用目标锚点')

    try {
      // Isolated read-only snapshot + LLM judge. No typecheck/test/lint are run.
      const summary = await withReadonlySnapshot(deps.projectDir, async snapshotPath => {
        const task = buildJudgeTask(goal, snapshotPath)
        return runJudge(deps, task, signal, snapshotPath)
      })

      if (!summary) return passOpen('verify skipped: judge 未返回可用结果（超时/失败/取消）')
      const verdict = parseVerdict(summary)
      if (!verdict) return passOpen('verify skipped: 无法解析 judge 裁决 JSON')
      return verdict
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return passOpen(`verify skipped: gate 内部错误 — ${msg}`)
    }
  }
}
