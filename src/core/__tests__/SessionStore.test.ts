import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConversationMessage } from '../types.js'

let homeDir: string
let previousMetaAgentHome: string | undefined

beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), 'meta-agent-session-store-'))
  previousMetaAgentHome = process.env['META_AGENT_HOME']
  process.env['META_AGENT_HOME'] = join(homeDir, '.meta-agent')
  vi.resetModules()
  vi.doMock('node:os', async () => {
    const actual = await vi.importActual<typeof import('node:os')>('node:os')
    return { ...actual, homedir: () => homeDir }
  })
})

afterEach(async () => {
  if (previousMetaAgentHome === undefined) delete process.env['META_AGENT_HOME']
  else process.env['META_AGENT_HOME'] = previousMetaAgentHome
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

  it('atomically serializes concurrent history replacements', async () => {
    const { SessionStore } = await import('../SessionStore.js')
    const rootDir = await mkdtemp(join(tmpdir(), 'meta-agent-session-race-'))
    try {
      const a: ConversationMessage[] = [
        { role: 'user', content: [{ type: 'text', text: `A-${'a'.repeat(200_000)}` }] },
      ]
      const b: ConversationMessage[] = [
        { role: 'user', content: [{ type: 'text', text: `B-${'b'.repeat(200_000)}` }] },
      ]
      await Promise.all([
        SessionStore.replace('shared', meta(1), a, { rootDir }),
        SessionStore.replace('shared', meta(1), b, { rootDir }),
      ])
      const loaded = await SessionStore.loadHistory('shared', { rootDir })
      expect(loaded).toHaveLength(1)
      expect([a[0]!.content, b[0]!.content]).toContainEqual(loaded[0]!.content)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('self-heals a diverged append by rewriting the full history (never stalls persistence)', async () => {
    const { SessionStore } = await import('../SessionStore.js')
    const rootDir = await mkdtemp(join(tmpdir(), 'meta-agent-session-conflict-'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const first: ConversationMessage[] = [
        { role: 'user', content: [{ type: 'text', text: 'one' }] },
      ]
      await SessionStore.append('shared', meta(1), first, 0, { rootDir })

      // A diverged caller (index says 1 persisted, caller believes 0): must NOT
      // throw and must NOT duplicate — the in-memory transcript wins wholesale.
      const diverged: ConversationMessage[] = [
        ...first,
        { role: 'assistant', content: [{ type: 'text', text: 'diverged' }] },
      ]
      await SessionStore.append('shared', meta(2), diverged, 0, { rootDir })
      expect(await SessionStore.loadHistory('shared', { rootDir })).toEqual(diverged)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('divergence'))

      // Persistence keeps working on subsequent turns.
      const next: ConversationMessage[] = [
        ...diverged,
        { role: 'user', content: [{ type: 'text', text: 'more' }] },
      ]
      await SessionStore.append('shared', meta(3), next, 2, { rootDir })
      expect(await SessionStore.loadHistory('shared', { rootDir })).toEqual(next)
    } finally {
      warn.mockRestore()
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('replace proceeds (loudly) past an expectedMessageCount mismatch', async () => {
    const { SessionStore } = await import('../SessionStore.js')
    const rootDir = await mkdtemp(join(tmpdir(), 'meta-agent-session-replace-conflict-'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const first: ConversationMessage[] = [
        { role: 'user', content: [{ type: 'text', text: 'one' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'two' }] },
      ]
      await SessionStore.append('s', meta(2), first, 0, { rootDir })
      const compacted: ConversationMessage[] = [
        { role: 'user', content: [{ type: 'text', text: 'summary' }] },
      ]
      await SessionStore.replace('s', meta(1), compacted, { rootDir, expectedMessageCount: 99 })
      expect(await SessionStore.loadHistory('s', { rootDir })).toEqual(compacted)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('divergence'))
    } finally {
      warn.mockRestore()
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('removes the physical directory when a session falls out of the bounded index', async () => {
    const { SessionStore } = await import('../SessionStore.js')
    const rootDir = await mkdtemp(join(tmpdir(), 'meta-agent-session-evict-'))
    try {
      for (let i = 0; i < 51; i++) {
        const messages: ConversationMessage[] = [
          { role: 'user', content: [{ type: 'text', text: `session ${i}` }] },
        ]
        await SessionStore.append(`session-${i}`, {
          ...meta(1), lastActivity: i,
        }, messages, 0, { rootDir })
      }
      expect(await SessionStore.listSessions(100, { rootDir })).toHaveLength(50)
      expect(SessionStore.sessionExists('session-0', { rootDir })).toBe(false)
      expect(SessionStore.sessionExists('session-50', { rootDir })).toBe(true)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('eviction spares a recently-active session directory (grace window)', async () => {
    const { SessionStore } = await import('../SessionStore.js')
    const rootDir = await mkdtemp(join(tmpdir(), 'meta-agent-session-evict-grace-'))
    try {
      const now = Date.now()
      for (let i = 0; i < 51; i++) {
        const messages: ConversationMessage[] = [
          { role: 'user', content: [{ type: 'text', text: `session ${i}` }] },
        ]
        // session-0 is the least recently active → evicted first, but its
        // lastActivity is recent, so the default 24h grace must spare its dir.
        await SessionStore.append(`session-${i}`, {
          ...meta(1), lastActivity: i === 0 ? now - 60_000 : now + i,
        }, messages, 0, { rootDir })
      }
      expect(await SessionStore.listSessions(100, { rootDir })).toHaveLength(50)
      expect((await SessionStore.listSessions(100, { rootDir }))
        .some(s => s.sessionId === 'session-0')).toBe(false)
      expect(SessionStore.sessionExists('session-0', { rootDir })).toBe(true)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('eviction sweeps stale unindexed orphan directories', async () => {
    const { SessionStore } = await import('../SessionStore.js')
    const rootDir = await mkdtemp(join(tmpdir(), 'meta-agent-session-sweep-'))
    process.env['META_AGENT_SESSION_EVICT_GRACE_MS'] = '0'
    try {
      const fs = await import('node:fs/promises')
      const orphan = join(rootDir, 'legacy-orphan')
      await fs.mkdir(orphan, { recursive: true })
      await fs.writeFile(join(orphan, 'history.jsonl'), '{}\n')
      // Trigger an eviction (index overflow) — the sweep rides on it.
      for (let i = 0; i < 51; i++) {
        await SessionStore.append(`session-${i}`, {
          ...meta(1), lastActivity: i,
        }, [{ role: 'user', content: [{ type: 'text', text: `s${i}` }] }], 0, { rootDir })
      }
      expect(existsSync(orphan)).toBe(false)
    } finally {
      delete process.env['META_AGENT_SESSION_EVICT_GRACE_MS']
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('deleteAllSessions also removes legacy directories absent from the index', async () => {
    const { SessionStore } = await import('../SessionStore.js')
    const rootDir = await mkdtemp(join(tmpdir(), 'meta-agent-session-orphan-'))
    try {
      const orphan = join(rootDir, 'legacy-orphan')
      await import('node:fs/promises').then(fs => fs.mkdir(orphan, { recursive: true }))
      await import('node:fs/promises').then(fs => fs.writeFile(join(orphan, 'history.jsonl'), '{}\n'))
      await SessionStore.deleteAllSessions({ rootDir })
      expect(existsSync(orphan)).toBe(false)
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
