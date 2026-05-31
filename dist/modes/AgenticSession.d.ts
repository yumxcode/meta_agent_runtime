import type { MetaAgentEvent, MetaAgentTool, TokenUsage } from '../core/types.js';
import type { MetaAgentConfig } from '../core/config.js';
import type { KernelMessage } from '../kernel/index.js';
export declare class AgenticSession {
    private readonly _engine;
    private readonly _config;
    private readonly _sessionId;
    private readonly _registeredTools;
    /** S1: guard against double dispose. */
    private _disposed;
    private _totalCostUsd;
    private _usage;
    constructor(config: MetaAgentConfig);
    registerTool(tool: MetaAgentTool): void;
    submit(prompt: string): AsyncGenerator<MetaAgentEvent>;
    interrupt(): void;
    /**
     * S1 + S9: Release all per-session resources.  Forwards to the inner
     * KernelSession dispose (which clears messages / fileCache / tools closures),
     * and empties our own _registeredTools array so any caller-supplied tools —
     * with their potentially heavy closures — become unreachable.
     *
     * Safe to call multiple times.  Once called the session must not be reused.
     */
    dispose(): void;
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