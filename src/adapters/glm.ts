/**
 * GLM (Zhipu AI) Adapter
 *
 * GLM-4 series uses an OpenAI-compatible API, so this adapter is a thin
 * wrapper around the OpenAI adapter with Zhipu's base URL pre-configured.
 *
 * Models: glm-4, glm-4-air, glm-4-flash, glm-4-plus, glm-4v, etc.
 * API docs: https://open.bigmodel.cn/dev/api
 *
 * GLM also supports a custom JWT-based auth in addition to simple API keys.
 * When `useJwt` is set, the adapter generates a short-lived JWT token.
 */

import { OpenAIAdapter } from './openai.js';
import type { LLMAdapter, LLMCallOptions } from './base.js';
import { roughTokenCount } from './base.js';
import type {
  Message,
  LLMResponse,
  ToolDefinition,
  ProviderConfig,
} from '../types.js';
import { extractText } from '../types.js';

export const GLM_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4';

// ---------------------------------------------------------------------------
// JWT generation (optional — only if glm_jwt is passed via options)
// ---------------------------------------------------------------------------

/**
 * Generate a GLM JWT token from an api_key of the form "id.secret".
 * The token is valid for 30 seconds.
 */
async function generateGlmJwt(apiKey: string): Promise<string> {
  const parts = apiKey.split('.');
  if (parts.length !== 2) {
    throw new Error(`GLM JWT apiKey must be in format "id.secret", got: ${apiKey}`);
  }
  const [id, secret] = parts;

  const header = { alg: 'HS256', sign_type: 'SIGN' };
  const payload = {
    api_key: id,
    exp: Math.floor(Date.now() / 1000) + 30,
    timestamp: Math.floor(Date.now() / 1000),
  };

  const base64url = (obj: object): string =>
    Buffer.from(JSON.stringify(obj)).toString('base64url');

  const signingInput = `${base64url(header)}.${base64url(payload)}`;

  // Node.js crypto HMAC-SHA256
  const crypto = await import('crypto');
  const hmac = crypto.createHmac('sha256', secret as string);
  hmac.update(signingInput);
  const sig = hmac.digest('base64url');

  return `${signingInput}.${sig}`;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class GLMAdapter implements LLMAdapter {
  readonly name = 'glm';
  readonly model: string;

  private inner: OpenAIAdapter;
  private useJwt: boolean;
  private rawApiKey: string;

  constructor(config: ProviderConfig) {
    this.model = config.model;
    this.rawApiKey = config.apiKey;
    this.useJwt = !!(config.options?.['useJwt']);

    // Build the inner OpenAI-compatible adapter
    this.inner = new OpenAIAdapter({
      ...config,
      type: 'openai',
      baseUrl: config.baseUrl ?? GLM_BASE_URL,
      // If JWT mode, we'll override the apiKey at call time
      apiKey: this.useJwt ? 'placeholder' : config.apiKey,
    });
  }

  estimateTokens(messages: Message[]): number {
    let total = 0;
    for (const m of messages) total += roughTokenCount(extractText(m.content));
    return total;
  }

  async call(
    messages: Message[],
    tools: ToolDefinition[],
    options: LLMCallOptions = {},
  ): Promise<LLMResponse> {
    if (this.useJwt) {
      // Rebuild adapter with fresh JWT token each call
      const jwt = await generateGlmJwt(this.rawApiKey);
      const jwtAdapter = new OpenAIAdapter({
        type: 'openai',
        model: this.model,
        apiKey: jwt,
        baseUrl: GLM_BASE_URL,
      });
      return jwtAdapter.call(messages, tools, options);
    }

    return this.inner.call(messages, tools, options);
  }
}
