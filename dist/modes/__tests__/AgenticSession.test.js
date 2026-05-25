import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgenticSession } from '../AgenticSession.js';
import { MetaAgentSession } from '../../core/MetaAgentSession.js';
vi.mock('../../kernel/api/AnthropicClient.js', () => ({
    streamMessages: vi.fn(),
}));
import { streamMessages } from '../../kernel/api/AnthropicClient.js';
const mockStream = vi.mocked(streamMessages);
async function* textStream(text) {
    yield { type: 'message_start', usage: { input_tokens: 100 } };
    yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
    yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } };
    yield { type: 'content_block_stop', index: 0 };
    yield { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } };
    yield { type: 'message_stop' };
}
async function* toolUseStream(toolId, toolName, input) {
    yield { type: 'message_start', usage: { input_tokens: 100 } };
    yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: toolId, name: toolName, input: {} } };
    yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } };
    yield { type: 'content_block_stop', index: 0 };
    yield { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } };
    yield { type: 'message_stop' };
}
function makeTool() {
    return {
        name: 'calculator',
        description: async (ctx) => `Calculator. Siblings: ${[...ctx.toolNames].join(',')}`,
        inputSchema: {
            type: 'object',
            properties: { expression: { type: 'string' } },
            required: ['expression'],
        },
        call: async (input) => ({ content: `value=${input['expression']}`, isError: false }),
        isConcurrencySafe: false,
    };
}
beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.clearAllMocks(); });
describe('AgenticSession facade wiring', () => {
    it('registers tools provided in the constructor and resolves dynamic descriptions', async () => {
        let callCount = 0;
        mockStream.mockImplementation(params => {
            callCount++;
            if (callCount === 1) {
                expect(params.tools.map(t => t.name)).toContain('calculator');
                return toolUseStream('tool-1', 'calculator', { expression: '2+2' });
            }
            return textStream('done');
        });
        const session = new AgenticSession({
            apiKey: 'test-key',
            model: 'claude-sonnet-4-6',
            tools: [makeTool()],
        });
        const events = [];
        for await (const event of session.submit('calculate')) {
            events.push(event);
        }
        expect(events.some(e => e.type === 'tool_result' && e.content.includes('value=2+2'))).toBe(true);
        const firstRequest = mockStream.mock.calls[0]?.[0];
        const description = firstRequest?.tools[0]?.description;
        expect(description).toBeTypeOf('function');
        if (typeof description === 'function') {
            await expect(description({ sessionId: 's', model: 'm' })).resolves.toContain('Siblings: calculator');
        }
    });
    it('preloads initialMessages into the kernel history', () => {
        const session = new AgenticSession({
            apiKey: 'test-key',
            model: 'claude-sonnet-4-6',
            initialMessages: [
                { role: 'user', content: 'previous question' },
                { role: 'assistant', content: [{ type: 'text', text: 'previous answer' }] },
            ],
        });
        expect(session.getMessages()).toHaveLength(2);
        expect(session.getMessages()[0]?.role).toBe('user');
        expect(session.getMessages()[1]?.role).toBe('assistant');
    });
});
describe('MetaAgentSession facade wiring', () => {
    it('registers constructor tools through the public session entry point', async () => {
        let callCount = 0;
        mockStream.mockImplementation(() => {
            callCount++;
            return callCount === 1
                ? toolUseStream('tool-1', 'calculator', { expression: '3+3' })
                : textStream('done');
        });
        const session = new MetaAgentSession({
            apiKey: 'test-key',
            model: 'claude-sonnet-4-6',
            tools: [makeTool()],
        });
        const events = [];
        for await (const event of session.submit('calculate')) {
            events.push(event);
        }
        expect(events.some(e => e.type === 'tool_result' && e.content.includes('value=3+3'))).toBe(true);
    });
});
//# sourceMappingURL=AgenticSession.test.js.map