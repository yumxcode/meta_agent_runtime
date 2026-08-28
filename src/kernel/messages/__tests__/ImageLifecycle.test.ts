import { describe, it, expect } from 'vitest'
import { makeUserMessage, makeAssistantMessage, type KernelMessage, type ContentBlock } from '../../types/KernelMessage.js'
import { applyImageRetention, downgradeImagesForModel, normalizeMessagesForAPI } from '../MessageNormalizer.js'
import { tokenCountWithEstimation } from '../../api/TokenCount.js'
import {
  promptTextOf, promptImagesOf, withPromptPrefix, withPromptText, promptToContentBlocks,
} from '../../../core/promptInput.js'

const IMG: ContentBlock = {
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
} as ContentBlock

function imageMessage(label: string): KernelMessage {
  return makeUserMessage([{ type: 'text', text: label }, IMG])
}

function countImages(messages: readonly KernelMessage[]): number {
  let n = 0
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === 'image') n++
      else if (b.type === 'tool_result' && Array.isArray(b.content)) {
        n += (b.content as ContentBlock[]).filter(i => i.type === 'image').length
      }
    }
  }
  return n
}

describe('applyImageRetention', () => {
  it('is identity when the transcript is under the budget', () => {
    const messages = [imageMessage('a'), imageMessage('b')]
    expect(applyImageRetention(messages, 4)).toBe(messages)
  })

  it('keeps the most recent N images and ages out the rest', () => {
    const messages = [imageMessage('a'), imageMessage('b'), imageMessage('c'), imageMessage('d')]
    const out = applyImageRetention(messages, 2)
    expect(countImages(out)).toBe(2)
    // The survivors must be the LAST two, not the first two.
    expect(out[2]!.content.some(b => b.type === 'image')).toBe(true)
    expect(out[3]!.content.some(b => b.type === 'image')).toBe(true)
    expect(out[0]!.content.some(b => b.type === 'image')).toBe(false)
  })

  it('leaves a placeholder so later turns can still refer to the image', () => {
    const out = applyImageRetention([imageMessage('a'), imageMessage('b')], 1)
    const texts = out[0]!.content.filter(b => b.type === 'text').map(b => (b as { text: string }).text)
    expect(texts).toContain('[image aged out of context]')
  })

  it('never rewrites the text around an aged-out image', () => {
    const out = applyImageRetention([imageMessage('the failing screen'), imageMessage('b')], 1)
    const texts = out[0]!.content.filter(b => b.type === 'text').map(b => (b as { text: string }).text)
    expect(texts).toContain('the failing screen')
  })

  it('splits the budget inside a single message, keeping the later images', () => {
    const multi = makeUserMessage([
      { type: 'text', text: 'first' }, IMG,
      { type: 'text', text: 'second' }, IMG,
      { type: 'text', text: 'third' }, IMG,
    ])
    const out = applyImageRetention([multi], 1)
    expect(countImages(out)).toBe(1)
    // The surviving image is the last one in the message.
    const blocks = out[0]!.content
    expect(blocks[blocks.length - 1]!.type).toBe('image')
  })

  it('ages out images nested inside tool results too', () => {
    const withToolImage = makeUserMessage([
      { type: 'tool_result', tool_use_id: 't1', content: [IMG] } as never,
    ])
    const out = applyImageRetention([withToolImage, imageMessage('newer')], 1)
    expect(countImages(out)).toBe(1)
  })

  it('strips everything at a retention of zero', () => {
    expect(countImages(applyImageRetention([imageMessage('a')], 0))).toBe(0)
  })
})

describe('downgradeImagesForModel', () => {
  it('is identity for a vision model', () => {
    const messages = [imageMessage('a')]
    expect(downgradeImagesForModel(messages, true)).toBe(messages)
  })

  it('replaces images when the active model cannot see', () => {
    // The entry point already rejects new attachments for a text-only model.
    // This covers the case it cannot: `/model` switching mid-session, which
    // leaves images from earlier turns sitting in the transcript.
    const out = downgradeImagesForModel([imageMessage('a')], false)
    expect(countImages(out)).toBe(0)
    expect(JSON.stringify(out)).toContain('no vision support')
  })

  it('reaches images nested in tool results', () => {
    const withToolImage = makeUserMessage([
      { type: 'tool_result', tool_use_id: 't1', content: [IMG] } as never,
    ])
    expect(countImages(downgradeImagesForModel([withToolImage], false))).toBe(0)
  })

  it('leaves a transcript with no images completely untouched', () => {
    const messages = [makeUserMessage([{ type: 'text', text: 'hi' }])]
    expect(downgradeImagesForModel(messages, false)).toBe(messages)
  })
})

describe('token accounting for images', () => {
  it('charges a flat per-image budget instead of zero', () => {
    // Skipping image blocks — which the original `'text' in block` chain did —
    // charged them nothing, so a screenshot-heavy transcript sailed past the
    // compaction threshold and hit the model's hard context limit instead.
    const withImage = tokenCountWithEstimation([imageMessage('a')], 'deepseek-v4-flash-vision-exp')
    const withoutImage = tokenCountWithEstimation(
      [makeUserMessage([{ type: 'text', text: 'a' }])],
      'deepseek-v4-flash-vision-exp',
    )
    expect(withImage - withoutImage).toBe(384)
  })

  it('does not scale the charge with the base64 length', () => {
    // Estimating from the encoded string inflates a 1 MB image to ~350k tokens
    // and would trip compaction on the very first attachment. Providers scale
    // every image to a fixed budget before inference.
    const big: ContentBlock = {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(1_400_000) },
    } as ContentBlock
    const small = tokenCountWithEstimation([makeUserMessage([IMG])], 'deepseek-v4-flash-vision-exp')
    const large = tokenCountWithEstimation([makeUserMessage([big])], 'deepseek-v4-flash-vision-exp')
    expect(large).toBe(small)
  })

  it('charges tool-returned images the same as attached ones', () => {
    const toolImage = makeUserMessage([
      { type: 'tool_result', tool_use_id: 't1', content: [IMG] } as never,
    ])
    expect(tokenCountWithEstimation([toolImage], 'deepseek-v4-flash-vision-exp')).toBe(384)
  })

  it('falls back to a conservative ceiling when no model is named', () => {
    expect(tokenCountWithEstimation([makeUserMessage([IMG])])).toBe(1600)
  })
})

describe('Anthropic normalisation carries images through unchanged', () => {
  it('passes an image block straight to the API shape', () => {
    const out = normalizeMessagesForAPI([imageMessage('look')])
    expect(out[0]!.content).toEqual([{ type: 'text', text: 'look' }, IMG])
  })

  it('preserves images when merging consecutive same-role messages', () => {
    const out = normalizeMessagesForAPI([imageMessage('a'), imageMessage('b')])
    expect(out).toHaveLength(1)
    expect((out[0]!.content as ContentBlock[]).filter(b => b.type === 'image')).toHaveLength(2)
  })

  it('does not mutate the source messages across repeated calls', () => {
    // mutableMessages persists across turns; an in-place merge would duplicate
    // blocks on every subsequent normalise.
    const messages = [imageMessage('a'), makeAssistantMessage([{ type: 'text', text: 'ok' }]), imageMessage('b')]
    normalizeMessagesForAPI(messages)
    normalizeMessagesForAPI(messages)
    expect(countImages(messages)).toBe(2)
  })
})

describe('PromptInput preserves attachments through context prefixing', () => {
  const prompt = [
    { type: 'text' as const, text: 'what broke?' },
    { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'AAAA' } },
  ]

  it('extracts text only, so goal anchoring never sees [object Object]', () => {
    expect(promptTextOf(prompt)).toBe('what broke?')
    expect(promptImagesOf(prompt)).toHaveLength(1)
  })

  it('prepends a preamble without destroying the attachment', () => {
    // Every layer that wraps the prompt used to do it by string interpolation,
    // which is exactly the operation that loses an image.
    const out = withPromptPrefix(prompt, '<context>state</context>')
    expect(Array.isArray(out)).toBe(true)
    expect(promptImagesOf(out)).toHaveLength(1)
    expect(promptTextOf(out)).toBe('<context>state</context>\n\nwhat broke?')
  })

  it('keeps a string prompt a string, leaving the text-only path identical', () => {
    expect(withPromptPrefix('hello', 'ctx')).toBe('ctx\n\nhello')
  })

  it('is a no-op when the prefix is empty', () => {
    expect(withPromptPrefix(prompt, '')).toBe(prompt)
  })

  it('keeps images when the text is replaced wholesale', () => {
    const out = withPromptText(prompt, 'rewritten')
    expect(promptTextOf(out)).toBe('rewritten')
    expect(promptImagesOf(out)).toHaveLength(1)
  })

  it('widens a bare string into a single text block', () => {
    expect(promptToContentBlocks('hi')).toEqual([{ type: 'text', text: 'hi' }])
  })
})
