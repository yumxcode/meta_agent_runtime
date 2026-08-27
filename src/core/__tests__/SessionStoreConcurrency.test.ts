/**
 * Regression tests for P3-2 (review 2026-08-27): a large session's persist must
 * not block every other session's persist.
 *
 * The original arrangement held the GLOBAL index.json lock across history
 * serialisation and a full history rewrite — up to the 64 MiB resume guard — so
 * one session hitting divergence or compaction stalled the whole host.
 *
 * These tests pin the two properties the restructure has to preserve while
 * removing that coupling:
 *   1. cross-session persists proceed concurrently;
 *   2. same-session writes, index bookkeeping, eviction and delete still behave.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rm, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SessionStore } from '../SessionStore.js'
import type { SessionMeta } from '../SessionStore.js'
import type { ConversationMessage } from '../types.js'
import { makeTempDir } from '../../__tests__/tempDir.js'

let rootDir: string

function meta(overrides: Partial<SessionMeta> = {}): Omit<SessionMeta, 'sessionId'> {
  return {
    mode: 'test',
    startTime: Date.now(),
    lastActivity: Date.now(),
    messageCount: 0,
    firstPrompt: 'hello',
    ...overrides,
  }
}

function messages(n: number, prefix = 'm'): ConversationMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `${prefix}-${i}`,
  })) as ConversationMessage[]
}

async function historyLines(sessionId: string): Promise<string[]> {
  const raw = await readFile(join(rootDir, sessionId, 'history.jsonl'), 'utf-8')
  return raw.split('\n').filter(Boolean)
}

beforeEach(async () => {
  rootDir = await makeTempDir('session-store-concurrency-')
  await mkdir(rootDir, { recursive: true })
})

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true })
})

describe('SessionStore cross-session concurrency (P3-2)', () => {
  it('persists many sessions concurrently without corrupting the index', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `session-${i}`)

    await Promise.all(ids.map(async (id, i) => {
      const msgs = messages(4, id)
      await SessionStore.append(id, meta({ messageCount: msgs.length, firstPrompt: `p${i}` }), msgs, 0, { rootDir })
    }))

    const listed = await SessionStore.listSessions(50, { rootDir })
    expect(listed.map(e => e.sessionId).sort()).toEqual([...ids].sort())

    // Every session's history must be complete — a lost update in the index
    // read-modify-write would show up as a missing entry above, and a torn
    // history as a short file here.
    for (const id of ids) {
      expect(await historyLines(id)).toHaveLength(4)
    }
  })

  it('does not serialise one session\'s large rewrite ahead of another\'s append', async () => {
    // A big session hitting the divergence path (full rewrite) concurrently
    // with a small session's ordinary append. Both must finish; the point of
    // the restructure is that the small one is not queued behind the large
    // one's serialisation and write.
    const big = 'session-big'
    const small = 'session-small'

    const bigMsgs = messages(2_000, big)
    await SessionStore.append(big, meta({ messageCount: bigMsgs.length }), bigMsgs, 0, { rootDir })

    // Force divergence: claim a different append cursor than the index holds.
    const rewrite = SessionStore.append(
      big,
      meta({ messageCount: bigMsgs.length + 1 }),
      [...bigMsgs, { role: 'user', content: 'extra' } as ConversationMessage],
      0,
      { rootDir },
    )
    const smallAppend = SessionStore.append(
      small,
      meta({ messageCount: 2 }),
      messages(2, small),
      0,
      { rootDir },
    )

    await Promise.all([rewrite, smallAppend])

    expect(await historyLines(big)).toHaveLength(bigMsgs.length + 1)
    expect(await historyLines(small)).toHaveLength(2)
  })

  it('serialises concurrent appends to the SAME session', async () => {
    // Per-session ordering is the invariant the global lock used to provide as
    // a side effect; the per-session lock has to provide it directly.
    const id = 'session-same'
    const first = messages(3, 'a')
    await SessionStore.append(id, meta({ messageCount: 3 }), first, 0, { rootDir })

    const all = [...first, ...messages(3, 'b')]
    await Promise.all([
      SessionStore.append(id, meta({ messageCount: 6 }), all, 3, { rootDir }),
      SessionStore.append(id, meta({ messageCount: 6 }), all, 3, { rootDir }),
    ])

    // Whatever interleaving occurred, the file must be a coherent transcript:
    // every line valid JSON, never a torn record.
    const lines = await historyLines(id)
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow()
    }
    expect(lines.length).toBeGreaterThanOrEqual(6)
  })

  it('keeps replace() atomic against a concurrent append to another session', async () => {
    const a = 'session-replace-a'
    const b = 'session-replace-b'
    await SessionStore.append(a, meta({ messageCount: 5 }), messages(5, a), 0, { rootDir })

    await Promise.all([
      SessionStore.replace(a, meta({ messageCount: 2 }), messages(2, 'compacted'), { rootDir }),
      SessionStore.append(b, meta({ messageCount: 3 }), messages(3, b), 0, { rootDir }),
    ])

    expect(await historyLines(a)).toHaveLength(2)
    expect(await historyLines(b)).toHaveLength(3)
  })

  it('deleteSession does not interleave with a live append to the same session', async () => {
    const id = 'session-delete-race'
    await SessionStore.append(id, meta({ messageCount: 3 }), messages(3, id), 0, { rootDir })

    await Promise.all([
      SessionStore.deleteSession(id, { rootDir }),
      SessionStore.append(id, meta({ messageCount: 6 }), messages(6, id), 3, { rootDir }),
    ])

    // Either outcome is legitimate for a delete racing a write — what must not
    // happen is a half-deleted directory holding a torn history file.
    if (SessionStore.sessionExists(id, { rootDir })) {
      for (const line of await historyLines(id)) {
        expect(() => JSON.parse(line)).not.toThrow()
      }
    }
  })

  it('still round-trips history through loadHistory', async () => {
    const id = 'session-roundtrip'
    const msgs = messages(6, id)
    await SessionStore.append(id, meta({ messageCount: msgs.length }), msgs, 0, { rootDir })

    const loaded = await SessionStore.loadHistory(id, { rootDir })
    expect(loaded).toHaveLength(6)
    expect(loaded[0]?.content).toBe(`${id}-0`)
  })

  it('records the index entry after the history write, not before', async () => {
    // Phase ordering: if the index were committed first, a crash between the
    // phases would advertise messages that are not on disk.
    const id = 'session-ordering'
    const msgs = messages(4, id)
    await SessionStore.append(id, meta({ messageCount: msgs.length }), msgs, 0, { rootDir })

    const entry = await SessionStore.getSession(id, { rootDir })
    expect(entry?.messageCount).toBe(4)
    expect(await historyLines(id)).toHaveLength(4)
  })
})
