/**
 * reviewer.ts — shared sub-agent spawn/poll + the generic read-only "reviewer"
 * role handler.
 *
 * Extracted from KernelNodeRunner so BOTH the node runner and the RoleCatalog can
 * use it without importing each other (which would form a cycle). The generic
 * reviewer is the default role behaviour: spawn a read-only sub-agent that emits
 * a {label:'pass'|'fail', messages?} verdict, mapped onto the unified OrchVerdict.
 */
import type { ISubAgentDispatcher } from '../../subagent/ISubAgentDispatcher.js'
import { DEFAULT_SUB_AGENT_MAX_DURATION_MS, TERMINAL_STATUSES, type SubAgentRecord, type SubAgentConfig } from '../../subagent/types.js'
import type { OrchVerdict } from './Verdict.js'

/** Read-only toolset for reviewing role nodes (no write vector). */
export const ROLE_TOOLS_READONLY = ['read_file', 'grep', 'glob']

/** Wrap a role node's criteria with the verdict-output contract. */
export function roleSystemPrompt(role: string, criteria: string): string {
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
export function parseRoleVerdict(
  text: string,
): { label: 'pass' | 'fail'; messages: string[]; note?: string } | null {
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

export interface SpawnWaitOptions {
  pollMs?: number
  maxWaitMs?: number
}

/** Spawn a sub-agent and poll until terminal (or abort/timeout). */
export async function spawnAndWait(
  dispatcher: ISubAgentDispatcher,
  config: Partial<SubAgentConfig> & Pick<SubAgentConfig, 'taskDescription'>,
  signal: AbortSignal,
  opts?: SpawnWaitOptions,
): Promise<SubAgentRecord | null> {
  const pollMs = opts?.pollMs ?? 500
  const maxWaitMs = opts?.maxWaitMs ?? DEFAULT_SUB_AGENT_MAX_DURATION_MS + 60_000
  const rec = await dispatcher.spawnSubAgent({ config, abortSignal: signal })
  const deadline = Date.now() + maxWaitMs
  let latest = rec
  while (!TERMINAL_STATUSES.has(latest.status)) {
    if (signal.aborted || Date.now() > deadline) break
    await new Promise(r => setTimeout(r, pollMs))
    const polled = await dispatcher.getStatus(rec.taskId)
    if (!polled) break
    latest = polled
  }
  return TERMINAL_STATUSES.has(latest.status) ? latest : null
}

export interface ReviewerInput {
  role: string
  criteria: string
  allowedTools?: string[]
  maxTurns?: number
  maxBudgetUsd?: number
  signal: AbortSignal
  spawnOptions?: SpawnWaitOptions
}

/**
 * The generic read-only reviewer: spawn → parse pass/fail → unified verdict.
 * Fail-open: an unrunnable / unparsable reviewer becomes a skipped 'pass' so it
 * can never wedge the orchestration graph.
 */
export async function runReviewer(
  dispatcher: ISubAgentDispatcher,
  input: ReviewerInput,
): Promise<OrchVerdict> {
  const rec = await spawnAndWait(
    dispatcher,
    {
      taskDescription: input.criteria,
      systemPrompt: roleSystemPrompt(input.role, input.criteria),
      allowedTools: input.allowedTools ?? ROLE_TOOLS_READONLY,
      maxTurns: input.maxTurns ?? 10,
      maxBudgetUsd: input.maxBudgetUsd ?? 0.3,
      requireHumanApproval: false,
      useEventDriven: false,
      pollIntervalMs: input.spawnOptions?.pollMs ?? 500,
      checkpointEveryNTurns: 0,
      workspaceMode: 'shared_readonly',
    },
    input.signal,
    input.spawnOptions,
  )
  const cost = rec?.result?.costUsd ?? 0
  if (rec?.status !== 'completed' || !rec.result?.summary) {
    return { action: 'done', label: 'pass', skipped: true, note: `${input.role} unavailable`, data: { costUsd: cost, gateKind: input.role } }
  }
  const verdict = parseRoleVerdict(rec.result.summary)
  if (!verdict) {
    return { action: 'done', label: 'pass', skipped: true, note: `${input.role} returned an unparsable verdict`, data: { costUsd: cost, gateKind: input.role } }
  }
  if (verdict.label === 'pass') {
    return { action: 'done', label: 'pass', note: verdict.note, data: { costUsd: cost } }
  }
  return { action: 'branch', label: 'fail', messages: verdict.messages, note: verdict.note, data: { costUsd: cost } }
}
