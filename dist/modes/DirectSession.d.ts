import type { MetaAgentEvent, MetaAgentTool } from '../core/types.js';
import type { MetaAgentConfig } from '../core/config.js';
import type { KernelMessage } from '../kernel/index.js';
export declare class DirectSession {
    private readonly _engine;
    private readonly _sessionId;
    private readonly _registeredTools;
    /** #11: Guard against concurrent submit() calls on the same instance. */
    private _submitInFlight;
    constructor(config: MetaAgentConfig);
    registerTool(tool: MetaAgentTool): void;
    submit(prompt: string): AsyncGenerator<MetaAgentEvent>;
    getMessages(): readonly KernelMessage[];
    getSessionId(): string;
    interrupt(): void;
}
//# sourceMappingURL=DirectSession.d.ts.map