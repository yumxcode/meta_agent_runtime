/**
 * Agent-facing team-mode tools — the "meta-agent half" of a unit.
 *
 * Permission model (decided with the team-mode owner):
 *   - team_note      → direct write. Recording an attempt on a task THIS unit
 *                      owns is low-risk, high-value — the agent has the
 *                      direction/outcome/ref in its context right when the
 *                      experiment finishes; humans rarely backfill it.
 *   - team_take      → flagged sensitive in the CLI guard (detectSensitiveOp)
 *   - team_mark_done → flagged sensitive in the CLI guard
 *     Both mutate what teammates see on the board, so a human confirms each.
 *   - steal is deliberately NOT exposed — conflict resolution stays human.
 *
 * All tools no-op with a clear error when team mode is not initialised, so
 * registering them unconditionally can never silently create a team/ dir.
 */

import type { MetaAgentTool, ToolResult } from '../../../core/types.js'
import type {
  TeamNoteInput,
  TeamState,
  TeamTask,
  TeamTaskStatus,
} from '../../team/TeamStore.js'
import type { TeamPublishState } from '../../team/TeamStore.js'

/**
 * The slice of RoboticsSession the team tools need. Methods mirror the
 * session's team*() wrappers so prompt-section invalidation and watcher
 * refresh keep happening on every mutation.
 */
export interface TeamToolsHost {
  teamExists(): Promise<boolean>
  teamUnitId(): string
  teamStatus(): Promise<TeamState | null>
  teamNote(input: TeamNoteInput): Promise<{ task: TeamTask }>
  teamTake(taskId: string): Promise<{ task: TeamTask }>
  teamTaskStatus(taskId: string, status: TeamTaskStatus): Promise<{ task: TeamTask }>
  teamPublishState(): Promise<TeamPublishState>
}

const NOT_INITIALISED =
  'Team mode 未初始化（没有 team/team.json）。请让用户运行 /team init 或 /team join。'

async function publishReminder(host: TeamToolsHost): Promise<string> {
  try {
    const s = await host.teamPublishState()
    if (!s.isGitRepo) return ''
    if (s.dirty.length > 0 || s.unpushedCommits > 0) {
      return '\n提醒：本地 team/ 有未发布的变更，队友看不到 — 建议提示用户运行 /team push。'
    }
  } catch { /* advisory only */ }
  return ''
}

export function createTeamNoteTool(host: TeamToolsHost): MetaAgentTool {
  return {
    name: 'team_note',
    description:
      '在 team 协作板上为当前 unit 持有的任务追加一条 attempt 记录（方向 + 结果 + 可选 ref）。' +
      '在一轮有意义的实验/调试得出结论后主动调用——成功和失败都值得记录，失败的结论对队友价值更大。' +
      'ref 填 wandb/git commit/rosbag 等可追溯链接。只能记录自己持有的任务；其他情况会报错。',
    inputSchema: {
      type: 'object',
      required: ['task_id', 'direction', 'outcome'],
      properties: {
        task_id:   { type: 'string', description: '任务 ID，如 TASK-001' },
        direction: { type: 'string', description: '试了什么方向（一句话）' },
        outcome:   { type: 'string', description: '结果如何，含关键数字（一两句话）' },
        ref:       { type: 'string', description: '可选：wandb/git/rosbag 等追溯链接' },
      },
    },
    async call(input): Promise<ToolResult> {
      try {
        if (!(await host.teamExists())) return { content: NOT_INITIALISED, isError: true }
        const result = await host.teamNote({
          taskId:    String(input['task_id'] ?? '').trim(),
          direction: String(input['direction'] ?? '').trim(),
          outcome:   String(input['outcome'] ?? '').trim(),
          ref:       typeof input['ref'] === 'string' ? input['ref'] : undefined,
        })
        const reminder = await publishReminder(host)
        return {
          content: `📓 已为 ${result.task.id} 记录 attempt（共 ${result.task.attempts.length} 条）。${reminder}`,
          isError: false,
        }
      } catch (err) {
        return { content: `team_note 失败: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  }
}

export function createTeamTakeTool(host: TeamToolsHost): MetaAgentTool {
  return {
    name: 'team_take',
    description:
      '排他领取一个 team 任务（设置 owner 锁）。需要用户确认。' +
      '已被他人持有的任务会失败并提示 owner——此时不要尝试绕过，把情况告诉用户。',
    inputSchema: {
      type: 'object',
      required: ['task_id'],
      properties: {
        task_id: { type: 'string', description: '任务 ID，如 TASK-001' },
      },
    },
    async call(input): Promise<ToolResult> {
      try {
        if (!(await host.teamExists())) return { content: NOT_INITIALISED, isError: true }
        const result = await host.teamTake(String(input['task_id'] ?? '').trim())
        const reminder = await publishReminder(host)
        return {
          content: `🔒 已领取 ${result.task.id}: ${result.task.title}（owner=${host.teamUnitId()}）。${reminder}`,
          isError: false,
        }
      } catch (err) {
        return { content: `team_take 失败: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  }
}

export function createTeamMarkDoneTool(host: TeamToolsHost): MetaAgentTool {
  return {
    name: 'team_mark_done',
    description:
      '把当前 unit 持有的 team 任务标记为 done（释放锁，任务从进行中移除）。需要用户确认。' +
      '标记前应先用 team_note 记录最终结论。',
    inputSchema: {
      type: 'object',
      required: ['task_id'],
      properties: {
        task_id: { type: 'string', description: '任务 ID，如 TASK-001' },
      },
    },
    async call(input): Promise<ToolResult> {
      try {
        if (!(await host.teamExists())) return { content: NOT_INITIALISED, isError: true }
        const result = await host.teamTaskStatus(String(input['task_id'] ?? '').trim(), 'done')
        const reminder = await publishReminder(host)
        return {
          content: `✅ ${result.task.id} 已标记 done。${reminder}`,
          isError: false,
        }
      } catch (err) {
        return { content: `team_mark_done 失败: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  }
}

export function createTeamTools(host: TeamToolsHost): MetaAgentTool[] {
  return [createTeamNoteTool(host), createTeamTakeTool(host), createTeamMarkDoneTool(host)]
}
