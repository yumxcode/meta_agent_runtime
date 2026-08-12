/**
 * M3 regression: a corrupt journal entry must surface as a sequence gap, not be
 * quarantined away and silently overwritten.
 *
 * Both journal scans used readJsonFile() as their existence probe. That helper
 * QUARANTINES a file it cannot parse (renames it to `<path>.<ts>.corrupt`) and
 * returns null, so probing a corrupt entry deleted it, stopped the scan at that
 * sequence, and let the next append reuse the number. The event vanished and,
 * because the numbering stayed contiguous, readJournalRangeLocked's
 * `journal sequence gap` check — the thing crash recovery relies on, and which
 * isDeterministicGraphError classifies as deterministic — never fired.
 */
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createDefaultGraphRuntimeCatalog,
  freezeLoopGraph,
  GraphStore,
  type LoopGraphSpec,
} from '../../index.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function makeStore(instanceId: string) {
  const projectDir = await mkdtemp(join(tmpdir(), 'graph-journal-corrupt-'))
  roots.push(projectDir)
  const catalog = createDefaultGraphRuntimeCatalog()
  const source: LoopGraphSpec = {
    schemaVersion: 'graph-2.0',
    id: 'journal_corruption',
    version: 1,
    goal: 'Exercise journal integrity.',
    state: {},
    lanes: {},
    nodes: {
      wait: { type: 'wait', wait: { kind: 'event', event: 'job.completed' } },
      done: { type: 'terminal', status: 'done' },
      failed: { type: 'terminal', status: 'failed' },
    },
    transitions: [
      { id: 'received', from: 'wait', on: 'event', to: 'done' },
      { id: 'failed', from: 'wait', on: 'failure', to: 'failed' },
    ],
    entrypoints: [{ id: 'start', node: 'wait' }],
    limits: { maxActivations: 3 },
  }
  const graph = freezeLoopGraph(source, catalog, 1)
  const store = await GraphStore.create({
    projectDir, instanceId, graph, functions: catalog.functions, now: 10,
  })
  return { projectDir, store }
}

const seqName = (n: number): string => `${String(n).padStart(12, '0')}.json`

describe('GraphStore journal integrity', () => {
  /**
   * The damaging shape is a crash that left the sequence counter BEHIND the
   * entries on disk, with the first entry past the counter corrupt. Recovery
   * scans forward from the counter to find the true tail — and that scan was
   * the destructive probe.
   */
  it('does not renumber over a corrupt entry when scanning forward from the counter', async () => {
    const { store } = await makeStore('corrupt-tail')
    const journalDir = store.paths.journalDir

    // Entries 2 and 3 landed, but the counter write for them never did.
    const tail = JSON.stringify({
      schemaVersion: 'graph-journal-1.0',
      sequence: 3,
      eventId: 'evt-3',
      event: { type: 'graph_status_changed', instance: {} },
    })
    await writeFile(join(journalDir, seqName(2)), '{ torn write, not json', 'utf-8')
    await writeFile(join(journalDir, seqName(3)), tail, 'utf-8')
    await writeFile(
      store.paths.journalSequenceJson,
      JSON.stringify({ schemaVersion: '1.0', lastSequence: 1 }),
      'utf-8',
    )

    // Appending must skip PAST the damaged tail (→ sequence 4), never reuse 2.
    const appended = await store.withTransaction(() =>
      store.appendEventLocked({ type: 'graph_status_changed', instance: {} } as never),
    )
    expect(appended.sequence).toBe(4)

    // Entry 3 was not orphaned behind a reused number, and the corrupt entry 2
    // is still on disk under some name — the history is damaged and stays
    // visibly damaged instead of being quietly rewritten.
    const names = await readdir(journalDir)
    expect(names).toContain(seqName(3))
    expect(names).toContain(seqName(4))
    expect(names.some(n => n.startsWith(seqName(2)))).toBe(true)

    // And a read of that range still refuses to reconstruct state from it.
    await expect(store.snapshot()).rejects.toThrow(/journal sequence gap/)
  })
})
