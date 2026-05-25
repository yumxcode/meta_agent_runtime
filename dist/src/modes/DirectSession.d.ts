import type { MetaAgentEvent, MetaAgentTool } from '../core/types.js';
import type { MetaAgentConfig } from '../core/config.js';
export declare class DirectSession {
    private readonly _engine;
    private readonly _sessionId;
    constructor(config: MetaAgentConfig);
    registerTool(tool: MetaAgentTool): void;
    submit(prompt: string): AsyncGenerator<MetaAgentEvent>;
    getMessages(): readonly import("../kernel/index.js").KernelMessage[];
    getSessionId(): string;
    interrupt(): void;
}
//# sourceMappingURL=DirectSession.d.ts.map