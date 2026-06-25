import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
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

  it('loads the FULL history verbatim by default (no resume cap)', async () => {
    const { SessionStore } = await import('../SessionStore.js')
    const messages: ConversationMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'original long-running task' }] },
      ...Array.from({ length: 220 }, (_, i): ConversationMessage => ({
        role: i % 2 === 0 ? 'assistant' : 'user',
        content: [{ type: 'text', text: `recent-ish message ${i}` }],
      })),
    ]

    await SessionStore.append('session-c', meta(messages.length), messages, 0)

    const loaded = await SessionStore.loadHistory('session-c')
    expect(loaded).toHaveLength(221)                       // every message, verbatim
    expect(JSON.stringify(loaded)).not.toContain('[Local resume summary]')
    expect(loaded[0]).toEqual(messages[0])                 // earliest message preserved
    expect(JSON.stringify(loaded)).toContain('recent-ish message 219')
  })

  it('caps and summarizes when META_AGENT_MAX_RESUME_MESSAGES is set', async () => {
    const prev = process.env['META_AGENT_MAX_RESUME_MESSAGES']
    process.env['META_AGENT_MAX_RESUME_MESSAGES'] = '200'
    try {
      const { SessionStore } = await import('../SessionStore.js')
      const messages: ConversationMessage[] = [
        { role: 'user', content: [{ type: 'text', text: 'original long-running task' }] },
        ...Array.from({ length: 220 }, (_, i): ConversationMessage => ({
          role: i % 2 === 0 ? 'assistant' : 'user',
          content: [{ type: 'text', text: `recent-ish message ${i}` }],
        })),
      ]

      await SessionStore.append('session-c2', meta(messages.length), messages, 0)

      const loaded = await SessionStore.loadHistory('session-c2')
      expect(loaded).toHaveLength(200)
      expect(JSON.stringify(loaded[0])).toContain('[Local resume summary]')
      expect(JSON.stringify(loaded[0])).toContain('original long-running task')
      expect(JSON.stringify(loaded)).toContain('recent-ish message 219')
    } finally {
      if (prev === undefined) delete process.env['META_AGENT_MAX_RESUME_MESSAGES']
      else process.env['META_AGENT_MAX_RESUME_MESSAGES'] = prev
    }
  })

  it('does not resume from an orphan tool_result boundary (when capped)', async () => {
    // The orphan-boundary trim matters on the SUMMARY path (a capped window can
    // start mid tool_use/tool_result pair). Exercise it with an explicit cap.
    const prev = process.env['META_AGENT_MAX_RESUME_MESSAGES']
    process.env['META_AGENT_MAX_RESUME_MESSAGES'] = '200'
    try {
    const { SessionStore } = await import('../SessionStore.js')
    const messages: ConversationMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'initial request' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tool-1', name: 'bash', input: { command: 'echo old' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'old output' }],
      },
      ...Array.from({ length: 198 }, (_, i): ConversationMessage => ({
        role: i % 2 === 0 ? 'assistant' : 'user',
        content: [{ type: 'text', text: `safe message ${i}` }],
      })),
    ]

    await SessionStore.append('session-d', meta(messages.length), messages, 0)

    const loaded = await SessionStore.loadHistory('session-d')
    expect(JSON.stringify(loaded[0])).toContain('[Local resume summary]')
    expect(JSON.stringify(loaded[0])).toContain('tool_result blocks: 1')
    expect(loaded[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'safe message 0' }],
    })
    expect(JSON.stringify(loaded.slice(1, 3))).not.toContain('tool_result')
    } finally {
      if (prev === undefined) delete process.env['META_AGENT_MAX_RESUME_MESSAGES']
      else process.env['META_AGENT_MAX_RESUME_MESSAGES'] = prev
    }
  })

  it('can persist a session under a caller-provided root directory', async () => {
    const { SessionStore } = await import('../SessionStore.js')
    const rootDir = await mkdtemp(join(tmpdir(), 'meta-agent-one-shot-sessions-'))
    try {
      const messages: ConversationMessage[] = [
        { role: 'user', content: [{ type: 'text', text: 'single turn prompt' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'single turn answer' }] },
      ]

      await SessionStore.append('one-shot-session', meta(messages.length), messages, 0, { rootDir })

      const loaded = await SessionStore.loadHistory('one-shot-session', { rootDir })
      expect(loaded).toEqual(messages)
      const index = JSON.parse(await readFile(join(rootDir, 'index.json'), 'utf-8')) as unknown[]
      expect(index).toHaveLength(1)
      expect(index[0]).toMatchObject({ sessionId: 'one-shot-session', firstPrompt: 'first' })
      expect(existsSync(join(homeDir, '.meta-agent', 'sessions', 'one-shot-session'))).toBe(false)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })
})

describe('session titles', () => {
  it('updateTitle sets the title and per-turn persists preserve it', async () => {
    const { SessionStore } = await import('../SessionStore.js')
    const messages = [
      { role: 'user', content: [{ type: 'text', text: '增加对称性 reward' }] },
    ] as never[]

    await SessionStore.append('sess-1', meta(1), messages, 0)
    await SessionStore.updateTitle('sess-1', '步态对称性 reward 调参', 1)

    let [entry] = await SessionStore.listSessions(1)
    expect(entry?.title).toBe('步态对称性 reward 调参')
    expect(entry?.titleMessageCount).toBe(1)

    // A later per-turn persist rebuilds meta WITHOUT title fields — the
    // merge-preserving upsert must keep the generated title.
    await SessionStore.append('sess-1', meta(2), [...messages,
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } as never], 1)
    ;[entry] = await SessionStore.listSessions(1)
    expect(entry?.title).toBe('步态对称性 reward 调参')
    expect(entry?.messageCount).toBe(2)
  })

  it('updateTitle is a no-op for unknown sessions', async () => {
    const { SessionStore } = await import('../SessionStore.js')
    await SessionStore.updateTitle('nonexistent', 'x', 1)
    expect(await SessionStore.listSessions(5)).toEqual([])
  })
})
