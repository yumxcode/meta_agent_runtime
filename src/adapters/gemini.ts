/**
 * Google Gemini Native Adapter
 *
 * Uses @google/generative-ai SDK.
 * Supports gemini-2.0-flash, gemini-1.5-pro, gemini-1.5-flash, etc.
 */

import {
  GoogleGenerativeAI,
  HarmCategory,
  HarmBlockThreshold,
  SchemaType,
} from '@google/generative-ai';
import type {
  Content,
  Part,
  FunctionDeclaration,
  Tool as GeminiTool,
  GenerateContentResult,
} from '@google/generative-ai';

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

function jsonSchemaTypeToGemini(type: string): SchemaType {
  switch (type) {
    case 'string': return SchemaType.STRING;
    case 'number': return SchemaType.NUMBER;
    case 'integer': return SchemaType.INTEGER;
    case 'boolean': return SchemaType.BOOLEAN;
    case 'array': return SchemaType.ARRAY;
    case 'object': return SchemaType.OBJECT;
    default: return SchemaType.STRING;
  }
}

function convertJsonSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {
    type: jsonSchemaTypeToGemini((schema['type'] as string) ?? 'string'),
  };
  if (schema['description']) result['description'] = schema['description'];
  if (schema['enum']) result['enum'] = schema['enum'];
  if (schema['properties']) {
    result['properties'] = Object.fromEntries(
      Object.entries(schema['properties'] as Record<string, unknown>).map(([k, v]) => [
        k,
        convertJsonSchema(v as Record<string, unknown>),
      ]),
    );
  }
  if (schema['required']) result['required'] = schema['required'];
  if (schema['items']) result['items'] = convertJsonSchema(schema['items'] as Record<string, unknown>);
  return result;
}

function toolsToGemini(tools: ToolDefinition[]): GeminiTool[] {
  if (tools.length === 0) return [];
  const declarations: FunctionDeclaration[] = tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: convertJsonSchema(t.parameters as Record<string, unknown>) as unknown as FunctionDeclaration['parameters'],
  }));
  return [{ functionDeclarations: declarations }];
}

function messagesToGemini(messages: Message[]): {
  systemInstruction: string;
  contents: Content[];
} {
  let systemInstruction = '';
  const contents: Content[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemInstruction += (systemInstruction ? '\n\n' : '') + extractText(msg.content);
      continue;
    }

    if (msg.role === 'user') {
      contents.push({ role: 'user', parts: [{ text: extractText(msg.content) }] });
      continue;
    }

    if (msg.role === 'assistant') {
      const parts: Part[] = [];
      // Tool calls
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
          let args: Record<string, unknown> = {};
          try { args = JSON.parse(tc.function.arguments); } catch { /* ignore */ }
          parts.push({ functionCall: { name: tc.function.name, args } });
        }
      }
      const text = extractText(msg.content);
      if (text) parts.push({ text });
      contents.push({ role: 'model', parts });
      continue;
    }

    if (msg.role === 'tool') {
      // Gemini wants tool responses as 'function' role with functionResponse
      const lastContent = contents[contents.length - 1];
      const responsePart: Part = {
        functionResponse: {
          name: msg.name ?? msg.tool_call_id ?? 'tool',
          response: { output: extractText(msg.content) },
        },
      };
      // Append to previous user message if it exists, otherwise create new one
      if (lastContent?.role === 'user') {
        lastContent.parts.push(responsePart);
      } else {
        contents.push({ role: 'user', parts: [responsePart] });
      }
      continue;
    }
  }

  return { systemInstruction, contents };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class GeminiAdapter implements LLMAdapter {
  readonly name = 'gemini';
  readonly model: string;

  private genAI: GoogleGenerativeAI;

  constructor(config: ProviderConfig) {
    this.model = config.model;
    this.genAI = new GoogleGenerativeAI(config.apiKey);
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
    const { systemInstruction, contents } = messagesToGemini(messages);
    const geminiTools = toolsToGemini(tools);

    const genModel = this.genAI.getGenerativeModel({
      model: this.model,
      ...(systemInstruction ? { systemInstruction } : {}),
      ...(geminiTools.length > 0 ? { tools: geminiTools } : {}),
      safetySettings: [
        {
          category: HarmCategory.HARM_CATEGORY_HARASSMENT,
          threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH,
        },
        {
          category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
          threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH,
        },
      ],
      generationConfig: {
        ...(options.maxTokens !== undefined ? { maxOutputTokens: options.maxTokens } : {}),
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(options.topP !== undefined ? { topP: options.topP } : {}),
      },
    });

    // -----------------------------------------------------------------------
    // Streaming path
    // -----------------------------------------------------------------------
    if (options.stream && options.onStreamDelta) {
      return this._callStream(genModel, contents, options.onStreamDelta);
    }

    // -----------------------------------------------------------------------
    // Non-streaming path
    // -----------------------------------------------------------------------
    const result = await genModel.generateContent({ contents });
    return this._parseResult(result);
  }

  private async _callStream(
    genModel: ReturnType<GoogleGenerativeAI['getGenerativeModel']>,
    contents: Content[],
    onDelta: (delta: string) => void,
  ): Promise<LLMResponse> {
    const { stream, response } = await genModel.generateContentStream({ contents });
    let textAccum = '';

    for await (const chunk of stream) {
      const text = chunk.text?.() ?? '';
      if (text) {
        textAccum += text;
        onDelta(text);
      }
    }

    const finalResponse = await response;
    return this._parseResult({ response: finalResponse } as GenerateContentResult, textAccum);
  }

  private _parseResult(result: GenerateContentResult, overrideText?: string): LLMResponse {
    const candidate = result.response.candidates?.[0];
    const content = candidate?.content;
    const toolCalls: ParsedToolCall[] = [];
    let text = overrideText ?? '';

    if (!overrideText) {
      for (const part of content?.parts ?? []) {
        if (part.text) text += part.text;
        if (part.functionCall) {
          toolCalls.push({
            id: `fc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            name: part.functionCall.name,
            args: (part.functionCall.args as Record<string, unknown>) ?? {},
          });
        }
      }
    } else {
      // Parse tool calls from parts
      for (const part of content?.parts ?? []) {
        if (part.functionCall) {
          toolCalls.push({
            id: `fc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            name: part.functionCall.name,
            args: (part.functionCall.args as Record<string, unknown>) ?? {},
          });
        }
      }
    }

    return {
      text,
      toolCalls,
      stopReason: candidate?.finishReason?.toString(),
      usage: {
        inputTokens: result.response.usageMetadata?.promptTokenCount,
        outputTokens: result.response.usageMetadata?.candidatesTokenCount,
      },
    };
  }
}
