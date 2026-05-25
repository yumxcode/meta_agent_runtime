export type TeamPlannerIntent =
  | 'status'
  | 'start_work'
  | 'continue_work'
  | 'finish_work'
  | 'handoff'
  | 'resolve_conflict'
  | 'onboarding'
  | 'sync'
  | 'none'

export type TeamPlannerActionType =
  | 'show_status'
  | 'show_onboarding'
  | 'claim_task'
  | 'create_branch'
  | 'mark_task_status'
  | 'create_handoff'
  | 'create_pr_draft'
  | 'sync_github_issues'
  | 'sync_team'
  | 'pull_team'

export interface TeamPlannerAction {
  type: TeamPlannerActionType
  taskId?: string
  status?: string
  note?: string
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
  conflicts: unknown
  onboarding: unknown
  events: unknown[]
}

export const TEAM_PLANNER_SYSTEM = `你是 meta-agent robot mode 的 TeamPlanner。

你只负责在用户已经显式进入 /team 引导模式后，根据 team board、模块边界、当前 unit、工作区冲突和用户自然语言意图，规划协作动作。

硬规则：
1. 只输出 JSON，不要输出 markdown，不要解释 JSON 外的文本。
2. 不要发明不存在的 taskId。只有 snapshot.state.tasks 里存在的任务才能 claim、branch、done、handoff、pr。
3. 涉及写入共享 team 文件、切分支、push/pull、GitHub、任务状态变更、handoff 的动作必须 requiresConfirmation=true，除非用户刚才明确说“继续/确认/执行”并且上下文已经给出同一动作。
4. 读取状态、展示 onboarding、展示建议可以 requiresConfirmation=false。
5. 如果用户只是提出普通开发需求，给出 team 协作建议后 continueToAgent=true，让主 agent 继续工作。
6. 如果用户的意图主要是 team 操作（例如“接个任务”“任务完成了”“帮我交接”“看看团队状态”），continueToAgent=false。
7. 如果冲突里存在 error，risk 必须是 blocked，不要建议直接修改；应该建议协调、换任务或交接。
8. 输出应简短，面向工程协作，不要要求用户记忆底层 /team xxx 命令。

JSON schema:
{
  "intent": "status|start_work|continue_work|finish_work|handoff|resolve_conflict|onboarding|sync|none",
  "risk": "safe|needs_confirmation|blocked",
  "summary": "一句话概括判断",
  "guidance": "给用户的简短中文引导",
  "actions": [
    {
      "type": "show_status|show_onboarding|claim_task|create_branch|mark_task_status|create_handoff|create_pr_draft|sync_github_issues|sync_team|pull_team",
      "taskId": "TASK-001",
      "status": "done|review|blocked|in_progress|claimed|handoff",
      "note": "可选交接说明",
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
    const actions = rawActions.length > 0
      ? rawActions
          .filter((a): a is Record<string, unknown> => Boolean(a) && typeof a === 'object')
          .map(a => ({
            type: String(a.type ?? 'show_status') as TeamPlannerActionType,
            taskId: typeof a.taskId === 'string' ? a.taskId : undefined,
            status: typeof a.status === 'string' ? a.status : undefined,
            note: typeof a.note === 'string' ? a.note : undefined,
            reason: typeof a.reason === 'string' ? a.reason : '',
            requiresConfirmation: Boolean(a.requiresConfirmation),
          }))
      : []
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
