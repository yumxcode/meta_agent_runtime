/**
 * Base LLM Adapter interface.
 *
 * Every provider adapter must implement this interface so the agent runtime
 * can swap providers transparently.
 */

import type { Message, LLMResponse, ToolDefinition, ProviderConfig } from '../types.js';

export interface LLMCallOptions {
  /** Maximum tokens to generate. */
  maxTokens?: number;
  /** Temperature (0–1). */
  temperature?: number;
  /** Top-p sampling. */
  topP?: number;
  /** Stop sequences. */
  stopSequences?: string[];
  /** Whether to stream the response. */
  stream?: boolean;
  /** Called for each token delta during streaming. */
  onStreamDelta?: (delta: string) => void;
  /** AbortSignal for cancellation. */
  signal?: AbortSignal;
}

/** The contract every LLM adapter must satisfy. */
export interface LLMAdapter {
  /** Human-readable name for logging. */
  readonly name: string;
  /** The model string being used. */
  readonly model: string;

  /**
   * Send a conversation to the LLM and return a normalised response.
   *
   * @param messages    Full conversation history in canonical format.
   * @param tools       Tool definitions the model may call (empty = no tools).
   * @param options     Call-level overrides.
   */
  call(
    messages: Message[],
    tools: ToolDefinition[],
    options?: LLMCallOptions,
  ): Promise<LLMResponse>;

  /**
   * Estimate the number of tokens in a message list.
   * This is an approximation — adapters may use tiktoken, SDK helpers, or heuristics.
   */
  estimateTokens(messages: Message[]): number;
}

/** Create the appropriate adapter from a ProviderConfig. */
export type AdapterFactory = (config: ProviderConfig) => LLMAdapter;

// ---------------------------------------------------------------------------
// Shared utilities
// ---------------------------------------------------------------------------

/** Rough token estimator: ~4 chars per token (GPT heuristic). */
export function roughTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Known context window sizes for popular models.
 * Falls back to 128 000 if the model is not found.
 */
export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // Anthropic
  'claude-opus-4-6': 200_000,
  'claude-sonnet-4-6': 200_000,
  'claude-haiku-4-5': 200_000,
  'claude-3-5-sonnet-20241022': 200_000,
  'claude-3-5-haiku-20241022': 200_000,
  'claude-3-opus-20240229': 200_000,
  // OpenAI
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
  'gpt-4-turbo': 128_000,
  'gpt-4': 8_192,
  'gpt-3.5-turbo': 16_385,
  'o1': 200_000,
  'o1-mini': 128_000,
  // Google
  'gemini-2.0-flash': 1_000_000,
  'gemini-1.5-pro': 2_000_000,
  'gemini-1.5-flash': 1_000_000,
  // GLM (Zhipu)
  'glm-4': 128_000,
  'glm-4-air': 128_000,
  'glm-4-flash': 128_000,
  'glm-4-plus': 128_000,
};

export function getContextWindow(model: string): number {
  // Exact match first
  if (MODEL_CONTEXT_WINDOWS[model]) return MODEL_CONTEXT_WINDOWS[model];
  // Prefix match
  for (const [key, size] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
    if (model.startsWith(key)) return size;
  }
  return 128_000;
}
