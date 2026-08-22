import { createHash } from 'node:crypto'
import { access, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { SessionStore } from '../core/SessionStore.js'
import type { ConversationMessage } from '../core/types.js'
import { atomicWriteJson, readJsonFile, withFileLock } from '../infra/persist/index.js'
import { readTrajectoryHealth } from './health.js'
import { listTrajectoryIndex } from './indexStore.js'
import {
  readModelContextFromTrajectory,
  readTrajectoryPreservingUnknown,
} from './reader.js'
import { sanitizeTrajectoryItem } from './privacy.js'
import {
  trajectoryFile,
  trajectoryHome,
  trajectoryLeaseFile,
  trajectoryParityStateFile,
  type TrajectoryPathsOptions,
} from './paths.js'

const PARITY_STATE_VERSION = 'trajectory-parity-state-1.0' as const
const MAX_RETAINED_RUNS = 100

export type TrajectoryParityStatus =
  | 'match'
  | 'mismatch'
  | 'missing_legacy'
  | 'active_writer'
  | 'degraded'
  | 'error'

export interface TrajectoryParityObservation {
  trajectoryId: string
  sessionId: string
  lastOrdinal: number
  status: TrajectoryParityStatus
  trajectoryMessageCount?: number
  legacyMessageCount?: number
  trajectoryHash?: string
  legacyHash?: string
  unknownItems?: number
  error?: string
}

export interface TrajectoryParityEvidence {
  sessionId: string
  trajectoryId: string
  lastStatus: TrajectoryParityStatus
  lastObservedAt: number
  lastOrdinal: number
  matchStreakStartedAt?: number
  lastMatchedAt?: number
  lastMatchedOrdinal?: number
  matchingCheckpoints: number
}

export interface TrajectoryParityRun {
  observedAt: number
  completedAt: number
  observations: TrajectoryParityObservation[]
  comparable: number
  matches: number
  mismatches: number
  skipped: number
  allComparableMatched: boolean
}

interface TrajectoryParityState {
  schemaVersion: typeof PARITY_STATE_VERSION
  evidence: Record<string, TrajectoryParityEvidence>
  runs: TrajectoryParityRun[]
}

export interface TrajectoryParityReport extends TrajectoryParityRun {
  evidence: Record<string, TrajectoryParityEvidence>
  /** Technical signal only; elapsed release-cycle policy remains an external gate. */
  technicallyReady: boolean
}

/**
 * Compare the newest canonical session trajectory with the legacy
 * `history.jsonl` resume path. Results contain hashes/counts only and are kept
 * across invocations so a real release cycle can accumulate auditable evidence.
 */
export async function projectTrajectoryResumeParity(
  options: TrajectoryPathsOptions & { rebuild?: boolean } = {},
): Promise<TrajectoryParityReport> {
  const file = trajectoryParityStateFile(options)
  return withFileLock(file, async () => {
    const stored = options.rebuild
      ? null
      : await readJsonFile<TrajectoryParityState>(file, { tolerateUnreadable: true })
    const prior: TrajectoryParityState = stored?.schemaVersion === PARITY_STATE_VERSION
      ? stored
      : { schemaVersion: PARITY_STATE_VERSION, evidence: {}, runs: [] }
    const observedAt = Date.now()
    const latestBySession = new Map<string, Awaited<ReturnType<typeof listTrajectoryIndex>>[number]>()
    for (const entry of await listTrajectoryIndex(options)) {
      if (entry.subject.kind !== 'session') continue
      const previous = latestBySession.get(entry.subject.sessionId)
      if (
        !previous ||
        entry.lastActivity > previous.lastActivity ||
        (entry.lastActivity === previous.lastActivity && entry.trajectoryId > previous.trajectoryId)
      ) {
        latestBySession.set(entry.subject.sessionId, entry)
      }
    }

    const observations: TrajectoryParityObservation[] = []
    for (const [sessionId, entry] of [...latestBySession].sort(([a], [b]) => a.localeCompare(b))) {
      observations.push(await compareSessionTrajectory(sessionId, entry.trajectoryId, options))
    }
    const completedAt = Date.now()
    const comparable = observations.filter(item => item.status === 'match' || item.status === 'mismatch').length
    const matches = observations.filter(item => item.status === 'match').length
    const mismatches = observations.filter(item => item.status === 'mismatch').length
    const run: TrajectoryParityRun = {
      observedAt,
      completedAt,
      observations,
      comparable,
      matches,
      mismatches,
      skipped: observations.length - comparable,
      allComparableMatched: comparable > 0 && matches === comparable,
    }
    const evidence = updateEvidence(prior.evidence, run)
    const state: TrajectoryParityState = {
      schemaVersion: PARITY_STATE_VERSION,
      evidence,
      runs: [...prior.runs, run].slice(-MAX_RETAINED_RUNS),
    }
    await atomicWriteJson(file, state)
    await chmod(file, 0o600)
    const technicallyReady = observations.length > 0 && observations.every(item => item.status === 'match')
    return { ...run, evidence, technicallyReady }
  })
}

async function compareSessionTrajectory(
  sessionId: string,
  trajectoryId: string,
  options: TrajectoryPathsOptions,
): Promise<TrajectoryParityObservation> {
  let lastOrdinal = 0
  try {
    await access(trajectoryLeaseFile(trajectoryId, options))
    return { trajectoryId, sessionId, lastOrdinal, status: 'active_writer' }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { trajectoryId, sessionId, lastOrdinal, status: 'error', error: errorText(error) }
    }
  }
  try {
    const health = await readTrajectoryHealth(trajectoryId, options)
    if (health.canonicalDegraded || health.projectionDegraded) {
      return {
        trajectoryId,
        sessionId,
        lastOrdinal,
        status: 'degraded',
        error: health.lastError,
      }
    }
    const legacyFile = join(trajectoryHome(options), 'sessions', sessionId, 'history.jsonl')
    try {
      await access(legacyFile)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { trajectoryId, sessionId, lastOrdinal, status: 'missing_legacy' }
      }
      throw error
    }
    const canonical = await readTrajectoryPreservingUnknown(trajectoryFile(trajectoryId, options))
    lastOrdinal = canonical.at(-1)?.ordinal ?? 0
    const unknownItems = canonical.filter(line => !line.knownItem).length
    const [projected, legacy] = await Promise.all([
      readModelContextFromTrajectory(trajectoryFile(trajectoryId, options)),
      SessionStore.loadHistory(sessionId, { rootDir: join(trajectoryHome(options), 'sessions') }),
    ])
    const trajectoryMessages = comparableMessages(projected.messages)
    const legacyMessages = comparableMessages(legacy)
    const trajectoryHash = stableHash(trajectoryMessages)
    const legacyHash = stableHash(legacyMessages)
    return {
      trajectoryId,
      sessionId,
      lastOrdinal,
      status: trajectoryHash === legacyHash ? 'match' : 'mismatch',
      trajectoryMessageCount: trajectoryMessages.length,
      legacyMessageCount: legacyMessages.length,
      trajectoryHash,
      legacyHash,
      unknownItems,
    }
  } catch (error) {
    return { trajectoryId, sessionId, lastOrdinal, status: 'error', error: errorText(error) }
  }
}

function comparableMessages(
  messages: readonly (ConversationMessage | Record<string, unknown>)[],
): Array<Record<string, unknown>> {
  return messages.map(message => {
    const item = sanitizeTrajectoryItem({ type: 'message', message: { ...message } })
    if (item.type !== 'message') throw new Error('message sanitization changed item type')
    return item.message
  })
}

function stableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(sortJson(value))).digest('hex')
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, sortJson(child)]),
  )
}

function updateEvidence(
  prior: Readonly<Record<string, TrajectoryParityEvidence>>,
  run: TrajectoryParityRun,
): Record<string, TrajectoryParityEvidence> {
  const next = { ...prior }
  for (const observation of run.observations) {
    const previous = next[observation.sessionId]
    if (observation.status === 'active_writer') continue
    const matching = observation.status === 'match'
    const continues = matching && previous?.lastStatus === 'match'
    const newCheckpoint = matching && (
      previous?.trajectoryId !== observation.trajectoryId ||
      previous?.lastMatchedOrdinal !== observation.lastOrdinal
    )
    next[observation.sessionId] = {
      sessionId: observation.sessionId,
      trajectoryId: observation.trajectoryId,
      lastStatus: observation.status,
      lastObservedAt: run.completedAt,
      lastOrdinal: observation.lastOrdinal,
      matchStreakStartedAt: matching
        ? continues ? previous.matchStreakStartedAt ?? run.observedAt : run.observedAt
        : undefined,
      lastMatchedAt: matching ? run.completedAt : previous?.lastMatchedAt,
      lastMatchedOrdinal: matching ? observation.lastOrdinal : previous?.lastMatchedOrdinal,
      matchingCheckpoints: matching
        ? continues ? (previous.matchingCheckpoints + (newCheckpoint ? 1 : 0)) : 1
        : 0,
    }
  }
  return next
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
