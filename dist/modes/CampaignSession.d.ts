import type { ConversationMessage, MetaAgentEvent, MetaAgentTool, TokenUsage } from '../core/types.js';
import type { MetaAgentConfig } from '../core/config.js';
export declare class CampaignSession {
    private readonly _engine;
    private readonly _config;
    private readonly _sessionId;
    private readonly _sessionStartMs;
    private readonly _registeredTools;
    private _totalCostUsd;
    /** #11: Guard against concurrent submit() calls on the same session. */
    private _submitInFlight;
    private _usage;
    constructor(config: MetaAgentConfig);
    registerTool(tool: MetaAgentTool): void;
    submit(prompt: string): AsyncGenerator<MetaAgentEvent>;
    interrupt(): void;
    getMessages(): readonly ConversationMessage[];
    getSessionId(): string;
    getUsage(): TokenUsage;
    getEstimatedCost(): number;
    private _buildEnrichedSuffix;
}
//# sourceMappingURL=CampaignSession.d.ts.map