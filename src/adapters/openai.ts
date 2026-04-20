/**
 * OpenAI-compatible Adapter
 *
 * Works with:
 *  - OpenAI (gpt-4o, o1, etc.)
 *  - OpenRouter (openrouter.ai)
 *  - Local models via vLLM / llama.cpp / Ollama
 *  - GLM (Zhipu AI) — set baseUrl to https://open.bigmodel.cn/api/paas/v4
 *  - Any API that speaks the OpenAI Chat Completions protocol
 */

import OpenAI from 'openai';
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionChunk,
} from 'openai/resources/chat/completions.js';

import type { LLMAdapter, LLMCallOptions } from './base.js';
import { roughTokenCount } from './base.js';
import type {
  Message,
  LLMResponse,
  ToolDefinition,
  ParsedToolCall,
  ProviderConfig,
} from '../types.js';
import { extractText } from '../types.js';

// ---------------------------------------------------------------------------
// Message conversion
// ---------------------------------------------------------------------------

function messagesToOpenAI(messages: Message[]): ChatCompletionMessageParam[] {
  const result: ChatCompletionMessageParam[] = [];

  for (const msg of messages) {
    switch (msg.role) {
      case 'system':
        result.push({ role: 'system', content: extractText(msg.content) });
        break;

      case 'user':
        result.push({ role: 'user', content: extractText(msg.content) });
        break;

      case 'assistant': {
        const text = extractText(msg.content);
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          result.push({
            role: 'assistant',
            content: text || null,
            tool_calls: msg.tool_calls.map((tc) => ({
              id: tc.id,
              type: 'function' as const,
              function: {
                name: tc.function.name,
                arguments: tc.function.arguments,
              },
            })),
          });
        } else {
          result.push({ role: 'assistant', content: text });
        }
        break;
      }

      case 'tool':
        result.push({
          role: 'tool',
          tool_call_id: msg.tool_call_id ?? '',
          content: extractText(msg.content),
        });
        break;
    }
  }

  return result;
}

function toolsToOpenAI(tools: ToolDefinition[]): ChatCompletionTool[] {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class OpenAIAdapter implements LLMAdapter {
  readonly name: string;
  readonly model: string;

  private client: OpenAI;

  constructor(config: ProviderConfig) {
    this.name = config.type; // 'openai' | 'glm' etc.
    this.model = config.model;
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
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
    const openAIMessages = messagesToOpenAI(messages);
    const openAITools = toolsToOpenAI(tools);

    const params: Parameters<typeof this.client.chat.completions.create>[0] = {
      model: this.model,
      messages: openAIMessages,
      ...(openAITools.length > 0
        ? { tools: openAITools, tool_choice: 'auto' as const }
        : {}),
      ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options.topP !== undefined ? { top_p: options.topP } : {}),
      ...(options.stopSequences ? { stop: options.stopSequences } : {}),
    };

    // -----------------------------------------------------------------------
    // Streaming path
    // -----------------------------------------------------------------------
    if (options.stream && options.onStreamDelta) {
      return this._callStream(params, options.onStreamDelta, options.signal);
    }

    // -----------------------------------------------------------------------
    // Non-streaming path
    // -----------------------------------------------------------------------
    const response = await this.client.chat.completions.create({
      ...params,
      stream: false,
    });

    const choice = response.choices[0];
    const message = choice?.message;

    const toolCalls: ParsedToolCall[] = [];
    for (const tc of message?.tool_calls ?? []) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function.arguments);
      } catch {
        // ignore
      }
      toolCalls.push({ id: tc.id, name: tc.function.name, args });
    }

    return {
      text: message?.content ?? '',
      toolCalls,
      stopReason: choice?.finish_reason ?? undefined,
      usage: {
        inputTokens: response.usage?.prompt_tokens,
        outputTokens: response.usage?.completion_tokens,
      },
    };
  }

  private async _callStream(
    params: Parameters<typeof this.client.chat.completions.create>[0],
    onDelta: (delta: string) => void,
    signal?: AbortSignal,
  ): Promise<LLMResponse> {
    let textAccum = '';
    const toolCallAccum: Record<
      number,
      { id: string; name: string; arguments: string }
    > = {};
    let finishReason: string | null = null;

    const stream = await this.client.chat.completions.create({
      ...params,
      stream: true,
    }, { signal });

    for await (const chunk of stream as AsyncIterable<ChatCompletionChunk>) {
      const choice = chunk.choices[0];
      if (!choice) continue;

      finishReason = choice.finish_reason ?? finishReason;

      const delta = choice.delta;
      if (delta.content) {
        textAccum += delta.content;
        onDelta(delta.content);
      }

      for (const tc of delta.tool_calls ?? []) {
        const idx = tc.index;
        if (!toolCallAccum[idx]) {
          toolCallAccum[idx] = { id: tc.id ?? '', name: tc.function?.name ?? '', arguments: '' };
        }
        if (tc.id) toolCallAccum[idx].id = tc.id;
        if (tc.function?.name) toolCallAccum[idx].name = tc.function.name;
        if (tc.function?.arguments) toolCallAccum[idx].arguments += tc.function.arguments;
      }
    }

    const toolCalls: ParsedToolCall[] = Object.values(toolCallAccum).map((tc) => {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(tc.arguments); } catch { /* ignore */ }
      return { id: tc.id, name: tc.name, args };
    });

    return {
      text: textAccum,
      toolCalls,
      stopReason: finishReason ?? undefined,
    };
  }
}
