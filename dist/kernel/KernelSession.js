import { emptyUsage, addUsage } from './types/TokenUsage.js';
import { makeTextUserMessage } from './messages/MessageFactory.js';
import { FileStateCache } from './session/FileStateCache.js';
import { createBootstrapState } from './session/BootstrapState.js';
import { runKernelLoop } from './loop/KernelLoop.js';
const VOLATILE_CONTEXT_PREFIX_START = '<context>\n';
const VOLATILE_CONTEXT_PREFIX_END = '\n</context>\n\n---\n\n';
function stripVolatileContextPrefix(text) {
    if (!text.startsWith(VOLATILE_CONTEXT_PREFIX_START))
        return text;
    const end = text.lastIndexOf(VOLATILE_CONTEXT_PREFIX_END);
    if (end < 0)
        return text;
    return text.slice(end + VOLATILE_CONTEXT_PREFIX_END.length);
}
function stripVolatileContextFromMessages(messages) {
    for (const msg of messages) {
        if (msg.role !== 'user')
            continue;
        let changed = false;
        const content = msg.content.map(block => {
            if (block.type !== 'text')
                return block;
            const stripped = stripVolatileContextPrefix(block.text);
            if (stripped === block.text)
                return block;
            changed = true;
            return { ...block, text: stripped };
        });
        if (changed)
            msg.content = content;
    }
}
export class KernelSession {
    _config;
    _messages = [];
    _abortController = new AbortController();
    _totalUsage = emptyUsage();
    _totalCostUsd = 0;
    _fileCache;
    _autoCompactTracking;
    _sessionId;
    _cwd;
    _permissionDenials = [];
    _submitInFlight = false;
    constructor(config) {
        this._config = { ...config };
        this._messages = [...(config.initialMessages ?? [])];
        this._fileCache = new FileStateCache();
        const bootstrap = createBootstrapState(config.cwd, config.sessionId);
        this._sessionId = bootstrap.sessionId;
        this._cwd = bootstrap.cwd;
    }
    // ── Public API ─────────────────────────────────────────────────────────────
    /**
     * Submit a new user message and run the agentic loop until completion.
     * Yields KernelEvents; the last event is always a 'result' event.
     */
    async *submitMessage(prompt) {
        if (this._submitInFlight) {
            throw new Error(`[KernelSession:${this._sessionId.slice(0, 8)}] Cannot call submitMessage() concurrently on the same session. ` +
                'Wait for the current turn to complete before submitting a new prompt.');
        }
        this._submitInFlight = true;
        try {
            // Fresh abort controller for this submitMessage call
            this._abortController = new AbortController();
            stripVolatileContextFromMessages(this._messages);
            // Build user message
            const userMessage = typeof prompt === 'string'
                ? makeTextUserMessage(prompt)
                : {
                    uuid: crypto.randomUUID(),
                    role: 'user',
                    content: prompt,
                };
            this._messages.push(userMessage);
            this._config.onMessagesUpdate?.(this._messages);
            // ── Run the loop. Events are yielded immediately; the terminal result is
            // still emitted even when the loop throws.
            let loopResult;
            let loopError;
            try {
                const gen = runKernelLoop({
                    config: this._config,
                    mutableMessages: this._messages,
                    abortController: this._abortController,
                    fileCache: this._fileCache,
                    sessionId: this._sessionId,
                    cwd: this._cwd,
                    cumulativeCostUsd: this._totalCostUsd,
                    autoCompactTracking: this._autoCompactTracking,
                });
                let step = await gen.next();
                while (!step.done) {
                    yield step.value;
                    step = await gen.next();
                }
                // The generator's return value is the LoopResult
                loopResult = step.value;
            }
            catch (err) {
                loopError = err;
            }
            const resultEvent = this._buildResultEvent(loopResult, loopError);
            stripVolatileContextFromMessages(this._messages);
            // Emit terminal result event
            yield resultEvent;
            // Update session cumulative state
            if (loopResult) {
                this._totalUsage = addUsage(this._totalUsage, loopResult.totalUsage);
                this._totalCostUsd = loopResult.costUsd;
                this._autoCompactTracking = loopResult.autoCompactTracking;
                this._permissionDenials.push(...loopResult.permissionDenials);
                if (loopResult.fallbackTriggered) {
                    this._config = { ...this._config, model: loopResult.finalModel };
                }
                this._config.onMessagesUpdate?.(this._messages);
            }
        }
        finally {
            this._submitInFlight = false;
        }
    }
    /** Interrupt the currently-running loop */
    interrupt() {
        this._abortController.abort('interrupt');
    }
    /** Read-only view of the full message history */
    getMessages() {
        return this._messages;
    }
    getSessionId() {
        return this._sessionId;
    }
    getTotalUsage() {
        return { ...this._totalUsage };
    }
    getTotalCostUsd() {
        return this._totalCostUsd;
    }
    /** Change the main model for future submitMessage calls */
    setModel(model) {
        this._config = { ...this._config, model };
    }
    /**
     * Set or update the suffix appended to the system prompt.
     * Used by CampaignSession to inject dynamic context before each submit.
     */
    setAppendSystemPrompt(suffix) {
        this._config = { ...this._config, appendSystemPrompt: suffix };
    }
    /** Add a tool (no-op if tool with same name already exists) */
    addTool(tool) {
        if (this._config.tools.some(t => t.name === tool.name))
            return;
        this._config = { ...this._config, tools: [...this._config.tools, tool] };
    }
    /** Add or replace a tool by name */
    upsertTool(tool) {
        const idx = this._config.tools.findIndex(t => t.name === tool.name);
        if (idx < 0) {
            this._config = { ...this._config, tools: [...this._config.tools, tool] };
        }
        else {
            const tools = [...this._config.tools];
            tools[idx] = tool;
            this._config = { ...this._config, tools };
        }
    }
    getPermissionDenials() {
        return this._permissionDenials;
    }
    // ── Private helpers ────────────────────────────────────────────────────────
    _buildResultEvent(loopResult, loopError) {
        if (loopResult) {
            const subtypeMap = {
                success: 'success',
                max_turns: 'error_max_turns',
                no_progress: 'error_during_execution',
                blocking_limit: 'error_blocking_limit',
                aborted_streaming: 'error_during_execution',
                aborted_tools: 'error_during_execution',
                max_budget_usd: 'error_max_budget_usd',
                error: 'error_during_execution',
            };
            return {
                type: 'result',
                subtype: subtypeMap[loopResult.reason],
                sessionId: this._sessionId,
                usage: loopResult.totalUsage,
                costUsd: loopResult.costUsd,
                numTurns: loopResult.numTurns,
                stopReason: null,
                resultText: loopResult.resultText,
                permissionDenials: loopResult.permissionDenials,
            };
        }
        return {
            type: 'result',
            subtype: 'error_during_execution',
            sessionId: this._sessionId,
            usage: emptyUsage(),
            costUsd: this._totalCostUsd,
            numTurns: 0,
            stopReason: null,
            resultText: '',
            errors: [String(loopError ?? 'Unknown error')],
        };
    }
}
//# sourceMappingURL=KernelSession.js.map