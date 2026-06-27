import { describe, expect, it } from 'vitest'
import { runPostSessionMemoryWriter } from '../memoryWriter.js'

describe('post-session memory writer — auto read-only boundary', () => {
  it('does not call a model or touch the pending store in auto mode', async () => {
    const pendingStore = {
      list: () => {
        throw new Error('pending store must not be read')
      },
    }

    const result = await runPostSessionMemoryWriter({
      mode: 'auto',
      messages: [{ role: 'user', content: 'remember this globally' }],
      pendingStore: pendingStore as never,
    })

    expect(result).toEqual({
      attempted: false,
      queued: [],
      skipped: ['read_only_mode'],
    })
  })

  it('keeps the post-session writer read-only in auto-orch mode', async () => {
    const pendingStore = {
      list: () => {
        throw new Error('pending store must not be read')
      },
    }

    const result = await runPostSessionMemoryWriter({
      mode: 'auto-orch',
      messages: [{ role: 'user', content: 'remember this globally' }],
      pendingStore: pendingStore as never,
    })

    expect(result).toEqual({
      attempted: false,
      queued: [],
      skipped: ['read_only_mode'],
    })
  })
})
