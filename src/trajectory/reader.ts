import { createReadStream } from 'node:fs'
import { appendFile, open, readFile, stat, truncate } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { normalizeResumedHistory } from '../core/SessionStore.js'
import type { ConversationMessage } from '../core/types.js'
import {
  TrajectoryEnvelopeSchema,
  TrajectoryItemSchema,
  TrajectoryLineSchema,
  type PreservedTrajectoryLine,
  type TrajectoryLine,
} from './types.js'

export interface TrajectoryVerification {
  valid: boolean
  lineCount: number
  lastOrdinal: number
  repairedTailBytes: number
  errors: string[]
}

function parsePreservedLine(raw: string, lineNumber: number | string): PreservedTrajectoryLine {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (error) {
    throw new Error(`invalid JSON at line ${lineNumber}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const envelope = TrajectoryEnvelopeSchema.safeParse(value)
  if (!envelope.success) {
    throw new Error(`invalid trajectory envelope at line ${lineNumber}: ${envelope.error.message}`)
  }
  const item = TrajectoryItemSchema.safeParse(envelope.data.item)
  return {
    ...envelope.data,
    item: item.success ? item.data : envelope.data.item,
    knownItem: item.success,
    rawLine: raw,
  }
}

function parseLine(raw: string, lineNumber: number | string): TrajectoryLine {
  const preserved = parsePreservedLine(raw, lineNumber)
  if (!preserved.knownItem) {
    throw new Error(
      `unknown trajectory item '${preserved.item.type}' at line ${lineNumber}; ` +
      'use the audit reader to preserve unsupported items',
    )
  }
  return TrajectoryLineSchema.parse(preserved)
}

export async function readTrajectory(path: string): Promise<TrajectoryLine[]> {
  const raw = await readFile(path, 'utf8')
  const lines = raw.split('\n')
  const result: TrajectoryLine[] = []
  let trajectoryId: string | undefined
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (!line) continue
    const parsed = parseLine(line, i + 1)
    const expected = result.length + 1
    if (parsed.ordinal !== expected) {
      throw new Error(`ordinal gap at line ${i + 1}: expected ${expected}, got ${parsed.ordinal}`)
    }
    if (result.length === 0) {
      if (parsed.item.type !== 'trajectory_meta') {
        throw new Error('first trajectory line must be trajectory_meta')
      }
      trajectoryId = parsed.trajectoryId
    } else if (parsed.trajectoryId !== trajectoryId) {
      throw new Error(
        `trajectoryId changed at line ${i + 1}: expected ${trajectoryId}, got ${parsed.trajectoryId}`,
      )
    }
    result.push(parsed)
  }
  return result
}

/**
 * Audit reader with forward compatibility for future item variants. Envelope,
 * identity and ordinal invariants stay strict; unknown item payloads retain the
 * exact raw JSON line and are excluded from recovery projectors.
 */
export async function readTrajectoryPreservingUnknown(
  path: string,
): Promise<PreservedTrajectoryLine[]> {
  const raw = await readFile(path, 'utf8')
  const result: PreservedTrajectoryLine[] = []
  let trajectoryId: string | undefined
  for (const [index, line] of raw.split('\n').entries()) {
    if (!line) continue
    const parsed = parsePreservedLine(line, index + 1)
    const expected = result.length + 1
    if (parsed.ordinal !== expected) {
      throw new Error(`ordinal gap at line ${index + 1}: expected ${expected}, got ${parsed.ordinal}`)
    }
    if (result.length === 0) {
      if (!parsed.knownItem || parsed.item.type !== 'trajectory_meta') {
        throw new Error('first trajectory line must be a known trajectory_meta item')
      }
      trajectoryId = parsed.trajectoryId
    } else if (parsed.trajectoryId !== trajectoryId) {
      throw new Error(
        `trajectoryId changed at line ${index + 1}: expected ${trajectoryId}, got ${parsed.trajectoryId}`,
      )
    }
    result.push(parsed)
  }
  return result
}

/**
 * Repair only a crash-torn final line, then validate every complete line.
 * Invalid JSON/schema in the middle and ordinal gaps fail closed.
 */
export async function repairAndVerifyTrajectory(path: string): Promise<TrajectoryVerification> {
  let info
  try {
    info = await stat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { valid: true, lineCount: 0, lastOrdinal: 0, repairedTailBytes: 0, errors: [] }
    }
    throw error
  }
  if (info.size === 0) {
    return { valid: true, lineCount: 0, lastOrdinal: 0, repairedTailBytes: 0, errors: [] }
  }

  const fh = await open(path, 'r')
  let raw: string
  try {
    raw = await fh.readFile('utf8')
  } finally {
    await fh.close()
  }

  let repairedTailBytes = 0
  if (!raw.endsWith('\n')) {
    const lastNewline = raw.lastIndexOf('\n')
    const tail = raw.slice(lastNewline + 1)
    try {
      parsePreservedLine(tail, raw.slice(0, lastNewline + 1).split('\n').length)
      raw += '\n'
      await appendFile(path, '\n', 'utf8')
    } catch {
      const keep = lastNewline < 0 ? 0 : Buffer.byteLength(raw.slice(0, lastNewline + 1))
      repairedTailBytes = info.size - keep
      await truncate(path, keep)
      raw = lastNewline < 0 ? '' : raw.slice(0, lastNewline + 1)
    }
  }

  const errors: string[] = []
  let lastOrdinal = 0
  let lineCount = 0
  let trajectoryId: string | undefined
  const lines = raw.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (!line) continue
    try {
      const parsed = parsePreservedLine(line, i + 1)
      const expected = lastOrdinal + 1
      if (parsed.ordinal !== expected) {
        errors.push(`ordinal gap at line ${i + 1}: expected ${expected}, got ${parsed.ordinal}`)
      }
      if (lineCount === 0) {
        trajectoryId = parsed.trajectoryId
        if (!parsed.knownItem || parsed.item.type !== 'trajectory_meta') {
          errors.push('first trajectory line must be a known trajectory_meta item')
        }
      } else if (parsed.trajectoryId !== trajectoryId) {
        errors.push(
          `trajectoryId changed at line ${i + 1}: expected ${trajectoryId}, got ${parsed.trajectoryId}`,
        )
      }
      lastOrdinal = parsed.ordinal
      lineCount++
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
  }
  return { valid: errors.length === 0, lineCount, lastOrdinal, repairedTailBytes, errors }
}

export interface TrajectoryPage {
  lines: PreservedTrajectoryLine[]
  afterOrdinal: number
  nextOrdinal: number
  hasMore: boolean
}

export interface TrajectorySuffix {
  lines: PreservedTrajectoryLine[]
  /** Last ordinal present in the file; 0 when the file is empty or missing. */
  lastOrdinal: number
}

/**
 * Every line after `afterOrdinal`, located by scanning backwards from EOF.
 *
 * This is the cursor read. It costs O(suffix) where the forward reader costs
 * O(prefix): an incremental consumer whose cursor already sits near the tail
 * stops as soon as it passes its own cursor, instead of re-parsing everything
 * before it to prove continuity from line 1.
 *
 * Skipping is still impossible. The suffix is verified internally — contiguous
 * descending ordinals, one trajectoryId — and the scan only stops on the line
 * whose ordinal equals `afterOrdinal`, so the first returned line is provably
 * `afterOrdinal + 1`. What this read deliberately does NOT do is re-prove the
 * prefix; whole-file integrity belongs to `trajectory verify` and the audit
 * reader. That is the same split already drawn between suffix resume and full
 * verified replay, applied to paging.
 */
export async function readTrajectorySuffixAfter(
  path: string,
  afterOrdinal: number,
): Promise<TrajectorySuffix> {
  const after = Math.max(0, afterOrdinal)
  let info
  try {
    info = await stat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { lines: [], lastOrdinal: 0 }
    throw error
  }
  if (info.size === 0) return { lines: [], lastOrdinal: 0 }

  const fh = await open(path, 'r')
  const reversed: PreservedTrajectoryLine[] = []
  let lastOrdinal = 0
  let expected: number | undefined
  let trajectoryId: string | undefined
  let reachedCursor = false
  try {
    for await (const raw of reverseRawLines(fh, info.size)) {
      const line = parsePreservedLine(raw, 'cursor suffix')
      if (expected !== undefined && line.ordinal !== expected) {
        throw new Error(`ordinal gap in cursor suffix: expected ${expected}, got ${line.ordinal}`)
      }
      if (!trajectoryId) {
        trajectoryId = line.trajectoryId
        lastOrdinal = line.ordinal
      } else if (line.trajectoryId !== trajectoryId) {
        throw new Error(
          `trajectoryId changed in cursor suffix: expected ${trajectoryId}, got ${line.trajectoryId}`,
        )
      }
      expected = line.ordinal - 1
      if (line.ordinal <= after) {
        reachedCursor = true
        break
      }
      reversed.push(line)
    }
  } finally {
    await fh.close()
  }

  // Reaching the file head is equivalent to reaching a cursor of 0: the first
  // line must then be ordinal 1, which the descending check already proved.
  if (!reachedCursor && after > 0 && reversed.length > 0 && reversed.at(-1)!.ordinal !== after + 1) {
    throw new Error(
      `cursor ${after} is not reachable in ${path}; suffix starts at ${reversed.at(-1)!.ordinal}`,
    )
  }
  return { lines: reversed.reverse(), lastOrdinal }
}

/**
 * Read the first page immediately after an ordinal; never skips the middle.
 *
 * `scan: 'verified'` (default) walks forward from line 1 and re-proves the whole
 * prefix — the right choice for inspection and diagnostics. `scan: 'cursor'`
 * uses the reverse suffix reader above, which is what an incremental consumer
 * wants: same no-skip guarantee, cost proportional to what is actually new.
 */
export async function readTrajectoryPage(
  path: string,
  options: { afterOrdinal?: number; limit?: number; scan?: 'verified' | 'cursor' } = {},
): Promise<TrajectoryPage> {
  const after = Math.max(0, options.afterOrdinal ?? 0)
  const limit = Math.max(1, options.limit ?? 200)
  if (options.scan === 'cursor') {
    const suffix = await readTrajectorySuffixAfter(path, after)
    const lines = suffix.lines.slice(0, limit)
    return {
      lines,
      afterOrdinal: after,
      nextOrdinal: lines.at(-1)?.ordinal ?? after,
      hasMore: suffix.lines.length > limit,
    }
  }
  const stream = createReadStream(path, { encoding: 'utf8' })
  const input = createInterface({ input: stream, crlfDelay: Infinity })
  const selected: PreservedTrajectoryLine[] = []
  let expected = 1
  let trajectoryId: string | undefined
  let lineNumber = 0
  try {
    for await (const raw of input) {
      lineNumber++
      if (!raw) continue
      const line = parsePreservedLine(raw, lineNumber)
      if (line.ordinal !== expected) {
        throw new Error(`ordinal gap at line ${lineNumber}: expected ${expected}, got ${line.ordinal}`)
      }
      expected++
      if (!trajectoryId) {
        if (!line.knownItem || line.item.type !== 'trajectory_meta') {
          throw new Error('first trajectory line must be a known trajectory_meta item')
        }
        trajectoryId = line.trajectoryId
      } else if (line.trajectoryId !== trajectoryId) {
        throw new Error(`trajectoryId changed at line ${lineNumber}: expected ${trajectoryId}, got ${line.trajectoryId}`)
      }
      if (line.ordinal <= after) continue
      selected.push(line)
      if (selected.length > limit) break
    }
  } finally {
    input.close()
    stream.destroy()
  }
  const hasMore = selected.length > limit
  const lines = selected.slice(0, limit)
  return {
    lines,
    afterOrdinal: after,
    nextOrdinal: lines.at(-1)?.ordinal ?? after,
    hasMore,
  }
}

/** Read newest lines, or a forward page when an explicit cursor is supplied. */
export async function readTrajectoryTail(
  path: string,
  options: { afterOrdinal?: number; limit?: number } = {},
): Promise<PreservedTrajectoryLine[]> {
  if (options.afterOrdinal !== undefined) {
    return (await readTrajectoryPage(path, options)).lines
  }
  const after = Math.max(0, options.afterOrdinal ?? 0)
  const limit = Math.max(1, options.limit ?? 200)
  const info = await stat(path)
  if (info.size === 0) return []
  const fh = await open(path, 'r')
  try {
    const chunks: Buffer[] = []
    const chunkSize = 64 * 1024
    let position = info.size
    let newlineCount = 0
    while (position > 0 && newlineCount <= limit + 1) {
      const size = Math.min(chunkSize, position)
      position -= size
      const buf = Buffer.allocUnsafe(size)
      await fh.read(buf, 0, size, position)
      chunks.unshift(buf)
      newlineCount += buf.toString('utf8').split('\n').length - 1
    }
    const raw = Buffer.concat(chunks).toString('utf8')
    const firstComplete = position > 0 ? raw.indexOf('\n') + 1 : 0
    const candidates = raw.slice(Math.max(0, firstComplete)).split('\n').filter(Boolean)
    const parsed = candidates
      .map(line => parsePreservedLine(line, 'suffix'))
      .filter(line => line.ordinal > after)
      .slice(-limit)
    for (let index = 1; index < parsed.length; index++) {
      const prior = parsed[index - 1]!
      const current = parsed[index]!
      if (current.trajectoryId !== prior.trajectoryId) {
        throw new Error(`trajectoryId changed in suffix: expected ${prior.trajectoryId}, got ${current.trajectoryId}`)
      }
      if (current.ordinal !== prior.ordinal + 1) {
        throw new Error(`ordinal gap in suffix: expected ${prior.ordinal + 1}, got ${current.ordinal}`)
      }
    }
    return parsed
  } finally {
    await fh.close()
  }
}

export interface ModelContextProjection {
  messages: Array<Record<string, unknown>>
  lastTurnContext?: Extract<TrajectoryLine['item'], { type: 'turn_context' }>
  /** Ordinal at which reconstruction started; 1 means a full replay. */
  scannedFromOrdinal: number
  usedCompaction: boolean
}

type CompactionLine = TrajectoryLine & {
  item: Extract<TrajectoryLine['item'], { type: 'compaction' }>
}

/** Reference forward projector used to prove reverse-scan parity. */
export function projectModelContext(
  lines: readonly TrajectoryLine[],
): ModelContextProjection {
  return foldModelContext(lines, [], 1, false)
}

/**
 * Rebuild model history from the newest safe, self-contained compaction.
 * A compaction is only a reverse-scan stop when a terminal run boundary exists
 * after it; otherwise an in-flight/torn run falls back to the full forward
 * replay. The returned context must therefore match projectModelContext().
 */
export async function readModelContextFromTrajectory(path: string): Promise<ModelContextProjection> {
  const info = await stat(path)
  if (info.size === 0) return projectModelContext([])
  const fh = await open(path, 'r')
  const reverseKnown: TrajectoryLine[] = []
  let expectedOrdinal: number | undefined
  let trajectoryId: string | undefined
  let newestRunBoundary: 'started' | 'result' | undefined
  let compaction: CompactionLine | undefined
  let latestTurnContext: ModelContextProjection['lastTurnContext']
  try {
    for await (const raw of reverseRawLines(fh, info.size)) {
      const preserved = parsePreservedLine(raw, 'reverse suffix')
      if (expectedOrdinal !== undefined && preserved.ordinal !== expectedOrdinal - 1) {
        throw new Error(
          `reverse ordinal gap: expected ${expectedOrdinal - 1}, got ${preserved.ordinal}`,
        )
      }
      expectedOrdinal = preserved.ordinal
      if (!trajectoryId) trajectoryId = preserved.trajectoryId
      else if (preserved.trajectoryId !== trajectoryId) {
        throw new Error(`trajectoryId changed during reverse scan: expected ${trajectoryId}, got ${preserved.trajectoryId}`)
      }
      if (preserved.knownItem) {
        const line = TrajectoryLineSchema.parse(preserved)
        reverseKnown.push(line)
        if (!latestTurnContext && line.item.type === 'turn_context') latestTurnContext = line.item
        if (!newestRunBoundary && line.item.type === 'run_result') newestRunBoundary = 'result'
        if (!newestRunBoundary && line.item.type === 'run_started') newestRunBoundary = 'started'
        if (!compaction && line.item.type === 'compaction' && newestRunBoundary === 'result') {
          compaction = line as CompactionLine
        }
      }
      if (compaction && latestTurnContext) break
    }
  } finally {
    await fh.close()
  }

  if (compaction && latestTurnContext) {
    const forward = reverseKnown.reverse()
    const boundary = forward.findIndex(line => line.ordinal === compaction!.ordinal)
    const projected = foldModelContext(
      forward.slice(boundary + 1),
      compaction.item.replacementHistory.map(message => ({ ...message })),
      compaction.ordinal,
      true,
    )
    projected.lastTurnContext = projected.lastTurnContext ?? latestTurnContext
    return projected
  }
  const preserved = await readTrajectoryPreservingUnknown(path)
  return projectModelContext(
    preserved
      .filter(line => line.knownItem)
      .map(line => TrajectoryLineSchema.parse(line)),
  )
}

function foldModelContext(
  lines: readonly TrajectoryLine[],
  seed: Array<Record<string, unknown>>,
  scannedFromOrdinal: number,
  usedCompaction: boolean,
): ModelContextProjection {
  let messages = seed
  let lastTurnContext: ModelContextProjection['lastTurnContext']
  for (const line of lines) {
    if (line.item.type === 'compaction') {
      messages = line.item.replacementHistory.map(message => ({ ...message }))
    } else if (line.item.type === 'message') {
      messages.push({ ...line.item.message })
    } else if (line.item.type === 'turn_context') {
      lastTurnContext = line.item
    }
  }
  // SessionStore omits thinking-only messages after stripping their blocks.
  // Canonical audit still records that a message existed, but model-context
  // projection must reproduce the legacy resume sequence exactly.
  const persistable = messages.filter(message => {
    const content = message['content']
    return !Array.isArray(content) || content.length > 0
  })
  const normalized = normalizeResumedHistory(persistable as unknown as ConversationMessage[])
  return {
    messages: normalized as unknown as Array<Record<string, unknown>>,
    lastTurnContext,
    scannedFromOrdinal,
    usedCompaction,
  }
}

async function* reverseRawLines(fh: FileHandle, fileSize: number): AsyncGenerator<string> {
  const chunkSize = 64 * 1024
  let position = fileSize
  let carry = Buffer.alloc(0)
  while (position > 0) {
    const size = Math.min(chunkSize, position)
    position -= size
    const chunk = Buffer.allocUnsafe(size)
    await fh.read(chunk, 0, size, position)
    const combined = Buffer.concat([chunk, carry])
    let end = combined.length
    for (let index = combined.length - 1; index >= 0; index--) {
      if (combined[index] !== 0x0a) continue
      if (index + 1 < end) yield combined.subarray(index + 1, end).toString('utf8')
      end = index
    }
    carry = combined.subarray(0, end)
  }
  if (carry.length > 0) yield carry.toString('utf8')
}
