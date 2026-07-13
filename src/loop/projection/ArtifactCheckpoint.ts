import { atomicWriteJson } from '../../infra/persist/index.js'
import {
  readArtifactJournal,
  sealArtifactJournalIfNeeded,
  type ArtifactJournalCursor,
  type ArtifactSegmentPolicy,
} from '../artifacts/ArtifactSegmentStore.js'
import { hashArtifactContent, type ArtifactProposal } from '../artifacts/ArtifactProtocol.js'
import { isCommittedEvent } from '../artifacts/ArtifactExecutor.js'
import {
  ensureVersionedContentIndex,
  indexCommittedArtifactEvents,
} from '../artifacts/ArtifactIndexes.js'
import type { ProjectionBinding } from '../charter/CharterTypes.js'
import type { LoopInstance } from '../instance/InstanceStore.js'

export interface ArtifactProjectionView {
  count: number
  items: ArtifactProposal[]
}

export interface ArtifactStreamState {
  commitMode: 'append' | 'replace' | 'versioned'
  /** Logical members: append count, replace 0|1, or unique version count. */
  logicalCount: number
  committedCount: number
  current?: Omit<ArtifactProposal, 'content'>
}

export interface ArtifactCheckpoint {
  schemaVersion: '3.0'
  projectorVersion: 'builtin/artifact-checkpoint@3'
  configHash: string
  stateHash: string
  cursor: ArtifactJournalCursor
  /** Legacy convenience mirror of cursor.activeByteOffset. */
  byteOffset: number
  eventCount: number
  activeEventCount: number
  lastTransactionId?: string
  views: Record<string, ArtifactProjectionView>
  streamStates: Record<string, ArtifactStreamState>
  updatedAt: number
}

export interface ArtifactCheckpointResult {
  checkpoint: ArtifactCheckpoint
  replayedBytes: number
  rebuilt: boolean
}

/** Caller holds the Artifact journal lock when concurrent commits are possible. */
export async function refreshArtifactCheckpoint(
  instance: LoopInstance,
  policy?: ArtifactSegmentPolicy,
): Promise<ArtifactCheckpointResult> {
  const configHash = projectionConfigHash(instance)
  const stored = await instance.ledger.readJson<ArtifactCheckpoint>(instance.paths.artifactsCheckpointJson)
  const usable = isUsableCheckpoint(stored, configHash, instance.charter.projections)
  const base = usable ? stored! : emptyCheckpoint(configHash, instance.charter.projections)
  const tail = await readArtifactJournal(instance, usable ? base.cursor : undefined)
  await indexCommittedArtifactEvents(instance, tail.events)
  const incremental = usable && tail.fromCursor
  const reductionBase = incremental ? base : emptyCheckpoint(configHash, instance.charter.projections)
  const streamStates = await reduceStreamStates(
    instance, reductionBase.streamStates, tail.events, incremental,
  )
  let checkpoint: ArtifactCheckpoint = {
    ...reductionBase,
    cursor: tail.cursor,
    byteOffset: tail.cursor.activeByteOffset,
    eventCount: incremental ? reductionBase.eventCount + tail.eventCount : tail.eventCount,
    activeEventCount: incremental
      ? reductionBase.activeEventCount + tail.eventCount
      : Math.max(0, tail.eventCount - tail.manifest.totalEvents),
    views: reduceProjectionEvents(
      reductionBase.views,
      tail.events,
      instance.charter.projections,
      instance.charter.artifacts,
    ),
    streamStates,
    lastTransactionId: lastTransactionId(tail.events) ?? reductionBase.lastTransactionId,
    updatedAt: Date.now(),
  }
  checkpoint.stateHash = checkpointStateHash(checkpoint)
  await atomicWriteJson(instance.paths.artifactsCheckpointJson, checkpoint)
  // A durable snapshot must exist before its active bytes become immutable.
  const sealed = await sealArtifactJournalIfNeeded(instance, policy, {
    activeBytes: checkpoint.cursor.activeByteOffset,
    activeEvents: checkpoint.activeEventCount,
  })
  if (sealed) {
    checkpoint = {
      ...checkpoint,
      cursor: {
        sealedSegments: checkpoint.cursor.sealedSegments + 1,
        sealedHeadHash: sealed.hash,
        activeByteOffset: 0,
      },
      byteOffset: 0,
      activeEventCount: 0,
      updatedAt: Date.now(),
    }
    checkpoint.stateHash = checkpointStateHash(checkpoint)
    await atomicWriteJson(instance.paths.artifactsCheckpointJson, checkpoint)
  }
  return { checkpoint, replayedBytes: tail.bytesRead, rebuilt: !incremental }
}

function projectionConfigHash(instance: LoopInstance): string {
  return hashArtifactContent({
    scenario: instance.charter.scenario,
    artifacts: instance.charter.artifacts,
    projections: instance.charter.projections,
  })
}

function emptyCheckpoint(
  configHash: string,
  bindings: readonly ProjectionBinding[],
): ArtifactCheckpoint {
  return {
    schemaVersion: '3.0', projectorVersion: 'builtin/artifact-checkpoint@3', configHash,
    stateHash: '',
    cursor: { sealedSegments: 0, sealedHeadHash: null, activeByteOffset: 0 },
    byteOffset: 0, eventCount: 0, activeEventCount: 0,
    views: Object.fromEntries(bindings.map(binding => [binding.id, { count: 0, items: [] }])),
    streamStates: {},
    updatedAt: Date.now(),
  }
}

function isUsableCheckpoint(
  value: ArtifactCheckpoint | null,
  configHash: string,
  bindings: readonly ProjectionBinding[],
): boolean {
  if (!value || value.schemaVersion !== '3.0' ||
      value.projectorVersion !== 'builtin/artifact-checkpoint@3' || value.configHash !== configHash ||
      value.stateHash !== checkpointStateHash(value)) return false
  if (!value.cursor || !Number.isInteger(value.cursor.sealedSegments) || value.cursor.sealedSegments < 0 ||
      !Number.isInteger(value.cursor.activeByteOffset) || value.cursor.activeByteOffset < 0 ||
      (value.cursor.sealedHeadHash !== null && typeof value.cursor.sealedHeadHash !== 'string')) return false
  if (!Number.isInteger(value.activeEventCount) || value.activeEventCount < 0 ||
      value.activeEventCount > value.eventCount) return false
  if (!value.views || typeof value.views !== 'object' ||
      !value.streamStates || typeof value.streamStates !== 'object') return false
  for (const state of Object.values(value.streamStates)) {
    if (!state || !['append', 'replace', 'versioned'].includes(state.commitMode) ||
        !Number.isInteger(state.logicalCount) || state.logicalCount < 0 ||
        !Number.isInteger(state.committedCount) || state.committedCount < state.logicalCount ||
        (state.commitMode === 'replace' && state.logicalCount > 1) ||
        (state.current && 'content' in state.current)) return false
  }
  return bindings.every(binding => {
    const view = value.views[binding.id]
    return !!view && Number.isInteger(view.count) && view.count >= 0 && Array.isArray(view.items) &&
      view.items.length <= projectionLimit(binding)
  })
}

function checkpointStateHash(checkpoint: Pick<
  ArtifactCheckpoint,
  'eventCount' | 'lastTransactionId' | 'views' | 'streamStates'
>): string {
  return hashArtifactContent({
    eventCount: checkpoint.eventCount,
    lastTransactionId: checkpoint.lastTransactionId,
    views: checkpoint.views,
    streamStates: checkpoint.streamStates,
  })
}

async function reduceStreamStates(
  instance: LoopInstance,
  previous: Record<string, ArtifactStreamState>,
  events: readonly unknown[],
  incremental: boolean,
): Promise<Record<string, ArtifactStreamState>> {
  const states = Object.fromEntries(Object.entries(previous).map(([stream, state]) => [
    stream, state.current ? { ...state, current: { ...state.current } } : { ...state },
  ]))
  const seenTransactions = new Set<string>()
  const rebuildVersions = new Map<string, Set<string>>()
  for (const event of events) {
    if (!isCommittedEvent(event) || seenTransactions.has(event.transactionId)) continue
    seenTransactions.add(event.transactionId)
    for (const decision of event.decisions) {
      if (decision.verdict !== 'committed') continue
      const proposal = decision.proposal
      const spec = instance.charter.artifacts[proposal.artifactId]
      if (!spec) continue
      const state = states[spec.stream] ?? {
        commitMode: spec.commitMode, logicalCount: 0, committedCount: 0,
      }
      if (state.commitMode !== spec.commitMode) {
        throw new Error(`Artifact stream '${spec.stream}' mixes incompatible commit modes`)
      }
      state.committedCount++
      if (spec.commitMode === 'append') state.logicalCount++
      if (spec.commitMode === 'replace') {
        state.logicalCount = 1
        state.current = proposalRef(proposal)
      }
      if (spec.commitMode === 'versioned') {
        let unique: boolean
        if (incremental) {
          unique = await ensureVersionedContentIndex(instance, {
            stream: spec.stream, contentHash: proposal.contentHash,
            transactionId: event.transactionId, proposalId: proposal.proposalId,
          })
        } else {
          const hashes = rebuildVersions.get(spec.stream) ?? new Set<string>()
          unique = !hashes.has(proposal.contentHash)
          hashes.add(proposal.contentHash)
          rebuildVersions.set(spec.stream, hashes)
          await ensureVersionedContentIndex(instance, {
            stream: spec.stream, contentHash: proposal.contentHash,
            transactionId: event.transactionId, proposalId: proposal.proposalId,
          })
        }
        if (unique) state.logicalCount++
        if (unique) state.current = proposalRef(proposal)
      }
      states[spec.stream] = state
    }
  }
  return states
}

function proposalRef(proposal: ArtifactProposal): Omit<ArtifactProposal, 'content'> {
  const { content: _content, ...reference } = proposal
  return reference
}

function reduceProjectionEvents(
  previous: Record<string, ArtifactProjectionView>,
  events: readonly unknown[],
  bindings: readonly ProjectionBinding[],
  specs: LoopInstance['charter']['artifacts'],
): Record<string, ArtifactProjectionView> {
  const views = Object.fromEntries(Object.entries(previous).map(([id, view]) => [
    id, { count: view.count, items: [...view.items] },
  ]))
  const byStream = new Map<string, ProjectionBinding[]>()
  for (const binding of bindings) {
    byStream.set(binding.source.stream, [...(byStream.get(binding.source.stream) ?? []), binding])
  }
  for (const event of events) {
    if (!isCommittedEvent(event)) continue
    for (const decision of event.decisions) {
      if (decision.verdict !== 'committed') continue
      const spec = specs[decision.proposal.artifactId]
      if (!spec) continue
      for (const binding of byStream.get(spec.stream) ?? []) {
        const view = views[binding.id] ?? { count: 0, items: [] }
        view.count++
        if (binding.mode === 'latest') view.items = [decision.proposal]
        if (binding.mode === 'window') {
          view.items = [...view.items, decision.proposal].slice(-projectionLimit(binding))
        }
        views[binding.id] = view
      }
    }
  }
  return views
}

function projectionLimit(binding: ProjectionBinding): number {
  return binding.mode === 'count' ? 0 : binding.mode === 'latest' ? 1 : binding.maxItems ?? 1
}

function lastTransactionId(events: readonly unknown[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (isCommittedEvent(event)) return event.transactionId
  }
  return undefined
}
