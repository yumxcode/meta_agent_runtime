/**
 * Resume-side repair for transcripts that already contain an unanswered
 * tool_use.
 *
 * KernelLoop now synthesises the missing results at every exit that can leave
 * one, but transcripts written before that fix are already on disk and cannot be
 * rewritten retroactively. They are unresumable without this: the Messages API
 * rejects a request whose tool_use has no following tool_result, so `--resume`
 * fails on its first turn and the session is permanently stuck.
 *
 * The repair appends rather than deletes. The offending assistant message also
 * carries the model's reasoning; dropping it to satisfy the protocol would
 * silently discard the context the resume exists to recover.
 */
import { describe, it, expect } from 'vitest'
import { normalizeResumedHistory } from '../SessionStore.js'
import type { ConversationMessage } from '../types.js'

function blocks(message: ConversationMessage): Array<Record<string, unknown>> {
  return Array.isArray(message.content)
    ? message.content as Array<Record<string, unknown>>
    : [{ type: 'text', text: message.content }]
}

function unanswered(messages: readonly ConversationMessage[]): string[] {
  const answered = new Set<string>()
  for (const message of messages) {
    for (const block of blocks(message)) {
      if (block['type'] === 'tool_result') answered.add(block['tool_use_id'] as string)
    }
  }
  const dangling: string[] = []
  for (const message of messages) {
    for (const block of blocks(message)) {
      if (block['type'] === 'tool_use' && !answered.has(block['id'] as string)) {
        dangling.push(block['id'] as string)
      }
    }
  }
  return dangling
}

describe('normalizeResumedHistory: dangling tool_use repair', () => {
  it('answers a trailing tool_use left by an interrupted session', () => {
    const history: ConversationMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'do the thing' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I will read the file.' },
          { type: 'tool_use', id: 'tu_1', name: 'read_file', input: { file_path: 'a.ts' } },
        ],
      } as ConversationMessage,
    ]

    const resumed = normalizeResumedHistory(history)

    expect(unanswered(resumed)).toEqual([])
    // The assistant's reasoning survives — repair adds, never removes.
    expect(resumed.some(m => blocks(m).some(b => b['text'] === 'I will read the file.'))).toBe(true)
    const repair = blocks(resumed.at(-1)!).find(b => b['type'] === 'tool_result')
    expect(repair?.['tool_use_id']).toBe('tu_1')
    // Reported as an error: a never-executed tool presented as a successful
    // empty result would teach the model the call had worked.
    expect(repair?.['is_error']).toBe(true)
  })

  it('answers every unmatched id in a multi-tool batch', () => {
    const history: ConversationMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu_a', name: 'grep', input: {} },
          { type: 'tool_use', id: 'tu_b', name: 'glob', input: {} },
        ],
      } as ConversationMessage,
      // Only one of the two ever came back.
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu_a', content: 'hit' }],
      } as ConversationMessage,
    ]

    expect(unanswered(normalizeResumedHistory(history))).toEqual([])
  })

  it('leaves a well-formed transcript untouched', () => {
    const history: ConversationMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_1', name: 'grep', input: {} }],
      } as ConversationMessage,
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }],
      } as ConversationMessage,
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    ]

    expect(normalizeResumedHistory(history)).toHaveLength(history.length)
  })
})
