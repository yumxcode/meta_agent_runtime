/**
 * The park→resume fence must be computed from the PERSISTED transcript.
 *
 * A real unattended run died here. A turn compacted, parked, and armed its wake
 * with `router.getMessages().length`. The compact boundary marker carries
 * `content: []` and is dropped by `serializeMessages`, so the file held one
 * fewer message than the number recorded on the wake. 46 minutes later the
 * scheduler resumed it, `history.length !== record.historyMessageCount`
 * rejected it, `cancelled` is terminal, and the session — a 40-minute GPU run
 * it was babysitting — was gone. Nothing in the log looked like a failure.
 *
 * This is not a race: any turn that compacts arms a wake that CANNOT survive.
 * These tests pin the invariant that makes it impossible:
 *
 *     the count armed on the wake === the count a fresh resume loads
 *
 * They deliberately assert the lossy step still happens (it is correct — an
 * empty-content message would be rejected by the API on replay) and that the
 * fence value no longer depends on it.
 */
import { describe, expect, it, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionStore } from '../../core/SessionStore.js'
import { persistSessionSnapshot, persistedResumeMessageCount } from '../sessionFlow.js'
import { makeCompactBoundaryMessage } from '../../kernel/types/KernelMessage.js'
import type { SessionRouter } from '../../routing/SessionRouter.js'
import type { ConversationMessage } from '../../core/types.js'
import type { CliOptions } from '../args.js'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true })))
})

async function sessionRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'park-fence-'))
  dirs.push(dir)
  return dir
}

const user = (text: string): ConversationMessage =>
  ({ role: 'user', content: [{ type: 'text', text }] }) as ConversationMessage
const assistant = (text: string): ConversationMessage =>
  ({ role: 'assistant', content: [{ type: 'text', text }] }) as ConversationMessage
const thinkingOnly = (): ConversationMessage =>
  ({ role: 'assistant', content: [{ type: 'thinking', thinking: 'internal' }] }) as unknown as ConversationMessage
const orphanToolResult = (): ConversationMessage =>
  ({
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'toolu_gone', content: 'result' }],
  }) as unknown as ConversationMessage
const compactBoundary = (): ConversationMessage =>
  makeCompactBoundaryMessage() as unknown as ConversationMessage

function stubRouter(sessionId: string, messages: readonly ConversationMessage[]): SessionRouter {
  return {
    mode: 'auto',
    getSessionId: () => sessionId,
    getMessages: () => messages,
  } as unknown as SessionRouter
}

const opts = { mode: 'auto', workspace: '/workspace' } as unknown as CliOptions

/**
 * Persist exactly the way a session does, one turn per stage — each stage is
 * the FULL in-memory transcript at the end of that turn, and the append cursor
 * is carried between them the way the CLI carries `savedMessageCount`. The last
 * stage is the turn that parks.
 *
 * `armedByOldCode` is what the wake used to record (in-memory length), `armed`
 * is what it records now (read back), `seenAtResume` is what the fence loads.
 */
async function park(
  ...stages: ReadonlyArray<readonly ConversationMessage[]>
): Promise<{ armedByOldCode: number; armed: number; seenAtResume: number }> {
  const root = await sessionRoot()
  const sessionId = 'sess-park'
  let savedMessageCount = 0
  for (const messages of stages) {
    savedMessageCount = await persistSessionSnapshot({
      router: stubRouter(sessionId, messages),
      opts,
      currentInput: '继续',
      savedMessageCount,
      sessionRoot: root,
    })
  }
  const armed = await persistedResumeMessageCount(sessionId, root)
  const seenAtResume = (await SessionStore.loadHistory(sessionId, { rootDir: root })).length
  return { armedByOldCode: savedMessageCount, armed, seenAtResume }
}

describe('a wake armed after a compaction survives its own fence', () => {
  it('does not count the compact boundary marker, which is never persisted', async () => {
    // Exactly the post-compact shape: boundary + summary + the turn that parked.
    const messages = [
      compactBoundary(),
      user('[compact summary]'),
      assistant('gate still running'),
      user('继续'),
    ]
    const { armedByOldCode, armed, seenAtResume } = await park(messages)

    // The old value: in-memory length. This is the number that killed the run.
    expect(armedByOldCode).toBe(4)
    // The boundary marker has content: [] and is dropped on write — correctly,
    // an empty message cannot be replayed to the API.
    expect(armed).toBe(3)
    // The invariant. Before the fix this was 3 !== 4 → 'cancelled' → terminal.
    expect(armed).toBe(seenAtResume)
  })

  it('does not count thinking-only messages, which are stripped on write', async () => {
    const messages = [user('go'), thinkingOnly(), assistant('parked'), user('继续')]
    const { armedByOldCode, armed, seenAtResume } = await park(messages)

    expect(armedByOldCode).toBe(4)
    expect(armed).toBe(3)
    expect(armed).toBe(seenAtResume)
  })

  it('accounts for leading orphan tool_results trimmed at LOAD time', async () => {
    // Here nothing is lost on write; the shrink happens in
    // trimToSafeResumeBoundary when the history is read back.
    const messages = [orphanToolResult(), assistant('recovered'), user('继续')]
    const { armedByOldCode, armed, seenAtResume } = await park(messages)

    expect(armedByOldCode).toBe(3)
    expect(armed).toBe(2)
    expect(armed).toBe(seenAtResume)
  })

  it('is unchanged for a transcript that round-trips cleanly', async () => {
    const messages = [user('go'), assistant('working'), user('继续')]
    const { armedByOldCode, armed, seenAtResume } = await park(messages)

    // No regression for the common case: the two agree, as they always did.
    expect(armed).toBe(armedByOldCode)
    expect(armed).toBe(seenAtResume)
  })

  it('holds on the append path too, not just the compaction rewrite', async () => {
    // Turn 1 persists two messages; turn 2 grows the transcript, so the second
    // persist routes through append() rather than replace(). A thinking-only
    // message in the appended tail is dropped there as well.
    const turn1 = [user('go'), assistant('a')]
    const turn2 = [...turn1, thinkingOnly(), user('继续')]
    const { armedByOldCode, armed, seenAtResume } = await park(turn1, turn2)

    expect(armedByOldCode).toBe(4)
    expect(armed).toBe(3)
    expect(armed).toBe(seenAtResume)
  })

  it('holds across a real park → compact → park sequence', async () => {
    // The exact shape of the incident: a session parks once (fence agrees),
    // then the next turn compacts and parks again. The second wake is the one
    // that used to be dead on arrival.
    const beforeCompact = [
      user('go'), assistant('a'), user('b'), assistant('c'),
      user('d'), assistant('e'), user('继续'),
    ]
    const afterCompact = [
      compactBoundary(),
      user('[compact summary]'),
      assistant('gate still running'),
      user('继续'),
    ]
    const first = await park(beforeCompact)
    expect(first.armed).toBe(first.seenAtResume)

    // messages.length shrinks below savedMessageCount → replace() path.
    const second = await park(beforeCompact, afterCompact)
    expect(second.armedByOldCode).toBe(4)
    expect(second.armed).toBe(3)
    expect(second.armed).toBe(second.seenAtResume)
  })

  it('survives repeated compactions in the same session', async () => {
    // Nested compaction: a second boundary marker appears in a transcript that
    // already contains one. Both are dropped; the fence must still agree.
    const messages = [
      compactBoundary(),
      user('[summary 1]'),
      compactBoundary(),
      user('[summary 2]'),
      assistant('still going'),
      user('继续'),
    ]
    const { armedByOldCode, armed, seenAtResume } = await park(messages)

    expect(armedByOldCode).toBe(6)
    expect(armed).toBe(4)
    expect(armed).toBe(seenAtResume)
  })
})
