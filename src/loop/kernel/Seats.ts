/**
 * Seats — the LLM slots of a loop round (spec C7 seats; D5/D6).
 *
 * worker  — does the intelligent work. Task = capsule + charter prompt +
 *           output contract (drafts + return_result). Lineage is per ROUND:
 *           a corrective retry carries the previous attempt's summary and the
 *           gate's messages; a new round starts a blank session.
 * judge   — isolated verdict. Its task embeds the EVIDENCE FILE CONTENTS
 *           inline (size-capped) and grants no tools: independence is a
 *           property of its inputs, not an instruction. It cannot wander into
 *           the worker's transcript because there is no channel to it.
 * pivoter — isolated, low-frequency; produces a structural directive the
 *           kernel injects into the same round's capsule.
 */
import { readFile } from 'fs/promises'
import { join } from 'path'
import type { ISubAgentDispatcher } from '../../subagent/ISubAgentDispatcher.js'
import { spawnAndWait, type SpawnWaitOptions } from '../seatSpawn.js'
import type { FrozenCharter, SeatSpec } from '../charter/CharterTypes.js'
import type { InstancePaths } from '../types.js'
import type { Capsule } from '../capsule/CapsuleBuilder.js'
import { renderCapsule } from '../capsule/CapsuleBuilder.js'

const EVIDENCE_CAP_CHARS = 6_000
const DEFAULT_WORKER_TOOLS = ['read_file', 'edit_file', 'write_file', 'grep', 'glob', 'bash']

export interface SeatResult {
  ok: boolean
  summary: string
  /** Structured payload from return_result (authoritative). */
  data: Record<string, unknown>
  costUsd: number
}

export interface SeatRunnerDeps {
  dispatcher: ISubAgentDispatcher
  /** Workspace the worker operates on (taskDir, NOT the instance dir). */
  projectDir: string
  signal: AbortSignal
  spawnOpts?: SpawnWaitOptions
}

const WORKER_CONTRACT = `\
【产出契约（硬性）】
1. 选定本轮方向后，先写 drafts/direction.json：{"key":"<方向短标识>","rationale":"一句话"}。
2. 完成工作后，把结构化 findings 草稿写入 drafts/findings_draft.json（数组，每条含 claim 与 evidence 字段）。
3. 最后必须调用 return_result，data 写 {"label":"ok"|"error","note":"一句话"}。
【路径硬性约定】跨轮共享状态只写 drafts/ 下的草稿——入账由内核完成，你无权直接改 ledger/ 下任何文件；禁止写 .meta-agent/ 下任何路径。`

export async function runWorkerSeat(
  deps: SeatRunnerDeps,
  charter: FrozenCharter,
  paths: InstancePaths,
  capsule: Capsule,
  correctivePreface?: string,
): Promise<SeatResult> {
  const seat = charter.seats.worker
  const scopeNote = charter.writeScope?.length
    ? `【写入范围】除 drafts/ 外，仅允许修改：${charter.writeScope.join(', ')}`
    : ''
  const task = [
    correctivePreface ?? '',
    renderCapsule(capsule),
    seat.prompt,
    scopeNote,
    `【草稿目录】${join(paths.draftsDir)}`,
    WORKER_CONTRACT,
  ].filter(Boolean).join('\n\n')
  // D7 made structural (T4.2): the ledger and instance internals are DENIED at
  // the sandbox level for the worker's bash — the prompt contract above is the
  // instruction, this is the guarantee. Drafts/inbox stay writable.
  const sandbox = {
    writeDenyPaths: [
      paths.ledgerDir,
      paths.frozenCharter,
      paths.instanceJson,
      paths.capsuleJson,
      paths.reportsDir,
    ],
  }
  return runSeat(deps, seat, task, DEFAULT_WORKER_TOOLS, sandbox)
}

const JUDGE_CONTRACT = `\
你是隔离评审座位：你看不到执行座位的任何推理过程，只能依据下方内嵌证据作出裁决。
必须调用 return_result，data 写：
{"verdict":"pass"|"fail","new_findings_count":<int>,"metric_delta":<number>,"metric":<number|null>,"messages":["若fail给出具体纠偏项"]}
每个判断都要引用证据；无证据支撑的 finding 一律不计入 new_findings_count。`

export async function runJudgeSeat(
  deps: SeatRunnerDeps,
  charter: FrozenCharter,
  paths: InstancePaths,
  evidencePaths: string[],
): Promise<SeatResult> {
  const seat = charter.seats.judge
  if (!seat) throw new Error('charter has no judge seat')
  const evidence = await inlineEvidence(paths, seat.inputs ?? evidencePaths)
  const task = [seat.prompt, JUDGE_CONTRACT, '【证据（内嵌，只此为界）】', evidence].join('\n\n')
  // No tools: the judge's world is exactly the evidence block above.
  return runSeat(deps, seat, task, [])
}

const PIVOTER_CONTRACT = `\
你是结构性转向座位。不要做参数微调建议——给出改变结构性约束/研究框架的新方向
（相反假设 / 换证据源 / 跨域类比 / 改评估指标）。
必须调用 return_result，data 写 {"directive":"<一段结构性转向指令>","key":"<新方向短标识>"}。`

export async function runPivoterSeat(
  deps: SeatRunnerDeps,
  charter: FrozenCharter,
  paths: InstancePaths,
  capsule: Capsule,
): Promise<SeatResult> {
  const seat = charter.seats.pivoter
  if (!seat) throw new Error('charter has no pivoter seat')
  const evidence = await inlineEvidence(paths, seat.inputs ?? [])
  const task = [renderCapsule(capsule), seat.prompt, PIVOTER_CONTRACT, '【证据（内嵌）】', evidence]
    .filter(Boolean).join('\n\n')
  return runSeat(deps, seat, task, [])
}

// ── shared spawn plumbing ─────────────────────────────────────────────────────

async function runSeat(
  deps: SeatRunnerDeps,
  seat: SeatSpec,
  taskDescription: string,
  defaultTools: string[],
  sandbox?: { writeDenyPaths?: string[] },
): Promise<SeatResult> {
  const rec = await spawnAndWait(
    deps.dispatcher,
    {
      taskDescription,
      allowedTools: seat.tools ?? defaultTools,
      maxTurns: seat.budgetPerRound?.turns ?? 30,
      maxBudgetUsd: seat.budgetPerRound?.usd ?? 2,
      requireHumanApproval: false,
      useEventDriven: false,
      pollIntervalMs: 500,
      checkpointEveryNTurns: 0,
      projectDir: deps.projectDir,
      ...(sandbox ? { sandbox } : {}),
    },
    deps.signal,
    deps.spawnOpts,
  )
  const result = rec?.result
  const data = extractData(result?.output, result?.summary)
  return {
    ok: rec?.status === 'completed' && result?.success === true && data['label'] !== 'error',
    summary: result?.summary ?? `seat did not complete (${rec?.status ?? 'no record'})`,
    data,
    costUsd: result?.costUsd ?? 0,
  }
}

/** Prefer structured return_result output; fall back to the last JSON block. */
function extractData(output: unknown, summary?: string): Record<string, unknown> {
  if (output && typeof output === 'object' && !Array.isArray(output)) {
    return output as Record<string, unknown>
  }
  if (typeof output === 'string') {
    const parsed = lastJsonBlock(output)
    if (parsed) return parsed
  }
  if (summary) {
    const parsed = lastJsonBlock(summary)
    if (parsed) return parsed
  }
  return {}
}

function lastJsonBlock(text: string): Record<string, unknown> | null {
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map(m => m[1] ?? '')
  const candidates = fences.length ? fences : [text]
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(candidates[i]!.trim()) as unknown
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj as Record<string, unknown>
    } catch { /* next */ }
  }
  return null
}

async function inlineEvidence(paths: InstancePaths, relPaths: string[]): Promise<string> {
  const sections: string[] = []
  for (const rel of relPaths) {
    const abs = join(paths.root, rel)
    try {
      const raw = await readFile(abs, 'utf-8')
      const capped = raw.length > EVIDENCE_CAP_CHARS ? raw.slice(-EVIDENCE_CAP_CHARS) : raw
      sections.push(`--- ${rel} ---\n${capped}`)
    } catch {
      sections.push(`--- ${rel} ---\n(不存在)`)
    }
  }
  return sections.join('\n\n') || '(无证据文件)'
}
