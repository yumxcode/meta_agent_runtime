import { describe, expect, it } from 'vitest'
import { runPostSessionMemoryWriter } from '../memoryWriter.js'
import type { SessionMode } from '../../modes.js'

const AUTONOMOUS_MODES: SessionMode[] = ['auto', 'simple_auto']

describe('post-session memory writer — auto read-only boundary', () => {
  for (const mode of AUTONOMOUS_MODES) {
    it(`does not call a model or touch the pending store in ${mode} mode`, async () => {
      const pendingStore = {
        list: () => {
          throw new Error('pending store must not be read')
        },
      }

      const result = await runPostSessionMemoryWriter({
        mode,
        messages: [{ role: 'user', content: 'remember this globally' }],
        pendingStore: pendingStore as never,
      })

      expect(result).toEqual({
        attempted: false,
        queued: [],
        skipped: ['read_only_mode'],
      })
    })
  }
})
