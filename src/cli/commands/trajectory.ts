import { access, readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import type { CliOptions } from '../args.js'
import {
  listTrajectoryIndex,
  rebuildTrajectoryIndex,
  searchTrajectoryIndex,
} from '../../trajectory/indexStore.js'
import {
  readTrajectoryPage,
  readTrajectoryPreservingUnknown,
  readTrajectoryTail,
  repairAndVerifyTrajectory,
} from '../../trajectory/reader.js'
import { projectHistoricalTrajectoryTelemetry } from '../../trajectory/telemetryStore.js'
import { projectTrajectoryResumeParity } from '../../trajectory/parityStore.js'
import { readTrajectoryHealth } from '../../trajectory/health.js'
import { surveyCorpus, formatCorpusSurvey } from '../../evaluation/CorpusSurvey.js'
import {
  trajectoriesRoot,
  trajectoryFile,
  trajectoryIndexDir,
  trajectoryLeaseFile,
  legacyTrajectoryProjectionStateFile,
} from '../../trajectory/paths.js'
import {
  TrajectoryLineSchema,
  type PreservedTrajectoryLine,
  type TrajectoryIndexEntry,
  type TrajectoryLine,
} from '../../trajectory/types.js'

interface ParsedTrajectoryArgs {
  command: string
  positionals: string[]
  json: boolean
  clean: boolean
  apply: boolean
  after?: number
  limit: number
  search: string
}

export async function runTrajectoryCommand(opts: CliOptions): Promise<void> {
  const parsed = parseTrajectoryArgs(opts.loopCommand?.args ?? [], opts.json)
  switch (parsed.command) {
    case 'list': {
      const entries = (await searchTrajectoryIndex(parsed.search)).slice(0, parsed.limit)
      await printEntries(entries, parsed.json)
      return
    }
    case 'inspect': {
      const id = await resolveTrajectoryId(requireId(parsed))
      const lines = await readTrajectoryPreservingUnknown(trajectoryFile(id))
      if (parsed.json) console.log(JSON.stringify({ trajectoryId: id, lines }, null, 2))
      else {
        console.log(`Trajectory ${id}`)
        for (const line of lines) {
          if (line.knownItem) printTimelineLine(line as TrajectoryLine)
          else console.log(`${String(line.ordinal).padStart(6)}  ${new Date(line.ts).toISOString()}  unknown:${line.item.type}`)
        }
      }
      return
    }
    case 'tail': {
      const id = await resolveTrajectoryId(requireId(parsed))
      if (parsed.after !== undefined) {
        // `tail --after` is the incremental-consumption contract, so it takes
        // the cursor read. Whole-file integrity stays with `trajectory verify`.
        const page = await readTrajectoryPage(trajectoryFile(id), {
          afterOrdinal: parsed.after,
          limit: parsed.limit,
          scan: 'cursor',
        })
        if (parsed.json) console.log(JSON.stringify({ trajectoryId: id, ...page }, null, 2))
        else {
          printTimeline(id, page.lines)
          console.log(`cursor ${page.nextOrdinal}; ${page.hasMore ? 'more available' : 'end of trajectory'}`)
        }
      } else {
        const lines = await readTrajectoryTail(trajectoryFile(id), { limit: parsed.limit })
        if (parsed.json) console.log(JSON.stringify({ trajectoryId: id, lines }, null, 2))
        else printTimeline(id, lines)
      }
      return
    }
    case 'verify': {
      const id = await resolveTrajectoryId(requireId(parsed))
      const file = trajectoryFile(id)
      if (await access(trajectoryLeaseFile(id)).then(() => true, () => false)) {
        throw new Error(`trajectory '${id}' has an active writer; verify after the writer closes`)
      }
      const structural = await repairAndVerifyTrajectory(file)
      const errors = [...structural.errors]
      const warnings: string[] = []
      if (structural.valid) {
        const preserved = await readTrajectoryPreservingUnknown(file)
        const unknown = preserved.filter(line => !line.knownItem)
        for (const line of unknown) warnings.push(`ordinal ${line.ordinal} preserves unknown item '${line.item.type}'`)
        const known = preserved.filter(line => line.knownItem) as TrajectoryLine[]
        errors.push(...await verifyRelationsAndRuns(id, known, warnings))
      }
      const result = { trajectoryId: id, ...structural, valid: errors.length === 0, errors, warnings }
      if (parsed.json) console.log(JSON.stringify(result, null, 2))
      else {
        console.log(`${result.valid ? 'OK' : 'INVALID'} ${id}: ${result.lineCount} lines, last ordinal ${result.lastOrdinal}`)
        if (result.repairedTailBytes) console.log(`repaired torn tail: ${result.repairedTailBytes} bytes`)
        for (const warning of warnings) console.log(`warning: ${warning}`)
        for (const error of errors) console.log(`error: ${error}`)
      }
      if (!result.valid) process.exitCode = 1
      return
    }
    case 'reindex': {
      if (parsed.clean) {
        await unlink(legacyTrajectoryProjectionStateFile()).catch(ignoreMissing)
      }
      const result = await rebuildTrajectoryIndex({ clean: parsed.clean })
      if (parsed.json) console.log(JSON.stringify(result, null, 2))
      else console.log(`Reindexed ${result.indexed} trajectories; ${result.failed.length} failed.`)
      return
    }
    case 'disk': {
      const [canonicalBytes, indexBytes, entries] = await Promise.all([
        directoryBytes(trajectoriesRoot()),
        directoryBytes(trajectoryIndexDir()),
        listTrajectoryIndex(),
      ])
      const result = { trajectories: entries.length, canonicalBytes, indexBytes }
      if (parsed.json) console.log(JSON.stringify(result, null, 2))
      else console.log(`${entries.length} trajectories; canonical ${formatBytes(canonicalBytes)}; index ${formatBytes(indexBytes)}`)
      return
    }
    case 'telemetry': {
      const result = await projectHistoricalTrajectoryTelemetry({ rebuild: parsed.clean })
      if (parsed.json) console.log(JSON.stringify(result, null, 2))
      else {
        console.log(
          `${result.summary.trajectories} trajectories; ${result.summary.runs} runs; ` +
          `${result.summary.toolCalls} tool calls; ${result.summary.failedRuns} failed runs; ` +
          `${result.processedLines} new lines projected`,
        )
        if (result.skippedUnknownItems) console.log(`skipped ${result.skippedUnknownItems} unknown item(s)`)
      }
      return
    }
    case 'parity': {
      const result = await projectTrajectoryResumeParity({ rebuild: parsed.clean })
      if (parsed.json) console.log(JSON.stringify(result, null, 2))
      else {
        console.log(
          `Resume parity: ${result.matches}/${result.comparable} comparable session(s) match; ` +
          `${result.skipped} skipped; technical gate ${result.technicallyReady ? 'READY' : 'NOT READY'}.`,
        )
        for (const item of result.observations.filter(observation => observation.status !== 'match')) {
          console.log(
            `${item.status.padEnd(14)} ${item.sessionId} (${item.trajectoryId.slice(0, 12)})` +
            `${item.error ? `: ${item.error}` : ''}`,
          )
        }
        console.log('Release-cycle duration remains a time-based gate; this command only records evidence.')
      }
      return
    }
    case 'corpus': {
      // §10.3: how much of the corpus could support a re-executable EvalCase.
      // Reported from G0 onward rather than discovered at G2, because if the
      // answer is small the statistical design has to be redone for small
      // samples before the machinery that assumes otherwise gets built.
      const report = await surveyCorpus()
      if (parsed.json) console.log(JSON.stringify(report, null, 2))
      else console.log(formatCorpusSurvey(report))
      return
    }
    case 'gc': {
      if (parsed.apply) {
        throw new Error('trajectory gc --apply is disabled until session_closed and reference-retention contracts are durable')
      }
      const entries = await listTrajectoryIndex()
      const referenced = new Set<string>()
      for (const entry of entries) {
        if (entry.rootTrajectoryId && entry.rootTrajectoryId !== entry.trajectoryId) referenced.add(entry.rootTrajectoryId)
        if (entry.parentTrajectoryId) referenced.add(entry.parentTrajectoryId)
        try {
          const lines = await readTrajectoryPreservingUnknown(trajectoryFile(entry.trajectoryId))
          for (const line of lines) {
            if (!line.knownItem) continue
            const known = TrajectoryLineSchema.parse(line)
            if (known.item.type === 'subagent' && known.item.childTrajectoryId) referenced.add(known.item.childTrajectoryId)
          }
        } catch { /* verify/reindex reports corrupt files; GC never deletes them */ }
      }
      const candidates = await Promise.all(entries.map(async entry => {
        const reasons: string[] = []
        if (await access(trajectoryLeaseFile(entry.trajectoryId)).then(() => true, () => false)) reasons.push('active_or_stale_writer_lock')
        if (referenced.has(entry.trajectoryId)) reasons.push('referenced')
        reasons.push('session_closed_not_proven')
        return { trajectoryId: entry.trajectoryId, eligible: false, reasons }
      }))
      const result = { dryRun: true, deleted: 0, candidates }
      if (parsed.json) console.log(JSON.stringify(result, null, 2))
      else console.log(`Dry run: 0 deletable trajectories; inspected ${candidates.length}. Apply is disabled until lifecycle proof exists.`)
      return
    }
    default:
      throw new Error(
        'Usage: meta-agent trajectory <list|inspect|tail|verify|reindex|disk|telemetry|parity|gc> ' +
        '[id] [--after N] [--limit N] [--search text] [--clean] [--apply] [--json]',
      )
  }
}

export async function runSessionsCommand(opts: CliOptions): Promise<void> {
  const parsed = parseTrajectoryArgs(['list', ...(opts.loopCommand?.args ?? [])], opts.json)
  const entries = (await searchTrajectoryIndex(parsed.search))
    .filter(entry => entry.subject.kind === 'session')
    .slice(0, parsed.limit)
  await printEntries(entries, parsed.json)
}

function parseTrajectoryArgs(args: string[], inheritedJson: boolean): ParsedTrajectoryArgs {
  const parsed = parseArgs({
    args,
    options: {
      json: { type: 'boolean', short: 'j', default: false },
      clean: { type: 'boolean', default: false },
      apply: { type: 'boolean', default: false },
      after: { type: 'string' },
      limit: { type: 'string', default: '100' },
      search: { type: 'string', default: '' },
    },
    strict: true,
    allowPositionals: true,
  })
  const [command = 'list', ...positionals] = parsed.positionals
  const after = parsed.values.after === undefined
    ? undefined
    : parseNonNegativeInt(parsed.values.after, '--after')
  return {
    command,
    positionals,
    json: inheritedJson || parsed.values.json === true,
    clean: parsed.values.clean === true,
    apply: parsed.values.apply === true,
    after,
    limit: Math.max(1, parseNonNegativeInt(parsed.values.limit ?? '100', '--limit')),
    search: parsed.values.search ?? positionals.join(' '),
  }
}

function parseNonNegativeInt(value: string, name: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`)
  return parsed
}

function requireId(parsed: ParsedTrajectoryArgs): string {
  const id = parsed.positionals[0]
  if (!id) throw new Error(`trajectory ${parsed.command} requires an id`)
  return id
}

async function resolveTrajectoryId(input: string): Promise<string> {
  const entries = await listTrajectoryIndex()
  const exact = entries.find(entry => entry.trajectoryId === input)
  if (exact) return exact.trajectoryId
  const matches = entries.filter(entry => entry.trajectoryId.startsWith(input))
  if (matches.length === 1) return matches[0]!.trajectoryId
  if (matches.length > 1) throw new Error(`trajectory id prefix '${input}' is ambiguous`)
  await access(trajectoryFile(input))
  return input
}

async function verifyRelationsAndRuns(
  trajectoryId: string,
  lines: readonly TrajectoryLine[],
  warnings: string[],
): Promise<string[]> {
  const errors: string[] = []
  const entries = await listTrajectoryIndex()
  const known = new Set(entries.map(entry => entry.trajectoryId))
  const meta = lines[0]?.item.type === 'trajectory_meta' ? lines[0].item : undefined
  for (const ref of [meta?.parentTrajectoryId, meta?.rootTrajectoryId]) {
    if (ref && ref !== trajectoryId && !known.has(ref)) errors.push(`missing trajectory reference ${ref}`)
  }
  for (const line of lines) {
    if (line.item.type === 'subagent' && line.item.childTrajectoryId && !known.has(line.item.childTrajectoryId)) {
      errors.push(`ordinal ${line.ordinal} references missing child ${line.item.childTrajectoryId}`)
    }
  }

  const runs = new Map<string, { started: number; results: number }>()
  for (const line of lines) {
    if (line.item.type !== 'run_started' && line.item.type !== 'run_result') continue
    if (!line.runId) {
      errors.push(`ordinal ${line.ordinal} ${line.item.type} is missing runId`)
      continue
    }
    const counts = runs.get(line.runId) ?? { started: 0, results: 0 }
    if (line.item.type === 'run_started') counts.started++
    else counts.results++
    runs.set(line.runId, counts)
  }
  const liveWriter = await access(trajectoryLeaseFile(trajectoryId)).then(() => true, () => false)
  for (const [runId, counts] of runs) {
    if (counts.started === 1 && counts.results === 1) continue
    const text = `run ${runId} has ${counts.started} run_started and ${counts.results} run_result items`
    if (liveWriter && counts.started === 1 && counts.results === 0) warnings.push(`${text} (active writer)`)
    else errors.push(text)
  }
  return errors
}

async function printEntries(entries: readonly TrajectoryIndexEntry[], json: boolean): Promise<void> {
  const rows = await Promise.all(entries.map(async entry => ({
    entry,
    health: await readTrajectoryHealth(entry.trajectoryId),
  })))
  if (json) {
    console.log(JSON.stringify({ trajectories: rows.map(row => ({ ...row.entry, health: row.health })) }, null, 2))
    return
  }
  if (entries.length === 0) {
    console.log('No trajectories found.')
    return
  }
  for (const { entry, health } of rows) {
    const subject = entry.subject.kind === 'graph_instance'
      ? `${entry.subject.workspaceId}/${entry.subject.instanceId}`
      : entry.subject.sessionId
    const marker = health.canonicalDegraded ? 'CANONICAL_DEGRADED' : health.projectionDegraded ? 'PROJECTION_DEGRADED' : 'ok'
    console.log(`${entry.trajectoryId.slice(0, 12)}  ${entry.mode.padEnd(16)}  ${marker.padEnd(20)}  ${subject}  ${entry.title ?? ''}`.trimEnd())
  }
}

function printTimeline(id: string, lines: readonly PreservedTrajectoryLine[]): void {
  console.log(`Trajectory ${id}`)
  for (const line of lines) {
    if (line.knownItem) printTimelineLine(TrajectoryLineSchema.parse(line))
    else console.log(`${String(line.ordinal).padStart(6)}  ${new Date(line.ts).toISOString()}  unknown:${line.item.type}`)
  }
}

function printTimelineLine(line: TrajectoryLine): void {
  console.log(`${String(line.ordinal).padStart(6)}  ${new Date(line.ts).toISOString()}  ${line.item.type}  ${describeItem(line)}`.trimEnd())
}

function describeItem(line: TrajectoryLine): string {
  const item = line.item
  switch (item.type) {
    case 'trajectory_meta': return `${item.mode} ${item.subject.kind}`
    case 'run_started': return item.reason
    case 'run_result': return `${item.outcome}${item.isError ? ' (error)' : ''}`
    case 'tool_outcome': return `${item.toolName} ${item.isError ? 'error' : 'ok'} ${item.durationMs}ms`
    case 'phase': return `${item.domain}:${item.action}`
    case 'subagent': return `${item.action} ${item.taskId}`
    case 'job': return `${item.action} ${item.jobId}`
    case 'knowledge': return `${item.kind}:${item.action}`
    default: return ''
  }
}

async function directoryBytes(path: string): Promise<number> {
  let entries
  try {
    entries = await readdir(path, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
  let total = 0
  for (const entry of entries) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) total += await directoryBytes(child)
    else if (entry.isFile()) total += (await stat(child)).size
  }
  return total
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`
}

function ignoreMissing(error: unknown): void {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
}
