import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConversationMessage } from '../types.js'

let homeDir: string

beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), 'meta-agent-session-store-'))
  vi.resetModules()
  vi.doMock('node:os', async () => {
    const actual = await vi.importActual<typeof import('node:os')>('node:os')
    return { ...actual, homedir: () => homeDir }
  })
})

afterEach(async () => {
  vi.doUnmock('node:os')
  vi.resetModules()
  await rm(homeDir, { recursive: true, force: true })
})

function meta(messageCount: number) {
  return {
    mode: 'agentic',
    startTime: 1,
    lastActivity: 2,
    messageCount,
    firstPrompt: 'first',
    workspace: '/tmp/workspace',
  }
}

describe('SessionStore', () => {
  it('does not persist thinking blocks or thinking-only assistant messages', async () => {
    const { SessionStore } = await import('../SessionStore.js')
    const messages: ConversationMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'private chain', signature: 'sig' },
          { type: 'redacted_thinking', data: 'opaque' },
          { type: 'text', text: 'visible answer' },
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'only private', signature: 'sig2' }],
      },
    ]

    await SessionStore.append('session-a', meta(messages.length), messages, 0)

    const loaded = await SessionStore.loadHistory('session-a')
    expect(loaded).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'visible answer' }] },
    ])
  })

  it('replace rewrites compacted history instead of appending by stale index', async () => {
    const { SessionStore } = await import('../SessionStore.js')
    const original: ConversationMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'old prompt' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'old answer' }] },
      { role: 'user', content: [{ type: 'text', text: 'old follow-up' }] },
    ]
    const compacted: ConversationMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'compact summary' }] },
      { role: 'user', content: [{ type: 'text', text: 'new prompt' }] },
    ]

    await SessionStore.append('session-b', meta(original.length), original, 0)
    await SessionStore.replace('session-b', meta(compacted.length), compacted)

    const loaded = await SessionStore.loadHistory('session-b')
    expect(loaded).toEqual(compacted)
    expect(JSON.stringify(loaded)).not.toContain('old answer')
  })
})
