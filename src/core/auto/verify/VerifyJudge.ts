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
 *                       tools (read_file/grep/glob[/bash]) and must cite evidence
 *                       for every "done" claim — no rubber-stamping.
 *   • Safe isolation  — it inspects a throwaway git snapshot of the current
 *                       state, so its bash can't corrupt real source.
 *   • Fail-open       — any internal failure resolves to done:true (+ note) so a
 *                       broken verifier can never wedge a finished run.
 */
import type { ISubAgentDispatcher } from '../../../subagent/ISubAgentDispatcher.js'
import { TERMINAL_STATUSES } from '../../../subagent/types.js'
import type { VerifyGateFn, VerifyVerdict } from '../../../kernel/loop/VerifyGate.js'
import { withReadonlySnapshot, THIS_ROUND_DIFF_FILE, type SnapshotDiff } from './JudgeSnapshot.js'

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

// ── Judge budget (env-overridable) ────────────────────────────────────────────
// Defaults are sized for multi-file deliverables: a judge that must read across
// backend + frontend + infra + docs needs far more than a handful of turns to
// gather evidence AND emit its verdict. All three are overridable at runtime via
// environment variables (read on every gate invocation, so no restart-coupling
// beyond setting the variable), keeping the knobs out of code.
export const VERIFY_JUDGE_DEFAULTS = {
  /** Max tool-batch turns before the judge is force-stopped. */
  maxTurns: 30,
  /**
   * Max spend (USD) before the judge is force-stopped. Left unbounded for now;
   * pin to a concrete cap before real deployment (or via
   * META_AGENT_VERIFY_MAX_BUDGET_USD).
   */
  maxBudgetUsd: Number.POSITIVE_INFINITY,
  /** Wall-clock cap (ms) for a single judge run. */
  maxDurationMs: 600_000,
} as const

function verifyEnvInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function verifyEnvFloat(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const n = Number.parseFloat(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/**
 * Resolve the judge's circuit-breaker limits, applying env-var overrides over
 * the defaults. Read per-invocation so config can change without a code change.
 *
 *   META_AGENT_VERIFY_MAX_TURNS        (int,   default 30)
 *   META_AGENT_VERIFY_MAX_BUDGET_USD   (float, default unbounded)
 *   META_AGENT_VERIFY_MAX_DURATION_MS  (int,   default 600000)
 */
export function resolveJudgeLimits(): { maxTurns: number; maxBudgetUsd: number; maxDurationMs: number } {
  return {
    maxTurns:      verifyEnvInt('META_AGENT_VERIFY_MAX_TURNS', VERIFY_JUDGE_DEFAULTS.maxTurns, 1, 10_000),
    maxBudgetUsd:  verifyEnvFloat('META_AGENT_VERIFY_MAX_BUDGET_USD', VERIFY_JUDGE_DEFAULTS.maxBudgetUsd, 0.01, 1_000_000),
    maxDurationMs: verifyEnvInt('META_AGENT_VERIFY_MAX_DURATION_MS', VERIFY_JUDGE_DEFAULTS.maxDurationMs, 10_000, 3_600_000),
  }
}

/**
 * Build the judge's system prompt (rubric). The tool line is generated from the
 * ACTUAL granted tools so the rubric never promises a tool the judge wasn't
 * given (e.g. bash is dropped on the live-tree path) — a mismatch the judge
 * would otherwise waste turns on by attempting unavailable commands.
 */
export function buildJudgeRubric(allowedTools: readonly string[]): string {
  const toolList = allowedTools.join(' / ')
  const hasBash = allowedTools.includes('bash')
  const toolLine = hasBash
    ? `1. 你只有只读工具（${toolList}）。**不要修改任何文件**；bash 仅用于查看（cat/ls/grep 等），git 命令必须带 -C 指向快照目录（如 \`git -C <快照路径> diff <基线> HEAD\`，cwd 已默认在快照内）。本轮改动已为你预先生成：优先用 read_file 读取快照内的 ${THIS_ROUND_DIFF_FILE}，无需自己跑 git diff。`
    : `1. 你只有只读工具（${toolList}）——**没有 bash/shell**。**不要修改任何文件**；用 grep（content 模式，返回匹配行）和 glob 检索，用 read_file 读取具体文件。`
  return `\
你是一个独立的"完成度审核 Agent"。你处在一个隔离上下文中：你**没有**看到执行 Agent 的推理过程或它自称做了什么，这是刻意为之——你的判断必须独立。

你的唯一职责：判断【原始目标】是否已经被真正满足。

工作方式（强制）：
${toolLine}
2. 必须亲自到工作区取证来对照目标——不要凭空判断，也不要轻信任何"已完成"的说法。
3. verify 不运行 typecheck/test/lint；你必须仅基于原始目标和亲自读取到的代码/产物作出 LLM 审核判断。
4. 对每一条判断都要给出具体证据（文件:行号，或只读命令输出）。给不出证据的"完成"不成立。
5. 预算有限：一旦接近轮次/预算上限，立即输出 JSON 裁决（哪怕 done:false，并在 unfinished/note 里写明还没核到的部分），切勿在没有裁决的情况下耗尽预算。

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
}

/** Build the judge's task: pure goal + where to inspect + pre-computed round diff. */
function buildJudgeTask(goal: string, snapshotPath: string | null, diff: SnapshotDiff | null): string {
  const location = snapshotPath
    ? `待审核的代码位于这个只读快照目录（请只在此目录内取证）：\n  ${snapshotPath}`
    : `（无法创建 git 快照，请直接在工作区只读查证，切勿修改任何文件。）`
  const lines = [
    '【原始目标】',
    goal,
    '',
    '【取证位置】',
    location,
  ]
  // Pre-computed delta so the judge sees "what changed this round" with zero
  // tool calls — critical for incremental goals ("继续开发并给出进展") where the
  // round delta, not just the end state, is the thing under review.
  if (diff && diff.stat.trim()) {
    lines.push(
      '',
      '【本轮改动（已为你预先生成，无需自己跑 git）】',
      '以下为本轮相对上一轮基线的改动摘要（git diff --stat）；' +
        `完整 patch 见快照内 ${THIS_ROUND_DIFF_FILE}（用 read_file 读取）` +
        (diff.truncated ? '，注意该 patch 已截断，超出部分请直接读改动文件。' : '。'),
      '',
      diff.stat.trim(),
    )
  } else if (diff) {
    lines.push(
      '',
      '【本轮改动】',
      '本轮相对上一轮基线没有任何文件改动（git diff 为空）——若目标要求有产出/改动，这本身即是重要证据。',
    )
  }
  lines.push(
    '',
    '现在开始查证，并按要求只在最后输出 JSON 裁决。',
  )
  return lines.join('\n')
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
  const allowedTools = snapshotPath ? JUDGE_TOOLS : JUDGE_TOOLS_READONLY
  const limits = resolveJudgeLimits()
  const rec = await deps.dispatcher.spawnSubAgent({
    config: {
      taskDescription,
      // Rubric is generated from the ACTUAL granted tools so it never promises
      // bash on the live-tree path where bash is dropped.
      systemPrompt: buildJudgeRubric(allowedTools),
      // With a snapshot, bash writes are confined to the throwaway worktree; on
      // the live tree (no snapshot) bash is dropped to remove the write vector.
      allowedTools,
      maxTurns: limits.maxTurns,
      maxBudgetUsd: limits.maxBudgetUsd,
      maxDurationMs: limits.maxDurationMs,
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

  // Poll to terminal. Bounded so a stuck judge can't hang the gate forever — the
  // ceiling outlasts the judge's own wall-clock cap so we always observe its
  // terminal state rather than giving up early.
  const POLL_MS = 500
  const MAX_WAIT_MS = limits.maxDurationMs + 60_000
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
 * Build the verify gate for an auto session. Returns skipped verdicts when it
 * cannot reach a real verdict; KernelLoop applies the auto gate-failure policy.
 */
export function makeAutoVerifyGate(deps: AutoVerifyGateDeps): VerifyGateFn {
  return async ({ signal }) => {
    const passOpen = (note: string): VerifyVerdict =>
      ({ done: true, unfinished: [], evidence: [], note, skipped: true })

    const goal = deps.getGoal()
    if (!goal || !goal.trim()) return passOpen('verify skipped: 无可用目标锚点')

    try {
      // Isolated read-only snapshot + LLM judge. No typecheck/test/lint are run.
      const summary = await withReadonlySnapshot(deps.projectDir, async (snapshotPath, diff) => {
        const task = buildJudgeTask(goal, snapshotPath, diff)
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
