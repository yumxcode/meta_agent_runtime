import { loadToolPrompt } from '../../util.js';
import { listCronJobs } from '../cronStore.js';
export async function createCronListTool() {
    const description = await loadToolPrompt(import.meta.url);
    return {
        name: 'cron_list',
        description,
        isConcurrencySafe: true,
        inputSchema: {
            type: 'object',
            properties: {
                all_sessions: {
                    type: 'boolean',
                    description: 'If true, list jobs from all sessions. Default: only current session.',
                },
            },
            required: [],
        },
        async call(input, ctx) {
            const allSessions = input['all_sessions'] === true;
            const jobs = listCronJobs(allSessions ? undefined : ctx.sessionId);
            if (jobs.length === 0) {
                return {
                    content: allSessions
                        ? 'No scheduled cron jobs found.'
                        : 'No scheduled cron jobs for this session. Use cron_create to schedule one.',
                    isError: false,
                };
            }
            const rows = jobs.map(j => [
                `ID:         ${j.id}`,
                `Expression: ${j.expression}`,
                `Desc:       ${j.description}`,
                `Status:     ${j.active ? 'active' : 'inactive'}`,
                `Runs:       ${j.runCount}`,
                `Last run:   ${j.lastRunAt ? j.lastRunAt.toISOString() : 'never'}`,
                `Created:    ${j.createdAt.toISOString()}`,
            ].join('\n'));
            return { content: rows.join('\n\n'), isError: false };
        },
    };
}
//# sourceMappingURL=index.js.map