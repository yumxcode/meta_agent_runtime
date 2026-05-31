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
                let settled = false;
                let timer;
                const onAbort = () => {
                    if (settled)
                        return;
                    settled = true;
                    clearTimeout(timer);
                    reject(new Error('Sleep aborted'));
                };
                timer = setTimeout(() => {
                    if (settled)
                        return;
                    settled = true;
                    ctx.abortSignal.removeEventListener('abort', onAbort);
                    resolve();
                }, ms);
                if (ctx.abortSignal.aborted) {
                    onAbort();
                    return;
                }
                ctx.abortSignal.addEventListener('abort', onAbort, { once: true });
            });
            return { content: `Slept for ${ms}ms`, isError: false };
        },
    };
}
//# sourceMappingURL=index.js.map