import { describe, expect, it } from 'vitest'
import { buildPostCompactMessages } from '../compact/PostCompact.js'
import { FileStateCache } from '../session/FileStateCache.js'
import { makeTextUserMessage } from '../messages/MessageFactory.js'

describe('buildPostCompactMessages', () => {
  it('keeps explicit messages after the compact summary', () => {
    const fileCache = new FileStateCache()
    fileCache.record('/tmp/read-before-compact.txt', 123)
    const kept = makeTextUserMessage('Current user request must remain verbatim.')

    const result = buildPostCompactMessages('Summary:\nPrior work.', fileCache, [kept])
    const texts = result.postCompactMessages
      .flatMap(message => message.content)
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map(block => block.text)

    expect(texts[0]).toContain('Summary:\nPrior work.')
    expect(texts[1]).toBe('Current user request must remain verbatim.')
    expect(texts[2]).toContain('Re-read any file before relying on its contents')
  })
})
