/**
 * Resuming a history larger than the read guard must keep the NEWEST turns.
 *
 * The old tail read did `Buffer.alloc(maxBytes)` and then threw away
 * `fh.read()`'s `bytesRead`. A short read — a network filesystem, a file being
 * appended to concurrently, a signal — left the buffer's zero fill in place;
 * those NULs were decoded onto the end of the final line, `JSON.parse` rejected
 * it, and it was counted as a corrupt line. The messages lost that way were
 * always the most recent ones, which is precisely what a resume exists to
 * recover.
 *
 * It also held the whole file as a string, the array from `split('\n')`, and
 * the parsed objects at the same time — a several-hundred-MB spike at the
 * 64 MiB default, paid before the user has typed anything. Reading line by line
 * fixes both.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConversationMessage } from '../types.js'

let homeDir: string
let previousHome: string | undefined
let previousMaxBytes: string | undefined

beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), 'meta-agent-tail-read-'))
  previousHome = process.env['META_AGENT_HOME']
  previousMaxBytes = process.env['META_AGENT_MAX_RESUME_BYTES']
  process.env['META_AGENT_HOME'] = join(homeDir, '.meta-agent')
  vi.resetModules()
})

afterEach(async () => {
  if (previousHome === undefined) delete process.env['META_AGENT_HOME']
  else process.env['META_AGENT_HOME'] = previousHome
  if (previousMaxBytes === undefined) delete process.env['META_AGENT_MAX_RESUME_BYTES']
  else process.env['META_AGENT_MAX_RESUME_BYTES'] = previousMaxBytes
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

/** Padded so a modest message count still blows past a small byte guard. */
function say(i: number): ConversationMessage {
  return {
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: [{ type: 'text', text: `msg-${i} ${'x'.repeat(400)}` }],
  } as ConversationMessage
}

const textOf = (m: ConversationMessage): string =>
  (m.content as Array<{ type: string; text?: string }>)
    .filter(b => b.type === 'text')
    .map(b => b.text ?? '')
    .join('')

describe('SessionStore tail read', () => {
  it('returns the newest messages intact when the file exceeds the guard', async () => {
    const { SessionStore } = await import('../SessionStore.js')
    const sessionId = '11111111-1111-4111-8111-111111111111'
    const messages = Array.from({ length: 120 }, (_, i) => say(i))
    await SessionStore.append(sessionId, meta(messages.length), messages, 0)

    // Force the tail path: well under the file size, well over one line.
    process.env['META_AGENT_MAX_RESUME_BYTES'] = String(8 * 1024)
    const loaded = await SessionStore.loadHistory(sessionId)

    expect(loaded.length).toBeGreaterThan(0)
    expect(loaded.length).toBeLessThan(messages.length)   // it really was truncated
    // The LAST message must be present and whole — that is the one the old
    // NUL-padding bug ate.
    expect(textOf(loaded[loaded.length - 1]!)).toBe(textOf(messages[messages.length - 1]!))
    // And every line that survived must have parsed, not been half-decoded.
    for (const m of loaded) expect(textOf(m)).toMatch(/^msg-\d+ x+$/)
  })

  it('reads the whole file unchanged when it fits under the guard', async () => {
    const { SessionStore } = await import('../SessionStore.js')
    const sessionId = '22222222-2222-4222-8222-222222222222'
    const messages = Array.from({ length: 6 }, (_, i) => say(i))
    await SessionStore.append(sessionId, meta(messages.length), messages, 0)

    const loaded = await SessionStore.loadHistory(sessionId)
    expect(loaded.map(textOf)).toEqual(messages.map(textOf))
  })

  it('skips a corrupt line without losing the ones around it', async () => {
    const { SessionStore } = await import('../SessionStore.js')
    const { appendFile } = await import('node:fs/promises')
    const sessionId = '33333333-3333-4333-8333-333333333333'
    const messages = [say(0), say(1)]
    await SessionStore.append(sessionId, meta(2), messages, 0)

    const historyFile = join(
      process.env['META_AGENT_HOME']!, 'sessions', sessionId, 'history.jsonl',
    )
    await appendFile(historyFile, '{not json at all\n')
    await SessionStore.append(sessionId, meta(3), [...messages, say(2)], 2)

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const loaded = await SessionStore.loadHistory(sessionId)
    warn.mockRestore()

    expect(loaded.map(textOf)).toEqual([say(0), say(1), say(2)].map(textOf))
  })
})
