import { loadToolPrompt } from '../../util.js';
export async function createExitPlanModeTool(planModeRef) {
    const description = await loadToolPrompt(import.meta.url);
    return {
        name: 'exit_plan_mode',
        description,
        isConcurrencySafe: true,
        inputSchema: {
            type: 'object',
            properties: {},
            required: [],
        },
        async call(_input, _ctx) {
            if (!planModeRef.active) {
                return { content: 'Not in plan mode. Call enter_plan_mode first.', isError: true };
            }
            planModeRef.active = false;
            return {
                content: '✅ Plan mode deactivated. Tools will now execute without approval.',
                isError: false,
            };
        },
    };
}
//# sourceMappingURL=index.js.map