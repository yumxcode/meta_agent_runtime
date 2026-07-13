import { createHash } from 'crypto'
import { createReadStream } from 'fs'
import { mkdir, open, rename, stat } from 'fs/promises'
import { basename, join } from 'path'
import { atomicWriteJson } from '../../infra/persist/index.js'
import type { LoopInstance } from '../instance/InstanceStore.js'
import { hashArtifactContent } from './ArtifactProtocol.js'

export interface ArtifactSegment {
  id: number
  file: string
  firstSequence: number
  lastSequence: number
  eventCount: number
  bytes: number
  hash: string
  previousHash: string | null
}

/** Expanded logical manifest returned to recovery/inspection callers. */
export interface ArtifactSegmentManifest {
  schemaVersion: '2.0'
  segmentCount: number
  segments: ArtifactSegment[]
  pageCount: number
  pageHeadHash: string | null
  headHash: string | null
  totalEvents: number
  updatedAt: number
}

interface ManifestRoot {
  schemaVersion: '2.0'
  segmentCount: number
  pageCount: number
  pageHeadHash: string | null
  openSegments: ArtifactSegment[]
  headHash: string | null
  totalEvents: number
  updatedAt: number
  rootHash: string
}

interface LegacyManifest {
  schemaVersion: '1.0'
  segments: ArtifactSegment[]
  headHash: string | null
  totalEvents: number
  updatedAt: number
}

interface ManifestPage {
  schemaVersion: '1.0'
  id: number
  previousPageHash: string | null
  segments: ArtifactSegment[]
  hash: string
}

export interface ArtifactJournalCursor {
  sealedSegments: number
  sealedHeadHash: string | null
  activeByteOffset: number
}

export interface ArtifactJournalRead {
  events: unknown[]
  cursor: ArtifactJournalCursor
  fromCursor: boolean
  eventCount: number
  bytesRead: number
  manifest: ArtifactSegmentManifest
}

export interface ArtifactSegmentPolicy {
  maxActiveBytes?: number
  maxActiveEvents?: number
}

export class ArtifactJournalCorruptionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ArtifactJournalCorruptionError'
  }
}

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024
const DEFAULT_MAX_EVENTS = 10_000
/** Keeps the mutable root bounded; completed pages are immutable and hash-linked. */
const SEGMENTS_PER_PAGE = 64

export async function readArtifactJournal(
  instance: LoopInstance,
  cursor?: ArtifactJournalCursor,
): Promise<ArtifactJournalRead> {
  const root = await loadAndRecoverRoot(instance)
  const cursorUsable = !!cursor && cursor.sealedSegments === root.segmentCount &&
    cursor.sealedHeadHash === root.headHash && Number.isInteger(cursor.activeByteOffset) &&
    cursor.activeByteOffset >= 0
  const manifest = cursorUsable
    ? logicalManifest(root, [])
    : await expandAndVerifyManifest(instance, root)
  const events: unknown[] = []
  let bytesRead = 0
  let eventCount = 0
  if (!cursorUsable) {
    for (const segment of manifest.segments) {
      const path = join(instance.paths.artifactsSegmentsDir, segment.file)
      const parsed = await readCompleteJsonl(path, 0)
      if (parsed.completeBytes !== segment.bytes || parsed.events.length !== segment.eventCount) {
        throw new ArtifactJournalCorruptionError(`Artifact segment ${segment.file} no longer matches its manifest`)
      }
      events.push(...parsed.events)
      bytesRead += parsed.bytesRead
      eventCount += parsed.events.length
    }
  }

  const activeSize = await fileSize(instance.paths.artifactsJsonl)
  const activeOffset = cursorUsable && cursor.activeByteOffset <= activeSize ? cursor.activeByteOffset : 0
  const active = await readCompleteJsonl(instance.paths.artifactsJsonl, activeOffset)
  events.push(...active.events)
  bytesRead += active.bytesRead
  eventCount += active.events.length
  return {
    events,
    fromCursor: cursorUsable && activeOffset === cursor!.activeByteOffset,
    cursor: {
      sealedSegments: root.segmentCount,
      sealedHeadHash: root.headHash,
      activeByteOffset: activeOffset + active.completeBytes,
    },
    eventCount,
    bytesRead,
    manifest,
  }
}

/** Caller persists the projection checkpoint before invoking this function. */
export async function sealArtifactJournalIfNeeded(
  instance: LoopInstance,
  policy: ArtifactSegmentPolicy = {},
  observed?: { activeBytes: number; activeEvents: number },
): Promise<ArtifactSegment | null> {
  const maxBytes = policy.maxActiveBytes ?? DEFAULT_MAX_BYTES
  const maxEvents = policy.maxActiveEvents ?? DEFAULT_MAX_EVENTS
  const size = await fileSize(instance.paths.artifactsJsonl)
  if (size === 0 || (size < maxBytes && (observed?.activeEvents ?? 0) < maxEvents)) return null
  let root = await loadAndRecoverRoot(instance)
  const parsed = await readCompleteJsonl(instance.paths.artifactsJsonl, 0)
  if (parsed.completeBytes === 0 ||
      (parsed.completeBytes < maxBytes && parsed.events.length < maxEvents) ||
      size !== parsed.completeBytes) return null

  await mkdir(instance.paths.artifactsSegmentsDir, { recursive: true })
  const id = root.segmentCount + 1
  const file = segmentFile(id)
  const target = join(instance.paths.artifactsSegmentsDir, file)
  await rename(instance.paths.artifactsJsonl, target)
  const hash = await sha256File(target)
  const segment: ArtifactSegment = {
    id, file, firstSequence: root.totalEvents + 1,
    lastSequence: root.totalEvents + parsed.events.length,
    eventCount: parsed.events.length, bytes: parsed.completeBytes, hash,
    previousHash: root.headHash,
  }
  root = await writeRoot(instance, {
    ...root,
    segmentCount: root.segmentCount + 1,
    openSegments: [...root.openSegments, segment],
    headHash: hash,
    totalEvents: root.totalEvents + segment.eventCount,
    updatedAt: Date.now(),
  })
  await compactOpenSegments(instance, root)
  return segment
}

export async function loadArtifactSegmentManifest(
  instance: LoopInstance,
): Promise<ArtifactSegmentManifest> {
  return expandAndVerifyManifest(instance, await loadAndRecoverRoot(instance))
}

async function loadAndRecoverRoot(instance: LoopInstance): Promise<ManifestRoot> {
  const raw = await instance.ledger.readJson<ManifestRoot | LegacyManifest>(
    instance.paths.artifactsSegmentsManifestJson,
  )
  let root: ManifestRoot
  if (raw?.schemaVersion === '2.0') {
    root = validateRoot(raw)
  } else if (raw?.schemaVersion === '1.0') {
    root = await migrateLegacyManifest(instance, raw)
  } else {
    root = emptyRoot()
  }

  // Adopt a segment renamed before the root update. Deterministic filenames
  // let this remain O(number of crash orphans), not O(total segments).
  while (await exists(join(instance.paths.artifactsSegmentsDir, segmentFile(root.segmentCount + 1)))) {
    const id = root.segmentCount + 1
    const file = segmentFile(id)
    const path = join(instance.paths.artifactsSegmentsDir, file)
    const parsed = await readCompleteJsonl(path, 0)
    const bytes = await fileSize(path)
    if (bytes === 0 || parsed.completeBytes !== bytes) {
      throw new ArtifactJournalCorruptionError(`Orphan Artifact segment '${file}' is incomplete`)
    }
    const hash = await sha256File(path)
    const segment: ArtifactSegment = {
      id, file, firstSequence: root.totalEvents + 1,
      lastSequence: root.totalEvents + parsed.events.length,
      eventCount: parsed.events.length, bytes, hash, previousHash: root.headHash,
    }
    root = await writeRoot(instance, {
      ...root, segmentCount: id, openSegments: [...root.openSegments, segment],
      headHash: hash, totalEvents: root.totalEvents + segment.eventCount, updatedAt: Date.now(),
    })
    root = await compactOpenSegments(instance, root)
  }
  return compactOpenSegments(instance, root)
}

async function migrateLegacyManifest(
  instance: LoopInstance,
  legacy: LegacyManifest,
): Promise<ManifestRoot> {
  if (!Array.isArray(legacy.segments)) throw new ArtifactJournalCorruptionError('Invalid v1 Artifact manifest')
  let root = emptyRoot()
  for (const segment of legacy.segments) {
    root = {
      ...root, segmentCount: root.segmentCount + 1,
      openSegments: [...root.openSegments, segment], headHash: segment.hash,
      totalEvents: root.totalEvents + segment.eventCount, updatedAt: Date.now(),
    }
    if (root.openSegments.length >= SEGMENTS_PER_PAGE) root = await compactOpenSegments(instance, root)
  }
  if (root.headHash !== legacy.headHash || root.totalEvents !== legacy.totalEvents) {
    throw new ArtifactJournalCorruptionError('v1 Artifact manifest head is inconsistent')
  }
  return writeRoot(instance, root)
}

async function compactOpenSegments(instance: LoopInstance, root: ManifestRoot): Promise<ManifestRoot> {
  if (root.openSegments.length < SEGMENTS_PER_PAGE) return root
  const segments = root.openSegments.slice(0, SEGMENTS_PER_PAGE)
  const id = root.pageCount + 1
  const payload = {
    schemaVersion: '1.0' as const, id, previousPageHash: root.pageHeadHash, segments,
  }
  const page: ManifestPage = { ...payload, hash: hashArtifactContent(payload) }
  const path = pagePath(instance, id)
  const existing = await instance.ledger.readJson<ManifestPage>(path)
  if (existing && (existing.hash !== page.hash || hashArtifactContent({
    schemaVersion: existing.schemaVersion, id: existing.id,
    previousPageHash: existing.previousPageHash, segments: existing.segments,
  }) !== page.hash)) {
    throw new ArtifactJournalCorruptionError(`Conflicting Artifact manifest page ${id}`)
  }
  if (!existing) {
    await mkdir(instance.paths.artifactsSegmentPagesDir, { recursive: true })
    await atomicWriteJson(path, page)
  }
  return writeRoot(instance, {
    ...root, pageCount: id, pageHeadHash: page.hash,
    openSegments: root.openSegments.slice(SEGMENTS_PER_PAGE), updatedAt: Date.now(),
  })
}

async function expandAndVerifyManifest(
  instance: LoopInstance,
  root: ManifestRoot,
): Promise<ArtifactSegmentManifest> {
  const segments: ArtifactSegment[] = []
  let previousPageHash: string | null = null
  for (let id = 1; id <= root.pageCount; id++) {
    const page = await instance.ledger.readJson<ManifestPage>(pagePath(instance, id))
    if (!page || page.schemaVersion !== '1.0' || page.id !== id ||
        page.previousPageHash !== previousPageHash || page.segments.length !== SEGMENTS_PER_PAGE ||
        page.hash !== hashArtifactContent({
          schemaVersion: page.schemaVersion, id: page.id,
          previousPageHash: page.previousPageHash, segments: page.segments,
        })) {
      throw new ArtifactJournalCorruptionError(`Invalid Artifact manifest page ${id}`)
    }
    segments.push(...page.segments)
    previousPageHash = page.hash
  }
  if (previousPageHash !== root.pageHeadHash) {
    throw new ArtifactJournalCorruptionError('Artifact manifest page head is inconsistent')
  }
  segments.push(...root.openSegments)
  verifySegmentMetadata(root, segments)
  for (const segment of segments) {
    const path = join(instance.paths.artifactsSegmentsDir, segment.file)
    const info = await stat(path).catch(() => null)
    if (!info || info.size !== segment.bytes || await sha256File(path) !== segment.hash) {
      throw new ArtifactJournalCorruptionError(`Artifact segment '${segment.file}' failed verification`)
    }
  }
  return logicalManifest(root, segments)
}

function verifySegmentMetadata(root: ManifestRoot, segments: ArtifactSegment[]): void {
  let previousHash: string | null = null
  let nextSequence = 1
  if (segments.length !== root.segmentCount) {
    throw new ArtifactJournalCorruptionError('Artifact manifest segment count is inconsistent')
  }
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]!
    if (segment.id !== index + 1 || segment.file !== segmentFile(segment.id) ||
        segment.previousHash !== previousHash || segment.firstSequence !== nextSequence ||
        segment.lastSequence !== segment.firstSequence + segment.eventCount - 1) {
      throw new ArtifactJournalCorruptionError(`Invalid Artifact segment metadata at '${segment.file}'`)
    }
    previousHash = segment.hash
    nextSequence = segment.lastSequence + 1
  }
  if (root.headHash !== previousHash || root.totalEvents !== nextSequence - 1) {
    throw new ArtifactJournalCorruptionError('Artifact manifest head is inconsistent')
  }
}

async function writeRoot(instance: LoopInstance, value: Omit<ManifestRoot, 'rootHash'> | ManifestRoot): Promise<ManifestRoot> {
  const { rootHash: _old, ...fields } = value as ManifestRoot
  const root: ManifestRoot = { ...fields, rootHash: hashArtifactContent(fields) }
  await atomicWriteJson(instance.paths.artifactsSegmentsManifestJson, root)
  return root
}

function validateRoot(root: ManifestRoot): ManifestRoot {
  const { rootHash, ...fields } = root
  if (!Number.isInteger(root.segmentCount) || root.segmentCount < 0 ||
      !Number.isInteger(root.pageCount) || root.pageCount < 0 || !Array.isArray(root.openSegments) ||
      root.openSegments.length > SEGMENTS_PER_PAGE || rootHash !== hashArtifactContent(fields)) {
    throw new ArtifactJournalCorruptionError('Invalid Artifact manifest root')
  }
  return root
}

function emptyRoot(): ManifestRoot {
  const fields = {
    schemaVersion: '2.0' as const, segmentCount: 0, pageCount: 0,
    pageHeadHash: null, openSegments: [], headHash: null, totalEvents: 0, updatedAt: Date.now(),
  }
  return { ...fields, rootHash: hashArtifactContent(fields) }
}

function logicalManifest(root: ManifestRoot, segments: ArtifactSegment[]): ArtifactSegmentManifest {
  return {
    schemaVersion: '2.0', segmentCount: root.segmentCount, segments,
    pageCount: root.pageCount, pageHeadHash: root.pageHeadHash,
    headHash: root.headHash, totalEvents: root.totalEvents, updatedAt: root.updatedAt,
  }
}

function segmentFile(id: number): string { return `${String(id).padStart(8, '0')}.jsonl` }
function pagePath(instance: LoopInstance, id: number): string {
  return join(instance.paths.artifactsSegmentPagesDir, `${String(id).padStart(8, '0')}.json`)
}

async function readCompleteJsonl(
  path: string,
  offset: number,
): Promise<{ events: unknown[]; completeBytes: number; bytesRead: number }> {
  const events: unknown[] = []
  let carry: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  let bytesRead = 0
  try {
    const stream = createReadStream(path, { start: offset, highWaterMark: 64 * 1024 })
    for await (const value of stream) {
      const chunk = value as Buffer
      bytesRead += chunk.length
      const data = carry.length ? Buffer.concat([carry, chunk]) : chunk
      let start = 0
      for (let index = 0; index < data.length; index++) {
        if (data[index] !== 0x0a) continue
        const text = data.subarray(start, index).toString('utf-8').trim()
        if (text) {
          try { events.push(JSON.parse(text) as unknown) }
          catch { throw new ArtifactJournalCorruptionError(`Invalid JSON in '${basename(path)}'`) }
        }
        start = index + 1
      }
      carry = data.subarray(start)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { events: [], completeBytes: 0, bytesRead: 0 }
    throw error
  }
  return { events, completeBytes: bytesRead - carry.length, bytesRead }
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true } catch { return false }
}

async function fileSize(path: string): Promise<number> {
  try {
    const handle = await open(path, 'r')
    try { return (await handle.stat()).size } finally { await handle.close() }
  } catch { return 0 }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  const stream = createReadStream(path)
  for await (const chunk of stream) hash.update(chunk as Buffer)
  return hash.digest('hex')
}
