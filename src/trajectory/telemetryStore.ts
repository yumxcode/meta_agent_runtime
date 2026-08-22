import { chmod, mkdir, readdir } from 'node:fs/promises'
import { atomicWriteJson, readJsonFile, withFileLock } from '../infra/persist/index.js'
import {
  emptyTrajectoryTelemetrySummary,
  TrajectoryTelemetryProjector,
  type TrajectoryTelemetrySummary,
} from './projector.js'
import { readTrajectorySuffixAfter } from './reader.js'
import { TrajectoryLineSchema } from './types.js'
import {
  trajectoriesRoot,
  trajectoryFile,
  trajectoryIndexDir,
  trajectoryTelemetryStateFile,
  type TrajectoryPathsOptions,
} from './paths.js'

const TELEMETRY_STATE_VERSION = 'trajectory-telemetry-state-1.0' as const

interface HistoricalTelemetryState {
  schemaVersion: typeof TELEMETRY_STATE_VERSION
  projectedOrdinals: Record<string, number>
  summary: TrajectoryTelemetrySummary
}

export interface HistoricalTelemetryProjection {
  summary: TrajectoryTelemetrySummary
  processedLines: number
  skippedUnknownItems: number
  projectedOrdinals: Record<string, number>
}

/**
 * Operational M4 consumer. Summary and cursors share one atomic document, so a
 * crash cannot advance a cursor without its counters (or double-count later).
 */
export async function projectHistoricalTrajectoryTelemetry(
  options: TrajectoryPathsOptions & { rebuild?: boolean } = {},
): Promise<HistoricalTelemetryProjection> {
  await mkdir(trajectoryIndexDir(options), { recursive: true, mode: 0o700 })
  await chmod(trajectoryIndexDir(options), 0o700)
  const file = trajectoryTelemetryStateFile(options)
  return withFileLock(file, async () => {
    const stored = options.rebuild
      ? null
      : await readJsonFile<HistoricalTelemetryState>(file, { tolerateUnreadable: true })
    const prior = stored?.schemaVersion === TELEMETRY_STATE_VERSION
      ? stored
      : {
          schemaVersion: TELEMETRY_STATE_VERSION,
          projectedOrdinals: {},
          summary: emptyTrajectoryTelemetrySummary(),
        }
    const projector = new TrajectoryTelemetryProjector({
      summary: prior.summary,
      seenTrajectoryIds: Object.keys(prior.projectedOrdinals),
    })
    const projectedOrdinals = { ...prior.projectedOrdinals }
    let ids: string[] = []
    try {
      ids = (await readdir(trajectoriesRoot(options), { withFileTypes: true }))
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    let processedLines = 0
    let skippedUnknownItems = 0
    for (const id of ids) {
      const cursor = projectedOrdinals[id] ?? 0
      // Cursor read: cost is proportional to what is new since the last run,
      // not to the trajectory's total length. A cold cursor (0) still reads
      // everything, which is correct — there is nothing to skip on a first pass.
      const { lines, lastOrdinal } = await readTrajectorySuffixAfter(trajectoryFile(id, options), cursor)
      if (cursor > lastOrdinal) {
        throw new Error(`telemetry cursor ${cursor} is ahead of trajectory ${id} at ${lastOrdinal}; rebuild required`)
      }
      for (const line of lines) {
        if (!line.knownItem) {
          skippedUnknownItems++
          continue
        }
        projector.observe(TrajectoryLineSchema.parse(line))
        processedLines++
      }
      projectedOrdinals[id] = lastOrdinal
    }
    const state: HistoricalTelemetryState = {
      schemaVersion: TELEMETRY_STATE_VERSION,
      projectedOrdinals,
      summary: projector.snapshot(),
    }
    await atomicWriteJson(file, state)
    await chmod(file, 0o600)
    return { ...state, processedLines, skippedUnknownItems }
  })
}
