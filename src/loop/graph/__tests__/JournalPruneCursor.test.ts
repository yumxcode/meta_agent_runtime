/**
 * Journal prune cursor durability (B2).
 *
 * `journalPrunedThrough` was a plain in-memory field initialised to 0, so every
 * new process restarted the scan at sequence 1. `deleteJsonFile` swallows
 * ENOENT, so re-walking an already-deleted prefix still consumed the whole
 * HOUSEKEEPING_BATCH budget without deleting anything.
 *
 * With CHECKPOINT_INTERVAL=50 and HOUSEKEEPING_BATCH=500 that is 10 new journal
 * events per 1 sequence of catch-up. Every `meta-agent loop` invocation is a
 * fresh process, so an instance carrying a few thousand historical events could
 * never reach the live tail within one run — pruning stopped, permanently, and
 * the journal directory grew without bound.
 *
 * The cursor is now persisted in the checkpoint and, for checkpoints written
 * before the field existed, derived from the surviving journal files.
 */
import { describe, expect, it, afterEach } from 'vitest'
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GraphStore, graphPaths } from '../runtime/GraphStore.js'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true })))
})

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'graph-prune-'))
  dirs.push(dir)
  return dir
}

const INSTANCE = 'prune-fixture'

/**
 * Lay out an instance whose journal prefix 1..`prunedUpTo` is already deleted
 * and whose surviving tail runs `prunedUpTo+1 .. lastSequence`.
 */
async function seedInstance(projectDir: string, opts: {
  prunedUpTo: number
  lastSequence: number
  writePrunedThrough: boolean
}): Promise<void> {
  const paths = graphPaths(projectDir, INSTANCE)
  await mkdir(paths.journalDir, { recursive: true })
  for (let seq = opts.prunedUpTo + 1; seq <= opts.lastSequence; seq++) {
    const name = `${String(seq).padStart(12, '0')}.json`
    await writeFile(join(paths.journalDir, name), JSON.stringify({ sequence: seq }), 'utf-8')
  }
  const checkpoint: Record<string, unknown> = {
    schemaVersion: 'graph-checkpoint-2.0',
    lastSequence: opts.prunedUpTo,
    instance: {}, state: {}, activations: [], commitKeys: [], externalEvents: [],
  }
  if (opts.writePrunedThrough) checkpoint['prunedThrough'] = opts.prunedUpTo
  await writeFile(paths.checkpointJson, JSON.stringify(checkpoint), 'utf-8')
}

/** Reach the private cursor resolver the way a fresh process would. */
function resolveCursor(store: GraphStore, previous: unknown): Promise<number> {
  return (store as unknown as {
    resolvePrunedThroughLocked(p: unknown): Promise<number>
  }).resolvePrunedThroughLocked(previous)
}

describe('journal prune cursor', () => {
  it('recovers the cursor from the checkpoint in a brand-new store instance', async () => {
    const projectDir = await scratch()
    await seedInstance(projectDir, { prunedUpTo: 8_000, lastSequence: 8_050, writePrunedThrough: true })

    // A fresh GraphStore models a fresh process: the in-memory cursor is unset.
    const store = new GraphStore(projectDir, INSTANCE)
    const cursor = await resolveCursor(store, { prunedThrough: 8_000, lastSequence: 8_000 })

    expect(cursor).toBe(8_000)
  })

  it('derives the cursor from surviving journal files when the checkpoint predates the field', async () => {
    const projectDir = await scratch()
    await seedInstance(projectDir, { prunedUpTo: 8_000, lastSequence: 8_050, writePrunedThrough: false })

    const store = new GraphStore(projectDir, INSTANCE)
    // Legacy checkpoint: no `prunedThrough`. The lowest surviving journal file
    // is 8001, and files are deleted in ascending order, so everything below it
    // is provably gone.
    const cursor = await resolveCursor(store, { lastSequence: 8_000 })

    expect(cursor).toBe(8_000)
    // The pre-fix behaviour was 0, which is what stalled pruning. Assert the
    // regression explicitly rather than only the correct value.
    expect(cursor).not.toBe(0)
  })

  it('treats an empty journal directory as fully pruned up to the checkpoint', async () => {
    const projectDir = await scratch()
    await seedInstance(projectDir, { prunedUpTo: 500, lastSequence: 500, writePrunedThrough: false })

    const paths = graphPaths(projectDir, INSTANCE)
    expect(await readdir(paths.journalDir)).toEqual([])

    const store = new GraphStore(projectDir, INSTANCE)
    expect(await resolveCursor(store, { lastSequence: 500 })).toBe(500)
  })

  it('never rewinds: the in-process memo wins once resolved', async () => {
    const projectDir = await scratch()
    await seedInstance(projectDir, { prunedUpTo: 100, lastSequence: 150, writePrunedThrough: true })

    const store = new GraphStore(projectDir, INSTANCE)
    expect(await resolveCursor(store, { prunedThrough: 100, lastSequence: 100 })).toBe(100)
    // A later checkpoint read that somehow reports a lower value must not undo
    // deletions this process already performed.
    expect(await resolveCursor(store, { prunedThrough: 0, lastSequence: 100 })).toBe(100)
  })
})

describe('graph transactions', () => {
  it('rejects a nested transaction instead of deadlocking on its own lock', async () => {
    const projectDir = await scratch()
    const store = new GraphStore(projectDir, INSTANCE)

    // withFileLock is not reentrant. Before this guard the inner call waited
    // out the full 60s timeout and then threw a message about contention,
    // pointing the reader at other processes rather than at the real cause.
    await expect(
      store.withTransaction(async () => {
        await store.withTransaction(async () => 'unreachable')
      }),
    ).rejects.toThrow(/not reentrant/)
  })
})
