import { createHash } from 'node:crypto'
import { access } from 'node:fs/promises'
import { redactSecrets } from '../infra/redaction/secretRedaction.js'
import { readTrajectoryPreservingUnknown } from '../trajectory/reader.js'
import { trajectoryFile, trajectoryLeaseFile, type TrajectoryPathsOptions } from '../trajectory/paths.js'
import type {
  PreservedTrajectoryLine,
  TrajectoryIndexEntry,
  TrajectoryItem,
} from '../trajectory/types.js'

export type ReviewTrigger = 'reviewer_correction' | 'repeated_failure' | 'human_correction'

export interface ReducedTrajectoryLine {
  ordinal: number
  ts: number
  itemType: string
  text: string
  journalSequence?: number
  artifactHash?: string
}

export interface TrajectoryReviewWindow {
  id: string
  trajectoryId: string
  trigger: ReviewTrigger
  triggerOrdinals: number[]
  workspace?: string
  workspaceId?: string
  graphHash?: string
  nodeId?: string
  taskSummary: string
  lines: ReducedTrajectoryLine[]
  /** Internal grouping identity used to merge only the same failure series. */
  groupKey?: string
}

export interface UnknownEvaluationVerdict {
  ordinal: number
  evaluator: string
  verdict: string
}

export interface ScannedTrajectory {
  entry: TrajectoryIndexEntry
  inputHash: string
  windows: TrajectoryReviewWindow[]
  unknownEvaluationVerdicts: UnknownEvaluationVerdict[]
}

export interface SkippedTrajectory {
  trajectoryId: string
  reason: string
}

const WINDOW_BEFORE = 6
const WINDOW_AFTER = 14
const MAX_WINDOW_LINES = 64
const MAX_LINE_TEXT = 1_500
const MAX_TASK_SUMMARY = 500

export async function scanTrajectoryForLearning(
  entry: TrajectoryIndexEntry,
  options: TrajectoryPathsOptions = {},
): Promise<ScannedTrajectory | SkippedTrajectory> {
  if (await access(trajectoryLeaseFile(entry.trajectoryId, options)).then(() => true, () => false)) {
    return { trajectoryId: entry.trajectoryId, reason: 'active writer lease' }
  }
  let lines: PreservedTrajectoryLine[]
  try {
    lines = await readTrajectoryPreservingUnknown(trajectoryFile(entry.trajectoryId, options))
  } catch (error) {
    return {
      trajectoryId: entry.trajectoryId,
      reason: `trajectory unreadable: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  const inputHash = createHash('sha256').update(lines.map(line => line.rawLine).join('\n')).digest('hex')
  try {
    return {
      entry,
      inputHash,
      windows: buildReviewWindows(entry, lines),
      unknownEvaluationVerdicts: findUnknownEvaluationVerdicts(lines),
    }
  } catch (error) {
    return {
      trajectoryId: entry.trajectoryId,
      reason: `trajectory pre-scan failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

export function buildReviewWindows(
  entry: TrajectoryIndexEntry,
  lines: readonly PreservedTrajectoryLine[],
): TrajectoryReviewWindow[] {
  const windows: TrajectoryReviewWindow[] = []
  const failingEvaluations = lines.filter(line => {
    if (!isKnownLine(line) || line.item.type !== 'evaluation') return false
    return isExplicitFailureVerdict(line.item.verdict)
  })
  for (const line of failingEvaluations) {
    windows.push(makeWindow(entry, lines, 'reviewer_correction', [line.ordinal]))
  }

  // Auto Verify corrections in trajectories written before evaluation items
  // were introduced are preserved as meta user messages.
  const autoVerifyEvaluations = lines.filter(line =>
    isKnownLine(line) && line.item.type === 'evaluation' && line.item.evaluator === 'auto_verify')
  const autoVerifyRunIds = new Set(autoVerifyEvaluations
    .map(line => line.runId)
    .filter((runId): runId is string => Boolean(runId)))
  const legacyReviewerCorrections = lines.filter(line => {
    if (!isKnownLine(line) || line.item.type !== 'message') return false
    // New trajectories contain both the structured evaluation and the legacy
    // correction message. Suppress the message only when its run already has
    // structured Auto Verify evidence; preserve genuinely old runs in a mixed
    // trajectory created across an upgrade.
    if (line.runId ? autoVerifyRunIds.has(line.runId) : autoVerifyEvaluations.length > 0) return false
    return line.item.message['role'] === 'user' &&
      /^\[系统·完成度审核\s+第\s*\d+\s*轮\]/.test(messageText(line.item.message['content']).trim())
  })
  for (const line of legacyReviewerCorrections) {
    windows.push(makeWindow(entry, lines, 'reviewer_correction', [line.ordinal]))
  }

  const humanCorrections = lines.filter(line => {
    if (!isKnownLine(line)) return false
    if (line.item.type === 'approval') {
      return line.item.decidedBy === 'human' &&
        (line.item.decision === 'deny' || line.item.decision === 'redirect')
    }
    return line.item.type === 'message' &&
      line.item.message['role'] === 'user' &&
      line.item.message['isSteering'] === true
  })
  for (const line of humanCorrections) {
    windows.push(makeWindow(entry, lines, 'human_correction', [line.ordinal]))
  }

  const failureGroups = new Map<string, PreservedTrajectoryLine[]>()
  for (const line of lines) {
    if (!isKnownLine(line) || line.item.type !== 'tool_outcome' || !line.item.isError) continue
    const signature = failureSignature(line.item)
    const group = failureGroups.get(signature) ?? []
    group.push(line)
    failureGroups.set(signature, group)
  }
  for (const [signature, group] of failureGroups) {
    if (group.length < 2) continue
    // Each recurrence is an independently bounded learning event. This keeps
    // late failures and their local context available even in long sessions.
    for (let index = 1; index < group.length; index++) {
      windows.push(makeWindow(entry, lines, 'repeated_failure', [
        group[index - 1]!.ordinal,
        group[index]!.ordinal,
      ], signature))
    }
  }

  return deduplicateWindows(windows)
}

function makeWindow(
  entry: TrajectoryIndexEntry,
  lines: readonly PreservedTrajectoryLine[],
  trigger: ReviewTrigger,
  triggerOrdinals: number[],
  groupKey?: string,
): TrajectoryReviewWindow {
  const selected = new Map<number, PreservedTrajectoryLine>()
  for (const center of triggerOrdinals) {
    const index = lines.findIndex(line => line.ordinal === center)
    if (index < 0) continue
    const from = Math.max(0, index - WINDOW_BEFORE)
    const to = Math.min(lines.length, index + WINDOW_AFTER + 1)
    for (const line of lines.slice(from, to)) selected.set(line.ordinal, line)
  }
  const availableTriggerOrdinals = triggerOrdinals.filter(ordinal => selected.has(ordinal))
  const ordered = limitWindowLines(
    [...selected.values()].sort((a, b) => a.ordinal - b.ordinal),
    availableTriggerOrdinals,
  )
  const graphContext = graphContextFrom(ordered)
  const taskSummary = entry.firstPrompt?.trim() || firstUserMessage(lines) || entry.title || 'Untitled agent task'
  const key = `${entry.trajectoryId}:${trigger}:${availableTriggerOrdinals.join(',')}`
  return {
    id: `window_${createHash('sha256').update(key).digest('hex').slice(0, 24)}`,
    trajectoryId: entry.trajectoryId,
    trigger,
    triggerOrdinals: availableTriggerOrdinals,
    ...(entry.workspace ? { workspace: entry.workspace } : {}),
    ...(entry.workspaceId ? { workspaceId: entry.workspaceId } : {}),
    ...(graphContext.graphHash ? { graphHash: graphContext.graphHash } : {}),
    ...(graphContext.nodeId ? { nodeId: graphContext.nodeId } : {}),
    taskSummary: clip(redactTaskSummary(taskSummary, entry.workspace), MAX_TASK_SUMMARY),
    lines: ordered.map(reduceTrajectoryLine),
    ...(groupKey ? { groupKey } : {}),
  }
}

function limitWindowLines<T extends { ordinal: number }>(
  ordered: T[],
  triggerOrdinals: readonly number[],
): T[] {
  if (ordered.length <= MAX_WINDOW_LINES) return ordered
  const triggers = new Set(triggerOrdinals)
  const required = ordered.filter(line => triggers.has(line.ordinal))
  if (required.length > MAX_WINDOW_LINES) {
    throw new Error(`review window has ${required.length} trigger lines; maximum is ${MAX_WINDOW_LINES}`)
  }
  const nearestContext = ordered
    .filter(line => !triggers.has(line.ordinal))
    .sort((left, right) => {
      const leftDistance = distanceFromTriggers(left.ordinal, triggerOrdinals)
      const rightDistance = distanceFromTriggers(right.ordinal, triggerOrdinals)
      return leftDistance - rightDistance || left.ordinal - right.ordinal
    })
    .slice(0, MAX_WINDOW_LINES - required.length)
  return [...required, ...nearestContext].sort((a, b) => a.ordinal - b.ordinal)
}

function distanceFromTriggers(ordinal: number, triggers: readonly number[]): number {
  return Math.min(...triggers.map(trigger => Math.abs(trigger - ordinal)))
}

function deduplicateWindows(windows: TrajectoryReviewWindow[]): TrajectoryReviewWindow[] {
  const seen = new Set<string>()
  const kept: TrajectoryReviewWindow[] = []
  for (const window of windows
    .filter(item => item.lines.length > 0)
    .sort((a, b) => a.lines[0]!.ordinal - b.lines[0]!.ordinal)) {
    if (seen.has(window.id)) continue
    seen.add(window.id)
    const prior = kept.at(-1)
    if (prior && shouldMergeRepeatedFailureWindows(prior, window)) {
      kept[kept.length - 1] = mergeReviewWindows(prior, window)
      continue
    }
    kept.push(window)
  }
  return kept
}

function shouldMergeRepeatedFailureWindows(
  left: TrajectoryReviewWindow,
  right: TrajectoryReviewWindow,
): boolean {
  if (left.trigger !== 'repeated_failure' || right.trigger !== 'repeated_failure') return false
  if (!left.groupKey || left.groupKey !== right.groupKey) return false
  const triggerCount = new Set([...left.triggerOrdinals, ...right.triggerOrdinals]).size
  return triggerCount <= MAX_WINDOW_LINES && overlapRatio(left.lines, right.lines) >= 0.8
}

function mergeReviewWindows(
  left: TrajectoryReviewWindow,
  right: TrajectoryReviewWindow,
): TrajectoryReviewWindow {
  const triggerOrdinals = [...new Set([...left.triggerOrdinals, ...right.triggerOrdinals])]
    .sort((a, b) => a - b)
  const byOrdinal = new Map([...left.lines, ...right.lines].map(line => [line.ordinal, line]))
  const lines = limitWindowLines(
    [...byOrdinal.values()].sort((a, b) => a.ordinal - b.ordinal),
    triggerOrdinals,
  )
  const key = `${left.trajectoryId}:${left.trigger}:${triggerOrdinals.join(',')}`
  return {
    ...left,
    id: `window_${createHash('sha256').update(key).digest('hex').slice(0, 24)}`,
    triggerOrdinals,
    lines,
  }
}

function overlapRatio(left: ReducedTrajectoryLine[], right: ReducedTrajectoryLine[]): number {
  const leftOrdinals = new Set(left.map(line => line.ordinal))
  const overlap = right.filter(line => leftOrdinals.has(line.ordinal)).length
  return overlap / Math.max(1, Math.min(left.length, right.length))
}

export function reduceTrajectoryLine(line: PreservedTrajectoryLine): ReducedTrajectoryLine {
  const known = isKnownLine(line)
  const text = known ? renderKnownItem(line.item) : `unknown item '${line.item.type}'`
  const journalSequence = known && line.item.type === 'phase'
    ? line.item.journalSequence
    : undefined
  const artifactHash = known && line.item.type === 'evaluation'
    ? line.item.artifactHash
    : undefined
  return {
    ordinal: line.ordinal,
    ts: line.ts,
    itemType: line.item.type,
    text: clip(redactSecrets(text), MAX_LINE_TEXT),
    ...(journalSequence !== undefined ? { journalSequence } : {}),
    ...(artifactHash ? { artifactHash } : {}),
  }
}

function renderKnownItem(item: TrajectoryItem): string {
  switch (item.type) {
    case 'trajectory_meta':
      return `trajectory ${item.mode} ${JSON.stringify(item.subject)}`
    case 'run_started':
      return `run started: ${item.reason}`
    case 'run_result':
      return `run result outcome=${item.outcome} error=${item.isError} summary=${item.resultSummary ?? ''}`
    case 'turn_context':
      return `turn context model=${item.model} provider=${item.provider ?? ''}`
    case 'message':
      return `message role=${String(item.message['role'] ?? 'unknown')}: ${messageText(item.message['content'])}`
    case 'tool_outcome':
      return `tool ${item.toolName} error=${item.isError} exit=${String(item.exitCode ?? '')} ` +
        `command=${item.command ?? ''} summary=${item.outputSummary}`
    case 'turn_diff':
      return `diff files=${item.filesChanged} +${item.linesAdded} -${item.linesRemoved}: ` +
        item.files.map(file => `${file.status}:${file.path}`).join(', ')
    case 'approval':
      return `approval tool=${item.toolName} decision=${item.decision} by=${item.decidedBy} reason=${item.reason ?? ''}`
    case 'compaction':
      return `compaction ${item.previousTokens} -> ${item.summaryTokens}`
    case 'subagent':
      return `subagent ${item.action} task=${item.taskId}`
    case 'phase':
      return `phase ${item.domain}/${item.action} node=${item.nodeId ?? ''} details=${JSON.stringify(item.details ?? {})}`
    case 'job':
      return `job ${item.action} id=${item.jobId} summary=${item.summary ?? ''}`
    case 'knowledge':
      return `knowledge ${item.kind}/${item.action} entries=${item.entryIds.join(',')}` +
        renderInjectionProvenance(item)
    case 'state_checkpoint':
      return `checkpoint ${item.mode} revision=${String(item.revision ?? '')} hash=${item.contentHash}`
    case 'evaluation':
      return `evaluation by=${item.evaluator} verdict=${item.verdict} score=${String(item.score ?? '')} ` +
        `evidence=${(item.evidenceOrdinals ?? []).join(',')} details=${JSON.stringify(item['details'] ?? {})}`
  }
}

const MAX_RENDERED_INJECTIONS = 6
const MAX_RENDERED_REASON_CODES = 4

/**
 * Injection provenance, summarised for the Reviewer.
 *
 * The Reviewer is the read side of attribution: it is what will eventually be
 * asked "did this injected experience change anything". Rendering only
 * `entries=exp-1` would tell it an entry was present but not which version,
 * which selector chose it, or what it cost — the parts attribution needs.
 *
 * Appends nothing when the item carries no provenance, so every knowledge line
 * written before injection existed renders byte-identically and no existing
 * TaskCase window identity moves.
 *
 * Entry bodies are never rendered; only ids, truncated content hashes, selector
 * identity and reason codes, all of which the host already constrains.
 */
function renderInjectionProvenance(item: Extract<TrajectoryItem, { type: 'knowledge' }>): string {
  const parts: string[] = []

  const injected = item.injected ?? []
  if (injected.length > 0) {
    const shown = injected.slice(0, MAX_RENDERED_INJECTIONS)
    const rendered = shown.map(entry => `${entry.entryId}@${entry.contentHash.slice(0, 8)}`).join(',')
    const overflow = injected.length > shown.length ? `,+${injected.length - shown.length}` : ''
    parts.push(`injected=${injected.length}[${rendered}${overflow}]`)

    const selectors = [...new Set(shown.map(entry => entry.selectorVersion))]
    if (selectors.length > 0) parts.push(`selector=${selectors.join('|')}`)

    // Only surfaced when the selector actually assigned probabilistically —
    // its absence is meaningful and must not read as a default.
    const probabilistic = shown.filter(entry => entry.assignmentProbability !== undefined)
    if (probabilistic.length > 0) {
      parts.push(`propensity=${probabilistic.map(entry => entry.assignmentProbability!.toFixed(3)).join(',')}`)
    }
  }

  const excluded = item.excludedCandidates ?? []
  if (excluded.length > 0) {
    const codes = [...new Set(excluded.map(candidate => candidate.reasonCode))].slice(0, MAX_RENDERED_REASON_CODES)
    parts.push(`excluded=${excluded.length}(${codes.join(',')})`)
  }

  if (item.tokenCost !== undefined) parts.push(`tokens=${item.tokenCost}`)
  if (item.contextHash) parts.push(`context=${item.contextHash.slice(0, 8)}`)

  return parts.length > 0 ? ` ${parts.join(' ')}` : ''
}

function failureSignature(item: Extract<TrajectoryItem, { type: 'tool_outcome' }>): string {
  const normalized = item.outputSummary
    .toLowerCase()
    .replace(/[a-f0-9]{12,}/g, '<hex>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/\/[^\s:]+/g, '<path>')
    .replace(/\s+/g, ' ')
    .slice(0, 240)
  return `${item.toolName}|${String(item.exitCode ?? '')}|${normalized}`
}

function graphContextFrom(lines: readonly PreservedTrajectoryLine[]): { graphHash?: string; nodeId?: string } {
  for (const line of lines) {
    if (!isKnownLine(line) || line.item.type !== 'phase') continue
    const details = line.item.details ?? {}
    const graphHash = typeof details['graphHash'] === 'string' ? details['graphHash'] : undefined
    if (graphHash || line.item.nodeId) return { graphHash, nodeId: line.item.nodeId }
  }
  return {}
}

function firstUserMessage(lines: readonly PreservedTrajectoryLine[]): string {
  for (const line of lines) {
    if (!isKnownLine(line) || line.item.type !== 'message') continue
    if (line.item.message['role'] !== 'user') continue
    const text = messageText(line.item.message['content'])
    if (text) return text
  }
  return ''
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
}

function isExplicitFailureVerdict(verdict: string): boolean {
  const trimmed = verdict.trim()
  const normalized = trimmed.toLowerCase().replace(/[\s-]+/g, '_')
  return /^(?:fail|failed|failure|reject|rejected|deny|denied|violate|violated|violation|unsatisfied|not_satisfied|incomplete|invalid|error|needs_changes|changes_requested|failed_with_notes)$/.test(normalized) ||
    /^(?:未通过|失败|拒绝|不满足|不合格|需修改|需要修改)$/.test(trimmed)
}

function isExplicitSuccessVerdict(verdict: string): boolean {
  const trimmed = verdict.trim()
  const normalized = trimmed.toLowerCase().replace(/[\s-]+/g, '_')
  return /^(?:pass|passed|pass_with_notes|accept|accepted|ok|success|satisfied|valid|complete|completed)$/.test(normalized) ||
    /^(?:通过|满足|合格|完成|已完成)$/.test(trimmed)
}

function findUnknownEvaluationVerdicts(
  lines: readonly PreservedTrajectoryLine[],
): UnknownEvaluationVerdict[] {
  const unknown: UnknownEvaluationVerdict[] = []
  for (const line of lines) {
    if (!isKnownLine(line) || line.item.type !== 'evaluation') continue
    if (isExplicitFailureVerdict(line.item.verdict) || isExplicitSuccessVerdict(line.item.verdict)) continue
    unknown.push({
      ordinal: line.ordinal,
      evaluator: clip(redactSecrets(line.item.evaluator), 160).trim() || '[unknown evaluator]',
      verdict: clip(redactSecrets(line.item.verdict), 500),
    })
  }
  return unknown
}

export function redactTaskSummary(value: string, workspace?: string): string {
  let redacted = redactSecrets(value)
  if (workspace && !/^(?:\/|[A-Za-z]:[\\/])$/.test(workspace)) {
    redacted = replaceLiteral(redacted, workspace, '[WORKSPACE]')
  }
  const urls: string[] = []
  redacted = redacted.replace(/\bhttps?:\/\/[^\s\"'`，。；、<>()]+/gi, url => {
    const marker = `REVIEWER_URL_${urls.length}_PLACEHOLDER`
    urls.push(url)
    return marker
  })
  redacted = redacted
    .replace(/\/(?:Users|home)\/[^/\s]+/g, '[HOME]')
    .replace(/[A-Za-z]:\\Users\\[^\\\s]+/gi, '[HOME]')
    .replace(/(?:\/[^/\s\"'`，。；：、()[\]{}<>]+){2,}/g, '[PATH]')
  for (const [index, url] of urls.entries()) {
    redacted = replaceLiteral(redacted, `REVIEWER_URL_${index}_PLACEHOLDER`, url)
  }
  return redacted
}

function replaceLiteral(value: string, search: string, replacement: string): string {
  return search ? value.split(search).join(replacement) : value
}

function clip(value: string, limit: number): string {
  if (value.length <= limit) return value
  return `${value.slice(0, limit)}…[truncated]`
}

function isKnownLine(
  line: PreservedTrajectoryLine,
): line is PreservedTrajectoryLine & { knownItem: true; item: TrajectoryItem } {
  return line.knownItem
}
