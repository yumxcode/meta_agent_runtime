import { chmod, mkdir, open, readdir } from 'node:fs/promises'
import { atomicWriteJson, readJsonFile, withFileLock } from '../infra/persist/index.js'
import { readTrajectoryPreservingUnknown } from './reader.js'
import {
  TrajectoryLineSchema,
  type PreservedTrajectoryLine,
  type TrajectoryIndexEntry,
  type TrajectoryLine,
  type TrajectorySubject,
} from './types.js'
import {
  trajectoriesRoot,
  trajectoryFile,
  trajectoryIndexDir,
  trajectoryIndexFile,
  type TrajectoryPathsOptions,
} from './paths.js'

const INDEX_SCHEMA_VERSION = 'trajectory-index-1.0' as const

interface IndexDocument {
  schemaVersion: typeof INDEX_SCHEMA_VERSION
  entries: TrajectoryIndexEntry[]
}

function subjectKey(subject: TrajectorySubject): string {
  switch (subject.kind) {
    case 'session': return `session:${subject.sessionId}`
    case 'graph_instance': return `graph:${subject.workspaceId}:${subject.instanceId}`
    case 'subagent': return `subagent:${subject.taskId}:${subject.sessionId}`
  }
}

export function sameTrajectorySubject(a: TrajectorySubject, b: TrajectorySubject): boolean {
  return subjectKey(a) === subjectKey(b)
}

async function readIndex(options: TrajectoryPathsOptions = {}): Promise<IndexDocument> {
  const raw = await readJsonFile<IndexDocument>(trajectoryIndexFile(options), { tolerateUnreadable: true })
  if (!raw || raw.schemaVersion !== INDEX_SCHEMA_VERSION || !Array.isArray(raw.entries)) {
    return { schemaVersion: INDEX_SCHEMA_VERSION, entries: [] }
  }
  return raw
}

export async function listTrajectoryIndex(
  options: TrajectoryPathsOptions = {},
): Promise<TrajectoryIndexEntry[]> {
  return (await readIndex(options)).entries
}

export async function findIndexedTrajectory(
  subject: TrajectorySubject,
  options: TrajectoryPathsOptions = {},
): Promise<TrajectoryIndexEntry | null> {
  return (await readIndex(options)).entries.find(entry => sameTrajectorySubject(entry.subject, subject)) ?? null
}

export async function findIndexedTrajectoryById(
  trajectoryId: string,
  options: TrajectoryPathsOptions = {},
): Promise<TrajectoryIndexEntry | null> {
  return (await readIndex(options)).entries.find(entry => entry.trajectoryId === trajectoryId) ?? null
}

export async function findTrajectoryBySessionId(
  sessionId: string,
  options: TrajectoryPathsOptions = {},
): Promise<TrajectoryIndexEntry | null> {
  return (await readIndex(options)).entries.find(entry =>
    (entry.subject.kind === 'session' || entry.subject.kind === 'subagent') &&
    entry.subject.sessionId === sessionId,
  ) ?? null
}

export async function upsertTrajectoryIndex(
  entry: TrajectoryIndexEntry,
  options: TrajectoryPathsOptions = {},
): Promise<void> {
  const file = trajectoryIndexFile(options)
  await mkdir(trajectoryIndexDir(options), { recursive: true, mode: 0o700 })
  await chmod(trajectoryIndexDir(options), 0o700)
  await withFileLock(file, async () => {
    const index = await readIndex(options)
    const without = index.entries.filter(item => item.trajectoryId !== entry.trajectoryId)
    without.push(entry)
    without.sort((a, b) => b.lastActivity - a.lastActivity || a.trajectoryId.localeCompare(b.trajectoryId))
    await atomicWritePrivateJson(file, { schemaVersion: INDEX_SCHEMA_VERSION, entries: without })
  })
}

/**
 * Atomically reserve the one canonical trajectory id for a subject. This is the
 * subject-level fence that makes two processes converge on the same writer
 * lease instead of creating two independent JSONL files during first open.
 */
export async function reserveTrajectoryIndex(
  candidate: TrajectoryIndexEntry,
  options: TrajectoryPathsOptions = {},
): Promise<TrajectoryIndexEntry> {
  const file = trajectoryIndexFile(options)
  await mkdir(trajectoryIndexDir(options), { recursive: true, mode: 0o700 })
  await chmod(trajectoryIndexDir(options), 0o700)
  return withFileLock(file, async () => {
    const index = await readIndex(options)
    const existing = index.entries.find(item => sameTrajectorySubject(item.subject, candidate.subject))
    if (existing) return existing
    const entries = [...index.entries, candidate]
      .sort((a, b) => b.lastActivity - a.lastActivity || a.trajectoryId.localeCompare(b.trajectoryId))
    await atomicWritePrivateJson(file, { schemaVersion: INDEX_SCHEMA_VERSION, entries })
    return candidate
  })
}

export function projectTrajectory(lines: readonly TrajectoryLine[]): TrajectoryIndexEntry {
  const first = lines[0]
  if (!first || first.item.type !== 'trajectory_meta') {
    throw new Error('trajectory must start with trajectory_meta')
  }
  const meta = first.item
  const entry: TrajectoryIndexEntry = {
    trajectoryId: first.trajectoryId,
    subject: meta.subject,
    mode: meta.mode,
    createdAt: meta.createdAt,
    lastActivity: first.ts,
    lastOrdinal: first.ordinal,
    workspace: meta.workspace,
    workspaceId: meta.workspaceId,
    rootTrajectoryId: meta.rootTrajectoryId,
    parentTrajectoryId: meta.parentTrajectoryId,
    toolCalls: 0,
    toolErrors: 0,
    runs: 0,
    totalCostUsd: 0,
  }
  return projectTrajectoryDelta(entry, lines.slice(1))
}

/** Idempotently fold only lines newer than an index entry's last ordinal. */
export function projectTrajectoryDelta(
  prior: TrajectoryIndexEntry,
  lines: readonly TrajectoryLine[],
): TrajectoryIndexEntry {
  const entry: TrajectoryIndexEntry = { ...prior }
  const pending = lines
    .filter(line => line.ordinal > entry.lastOrdinal)
    .sort((a, b) => a.ordinal - b.ordinal)
  for (const line of pending) {
    if (line.trajectoryId !== entry.trajectoryId) {
      throw new Error(`projection trajectoryId mismatch: expected ${entry.trajectoryId}, got ${line.trajectoryId}`)
    }
    if (line.ordinal !== entry.lastOrdinal + 1) {
      throw new Error(`projection ordinal gap: expected ${entry.lastOrdinal + 1}, got ${line.ordinal}`)
    }
    entry.lastActivity = Math.max(entry.lastActivity, line.ts)
    entry.lastOrdinal = line.ordinal
    applyKnownLine(entry, line)
  }
  return entry
}

export function projectPreservedTrajectory(
  lines: readonly PreservedTrajectoryLine[],
): TrajectoryIndexEntry {
  const first = lines[0]
  if (!first?.knownItem || first.item.type !== 'trajectory_meta') {
    throw new Error('trajectory must start with a known trajectory_meta')
  }
  const meta = TrajectoryLineSchema.parse(first).item
  if (meta.type !== 'trajectory_meta') throw new Error('trajectory meta parse failed')
  const entry: TrajectoryIndexEntry = {
    trajectoryId: first.trajectoryId,
    subject: meta.subject,
    mode: meta.mode,
    createdAt: meta.createdAt,
    lastActivity: first.ts,
    lastOrdinal: first.ordinal,
    workspace: meta.workspace,
    workspaceId: meta.workspaceId,
    rootTrajectoryId: meta.rootTrajectoryId,
    parentTrajectoryId: meta.parentTrajectoryId,
    toolCalls: 0,
    toolErrors: 0,
    runs: 0,
    totalCostUsd: 0,
  }
  for (const preserved of lines.slice(1)) {
    entry.lastActivity = Math.max(entry.lastActivity, preserved.ts)
    entry.lastOrdinal = preserved.ordinal
    if (preserved.knownItem) applyKnownLine(entry, TrajectoryLineSchema.parse(preserved))
  }
  return entry
}

function applyKnownLine(entry: TrajectoryIndexEntry, line: TrajectoryLine): void {
  switch (line.item.type) {
      case 'message': {
        const message = line.item.message as { role?: unknown; content?: unknown }
        if (!entry.firstPrompt && message.role === 'user') {
          const text = messageText(message.content)
          if (text) {
            entry.firstPrompt = text.slice(0, 240)
            entry.title = text.replace(/\s+/g, ' ').slice(0, 80)
          }
        }
        break
      }
      case 'tool_outcome':
        entry.toolCalls++
        if (line.item.isError) entry.toolErrors++
        break
      case 'run_started':
        entry.runs++
        break
      case 'run_result':
        entry.lastOutcome = line.item.outcome
        entry.totalCostUsd += Math.max(0, line.item.costUsd ?? 0)
        break
  }
}

export async function searchTrajectoryIndex(
  query: string,
  options: TrajectoryPathsOptions = {},
): Promise<TrajectoryIndexEntry[]> {
  const needle = query.trim().toLocaleLowerCase()
  const entries = await listTrajectoryIndex(options)
  if (!needle) return entries
  return entries.filter(entry => [
    entry.title,
    entry.firstPrompt,
    entry.mode,
    entry.workspace,
    entry.workspaceId,
    subjectKey(entry.subject),
  ].some(value => value?.toLocaleLowerCase().includes(needle)))
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block): block is { type: string; text: string } =>
      Boolean(block) && typeof block === 'object' &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string')
    .map(block => block.text)
    .join(' ')
    .trim()
}

export async function rebuildTrajectoryIndex(
  options: TrajectoryPathsOptions & { clean?: boolean } = {},
): Promise<{ indexed: number; failed: Array<{ trajectoryId: string; error: string }> }> {
  await mkdir(trajectoryIndexDir(options), { recursive: true, mode: 0o700 })
  await chmod(trajectoryIndexDir(options), 0o700)
  const indexFile = trajectoryIndexFile(options)
  let ids: string[] = []
  try {
    ids = (await readdir(trajectoriesRoot(options), { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  // Canonical files are scanned without the global index/subject fence. The
  // final short lock merges any concurrently-created or more advanced entry.
  const scanned = new Map<string, TrajectoryIndexEntry>()
  const failed: Array<{ trajectoryId: string; error: string }> = []
  for (const id of ids) {
    try {
      scanned.set(id, projectPreservedTrajectory(await readTrajectoryPreservingUnknown(trajectoryFile(id, options))))
    } catch (error) {
      failed.push({ trajectoryId: id, error: error instanceof Error ? error.message : String(error) })
    }
  }
  const entries = await withFileLock(indexFile, async () => {
    const current = await readIndex(options)
    const scannedIds = new Set(ids)
    const base = options.clean
      // Keep a successfully-scanned entry long enough to compare cursors: an
      // active recorder may have projected a newer append after the lock-free
      // scan completed. Failed scans are removed by a clean rebuild, while
      // entries created after the directory snapshot are preserved.
      ? current.entries.filter(entry =>
          !scannedIds.has(entry.trajectoryId) || scanned.has(entry.trajectoryId))
      : current.entries
    const merged = new Map(base.map(entry => [entry.trajectoryId, entry]))
    for (const [id, projected] of scanned) {
      const existing = merged.get(id)
      if (!existing || projected.lastOrdinal >= existing.lastOrdinal) merged.set(id, projected)
    }
    const next = [...merged.values()]
      .sort((a, b) => b.lastActivity - a.lastActivity || a.trajectoryId.localeCompare(b.trajectoryId))
    await atomicWritePrivateJson(indexFile, { schemaVersion: INDEX_SCHEMA_VERSION, entries: next })
    return next
  })
  return { indexed: scanned.size, failed }
}

async function atomicWritePrivateJson(file: string, value: unknown): Promise<void> {
  await atomicWriteJson(file, value)
  await chmod(file, 0o600)
}

export async function findTrajectoryByScanning(
  subject: TrajectorySubject,
  options: TrajectoryPathsOptions = {},
): Promise<TrajectoryIndexEntry | null> {
  let ids: string[]
  try {
    ids = await readdir(trajectoriesRoot(options))
  } catch {
    return null
  }
  for (const id of ids) {
    try {
      const file = trajectoryFile(id, options)
      const firstLine = await readFirstLine(file)
      const parsed = JSON.parse(firstLine) as TrajectoryLine
      if (parsed.item.type !== 'trajectory_meta' || !sameTrajectorySubject(parsed.item.subject, subject)) continue
      return projectPreservedTrajectory(await readTrajectoryPreservingUnknown(file))
    } catch {
      // A corrupt trajectory is reported by verify/reindex; discovery does not
      // let one unrelated record hide every healthy subject.
    }
  }
  return null
}

async function readFirstLine(file: string): Promise<string> {
  const fh = await open(file, 'r')
  try {
    const chunks: Buffer[] = []
    const chunkSize = 16 * 1024
    let position = 0
    let total = 0
    while (total < 1024 * 1024) {
      const chunk = Buffer.allocUnsafe(chunkSize)
      const { bytesRead } = await fh.read(chunk, 0, chunkSize, position)
      if (bytesRead === 0) break
      const slice = chunk.subarray(0, bytesRead)
      const newline = slice.indexOf(0x0a)
      if (newline >= 0) {
        chunks.push(slice.subarray(0, newline))
        return Buffer.concat(chunks).toString('utf8')
      }
      chunks.push(slice)
      position += bytesRead
      total += bytesRead
    }
    if (chunks.length === 0) throw new Error('trajectory is empty')
    if (total >= 1024 * 1024) throw new Error('trajectory_meta exceeds 1 MiB')
    return Buffer.concat(chunks).toString('utf8')
  } finally {
    await fh.close()
  }
}
