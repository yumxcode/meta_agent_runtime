/**
 * KernelSession — the public entry point.
 * Equivalent to CC's QueryEngine.
 *
 * Manages per-session state:
 *  - Message history (mutableMessages)
 *  - Cumulative token usage / cost
 *  - AbortController lifecycle
 *  - FileStateCache
 *
 * Delegates the actual loop to runKernelLoop().
 */
import type { KernelConfig } from './types/KernelConfig.js';
import type { KernelEvent, PermissionDenial } from './types/KernelEvent.js';
import type { KernelMessage } from './types/KernelMessage.js';
import type { KernelTool } from './types/KernelTool.js';
import type { TokenUsage } from './types/TokenUsage.js';
export declare class KernelSession {
    private _config;
    private _messages;
    private _abortController;
    private _totalUsage;
    private _totalCostUsd;
    private _fileCache;
    private _autoCompactTracking;
    private readonly _sessionId;
    private readonly _cwd;
    private _permissionDenials;
    private _submitInFlight;
    constructor(config: KernelConfig);
    /**
     * Submit a new user message and run the agentic loop until completion.
     * Yields KernelEvents; the last event is always a 'result' event.
     */
    submitMessage(prompt: string | Array<{
        type: string;
        [key: string]: unknown;
    }>): AsyncGenerator<KernelEvent>;
    /** Interrupt the currently-running loop */
    interrupt(): void;
    /** Read-only view of the full message history */
    getMessages(): readonly KernelMessage[];
    getSessionId(): string;
    getTotalUsage(): TokenUsage;
    getTotalCostUsd(): number;
    /** Change the main model for future submitMessage calls */
    setModel(model: string): void;
    /**
     * Set or update the suffix appended to the system prompt.
     * Used by CampaignSession to inject dynamic context before each submit.
     */
    setAppendSystemPrompt(suffix: string): void;
    /** Add a tool (no-op if tool with same name already exists) */
    addTool(tool: KernelTool): void;
    /** Add or replace a tool by name */
    upsertTool(tool: KernelTool): void;
    getPermissionDenials(): readonly PermissionDenial[];
    private _buildResultEvent;
}
//# sourceMappingURL=KernelSession.d.ts.map