/**
 * Session management tools — list, star, tag.
 *
 *   session_list  — list all persisted sessions with star/tag/idle info
 *   session_star  — star or unstar a session (starred sessions skip auto-purge)
 *   session_tag   — set the tags for a session
 */

import type { MetaAgentTool } from '../../../core/types.js'
import { RoboticsProjectStore } from '../../persistence/RoboticsProjectStore.js'

// ── session_list ──────────────────────────────────────────────────────────────

export function createSessionListTool(): MetaAgentTool {
  return {
    name: 'session_list',
    description:
      'List all persisted robotics sessions, sorted by most-recently-active first. ' +
      'Shows sessionId (short), projectDir, robot, idle days, star status, tags, and current phase. ' +
      'Use the sessionId shown here with session_star and session_tag.',
    isConcurrencySafe: true,
    inputSchema: {
      type: 'object',
      properties: {
        filter: {
          type: 'string',
          enum: ['all', 'starred', 'unstarred'],
          description: 'Which sessions to show. Defaults to "all".',
        },
        tag: {
          type: 'string',
          description: 'If provided, only show sessions that include this tag.',
        },
      },
      required: [],
    },
    async call(input: Record<string, unknown>) {
      const all = await RoboticsProjectStore.listAll()

      let sessions = all
      const filter = (input['filter'] as string | undefined) ?? 'all'
      if (filter === 'starred')   sessions = sessions.filter(s => s.starred)
      if (filter === 'unstarred') sessions = sessions.filter(s => !s.starred)
      const tagFilter = input['tag'] as string | undefined
      if (tagFilter) sessions = sessions.filter(s => s.tags.includes(tagFilter))

      if (sessions.length === 0) {
        return { content: 'No sessions found.', isError: false }
      }

      const lines = [
        `## Sessions (${sessions.length})`,
        '',
        '| ★ | Session | Project | Robot | Idle | Tags | Phase |',
        '|---|---------|---------|-------|------|------|-------|',
        ...sessions.map(s => {
          const star    = s.starred ? '⭐' : '○'
          const sid     = s.sessionId.slice(0, 8)            // short 8-char prefix
          const proj    = s.projectDir.length > 35
            ? '…' + s.projectDir.slice(-33)
            : s.projectDir
          const robot   = s.robot ?? '—'
          const idle    = s.idleDays === 0 ? 'today' : `${s.idleDays}d`
          const tags    = s.tags.length > 0 ? s.tags.join(', ') : '—'
          const phase   = s.currentPhase ?? '—'
          return `| ${star} | \`${sid}\` | \`${proj}\` | ${robot} | ${idle} | ${tags} | ${phase} |`
        }),
        '',
        '> Use the full sessionId with `session_star` / `session_tag`. ' +
        'Run `session_list` to see short IDs — pass the exact `sessionId` from the state.',
      ]

      return { content: lines.join('\n'), isError: false }
    },
  }
}

// ── session_star ──────────────────────────────────────────────────────────────

export function createSessionStarTool(): MetaAgentTool {
  return {
    name: 'session_star',
    description:
      'Star or unstar a session by its projectDir + sessionId. ' +
      'Starred sessions are exempt from the 7-day auto-purge. ' +
      'Use session_list first to find the projectDir and sessionId.',
    inputSchema: {
      type: 'object',
      properties: {
        projectDir: {
          type: 'string',
          description: 'Absolute path of the project.',
        },
        sessionId: {
          type: 'string',
          description: 'Full sessionId of the session to star/unstar (from session_list).',
        },
        starred: {
          type: 'boolean',
          description: 'true = star the session; false = remove the star.',
        },
      },
      required: ['projectDir', 'sessionId', 'starred'],
    },
    async call(input: Record<string, unknown>) {
      const projectDir = input['projectDir'] as string
      const sessionId  = input['sessionId']  as string
      const starred    = input['starred']    as boolean
      await RoboticsProjectStore.star(projectDir, sessionId, starred)
      const action = starred ? 'Starred ⭐' : 'Unstarred'
      return { content: `${action}: \`${projectDir}\` (session \`${sessionId.slice(0, 8)}\`)`, isError: false }
    },
  }
}

// ── session_tag ───────────────────────────────────────────────────────────────

export function createSessionTagTool(): MetaAgentTool {
  return {
    name: 'session_tag',
    description:
      'Set the tags for a session. Replaces the existing tag list entirely. ' +
      'Pass an empty array to clear all tags. ' +
      'Tags are free-form strings, e.g. ["go2", "mpc", "sprint-3"]. ' +
      'Use session_list first to find the projectDir and sessionId.',
    inputSchema: {
      type: 'object',
      properties: {
        projectDir: {
          type: 'string',
          description: 'Absolute path of the project.',
        },
        sessionId: {
          type: 'string',
          description: 'Full sessionId of the session to tag (from session_list).',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'New tag list. Replaces the existing tags.',
        },
      },
      required: ['projectDir', 'sessionId', 'tags'],
    },
    async call(input: Record<string, unknown>) {
      const projectDir = input['projectDir'] as string
      const sessionId  = input['sessionId']  as string
      const tags       = input['tags']        as string[]
      await RoboticsProjectStore.setTags(projectDir, sessionId, tags)
      const tagStr = tags.length > 0
        ? tags.map(t => `\`${t}\``).join(', ')
        : '*(none)*'
      return {
        content: `Tags updated for \`${projectDir}\` (session \`${sessionId.slice(0, 8)}\`): ${tagStr}`,
        isError: false,
      }
    },
  }
}
