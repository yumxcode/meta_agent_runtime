/**
 * Adapter factory — creates the appropriate LLM adapter from a ProviderConfig.
 */

export { AnthropicAdapter } from './anthropic.js';
export { OpenAIAdapter } from './openai.js';
export { GeminiAdapter } from './gemini.js';
export { GLMAdapter } from './glm.js';
export { roughTokenCount, getContextWindow, MODEL_CONTEXT_WINDOWS } from './base.js';
export type { LLMAdapter, LLMCallOptions, AdapterFactory } from './base.js';

import type { ProviderConfig } from '../types.js';
import type { LLMAdapter } from './base.js';
import { AnthropicAdapter } from './anthropic.js';
import { OpenAIAdapter } from './openai.js';
import { GeminiAdapter } from './gemini.js';
import { GLMAdapter } from './glm.js';

export function createAdapter(config: ProviderConfig): LLMAdapter {
  switch (config.type) {
    case 'anthropic':
      return new AnthropicAdapter(config);
    case 'openai':
      return new OpenAIAdapter(config);
    case 'gemini':
      return new GeminiAdapter(config);
    case 'glm':
      return new GLMAdapter(config);
    default:
      throw new Error(`Unknown provider type: ${(config as ProviderConfig).type}`);
  }
}
