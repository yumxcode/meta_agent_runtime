import type { MetaAgentTool, ToolResult } from '../core/types.js'
import { reduceTrajectoryLine } from './TrajectoryReviewScanner.js'
import { taskCaseOverview, type TaskCase } from './TaskCase.js'

const DEFAULT_READ_LIMIT = 40
const MAX_READ_LIMIT = 80
const DEFAULT_SEARCH_LIMIT = 20
const MAX_SEARCH_LIMIT = 40

/**
 * Evidence-only tools for Reviewer mode. They expose a closed TaskCase snapshot
 * and cannot access arbitrary trajectories or mutate the reviewed workspace.
 */
export function createReviewerTools(taskCase: TaskCase): MetaAgentTool[] {
  const memberById = new Map(taskCase.members.map(member => [member.entry.trajectoryId, member]))
  const hintById = new Map(taskCase.triggerHints.map(hint => [hint.windowId, hint]))

  const overview: MetaAgentTool = {
    name: 'review_case_overview',
    description:
      'Return the bounded task case topology, aggregate metrics, run results, and trigger hints. ' +
      'Use this to orient before reading evidence. Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    abortSupport: 'bounded',
    isConcurrencySafe: true,
    async call(): Promise<ToolResult> {
      return ok(taskCaseOverview(taskCase))
    },
  }

  const read: MetaAgentTool = {
    name: 'review_trajectory_read',
    description:
      'Read a redacted ordinal slice from one trajectory in the current TaskCase. ' +
      'Use ordinals from overview, search, or prior reads. Read-only and case-confined.',
    inputSchema: {
      type: 'object',
      properties: {
        trajectoryId: { type: 'string', description: 'Exact trajectory UUID from review_case_overview.' },
        startOrdinal: { type: 'integer', minimum: 1, description: 'First ordinal to return.' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_READ_LIMIT, default: DEFAULT_READ_LIMIT },
      },
      required: ['trajectoryId', 'startOrdinal'],
      additionalProperties: false,
    },
    abortSupport: 'bounded',
    isConcurrencySafe: true,
    async call(input): Promise<ToolResult> {
      const trajectoryId = stringInput(input, 'trajectoryId')
      const startOrdinal = integerInput(input, 'startOrdinal', 1)
      const limit = boundedIntegerInput(input, 'limit', DEFAULT_READ_LIMIT, 1, MAX_READ_LIMIT)
      if (!trajectoryId || startOrdinal === null || limit === null) return invalidInput()
      const member = memberById.get(trajectoryId)
      if (!member) return failure(`trajectory '${trajectoryId}' is outside task case '${taskCase.id}'`)
      const lines = member.lines
        .filter(line => line.ordinal >= startOrdinal)
        .slice(0, limit)
        .map(reduceTrajectoryLine)
      return ok({
        trajectoryId,
        startOrdinal,
        lines,
        hasMore: lines.length > 0 && lines.at(-1)!.ordinal < (member.lines.at(-1)?.ordinal ?? 0),
      })
    },
  }

  const search: MetaAgentTool = {
    name: 'review_trajectory_search',
    description:
      'Search redacted trajectory evidence in the current TaskCase by literal text. ' +
      'Optionally restrict to one trajectory. Returns matching ordinals and bounded context-free previews.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 200 },
        trajectoryId: { type: 'string', description: 'Optional exact trajectory UUID.' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_SEARCH_LIMIT, default: DEFAULT_SEARCH_LIMIT },
      },
      required: ['query'],
      additionalProperties: false,
    },
    abortSupport: 'bounded',
    isConcurrencySafe: true,
    async call(input): Promise<ToolResult> {
      const query = stringInput(input, 'query')?.trim()
      const trajectoryId = optionalStringInput(input, 'trajectoryId')
      const limit = boundedIntegerInput(input, 'limit', DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT)
      if (!query || limit === null || trajectoryId === null) return invalidInput()
      const members = trajectoryId
        ? [memberById.get(trajectoryId)].filter((member): member is TaskCase['members'][number] => Boolean(member))
        : taskCase.members
      if (trajectoryId && members.length === 0) {
        return failure(`trajectory '${trajectoryId}' is outside task case '${taskCase.id}'`)
      }
      const needle = query.toLocaleLowerCase()
      const matches: Array<Record<string, unknown>> = []
      for (const member of members) {
        for (const line of member.lines) {
          const reduced = reduceTrajectoryLine(line)
          if (!reduced.text.toLocaleLowerCase().includes(needle)) continue
          matches.push({ trajectoryId: member.entry.trajectoryId, ...reduced })
          if (matches.length > limit) break
        }
        if (matches.length > limit) break
      }
      return ok({ query, matches: matches.slice(0, limit), truncated: matches.length > limit })
    },
  }

  const triggerContext: MetaAgentTool = {
    name: 'review_trigger_context',
    description:
      'Expand one deterministic trigger hint into redacted local evidence around all trigger ordinals. ' +
      'Triggers are navigation hints, not proof that a finding is important.',
    inputSchema: {
      type: 'object',
      properties: {
        windowId: { type: 'string', description: 'Window ID from review_case_overview.' },
      },
      required: ['windowId'],
      additionalProperties: false,
    },
    abortSupport: 'bounded',
    isConcurrencySafe: true,
    async call(input): Promise<ToolResult> {
      const windowId = stringInput(input, 'windowId')
      if (!windowId) return invalidInput()
      const hint = hintById.get(windowId)
      if (!hint) return failure(`unknown trigger window '${windowId}' in task case '${taskCase.id}'`)
      const member = memberById.get(hint.trajectoryId)!
      const selected = new Map<number, ReturnType<typeof reduceTrajectoryLine>>()
      for (const ordinal of hint.triggerOrdinals) {
        const index = member.lines.findIndex(line => line.ordinal === ordinal)
        if (index < 0) continue
        for (const line of member.lines.slice(Math.max(0, index - 6), index + 15)) {
          selected.set(line.ordinal, reduceTrajectoryLine(line))
        }
      }
      return ok({
        ...hint,
        lines: [...selected.values()].sort((left, right) => left.ordinal - right.ordinal),
      })
    },
  }

  return [overview, read, search, triggerContext]
}

function ok(value: unknown): ToolResult {
  return { content: JSON.stringify(value, null, 2), isError: false }
}

function failure(message: string): ToolResult {
  return { content: message, isError: true }
}

function invalidInput(): ToolResult {
  return failure('invalid reviewer tool input')
}

function stringInput(input: Record<string, unknown>, key: string): string | undefined {
  return typeof input[key] === 'string' && input[key] ? input[key] : undefined
}

function optionalStringInput(input: Record<string, unknown>, key: string): string | undefined | null {
  const value = input[key]
  if (value === undefined) return undefined
  return typeof value === 'string' && value ? value : null
}

function integerInput(input: Record<string, unknown>, key: string, minimum: number): number | null {
  const value = input[key]
  return Number.isSafeInteger(value) && (value as number) >= minimum ? value as number : null
}

function boundedIntegerInput(
  input: Record<string, unknown>,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number | null {
  if (input[key] === undefined) return fallback
  const value = integerInput(input, key, minimum)
  return value !== null && value <= maximum ? value : null
}
