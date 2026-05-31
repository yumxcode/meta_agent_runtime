/**
 * TeamPlanner (v2.0) — turns user intent into a structured plan over the
 * minimal team-mode action set.  Output is strict JSON; the CLI executor
 * dispatches each action with confirmation when requested.
 */

export type TeamPlannerIntent =
  | 'status'
  | 'start_work'
  | 'continue_work'
  | 'finish_work'
  | 'record_attempt'
  | 'release'
  | 'steal'
  | 'sync'
  | 'none'

export type TeamPlannerActionType =
  | 'show_board'
  | 'take_task'
  | 'add_note'
  | 'drop_task'
  | 'mark_done'
  | 'mark_paused'
  | 'steal_task'
  | 'sync_team'
  | 'pull_team'

export interface TeamPlannerAction {
  type: TeamPlannerActionType
  taskId?: string
  /** For add_note. */
  direction?: string
  /** For add_note. */
  outcome?: string
  /** For add_note (optional). */
  ref?: string
  /** For steal_task (optional human-readable reason). */
  reason: string
  requiresConfirmation: boolean
}

export interface TeamPlannerPlan {
  intent: TeamPlannerIntent
  risk: 'safe' | 'needs_confirmation' | 'blocked'
  summary: string
  guidance: string
  actions: TeamPlannerAction[]
  continueToAgent: boolean
}

export interface TeamPlannerSnapshot {
  state: unknown
  recentAttempts: unknown[]
  events: unknown[]
}

export const TEAM_PLANNER_SYSTEM = `你是 meta-agent robot mode 的 TeamPlanner（v2.0 协作日志模型）。

模型只有三类对象：unit / task / attempt。task 有 owner（排他），attempts[] 是 append-only 的方向+结果记录。

你的工作：在用户进入 /team 或自然描述协作意图时，给出一段简短中文建议，并附 0 到 N 个机器可执行动作。

硬规则：
1. 只输出 JSON，不要 markdown、不要 JSON 外文本。
2. 不要发明不存在的 taskId。
3. 任何会修改 team.json 的动作（take_task/add_note/drop_task/mark_done/mark_paused/steal_task/sync_team/pull_team）默认 requiresConfirmation=true。仅 show_board 可 false。
4. steal_task 只有在 task.ownerUnit 是他人时才允许。reason 必填。
5. add_note 必须指定 taskId、direction、outcome；ref 可选。只对自己持有的 task 提议 note。
6. 若用户意图是普通开发推进而不是 team 协作，continueToAgent=true、actions=[]，让主 agent 继续。
7. 若用户意图是 team 协作（看 board、领、记录、释放、完成），continueToAgent=false。
8. 简短，面向工程协作。

JSON schema:
{
  "intent": "status|start_work|continue_work|finish_work|record_attempt|release|steal|sync|none",
  "risk": "safe|needs_confirmation|blocked",
  "summary": "一句话概括判断",
  "guidance": "给用户的简短中文引导",
  "actions": [
    {
      "type": "show_board|take_task|add_note|drop_task|mark_done|mark_paused|steal_task|sync_team|pull_team",
      "taskId": "TASK-001",
      "direction": "试用 ResNet50 替换 backbone",
      "outcome": "失败：sim +0.3%，real -2%",
      "ref": "wandb.ai/.../run-3f2",
      "reason": "为什么要做",
      "requiresConfirmation": true
    }
  ],
  "continueToAgent": true
}`

export function buildTeamPlannerUserMessage(input: string, snapshot: TeamPlannerSnapshot): string {
  return [
    `用户输入:\n${input}`,
    '',
    'Team snapshot JSON:',
    JSON.stringify(snapshot, null, 2).slice(0, 18_000),
  ].join('\n')
}

export function parseTeamPlannerPlan(text: string): TeamPlannerPlan | null {
  const raw = extractJsonObject(text)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<TeamPlannerPlan>
    if (!parsed || typeof parsed !== 'object') return null
    const rawActions: unknown[] = Array.isArray(parsed.actions) ? parsed.actions as unknown[] : []
    const actions = rawActions
      .filter((a): a is Record<string, unknown> => Boolean(a) && typeof a === 'object')
      .map(a => ({
        type: String(a.type ?? 'show_board') as TeamPlannerActionType,
        taskId:    typeof a.taskId === 'string' ? a.taskId : undefined,
        direction: typeof a.direction === 'string' ? a.direction : undefined,
        outcome:   typeof a.outcome === 'string' ? a.outcome : undefined,
        ref:       typeof a.ref === 'string' ? a.ref : undefined,
        reason:    typeof a.reason === 'string' ? a.reason : '',
        requiresConfirmation: Boolean(a.requiresConfirmation),
      }))
    return {
      intent: String(parsed.intent ?? 'none') as TeamPlannerIntent,
      risk: parsed.risk === 'blocked' || parsed.risk === 'needs_confirmation' ? parsed.risk : 'safe',
      summary: typeof parsed.summary === 'string' ? parsed.summary : '',
      guidance: typeof parsed.guidance === 'string' ? parsed.guidance : '',
      actions,
      continueToAgent: parsed.continueToAgent !== false,
    }
  } catch {
    return null
  }
}

function extractJsonObject(text: string): string | null {
  const trimmed = text.trim()
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  return trimmed.slice(start, end + 1)
}
