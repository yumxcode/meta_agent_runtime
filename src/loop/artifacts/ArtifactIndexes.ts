import { createHash } from 'crypto'
import { mkdir } from 'fs/promises'
import { dirname, join } from 'path'
import { atomicWriteJson, readJsonFile } from '../../infra/persist/index.js'
import type { LoopInstance } from '../instance/InstanceStore.js'
import { hashArtifactContent } from './ArtifactProtocol.js'
import { isCommittedEvent, type ArtifactLedgerEvent } from './ArtifactExecutor.js'

type CommittedEvent = Extract<ArtifactLedgerEvent, { type: 'artifact.transaction_committed' }>

interface TransactionIndexRecord {
  schemaVersion: '1.0'
  transactionId: string
  event: CommittedEvent
  eventHash: string
}

interface VersionIndexRecord {
  schemaVersion: '1.0'
  stream: string
  contentHash: string
  firstTransactionId: string
  proposalId: string
}

export class ArtifactIndexCorruptionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ArtifactIndexCorruptionError'
  }
}

/** Indexes terminal events before the projection checkpoint advances past them. */
export async function indexCommittedArtifactEvents(
  instance: LoopInstance,
  events: readonly unknown[],
): Promise<void> {
  const unique = new Map<string, CommittedEvent>()
  for (const event of events) {
    if (!isCommittedEvent(event)) continue
    const prior = unique.get(event.transactionId)
    if (prior && hashArtifactContent(prior) !== hashArtifactContent(event)) {
      throw new ArtifactIndexCorruptionError(`Conflicting terminal events for '${event.transactionId}'`)
    }
    unique.set(event.transactionId, event)
  }
  const entries = [...unique.values()]
  for (let start = 0; start < entries.length; start += 32) {
    await Promise.all(entries.slice(start, start + 32).map(event => indexOneTransaction(instance, event)))
  }
}

async function indexOneTransaction(instance: LoopInstance, event: CommittedEvent): Promise<void> {
  for (const decision of event.decisions) {
    if (decision.proposal.transactionId !== event.transactionId ||
        decision.proposal.contentHash !== hashArtifactContent(decision.proposal.content)) {
      throw new ArtifactIndexCorruptionError(`Invalid proposal integrity in '${event.transactionId}'`)
    }
  }
  const path = transactionPath(instance, event.transactionId)
  const existing = await readJsonFile<TransactionIndexRecord>(path)
  const eventHash = hashArtifactContent(event)
  if (existing) {
    if (existing.transactionId !== event.transactionId || existing.eventHash !== eventHash ||
        hashArtifactContent(existing.event) !== existing.eventHash) {
      throw new ArtifactIndexCorruptionError(`Conflicting transaction index for '${event.transactionId}'`)
    }
    return
  }
  await mkdir(dirname(path), { recursive: true })
  await atomicWriteJson(path, {
    schemaVersion: '1.0', transactionId: event.transactionId, event, eventHash,
  } satisfies TransactionIndexRecord)
}

export async function findCommittedArtifactTransaction(
  instance: LoopInstance,
  transactionId: string,
): Promise<CommittedEvent | null> {
  const record = await readJsonFile<TransactionIndexRecord>(transactionPath(instance, transactionId))
  if (!record) return null
  if (record.schemaVersion !== '1.0' || record.transactionId !== transactionId ||
      !isCommittedEvent(record.event) || record.event.transactionId !== transactionId ||
      record.eventHash !== hashArtifactContent(record.event)) {
    throw new ArtifactIndexCorruptionError(`Invalid transaction index for '${transactionId}'`)
  }
  return record.event
}

/** Returns true exactly once for a stream/content hash pair. Caller holds the journal lock. */
export async function ensureVersionedContentIndex(
  instance: LoopInstance,
  input: { stream: string; contentHash: string; transactionId: string; proposalId: string },
): Promise<boolean> {
  const path = versionPath(instance, input.stream, input.contentHash)
  const existing = await readJsonFile<VersionIndexRecord>(path)
  if (existing) {
    if (existing.schemaVersion !== '1.0' || existing.stream !== input.stream ||
        existing.contentHash !== input.contentHash) {
      throw new ArtifactIndexCorruptionError(`Invalid version index for stream '${input.stream}'`)
    }
    // Exact same proposal means the derived index survived while its
    // checkpoint did not; replay must still apply the delta once.
    return existing.firstTransactionId === input.transactionId && existing.proposalId === input.proposalId
  }
  await mkdir(dirname(path), { recursive: true })
  await atomicWriteJson(path, {
    schemaVersion: '1.0', stream: input.stream, contentHash: input.contentHash,
    firstTransactionId: input.transactionId, proposalId: input.proposalId,
  } satisfies VersionIndexRecord)
  return true
}

function transactionPath(instance: LoopInstance, transactionId: string): string {
  const hash = sha256(transactionId)
  return join(instance.paths.artifactsTransactionIndexDir, hash.slice(0, 2), `${hash}.json`)
}

function versionPath(instance: LoopInstance, stream: string, contentHash: string): string {
  const streamHash = sha256(stream)
  const keyHash = sha256(contentHash)
  return join(instance.paths.artifactsStreamIndexDir, streamHash, keyHash.slice(0, 2), `${keyHash}.json`)
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
