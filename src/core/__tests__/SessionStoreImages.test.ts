import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionStore } from '../SessionStore.js'
import type { ConversationMessage } from '../types.js'

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

let root: string

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'sessimg-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

/** ~150 KB of base64 payload — enough that inlining it would be obvious. */
const BIG_DATA = 'A'.repeat(200_000)

function imageMessage(data = BIG_DATA): ConversationMessage {
  return {
    role: 'user',
    content: [
      { type: 'text', text: 'look at this' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
    ],
  } as unknown as ConversationMessage
}

async function historyBytes(sessionId: string): Promise<number> {
  const info = await stat(join(root, sessionId, 'history.jsonl'))
  return info.size
}

describe('SessionStore image externalisation', () => {
  it('keeps base64 out of history.jsonl', async () => {
    // A single 1 MB screenshot becomes ~1.4 MB of base64 on one line. Left
    // inline, a handful of them blows past the 64 MiB resume read guard while
    // META_AGENT_MAX_RESUME_MESSAGES — a count, not a size — reports everything
    // as fine.
    await SessionStore.append('s1', meta(1), [imageMessage()], 0, { rootDir: root })
    const raw = await readFile(join(root, 's1', 'history.jsonl'), 'utf-8')
    expect(raw).not.toContain(BIG_DATA)
    expect(raw).toContain('blob_ref')
    expect(await historyBytes('s1')).toBeLessThan(2_000)
  })

  it('round-trips the image bytes on load', async () => {
    await SessionStore.append('s2', meta(1), [imageMessage()], 0, { rootDir: root })
    const loaded = await SessionStore.loadHistory('s2', { rootDir: root })
    const blocks = loaded[0]!.content as unknown as Array<Record<string, unknown>>
    const image = blocks.find(b => b['type'] === 'image')
    expect(image).toBeDefined()
    expect((image!['source'] as Record<string, unknown>)['data']).toBe(BIG_DATA)
    expect((image!['source'] as Record<string, unknown>)['media_type']).toBe('image/png')
  })

  it('writes one blob when the same image is attached repeatedly', async () => {
    // Content addressing: re-attaching a reference image across many turns is a
    // normal workflow and should not cost a copy per turn.
    await SessionStore.append('s3', meta(3), [imageMessage(), imageMessage(), imageMessage()], 0, { rootDir: root })
    const blobs = await readdir(join(root, 's3', 'blobs'))
    expect(blobs).toHaveLength(1)
  })

  it('degrades to a placeholder rather than failing the resume when a blob is gone', async () => {
    // The transcript is the valuable part; one unreadable attachment is not
    // worth losing it.
    await SessionStore.append('s4', meta(1), [imageMessage()], 0, { rootDir: root })
    await rm(join(root, 's4', 'blobs'), { recursive: true, force: true })
    const loaded = await SessionStore.loadHistory('s4', { rootDir: root })
    expect(JSON.stringify(loaded)).toContain('no longer available')
    expect(JSON.stringify(loaded)).toContain('look at this')
  })

  it('externalises images nested inside tool results', async () => {
    // The tool_use must be present: resume normalisation drops an orphaned
    // tool_result, which would hide whether the blob round-trip worked.
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'screenshot it' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'shot', input: {} }] },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 't1',
          content: [
            { type: 'text', text: 'captured' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: BIG_DATA } },
          ],
        }],
      },
    ] as unknown as ConversationMessage[]
    await SessionStore.append('s5', meta(3), messages, 0, { rootDir: root })
    const raw = await readFile(join(root, 's5', 'history.jsonl'), 'utf-8')
    expect(raw).not.toContain(BIG_DATA)

    const loaded = await SessionStore.loadHistory('s5', { rootDir: root })
    expect(JSON.stringify(loaded)).toContain(BIG_DATA)
  })

  it('leaves a text-only transcript byte-identical', async () => {
    const text = { role: 'user', content: [{ type: 'text', text: 'hello' }] } as unknown as ConversationMessage
    await SessionStore.append('s6', meta(1), [text], 0, { rootDir: root })
    const raw = await readFile(join(root, 's6', 'history.jsonl'), 'utf-8')
    expect(JSON.parse(raw.trim())).toEqual(text)
    // No blobs directory is created for a session that has no attachments.
    await expect(readdir(join(root, 's6', 'blobs'))).rejects.toThrow()
  })

  it('removes the blobs along with the session', async () => {
    await SessionStore.append('s7', meta(1), [imageMessage()], 0, { rootDir: root })
    await SessionStore.deleteSession('s7', { rootDir: root })
    await expect(readdir(join(root, 's7'))).rejects.toThrow()
  })
})
