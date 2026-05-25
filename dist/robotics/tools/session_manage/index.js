/**
 * Session management tools — list, star, tag.
 *
 *   session_list  — list all persisted sessions with star/tag/idle info
 *   session_star  — star or unstar a session (starred sessions skip auto-purge)
 *   session_tag   — set the tags for a session
 */
import { RoboticsProjectStore } from '../../persistence/RoboticsProjectStore.js';
// ── session_list ──────────────────────────────────────────────────────────────
export function createSessionListTool() {
    return {
        name: 'session_list',
        description: 'List all persisted robotics sessions, sorted by most-recently-active first. ' +
            'Shows projectDir, robot, idle days, star status, tags, and current phase. ' +
            'Use this to browse history before starring or tagging a session.',
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
        async call(input) {
            const all = await RoboticsProjectStore.listAll();
            let sessions = all;
            const filter = input['filter'] ?? 'all';
            if (filter === 'starred')
                sessions = sessions.filter(s => s.starred);
            if (filter === 'unstarred')
                sessions = sessions.filter(s => !s.starred);
            const tagFilter = input['tag'];
            if (tagFilter)
                sessions = sessions.filter(s => s.tags.includes(tagFilter));
            if (sessions.length === 0) {
                return { content: 'No sessions found.', isError: false };
            }
            const lines = [
                `## Sessions (${sessions.length})`,
                '',
                '| ★ | Project | Robot | Idle | Tags | Phase |',
                '|---|---------|-------|------|------|-------|',
                ...sessions.map(s => {
                    const star = s.starred ? '⭐' : '○';
                    const proj = s.projectDir.length > 40
                        ? '…' + s.projectDir.slice(-38)
                        : s.projectDir;
                    const robot = s.robot ?? '—';
                    const idle = s.idleDays === 0 ? 'today' : `${s.idleDays}d`;
                    const tags = s.tags.length > 0 ? s.tags.join(', ') : '—';
                    const phase = s.currentPhase ?? '—';
                    return `| ${star} | \`${proj}\` | ${robot} | ${idle} | ${tags} | ${phase} |`;
                }),
            ];
            return { content: lines.join('\n'), isError: false };
        },
    };
}
// ── session_star ──────────────────────────────────────────────────────────────
export function createSessionStarTool() {
    return {
        name: 'session_star',
        description: 'Star or unstar a session by its projectDir. ' +
            'Starred sessions are exempt from the 7-day auto-purge. ' +
            'Use session_list first to find the projectDir of the session you want.',
        inputSchema: {
            type: 'object',
            properties: {
                projectDir: {
                    type: 'string',
                    description: 'Absolute path of the project whose session to star/unstar.',
                },
                starred: {
                    type: 'boolean',
                    description: 'true = star the session; false = remove the star.',
                },
            },
            required: ['projectDir', 'starred'],
        },
        async call(input) {
            const projectDir = input['projectDir'];
            const starred = input['starred'];
            await RoboticsProjectStore.star(projectDir, starred);
            const action = starred ? 'Starred ⭐' : 'Unstarred';
            return { content: `${action}: \`${projectDir}\``, isError: false };
        },
    };
}
// ── session_tag ───────────────────────────────────────────────────────────────
export function createSessionTagTool() {
    return {
        name: 'session_tag',
        description: 'Set the tags for a session. Replaces the existing tag list entirely. ' +
            'Pass an empty array to clear all tags. ' +
            'Tags are free-form strings, e.g. ["go2", "mpc", "sprint-3"].',
        inputSchema: {
            type: 'object',
            properties: {
                projectDir: {
                    type: 'string',
                    description: 'Absolute path of the project whose session to tag.',
                },
                tags: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'New tag list. Replaces the existing tags.',
                },
            },
            required: ['projectDir', 'tags'],
        },
        async call(input) {
            const projectDir = input['projectDir'];
            const tags = input['tags'];
            await RoboticsProjectStore.setTags(projectDir, tags);
            const tagStr = tags.length > 0
                ? tags.map(t => `\`${t}\``).join(', ')
                : '*(none)*';
            return { content: `Tags updated for \`${projectDir}\`: ${tagStr}`, isError: false };
        },
    };
}
//# sourceMappingURL=index.js.map