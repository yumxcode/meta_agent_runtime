/**
 * Regression: binding a hardware profile mid-session must not lose the
 * conversation.
 *
 * The REPL's post-turn hardware catch-up rebuilds the router, because that is
 * how a hardware profile reaches the system prompt. It used to rebuild with
 * `initialMessages = undefined` and no `resumeSessionId`, then reset
 * `savedMessageCount` to 0 — so answering a prompt that appears UNBIDDEN after
 * the first turn discarded that turn's whole context, while the confirmation
 * line reported only that hardware had been bound.
 *
 * The REPL loop itself is not unit-testable, so these lock the two contracts the
 * fix depends on, both at the persistence layer the rebuild writes through:
 *
 *   1. carrying the messages + the SAME session id continues one file;
 *   2. the old behaviour (fresh id, zero count) is what splits it in two.
 *
 * (2) is asserted deliberately: it is the shape of the bug, and if a future
 * refactor makes it indistinguishable from (1) these tests stop being evidence.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { persistSessionSnapshot } from '../sessionFlow.js'
import { SessionStore } from '../../core/SessionStore.js'
import type { SessionRouter } from '../router.js'
import type { CliOptions } from '../args.js'
import type { ConversationMessage } from '../../core/types.js'

let sessionRoot: string

const opts = { workspace: '/ws', mode: 'robotics' } as unknown as CliOptions

function msg(text: string): ConversationMessage {
  return { role: 'user', content: text } as unknown as ConversationMessage
}

/** Minimal stand-in exposing only what persistSessionSnapshot reads. */
function fakeRouter(sessionId: string, messages: ConversationMessage[]): SessionRouter {
  return {
    mode: 'robotics',
    getSessionId: () => sessionId,
    getMessages: () => messages,
  } as unknown as SessionRouter
}

async function persist(
  router: SessionRouter,
  savedMessageCount: number,
): Promise<number> {
  return persistSessionSnapshot({
    router, opts, currentInput: 'x', savedMessageCount, sessionRoot,
  })
}

async function storedCount(sessionId: string): Promise<number> {
  const history = await SessionStore.loadHistory(sessionId, { rootDir: sessionRoot })
  return history?.length ?? 0
}

beforeEach(() => {
  sessionRoot = mkdtempSync(join(tmpdir(), 'hwrebuild-'))
})
afterEach(() => {
  rmSync(sessionRoot, { recursive: true, force: true })
})

describe('hardware binding rebuild — session continuity', () => {
  it('carrying messages and the session id continues ONE session file', async () => {
    const before = [msg('turn 1'), msg('reply 1'), msg('turn 2')]
    const routerA = fakeRouter('sess-keep', before)
    const saved = await persist(routerA, 0)
    expect(saved).toBe(3)

    // The rebuild: same id, the carried messages, savedMessageCount = carried
    // length. A later turn appends one more message.
    const carried = [...before]
    const routerB = fakeRouter('sess-keep', [...carried, msg('turn 3')])
    const savedAfter = await persist(routerB, carried.length)

    expect(savedAfter).toBe(4)
    expect(await storedCount('sess-keep')).toBe(4)
  })

  it('the old behaviour — fresh id, zero count — splits one conversation in two', async () => {
    const before = [msg('turn 1'), msg('reply 1'), msg('turn 2')]
    await persist(fakeRouter('sess-old', before), 0)

    // What the buggy rebuild produced: a brand-new router with no history.
    const routerFresh = fakeRouter('sess-new', [msg('turn 3')])
    await persist(routerFresh, 0)

    expect(await storedCount('sess-old')).toBe(3)
    expect(await storedCount('sess-new')).toBe(1)
    // Two files, and the live router holds only the second one's single message
    // — the 3 messages the user had already paid for are no longer in context.
  })

  it('a dropped-context rebuild that KEEPS the id would rewrite the file', async () => {
    // The other half of the old behaviour: had the id been preserved but the
    // messages dropped, messages.length < savedMessageCount takes the
    // `replace` branch and the earlier turns are overwritten rather than split.
    const before = [msg('turn 1'), msg('reply 1'), msg('turn 2')]
    await persist(fakeRouter('sess-clobber', before), 0)

    const routerEmptied = fakeRouter('sess-clobber', [msg('turn 3')])
    await persist(routerEmptied, 3)

    expect(await storedCount('sess-clobber')).toBe(1)
  })
})
