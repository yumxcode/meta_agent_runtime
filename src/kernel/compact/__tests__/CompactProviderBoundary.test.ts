import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { compactConversation } from '../CompactConversation.js'
import { FileStateCache } from '../../session/FileStateCache.js'
import type { KernelMessage } from '../../types/KernelMessage.js'

// Minimal but non-trivial history so compaction proceeds to the side-call.
const messages: KernelMessage[] = [
  { uuid: 'u1', role: 'user', content: [{ type: 'text', text: 'do the task with detail. '.repeat(20) }] },
  { uuid: 'a1', role: 'assistant', content: [{ type: 'text', text: 'working through the steps. '.repeat(20) }] },
] as unknown as KernelMessage[]

describe('compact provider-boundary key safety (#4)', () => {
  let prevDS: string | undefined
  let prevAnth: string | undefined

  beforeEach(() => {
    prevDS = process.env['DEEPSEEK_API_KEY']
    prevAnth = process.env['ANTHROPIC_API_KEY']
    delete process.env['DEEPSEEK_API_KEY']
  })
  afterEach(() => {
    if (prevDS === undefined) delete process.env['DEEPSEEK_API_KEY']
    else process.env['DEEPSEEK_API_KEY'] = prevDS
    if (prevAnth === undefined) delete process.env['ANTHROPIC_API_KEY']
    else process.env['ANTHROPIC_API_KEY'] = prevAnth
  })

  it('fails fast on the DeepSeek (openai-protocol) path when no DeepSeek key exists', async () => {
    delete process.env['ANTHROPIC_API_KEY']
    await expect(
      compactConversation(messages, new FileStateCache(), { model: 'deepseek-chat' }),
    ).rejects.toThrow(/DeepSeek-compatible API key/)
  })

  it('does NOT fall back to ANTHROPIC_API_KEY on the DeepSeek path (no cross-provider key leak)', async () => {
    // An Anthropic key in the environment must NEVER be shipped to api.deepseek.com.
    // With the old `?? ANTHROPIC_API_KEY` fallback the client would have been built
    // with this key and attempted a network call; now it fails fast instead.
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-must-not-be-used'
    await expect(
      compactConversation(messages, new FileStateCache(), { model: 'deepseek-chat' }),
    ).rejects.toThrow(/DeepSeek-compatible API key/)
  })
})
