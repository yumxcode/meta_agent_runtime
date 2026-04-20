/**
 * Context Compressor
 *
 * Monitors token usage of the conversation history and, when the context window
 * approaches a configurable threshold (default 50%), automatically summarises
 * the middle portion of the history with a secondary LLM call.
 *
 * The compression result replaces the middle section with a single "summary"
 * system message so the LLM retains the key facts without consuming the full
 * context budget.
 *
 * Architecture mirrors the Python ContextCompressor in agent/context_compressor.py.
 */

import type { Message } from '../types.js';
import type { LLMAdapter } from '../adapters/base.js';
import { getContextWindow, roughTokenCount } from '../adapters/base.js';
import { extractText } from '../types.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface CompressionConfig {
  /** Fraction of context window at which compression triggers. Default 0.5 */
  threshold?: number;
  /** Number of messages to protect at the start of history. Default 4 */
  headProtect?: number;
  /** Number of most-recent messages to always keep. Default 6 */
  tailProtect?: number;
  /** Minimum number of messages in the middle before compression runs. Default 4 */
  minMiddleMessages?: number;
}

// ---------------------------------------------------------------------------
// Compression prompt
// ---------------------------------------------------------------------------

const COMPRESSION_SYSTEM = `You are a context summariser for an AI agent.
You will receive a portion of an agent conversation and must produce a compact, structured summary.
The summary must preserve all critical information: completed tasks, current state, key findings,
errors encountered, and pending work.`;

const COMPRESSION_PROMPT = `Please summarise the following agent conversation segment.
Your summary will replace the original messages in the context window, so be thorough but concise.

Return your summary in this exact format:

## RESOLVED
(List each completed task or finding, one per line with a bullet)

## CURRENT STATE
(Describe what the agent has set up, created, or established)

## KEY FINDINGS
(Important facts, values, file paths, API results, decisions made)

## PENDING
(What still needs to be done or is in progress)

---
CONVERSATION TO SUMMARISE:

{conversation}`;

// ---------------------------------------------------------------------------
// ContextCompressor
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Context-length error detection (Reactive Compact)
// ---------------------------------------------------------------------------

/**
 * Returns true if an error represents a context-window-exceeded condition.
 * Covers Anthropic, OpenAI, Gemini, and generic provider patterns.
 */
export function isContextLengthError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  // Anthropic: "prompt is too long"
  if (msg.includes('prompt is too long')) return true;
  // Anthropic API error type
  if ('status' in err && (err as { status?: number }).status === 400 && msg.includes('context')) return true;
  // OpenAI: "context_length_exceeded" or "maximum context length"
  if (msg.includes('context_length_exceeded')) return true;
  if (msg.includes('maximum context length')) return true;
  if (msg.includes("model's maximum context length")) return true;
  // Gemini: "input token limit exceeded"
  if (msg.includes('token limit exceeded')) return true;
  // Generic fallbacks
  if (msg.includes('context window')) return true;
  if (msg.includes('too many tokens')) return true;
  // Error code field (Anthropic SDK shapes)
  const code = (err as { code?: string }).code ?? (err as { error?: { type?: string } }).error?.type ?? '';
  if (code === 'context_length_exceeded') return true;
  if (code === 'prompt_too_long') return true;
  return false;
}

export class ContextCompressor {
  private threshold: number;
  private headProtect: number;
  private tailProtect: number;
  private minMiddleMessages: number;

  constructor(private adapter: LLMAdapter, config: CompressionConfig = {}) {
    this.threshold = config.threshold ?? 0.5;
    this.headProtect = config.headProtect ?? 4;
    this.tailProtect = config.tailProtect ?? 6;
    this.minMiddleMessages = config.minMiddleMessages ?? 4;
  }

  // -------------------------------------------------------------------------
  // Token estimation
  // -------------------------------------------------------------------------

  estimateTokens(messages: Message[]): number {
    let total = 0;
    for (const m of messages) total += roughTokenCount(extractText(m.content));
    return total;
  }

  // -------------------------------------------------------------------------
  // Compression check
  // -------------------------------------------------------------------------

  /**
   * Returns true if the conversation should be compressed.
   */
  shouldCompress(messages: Message[]): boolean {
    const contextWindow = getContextWindow(this.adapter.model);
    const used = this.estimateTokens(messages);
    return used / contextWindow >= this.threshold;
  }

  // -------------------------------------------------------------------------
  // Compress
  // -------------------------------------------------------------------------

  /**
   * Compress the conversation history if needed.
   * Returns a new (shorter) message array; if no compression was needed,
   * returns the original array unchanged.
   */
  async compress(messages: Message[]): Promise<Message[]> {
    if (!this.shouldCompress(messages)) return messages;

    const head = messages.slice(0, this.headProtect);
    const tail = messages.slice(Math.max(this.headProtect, messages.length - this.tailProtect));
    const middle = messages.slice(this.headProtect, messages.length - this.tailProtect);

    if (middle.length < this.minMiddleMessages) return messages;

    const summaryText = await this._summarise(middle);

    // Use 'user' role so Anthropic adapter keeps it in the messages array
    // rather than merging it into the system prompt string.
    // A paired assistant ack prevents a bare user message from looking odd.
    const summaryUserMsg: Message = {
      role: 'user',
      content:
        `[CONTEXT SUMMARY — replaces ${middle.length} earlier messages]\n\n` +
        summaryText,
    };
    const summaryAckMsg: Message = {
      role: 'assistant',
      content: 'Understood. I have the summary of prior context.',
    };

    return [...head, summaryUserMsg, summaryAckMsg, ...tail];
  }

  /**
   * Force multiple compression passes until the context is within threshold,
   * or until no further compression is possible.
   */
  async compressFully(messages: Message[]): Promise<Message[]> {
    let current = messages;
    let maxPasses = 3;
    while (this.shouldCompress(current) && maxPasses-- > 0) {
      const compressed = await this.compress(current);
      if (compressed.length >= current.length) break; // no progress, stop
      current = compressed;
    }
    return current;
  }

  // -------------------------------------------------------------------------
  // Private: summarise a message slice
  // -------------------------------------------------------------------------

  private async _summarise(messages: Message[]): Promise<string> {
    const conversation = messages
      .map((m) => `[${m.role.toUpperCase()}]: ${extractText(m.content)}`)
      .join('\n\n');

    const prompt = COMPRESSION_PROMPT.replace('{conversation}', conversation);

    const response = await this.adapter.call(
      [
        { role: 'system', content: COMPRESSION_SYSTEM },
        { role: 'user', content: prompt },
      ],
      [], // No tools for the summariser
      {
        maxTokens: 2048,
        temperature: 0.1,
        stream: false,
      },
    );

    return response.text || '[Summary unavailable]';
  }
}
