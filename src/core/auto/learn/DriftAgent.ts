/**
 * DriftAgent — the auto-mode drift/reflection gate implementation.
 *
 * `makeAutoDriftGate` returns a DriftGateFn (kernel contract) that, at a
 * structural boundary, spawns an independent agent to:
 *   1. judge whether the run has wandered off the ORIGINAL goal, comparing the
 *      pure goal against the durable checkpoint (NOT the executor's narrative),
 *      and
 *   2. persist any well-grounded lesson via `experience_write`.
 *
 * Why goal + checkpoint (not full context): the checkpoint is a compressed,
 * durable state record (done / pending / artifacts). Judging drift from it keeps
 * the agent independent of the executor's framing and cheap. This is why the
 * checkpoint writer had to be fixed first — drift is only as good as the record.
 *
 * Experience-write discipline: the strict "only record a lesson with a clear
 * error source" rule is a SOFT constraint carried by the rubric (per design),
 * reinforced by the tool requiring an `error_source` argument. The drift agent
 * abstracts grounded failures into reusable principles; it must not invent
 * lessons from thin air.
 *
 * Fail-open: any internal failure resolves to `{ drifted: false, corrective: [] }`.
 */
import type { ISubAgentDispatcher } from '../../../subagent/ISubAgentDispatcher.js'
import { TERMINAL_STATUSES } from '../../../subagent/types.js'
import type { DriftGateFn, DriftVerdict } from '../../../kernel/loop/DriftGate.js'
import { readAutoCheckpoint } from '../AutoCheckpointStore.js'
import { createAutoExperienceStore, renderRecentExperiences } from './AutoExperienceStore.js'

export interface AutoDriftGateDeps {
  /** Spawns the isolated drift sub-agent. */
  dispatcher: ISubAgentDispatcher
  /** Workspace / jail root. */
  projectDir: string
  /** Lazily reads the pure frozen goal (SessionRouter._autoGoal). */
  getGoal: () => string | null
}

/** Read-only investigation tools + the direct experience writer. */
const DRIFT_TOOLS = ['read_file', 'grep', 'glob', 'bash', 'experience_write']

const DRIFT_RUBRIC = `\
你是一个独立的"航向审查 + 经验沉淀 Agent"，在一次长时间无人值守任务的中途被触发。你看不到执行 Agent 的推理过程，只拿到【原始目标】、【进度快照(checkpoint)】和【既有经验】。

你的两个职责：

A. 判断是否偏离目标
- 对照原始目标与进度快照，判断当前推进方向是否仍然正确。
- 可用只读工具（read_file/grep/glob/bash）到工作区核对实际状态，但**不要修改任何文件**。
- "偏离"指：在做与目标无关的事、纠缠于次要细节、朝错误方案越走越远、或快照显示的已完成项与目标南辕北辙。正常的中途状态不算偏离。

B. 沉淀经验（严格）
- 只有当你掌握**确凿证据**时，才调用 experience_write 写入一条经验。
- 调用时**必须在 error_source 注明来源**：严重偏离目标的具体表现、verify 拒绝项、或明确的执行失败/退出码。
- 没有确凿来源就**不要写**——宁可不写，也不要凭猜测污染经验库。优先沉淀"失败教训"。

输出（关键）：在最后一条消息里只输出一个 JSON 代码块：
\`\`\`json
{
  "drifted": true 或 false,
  "severity": "minor" 或 "major",
  "corrective": ["若偏离，给出具体纠偏步骤", "..."],
  "note": "简述判断依据"
}
\`\`\`
drifted=false 时 corrective 必须为空数组。experience 通过工具写入，不要放进这个 JSON。`

function buildDriftTask(goal: string, checkpointJson: string, experienceBlock: string | null): string {
  return [
    '【原始目标】',
    goal,
    '',
    '【进度快照 checkpoint】',
    checkpointJson,
    '',
    '【既有经验】',
    experienceBlock ?? '（暂无）',
    '',
    '现在开始审查：先判断是否偏离目标，再决定是否有确凿经验值得写入，最后只输出 JSON 裁决。',
  ].join('\n')
}

/** Extract the last JSON drift verdict from the agent's summary text. */
export function parseDriftVerdict(text: string): DriftVerdict | null {
  if (!text) return null
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map(m => m[1] ?? '')
  const candidates = fences.length ? [...fences] : []
  const lastBrace = text.lastIndexOf('{')
  if (lastBrace !== -1) candidates.push(text.slice(lastBrace))

  for (let i = candidates.length - 1; i >= 0; i--) {
    const raw = candidates[i]?.trim()
    if (!raw) continue
    try {
      const obj = JSON.parse(raw) as Partial<DriftVerdict>
      if (typeof obj.drifted !== 'boolean') continue
      return {
        drifted: obj.drifted,
        severity: obj.severity === 'major' ? 'major' : obj.severity === 'minor' ? 'minor' : undefined,
        corrective: Array.isArray(obj.corrective) ? obj.corrective.map(String) : [],
        note: typeof obj.note === 'string' ? obj.note : undefined,
      }
    } catch {
      // try next candidate
    }
  }
  return null
}

/** Spawn the drift agent and block until terminal; return its summary text. */
async function runDriftAgent(
  dispatcher: ISubAgentDispatcher,
  taskDescription: string,
  signal: AbortSignal,
): Promise<string | null> {
  const rec = await dispatcher.spawnSubAgent({
    config: {
      taskDescription,
      systemPrompt: DRIFT_RUBRIC,
      allowedTools: DRIFT_TOOLS,
      maxTurns: 10,
      maxBudgetUsd: 0.3,
      requireHumanApproval: false,
      useEventDriven: false,
      pollIntervalMs: 500,
      checkpointEveryNTurns: 0,
      // Reserved side lane (see VerifyJudge): never starved by research/worker
      // sub-agents that share the bridge, nor blocked by the shared budget cap.
      internal: true,
      workspaceMode: 'shared_readonly',
    },
    abortSignal: signal,
  })

  const POLL_MS = 500
  const MAX_WAIT_MS = 10 * 2 * 60 * 1000
  const deadline = Date.now() + MAX_WAIT_MS
  let latest = rec
  while (!TERMINAL_STATUSES.has(latest.status)) {
    if (signal.aborted || Date.now() > deadline) break
    await new Promise(r => setTimeout(r, POLL_MS))
    const polled = await dispatcher.getStatus(rec.taskId)
    if (!polled) break
    latest = polled
  }
  if (latest.status !== 'completed') return null
  return latest.result?.summary ?? null
}

/** Build the drift gate for an auto session. Always resolves (fail-open). */
export function makeAutoDriftGate(deps: AutoDriftGateDeps): DriftGateFn {
  const store = createAutoExperienceStore(deps.projectDir)
  return async ({ signal }) => {
    // A fail-open SKIP (the agent could not run): unlike a genuine parsed
    // "drifted:false" verdict (agent ran, judged the run on course), this is
    // surfaced as a warning by the loop, so a healthy on-course run stays quiet.
    const skip = (): DriftVerdict => ({ drifted: false, corrective: [], skipped: true })

    const goal = deps.getGoal()
    if (!goal || !goal.trim()) return skip()

    try {
      const cp = readAutoCheckpoint(deps.projectDir)
      if (!cp) return skip()
      // Only feed the fields drift needs — keep it compact and goal-focused.
      const checkpointJson = JSON.stringify(
        {
          completedSteps: cp.completedSteps ?? [],
          pendingTodos: cp.pendingTodos ?? [],
          artifacts: cp.artifacts ?? [],
          turnCount: cp.turnCount,
          note: cp.note,
        },
        null,
        2,
      )

      const experienceBlock = await renderRecentExperiences(store)
      const task = buildDriftTask(goal, checkpointJson, experienceBlock)
      const summary = await runDriftAgent(deps.dispatcher, task, signal)
      if (!summary) return skip()
      return parseDriftVerdict(summary) ?? skip()
    } catch {
      return skip()
    }
  }
}
