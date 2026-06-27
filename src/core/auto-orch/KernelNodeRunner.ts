/**
 * KernelNodeRunner — the live execution half of (C).
 *
 * Implements `NodeRunner` by spawning a real kernel sub-agent per graph node via
 * `ISubAgentDispatcher` (the same dispatcher the drift/verify gates use). It is
 * the drop-in replacement for the test stub:
 *
 *   • executor node → a working sub-agent (the node's tools / isolation). Its
 *     terminal outcome becomes a branch verdict ('ok' | 'error') so the graph
 *     can route on success/failure.
 *   • role node     → a READ-ONLY reviewing sub-agent that must emit a small JSON
 *     verdict ({label:'pass'|'fail', messages?, note?}); 'pass' → done, 'fail' →
 *     branch('fail') carrying the corrective messages. verify/drift/reviewer all
 *     share this shape (the specific criteria live in the node's taskDescription,
 *     authored by the Planner).
 *
 * Cost is reported via the verdict's `data.costUsd` so PlanRunner can enforce the
 * plan's cost bound. Every failure path resolves to a verdict (never throws); the
 * PlanRunner treats a thrown runner as 'failed', so we keep that contract clean.
 */
import type { ISubAgentDispatcher } from '../../subagent/ISubAgentDispatcher.js'
import { TERMINAL_STATUSES, type SubAgentRecord, type SubAgentConfig } from '../../subagent/types.js'
import type { NodeRunner, PlanRunContext } from './PlanRunner.js'
import type { OrchNode } from './LoopIR.js'
import type { OrchVerdict } from './Verdict.js'

export interface KernelNodeRunnerOptions {
  /** Max wall-clock to wait for a single node's sub-agent. Default 24 min. */
  maxWaitMsPerNode?: number
  /** Poll cadence while waiting. Default 500 ms. */
  pollMs?: number
}

/** Read-only toolset for reviewing role nodes (no write vector). */
const ROLE_TOOLS_READONLY = ['read_file', 'grep', 'glob']

/** Wrap a role node's criteria with the verdict-output contract. */
function roleSystemPrompt(role: string, criteria: string): string {
  return [
    `你是一个独立的"${role}"审查 Agent，在一次自主编排任务中被触发。`,
    '你看不到执行 Agent 的推理过程，只能用只读工具（read_file/grep/glob）核对工作区实际状态。',
    '不要修改任何文件。对每个判断都要有证据。',
    '',
    '【审查标准】',
    criteria,
    '',
    '输出（关键）：只在最后一条消息里输出一个 JSON 代码块：',
    '```json',
    '{ "label": "pass" 或 "fail", "messages": ["若 fail，给出具体未达成项/纠偏步骤"], "note": "判断依据" }',
    '```',
    'pass 时 messages 为空数组。',
  ].join('\n')
}

/** Parse a role agent's pass/fail verdict JSON from its summary text. */
export function parseRoleVerdict(text: string): { label: 'pass' | 'fail'; messages: string[]; note?: string } | null {
  if (!text) return null
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map(m => m[1] ?? '')
  const candidates: string[] = fences.length ? [...fences] : []
  const lastBrace = text.lastIndexOf('{')
  if (lastBrace !== -1) candidates.push(text.slice(lastBrace))

  for (let i = candidates.length - 1; i >= 0; i--) {
    const raw = candidates[i]?.trim()
    if (!raw) continue
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>
      if (obj['label'] !== 'pass' && obj['label'] !== 'fail') continue
      return {
        label: obj['label'],
        messages: Array.isArray(obj['messages']) ? (obj['messages'] as unknown[]).map(String) : [],
        note: typeof obj['note'] === 'string' ? obj['note'] : undefined,
      }
    } catch {
      // next candidate
    }
  }
  return null
}

export class KernelNodeRunner implements NodeRunner {
  private readonly maxWaitMs: number
  private readonly pollMs: number

  constructor(
    private readonly dispatcher: ISubAgentDispatcher,
    opts?: KernelNodeRunnerOptions,
  ) {
    this.maxWaitMs = opts?.maxWaitMsPerNode ?? 24 * 60 * 1000
    this.pollMs = opts?.pollMs ?? 500
  }

  async run(node: OrchNode, ctx: PlanRunContext): Promise<OrchVerdict> {
    try {
      return node.kind === 'role'
        ? await this.runRole(node, ctx.signal)
        : await this.runExecutor(node, ctx.signal)
    } catch (err) {
      // Defensive: surface as a routable error verdict rather than throwing, so a
      // single flaky node doesn't abort the whole plan via PlanRunner's catch.
      return { action: 'branch', label: 'error', note: (err as Error).message }
    }
  }

  private async runExecutor(node: OrchNode, signal: AbortSignal): Promise<OrchVerdict> {
    const rec = await this.spawnAndWait(
      {
        taskDescription: node.taskDescription,
        systemPrompt: node.systemPrompt,
        allowedTools: node.allowedTools ?? [],
        maxTurns: node.maxTurns ?? 12,
        maxBudgetUsd: node.maxBudgetUsd ?? 0.5,
        requireHumanApproval: false,
        useEventDriven: false,
        pollIntervalMs: this.pollMs,
        checkpointEveryNTurns: 0,
        // Writers MUST be isolated (validatePlan enforces this); default readonly.
        workspaceMode: node.workspaceMode ?? 'shared_readonly',
      },
      signal,
    )
    const cost = rec?.result?.costUsd ?? 0
    if (rec?.status === 'completed' && rec.result?.success) {
      return { action: 'branch', label: 'ok', note: truncate(rec.result.summary), data: { costUsd: cost } }
    }
    return {
      action: 'branch',
      label: 'error',
      note: rec?.result?.error ?? `executor ${node.id} did not complete (${rec?.status ?? 'no record'})`,
      data: { costUsd: cost },
    }
  }

  private async runRole(node: OrchNode, signal: AbortSignal): Promise<OrchVerdict> {
    const role = node.role ?? 'reviewer'
    const rec = await this.spawnAndWait(
      {
        taskDescription: node.taskDescription,
        systemPrompt: roleSystemPrompt(role, node.taskDescription),
        allowedTools: node.allowedTools ?? ROLE_TOOLS_READONLY,
        maxTurns: node.maxTurns ?? 10,
        maxBudgetUsd: node.maxBudgetUsd ?? 0.3,
        requireHumanApproval: false,
        useEventDriven: false,
        pollIntervalMs: this.pollMs,
        checkpointEveryNTurns: 0,
        // Reviewers never write — keep them on the shared read-only lane.
        workspaceMode: 'shared_readonly',
      },
      signal,
    )
    const cost = rec?.result?.costUsd ?? 0
    if (rec?.status !== 'completed' || !rec.result?.summary) {
      // Fail-open: an unrunnable reviewer must not wedge the graph. Treat as a
      // skipped 'pass' so the run can proceed (the host can observe `skipped`).
      return { action: 'done', label: 'pass', skipped: true, note: `${role} unavailable`, data: { costUsd: cost } }
    }
    const verdict = parseRoleVerdict(rec.result.summary)
    if (!verdict) {
      return { action: 'done', label: 'pass', skipped: true, note: `${role} returned an unparsable verdict`, data: { costUsd: cost } }
    }
    if (verdict.label === 'pass') {
      return { action: 'done', label: 'pass', note: verdict.note, data: { costUsd: cost } }
    }
    return {
      action: 'branch',
      label: 'fail',
      messages: verdict.messages,
      note: verdict.note,
      data: { costUsd: cost },
    }
  }

  /** Spawn a sub-agent and poll until terminal (or abort/timeout). */
  private async spawnAndWait(
    config: Partial<SubAgentConfig> & Pick<SubAgentConfig, 'taskDescription'>,
    signal: AbortSignal,
  ): Promise<SubAgentRecord | null> {
    const rec = await this.dispatcher.spawnSubAgent({ config, abortSignal: signal })
    const deadline = Date.now() + this.maxWaitMs
    let latest = rec
    while (!TERMINAL_STATUSES.has(latest.status)) {
      if (signal.aborted || Date.now() > deadline) break
      await new Promise(r => setTimeout(r, this.pollMs))
      const polled = await this.dispatcher.getStatus(rec.taskId)
      if (!polled) break
      latest = polled
    }
    return TERMINAL_STATUSES.has(latest.status) ? latest : null
  }
}

function truncate(s: string, n = 500): string {
  return s.length > n ? s.slice(0, n) + '…' : s
}
