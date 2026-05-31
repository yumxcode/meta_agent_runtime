import { proposePrincipleFromExperience } from '../../PrinciplePromotion.js';
export function createPrinciplePromoteTool(experienceStore, anchorStore, pendingStore, flash) {
    return {
        name: 'principle_promote',
        description: 'Promote an approved experience into a reusable Principle candidate when the user explicitly asks to extract, promote, generalize, or abstract a principle. ' +
            'The generated principle is queued for human review and is NOT committed until `/principle review` approves it. ' +
            'Use this only for explicit user requests; confidence-threshold promotion is handled automatically after experience review.',
        inputSchema: {
            type: 'object',
            required: ['experience_id'],
            properties: {
                experience_id: {
                    type: 'string',
                    description: 'Approved ExperienceStore ID to promote into a principle candidate.',
                },
            },
        },
        async call(input) {
            const experienceId = String(input['experience_id'] ?? '').trim();
            if (!experienceId)
                return { content: 'experience_id is required', isError: true };
            const result = await proposePrincipleFromExperience({
                experienceId,
                experienceStore,
                anchorStore,
                pendingStore,
                flash,
                reason: 'explicit_user_request',
            });
            if (!result.promoted) {
                return {
                    content: `principle_promote did not queue a proposal: ${result.reason}`,
                    isError: result.reason !== 'below_threshold',
                };
            }
            return {
                content: `Principle candidate queued for review: ${result.pendingId}\n` +
                    `Trigger: explicit_user_request\n` +
                    `Score: ${result.score ?? 'n/a'}\n\n` +
                    `Run /principle review to approve, edit externally, or discard it.`,
                isError: false,
            };
        },
    };
}
//# sourceMappingURL=index.js.map