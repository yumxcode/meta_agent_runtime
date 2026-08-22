import { describe, expect, it } from 'vitest'
import { mkdtemp, appendFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TrajectoryRecorder } from '../recorder.js'
import { readTrajectoryPage, readTrajectorySuffixAfter } from '../reader.js'
import { projectHistoricalTrajectoryTelemetry } from '../telemetryStore.js'

const subject = { kind: 'session', sessionId: 'cursor' } as const

async function recorderWith(lines: number, rootDir?: string) {
  const root = rootDir ?? await mkdtemp(join(tmpdir(), 'traj-cursor-'))
  const rec = await TrajectoryRecorder.open({ subject, mode: 'agentic' }, { rootDir: root })
  for (let i = 0; i < lines; i++) await rec.record({ type: 'run_started', reason: `r${i}` })
  await rec.barrier('seed')
  return { rec, root }
}

describe('trajectory cursor read', () => {
  it('returns the exact suffix after a cursor, never skipping the middle', async () => {
    const { rec } = await recorderWith(50)
    const suffix = await readTrajectorySuffixAfter(rec.path, 1)
    await rec.close()
    expect(suffix.lines[0]!.ordinal).toBe(2)
    expect(suffix.lines.at(-1)!.ordinal).toBe(51)
    expect(suffix.lines).toHaveLength(50)
    expect(suffix.lastOrdinal).toBe(51)
  })

  it('a cold cursor reads the whole trajectory and starts at ordinal 1', async () => {
    const { rec } = await recorderWith(5)
    const suffix = await readTrajectorySuffixAfter(rec.path, 0)
    await rec.close()
    expect(suffix.lines[0]!.ordinal).toBe(1)
    expect(suffix.lines[0]!.item.type).toBe('trajectory_meta')
  })

  it('a cursor at the tail returns nothing but still reports the last ordinal', async () => {
    const { rec } = await recorderWith(10)
    const suffix = await readTrajectorySuffixAfter(rec.path, 11)
    await rec.close()
    expect(suffix.lines).toHaveLength(0)
    expect(suffix.lastOrdinal).toBe(11)
  })

  it('missing and empty trajectories are not errors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'traj-cursor-empty-'))
    expect(await readTrajectorySuffixAfter(join(root, 'nope.jsonl'), 0))
      .toEqual({ lines: [], lastOrdinal: 0 })
    const empty = join(root, 'empty.jsonl')
    await writeFile(empty, '')
    expect(await readTrajectorySuffixAfter(empty, 0)).toEqual({ lines: [], lastOrdinal: 0 })
  })

  it('fails closed on a gap inside the scanned suffix', async () => {
    const { rec } = await recorderWith(3)
    const path = rec.path
    const id = rec.trajectoryId
    await rec.close()
    await appendFile(path, JSON.stringify({
      schemaVersion: 'trajectory-line-1.0', ts: Date.now(),
      ordinal: 99, trajectoryId: id, item: { type: 'run_started', reason: 'gap' },
    }) + '\n')
    await expect(readTrajectorySuffixAfter(path, 1)).rejects.toThrow(/ordinal gap in cursor suffix/)
  })

  it('preserves unknown future items verbatim like the audit reader', async () => {
    const { rec } = await recorderWith(2)
    const path = rec.path
    const id = rec.trajectoryId
    await rec.close()
    await appendFile(path, JSON.stringify({
      schemaVersion: 'trajectory-line-1.0', ts: Date.now(),
      ordinal: 4, trajectoryId: id, item: { type: 'from_a_later_version', payload: 1 },
    }) + '\n')
    const suffix = await readTrajectorySuffixAfter(path, 3)
    expect(suffix.lines).toHaveLength(1)
    expect(suffix.lines[0]!.knownItem).toBe(false)
    expect(suffix.lines[0]!.item).toMatchObject({ type: 'from_a_later_version' })
  })

  it('cursor and verified paging agree on every page boundary', async () => {
    const { rec } = await recorderWith(40)
    for (const after of [0, 1, 7, 25, 40, 41]) {
      const verified = await readTrajectoryPage(rec.path, { afterOrdinal: after, limit: 6 })
      const cursor = await readTrajectoryPage(rec.path, { afterOrdinal: after, limit: 6, scan: 'cursor' })
      expect(cursor.lines.map(l => l.ordinal)).toEqual(verified.lines.map(l => l.ordinal))
      expect(cursor.nextOrdinal).toBe(verified.nextOrdinal)
      expect(cursor.hasMore).toBe(verified.hasMore)
    }
    await rec.close()
  })

  it('telemetry re-consumption is bounded by what is new, not by total length', async () => {
    const { rec, root } = await recorderWith(400)
    const first = await projectHistoricalTrajectoryTelemetry({ rootDir: root })
    expect(first.processedLines).toBe(401)

    const second = await projectHistoricalTrajectoryTelemetry({ rootDir: root })
    expect(second.processedLines).toBe(0)
    expect(second.summary).toEqual(first.summary)

    await rec.record({ type: 'run_started', reason: 'new' })
    await rec.barrier('more')
    const third = await projectHistoricalTrajectoryTelemetry({ rootDir: root })
    expect(third.processedLines).toBe(1)
    expect(third.summary.runs).toBe(first.summary.runs + 1)
    await rec.close()
  })
})
