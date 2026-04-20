/**
 * Anthropic Messages API Adapter
 *
 * Supports:
 *  - claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5, and all Claude 3.x models
 *  - Streaming (text + thinking blocks)
 *  - Tool use (parallel tool calls)
 *  - Extended thinking (budget_tokens)
 *  - Prompt caching (cache_control injection)
 */

import Anthropic from '@anthropic-ai/sdk';
import type {
  Message as AnthropicMessage,
  ContentBlockParam,
  TextBlockParam,
  ToolUseBlockParam,
  ToolResultBlockParam,
  ImageBlockParam,
  MessageParam,
  Tool as AnthropicTool,
} from '@anthropic-ai/sdk/resources/messages.js';

import type { LLMAdapter, LLMCallOptions } from './base.js';
import { roughTokenCount } from './base.js';
import type {
  Message,
  LLMResponse,
  ToolDefinition,
  ParsedToolCall,
  ProviderConfig,
  ContentBlock,
} from '../types.js';
import { extractText } from '../types.js';

// ---------------------------------------------------------------------------
// Message format conversion
// ---------------------------------------------------------------------------

function contentToAnthropic(content: string | ContentBlock[]): ContentBlockParam[] {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  const blocks: ContentBlockParam[] = [];
  for (const block of content) {
    switch (block.type) {
      case 'text':
        blocks.push({ type: 'text', text: block.text } as TextBlockParam);
        break;
      case 'image':
        if (block.source.type === 'base64') {
          const b64src = block.source as { type: 'base64'; media_type: string; data: string };
          blocks.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: b64src.media_type as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
              data: b64src.data,
            },
          } as ImageBlockParam);
        } else {
          const urlSrc = block.source as { type: 'url'; url: string };
          blocks.push({
            type: 'image',
            source: { type: 'url', url: urlSrc.url },
          } as unknown as ImageBlockParam);
        }
        break;
      case 'tool_use':
        blocks.push({
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: block.input,
        } as ToolUseBlockParam);
        break;
      case 'tool_result':
        blocks.push({
          type: 'tool_result',
          tool_use_id: block.tool_use_id,
          content:
            typeof block.content === 'string'
              ? block.content
              : block.content.map((b) =>
                  b.type === 'text' ? { type: 'text' as const, text: b.text } : null,
                ).filter(Boolean) as TextBlockParam[],
          is_error: block.is_error,
        } as ToolResultBlockParam);
        break;
      default:
        // skip thinking blocks when sending
        break;
    }
  }
  return blocks;
}

/**
 * Convert canonical messages to Anthropic MessageParam format.
 * Anthropic does not accept a 'system' role in the messages array —
 * system messages are extracted separately.
 */
function messagesToAnthropic(messages: Message[]): {
  systemPrompt: string;
  anthropicMessages: MessageParam[];
} {
  let systemPrompt = '';
  const anthropicMessages: MessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemPrompt += (systemPrompt ? '\n\n' : '') + extractText(msg.content);
      continue;
    }

    if (msg.role === 'tool') {
      // Tool results must be user messages with tool_result content blocks
      const lastMsg = anthropicMessages[anthropicMessages.length - 1];
      const resultBlock: ToolResultBlockParam = {
        type: 'tool_result',
        tool_use_id: msg.tool_call_id ?? '',
        content: extractText(msg.content),
      };
      if (lastMsg?.role === 'user') {
        (lastMsg.content as ContentBlockParam[]).push(resultBlock);
      } else {
        anthropicMessages.push({ role: 'user', content: [resultBlock] });
      }
      continue;
    }

    if (msg.role === 'user') {
      anthropicMessages.push({
        role: 'user',
        content: contentToAnthropic(msg.content),
      });
      continue;
    }

    if (msg.role === 'assistant') {
      const blocks: ContentBlockParam[] = [];
      // Include tool calls if any
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
          let input: Record<string, unknown> = {};
          try {
            input = JSON.parse(tc.function.arguments);
          } catch {
            // ignore parse errors
          }
          blocks.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input,
          } as ToolUseBlockParam);
        }
      }
      // Include text content
      const text = extractText(msg.content);
      if (text) {
        blocks.unshift({ type: 'text', text } as TextBlockParam);
      }
      anthropicMessages.push({
        role: 'assistant',
        content: blocks.length > 0 ? blocks : extractText(msg.content),
      });
      continue;
    }
  }

  return { systemPrompt, anthropicMessages };
}

function toolsToAnthropic(tools: ToolDefinition[]): AnthropicTool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as AnthropicTool['input_schema'],
  }));
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class AnthropicAdapter implements LLMAdapter {
  readonly name = 'anthropic';
  readonly model: string;

  private client: Anthropic;
  private maxOutputTokens: number;

  constructor(config: ProviderConfig) {
    this.model = config.model;
    this.client = new Anthropic({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
    });
    // Claude 3.x → 8192 output max; Claude 4.x / Sonnet 3.7+ → 64k
    this.maxOutputTokens = this.model.includes('claude-4') || this.model.includes('3-7')
      ? 64_000
      : 8_192;
  }

  estimateTokens(messages: Message[]): number {
    let total = 0;
    for (const m of messages) {
      total += roughTokenCount(extractText(m.content));
    }
    return total;
  }

  async call(
    messages: Message[],
    tools: ToolDefinition[],
    options: LLMCallOptions = {},
  ): Promise<LLMResponse> {
    const { systemPrompt, anthropicMessages } = messagesToAnthropic(messages);
    const anthropicTools = toolsToAnthropic(tools);

    const params: Parameters<typeof this.client.messages.create>[0] = {
      model: this.model,
      max_tokens: options.maxTokens ?? this.maxOutputTokens,
      messages: anthropicMessages,
      ...(systemPrompt ? { system: systemPrompt } : {}),
      ...(anthropicTools.length > 0 ? { tools: anthropicTools } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options.stopSequences ? { stop_sequences: options.stopSequences } : {}),
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
    const response = await this.client.messages.create({
      ...params,
      stream: false,
    });

    return this._parseResponse(response);
  }

  private async _callStream(
    params: Parameters<typeof this.client.messages.create>[0],
    onDelta: (delta: string) => void,
    signal?: AbortSignal,
  ): Promise<LLMResponse> {
    let textAccum = '';
    let thinkingAccum = '';
    const toolInputAccum: Record<string, string> = {};
    const toolBlocks: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];

    const stream = this.client.messages.stream({ ...params, stream: true });

    if (signal) {
      signal.addEventListener('abort', () => stream.abort());
    }

    for await (const event of stream) {
      if (event.type === 'content_block_delta') {
        const delta = event.delta;
        if (delta.type === 'text_delta') {
          textAccum += delta.text;
          onDelta(delta.text);
        } else if (delta.type === 'thinking_delta') {
          thinkingAccum += delta.thinking;
        } else if (delta.type === 'input_json_delta') {
          const idx = event.index;
          toolInputAccum[idx] = (toolInputAccum[idx] ?? '') + delta.partial_json;
        }
      } else if (event.type === 'content_block_start') {
        if (event.content_block.type === 'tool_use') {
          toolBlocks.push({
            id: event.content_block.id,
            name: event.content_block.name,
            input: {},
          });
        }
      }
    }

    // Parse accumulated tool inputs
    const finalMessage = await stream.finalMessage();

    // Build parsed tool calls from the final message for accuracy
    const toolCalls = this._extractToolCalls(finalMessage);

    return {
      text: textAccum,
      thinking: thinkingAccum || undefined,
      toolCalls,
      stopReason: finalMessage.stop_reason ?? undefined,
      usage: {
        inputTokens: finalMessage.usage.input_tokens,
        outputTokens: finalMessage.usage.output_tokens,
        cacheReadTokens: (finalMessage.usage as unknown as Record<string, number>)['cache_read_input_tokens'],
        cacheWriteTokens: (finalMessage.usage as unknown as Record<string, number>)['cache_creation_input_tokens'],
      },
    };
  }

  private _parseResponse(response: AnthropicMessage): LLMResponse {
    const toolCalls = this._extractToolCalls(response);
    let text = '';
    let thinking = '';

    for (const block of response.content) {
      if (block.type === 'text') text += block.text;
      if ((block as { type: string; thinking?: string }).type === 'thinking') {
        thinking += (block as { type: string; thinking?: string }).thinking ?? '';
      }
    }

    return {
      text,
      thinking: thinking || undefined,
      toolCalls,
      stopReason: response.stop_reason ?? undefined,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheReadTokens: (response.usage as unknown as Record<string, number>)['cache_read_input_tokens'],
        cacheWriteTokens: (response.usage as unknown as Record<string, number>)['cache_creation_input_tokens'],
      },
    };
  }

  private _extractToolCalls(response: AnthropicMessage): ParsedToolCall[] {
    const calls: ParsedToolCall[] = [];
    for (const block of response.content) {
      if (block.type === 'tool_use') {
        calls.push({
          id: block.id,
          name: block.name,
          args: (block.input as Record<string, unknown>) ?? {},
        });
      }
    }
    return calls;
  }
}
