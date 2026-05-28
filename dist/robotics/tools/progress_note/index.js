import { RoboticsProjectStore } from '../../persistence/RoboticsProjectStore.js';
export function createProgressNoteTool(projectDir, sessionId) {
    return {
        name: 'progress_note',
        description: 'Write a progress note to the robotics project store. ' +
            'Notes are shown in the R5 section when the session resumes (e.g. the next day). ' +
            'Call this at significant milestones: phase completion, sub-agent results, key decisions. ' +
            'Keep notes concise — they accumulate within this session (max 15 retained, oldest evicted).',
        inputSchema: {
            type: 'object',
            required: ['note'],
            properties: {
                note: {
                    type: 'string',
                    description: 'Progress note to record (≤ 200 chars recommended)',
                },
                current_phase: {
                    type: 'string',
                    description: 'Update the current phase label (e.g. "实验验证 3/5", "deployment")',
                },
            },
        },
        async call(input) {
            const note = String(input['note'] ?? '').trim();
            if (!note)
                return { content: 'note is required', isError: true };
            try {
                await RoboticsProjectStore.appendProgress(projectDir, sessionId, note);
                // Optionally update the current phase label in state
                const phase = input['current_phase'];
                if (phase) {
                    const state = await RoboticsProjectStore.findBySession(projectDir, sessionId);
                    if (state) {
                        state.currentPhase = phase;
                        await RoboticsProjectStore.save(state);
                    }
                }
                return {
                    content: `📌 Progress note recorded: "${note}"${phase ? ` (phase: ${phase})` : ''}`,
                    isError: false,
                };
            }
            catch (err) {
                return { content: `progress_note failed: ${String(err)}`, isError: true };
            }
        },
    };
}
//# sourceMappingURL=index.js.map