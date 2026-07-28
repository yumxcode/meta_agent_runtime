import { describe, it, expect } from 'vitest'
import { SubAgentRunner } from '../SubAgentRunner.js'
import { SessionStore } from '../../core/SessionStore.js'
import type { ConversationMessage } from '../../core/types.js'
import type { SubAgentRecord } from '../types.js'

/**
 * Guards the two lineage-persistence invariants fixed after the graph-loop
 * token audit (docs/reviews/graph-loop-token-cost-audit-2026-07-27.md):
 *
 *   G3 — only a COMPLETED segment extends the lineage. _persistLineageHistory
 *        runs from a `finally`, so a failed / cancelled / timed-out attempt
 *        would otherwise leave its transcript behind for the Kernel's retry to
 *        build on top of.
 *   G4 — persist only from the last compact boundary. Everything before it is
 *        never sent to the model again, but was being rewritten and re-read in
 *        full on every activation.
 *
 * Both are silent when broken (costs money, changes no behaviour), so they get
 * explicit coverage. We drive the private method against a stub session rather
 * than running a real sub-agent — no model or credentials needed.
 */

function msg(text: string, extra: Partial<ConversationMessage> = {}): ConversationMessage {
  return { role: 'user', content: [{ type: 'text', text }], ...extra } as ConversationMessage
}

/**
 * Build a runner without invoking the constructor (which wires abort signals and
 * a tool registry we do not need), then hand it exactly the two collaborators
 * _persistLineageHistory touches: `record` and `session`.
 */
function runnerWith(
  status: SubAgentRecord['status'],
  messages: readonly ConversationMessage[],
  lineageSessionId: string | undefined,
): { runner: SubAgentRunner; persist: () => Promise<void> } {
  const runner = Object.create(SubAgentRunner.prototype) as SubAgentRunner
  const record = {
    taskId: 'task-lineage-test',
    status,
    createdAt: 1,
    config: {
      taskDescription: 'lineage fixture',
      ...(lineageSessionId ? { lineageSessionId } : {}),
      projectDir: '/tmp/project',
      workspaceId: 'ws-test',
      loopInstanceId: 'inst-test',
    },
  }
  Object.assign(runner, {
    record,
    session: { getMessages: () => messages },
  })
  return {
    runner,
    persist: () => (runner as unknown as {
      _persistLineageHistory(): Promise<void>
    })._persistLineageHistory(),
  }
}

async function historyOf(lineageId: string): Promise<string[]> {
  const loaded = await SessionStore.loadHistory(lineageId)
  return loaded.map(m =>
    Array.isArray(m.content)
      ? (m.content as { type: string; text?: string }[]).map(b => b.text ?? '').join('')
      : String(m.content),
  )
}

describe('lineage persistence (G3/G4)', () => {
  it('G3: a completed segment extends the lineage', async () => {
    const id = 'lineage-g3-completed'
    const { persist } = runnerWith('completed', [msg('a'), msg('b')], id)
    await persist()
    expect(await historyOf(id)).toEqual(['a', 'b'])
  })

  it.each(['failed', 'cancelled', 'running'] as const)(
    'G3: a %s segment does NOT extend the lineage',
    async status => {
      const id = `lineage-g3-${status}`
      // Seed a known-good lineage, then let a non-completed attempt try to
      // overwrite it with its own (polluted) transcript.
      const good = runnerWith('completed', [msg('good-1')], id)
      await good.persist()

      const bad = runnerWith(status, [msg('good-1'), msg('polluted-attempt')], id)
      await bad.persist()

      expect(await historyOf(id)).toEqual(['good-1'])
    },
  )

  it('G4: persists only from the last compact boundary', async () => {
    const id = 'lineage-g4-boundary'
    const { persist } = runnerWith(
      'completed',
      [
        msg('dead-1'),
        msg('dead-2'),
        msg('summary', { isCompactBoundary: true }),
        msg('live-1'),
        msg('live-2'),
      ],
      id,
    )
    await persist()
    // The boundary itself is kept (it carries the compact summary); everything
    // before it is dropped — the kernel query path slices identically.
    expect(await historyOf(id)).toEqual(['summary', 'live-1', 'live-2'])
  })

  it('G4: an uncompacted transcript is persisted whole', async () => {
    const id = 'lineage-g4-nocompact'
    const { persist } = runnerWith('completed', [msg('x'), msg('y'), msg('z')], id)
    await persist()
    expect(await historyOf(id)).toEqual(['x', 'y', 'z'])
  })

  it('is a no-op without a lineageSessionId (ordinary isolated sub-agents)', async () => {
    const { persist } = runnerWith('completed', [msg('a')], undefined)
    await expect(persist()).resolves.toBeUndefined()
  })
})
