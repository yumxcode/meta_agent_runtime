import type { MetaAgentEvent, MetaAgentTool, TokenUsage } from '../core/types.js';
import type { MetaAgentConfig } from '../core/config.js';
import type { KernelMessage } from '../kernel/index.js';
export declare class AgenticSession {
    private readonly _engine;
    private readonly _config;
    private readonly _sessionId;
    private readonly _registeredTools;
    private _totalCostUsd;
    private _usage;
    constructor(config: MetaAgentConfig);
    registerTool(tool: MetaAgentTool): void;
    submit(prompt: string): AsyncGenerator<MetaAgentEvent>;
    interrupt(): void;
    getMessages(): readonly KernelMessage[];
    getSessionId(): string;
    getUsage(): TokenUsage;
    getEstimatedCost(): number;
    /**
     * Update the system prompt suffix that is appended on every submit.
     * The full effective prompt is: systemPrompt + '\n\n' + appendSystemPrompt.
     * Used by MetaAgentSession to inject dynamic sections per-submit, and by
     * RoboticsSession to inject R1-R5 sections.
     */
    setAppendSystemPrompt(suffix: string): void;
}
//# sourceMappingURL=AgenticSession.d.ts.map