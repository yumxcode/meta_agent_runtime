import { loadToolPrompt } from '../../util.js';
export async function createSleepTool() {
    const description = await loadToolPrompt(import.meta.url);
    return {
        name: 'sleep',
        description,
        inputSchema: {
            type: 'object',
            properties: {
                duration_ms: { type: 'number', description: 'Milliseconds to sleep (max: 60000)' },
            },
            required: ['duration_ms'],
        },
        async call(input, ctx) {
            const ms = Math.min(typeof input['duration_ms'] === 'number' ? input['duration_ms'] : 1000, 60000);
            if (ms <= 0)
                return { content: 'Error: duration_ms must be positive', isError: true };
            await new Promise((resolve, reject) => {
                const timer = setTimeout(resolve, ms);
                ctx.abortSignal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('Sleep aborted')); }, { once: true });
            });
            return { content: `Slept for ${ms}ms`, isError: false };
        },
    };
}
//# sourceMappingURL=index.js.map