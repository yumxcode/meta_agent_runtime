/**
 * CapsuleBuilder — the deterministic per-round context capsule (spec C6).
 *
 * The capsule is how a reborn worker "knows the conclusions without the
 * narrative" (D5): a size-bounded, template-rendered digest of the ledger +
 * inbox, computed by code so it is identical for every seat and replayable.
 * Nothing in here comes from any agent's memory of previous rounds.
 */
import { readFile, readdir, rename, mkdir, stat } from 'fs/promises'
import { join } from 'path'
import { atomicWriteJson } from '../../infra/persist/index.js'
import { renderRoute, type InstancePaths, type RoundMode } from '../types.js'
import type { Ledger } from '../ledger/LedgerApi.js'
import type { ScenarioCapsuleView } from '../scenarios/ScenarioPlugin.js'

export interface Capsule {
  schemaVersion: 2
  builtAt: number
  round: number
  mode: RoundMode
  goal: string
  progress: {
    meters: Record<string, number>
    status: string
    totalCostUsd: number
    objective?: { bestValue: number | null }
  }
  /** Last K round summaries (route + seat summary). */
  recentRounds: string[]
  /** Human/external feedback consumed from the inbox THIS round. */
  inboxMessages: string[]
  /** Pivot declaration from a pivoter seat, when this is a pivot round. */
  pivotDirective?: string
  scenario: {
    id: string
    view: ScenarioCapsuleView
  }
}

const MAX_LINE_CHARS = 400
const MAX_LIST_ITEMS = 8
const MAX_SCENARIO_DATA_CHARS = 24_000
const MAX_INBOX_FILES_PER_ROUND = 32
const MAX_INBOX_FILE_BYTES = 256 * 1024

function digestLine(value: unknown): string {
  const s = typeof value === 'string' ? value : JSON.stringify(value)
  return s.length > MAX_LINE_CHARS ? s.slice(0, MAX_LINE_CHARS - 1) + '…' : s
}

export interface BuildCapsuleInput {
  paths: InstancePaths
  ledger: Ledger
  goal: string
  round: number
  mode: RoundMode
  pivotDirective?: string
  /**
   * Pre-read inbox messages (kernel: readInbox at round start, archiveInbox
   * only after the round durably commits). Passing them here keeps every
   * capsule of the round (pivoter + worker) seeing the same feedback. When
   * absent, the build does a NON-destructive read — buildCapsule never moves
   * inbox files itself, so an aborted/replayed round cannot lose feedback.
   */
  inboxMessages?: string[]
  scenario?: { id: string; view: ScenarioCapsuleView }
}

/**
 * Build the capsule from the ledger + inbox. Inbox consumption is
 * transactional with the round: the kernel archives the files it read only
 * after the round's durable commit (completeRound / submitSegment), so a
 * crash or abort before that point replays the round WITH the feedback.
 */
export async function buildCapsule(input: BuildCapsuleInput): Promise<Capsule> {
  const view = await input.ledger.readView(MAX_LIST_ITEMS)
  const inboxMessages = input.inboxMessages ?? (await readInbox(input.paths)).messages

  const capsule: Capsule = {
    schemaVersion: 2,
    builtAt: Date.now(),
    round: input.round,
    mode: input.mode,
    goal: input.goal,
    progress: {
      meters: view.progress.meters,
      status: view.progress.status,
      totalCostUsd: view.progress.totalCostUsd,
      ...(view.progress.objectiveBestValue !== null
        ? { objective: { bestValue: view.progress.objectiveBestValue } }
        : {}),
    },
    recentRounds: view.lastRounds.map(r =>
      digestLine(`#${r.round} [${r.mode}] route=${renderRoute(r.route)} ${Object.values(r.seatSummaries)[0] ?? ''}`),
    ),
    inboxMessages,
    scenario: input.scenario ? {
      id: digestLine(input.scenario.id),
      view: boundScenarioView(input.scenario.view),
    } : {
      id: 'unbound',
      view: { schemaVersion: 1, data: {}, sections: [] },
    },
    ...(input.pivotDirective ? { pivotDirective: digestLine(input.pivotDirective) } : {}),
  }
  await atomicWriteJson(input.paths.capsuleJson, capsule)
  return capsule
}

function boundScenarioView(view: ScenarioCapsuleView): ScenarioCapsuleView {
  const serialized = JSON.stringify(view.data)
  const data = serialized.length <= MAX_SCENARIO_DATA_CHARS
    ? view.data
    : {
        truncated: true,
        originalChars: serialized.length,
        preview: digestLine(serialized),
      }
  return {
    schemaVersion: Number.isSafeInteger(view.schemaVersion) ? view.schemaVersion : 1,
    data,
    sections: view.sections.slice(0, MAX_LIST_ITEMS).map(section => ({
      title: digestLine(section.title),
      items: section.items.slice(0, MAX_LIST_ITEMS).map(digestLine),
    })),
  }
}

/** Render the capsule as the prompt preamble seats receive. */
export function renderCapsule(capsule: Capsule): string {
  const lines = [
    '【本轮胶囊 — 由内核从账本确定性生成】',
    `轮次: ${capsule.round}  模式: ${capsule.mode}`,
    `进度: status=${capsule.progress.status} meters=${JSON.stringify(capsule.progress.meters)} ` +
      `cost=$${capsule.progress.totalCostUsd.toFixed(2)}` +
      (capsule.progress.objective ? ` objective_best=${capsule.progress.objective.bestValue}` : ''),
    `目标: ${capsule.goal}`,
    `场景: ${capsule.scenario.id}`,
  ]
  if (capsule.pivotDirective) lines.push(`【结构性转向指令】${capsule.pivotDirective}`)
  if (capsule.inboxMessages.length) {
    lines.push('【人工/外部反馈（本轮生效）】', ...capsule.inboxMessages.map(m => `- ${m}`))
  }
  for (const section of capsule.scenario.view.sections.slice(0, MAX_LIST_ITEMS)) {
    const title = digestLine(section.title)
    const items = section.items.slice(0, MAX_LIST_ITEMS).map(digestLine)
    if (items.length) lines.push(`【${title}】`, ...items.map(item => `- ${item}`))
  }
  if (capsule.recentRounds.length) {
    lines.push('【近期轮次】', ...capsule.recentRounds.map(r => `- ${r}`))
  }
  return lines.join('\n')
}

/**
 * Read the inbox WITHOUT moving anything. Returns the digested messages plus
 * the file names that produced them, so the kernel can archive exactly those
 * files once the round durably commits (transactional consumption: an
 * abort/replay between read and commit re-reads the same feedback).
 *
 * Unparseable .json items are quarantined LOUDLY as `.bad` (same philosophy
 * as events/): silently retrying them every round forever hides the
 * producer's bug. `.bad` falls out of the extension filter, so this is a
 * one-time action.
 */
export async function readInbox(
  paths: InstancePaths,
): Promise<{ messages: string[]; files: string[] }> {
  let entries: string[]
  try {
    entries = (await readdir(paths.inboxDir))
      .filter(f => f.endsWith('.json') || f.endsWith('.txt'))
      .sort()
      .slice(0, MAX_INBOX_FILES_PER_ROUND)
  } catch {
    return { messages: [], files: [] }
  }
  const messages: string[] = []
  const files: string[] = []
  for (const file of entries) {
    const from = join(paths.inboxDir, file)
    try {
      const size = (await stat(from)).size
      if (size > MAX_INBOX_FILE_BYTES) {
        console.error(`[loop] oversized inbox file ${from} (${size} bytes) — quarantined`)
        await rename(from, `${from}.oversize`).catch(() => undefined)
        continue
      }
      const raw = await readFile(from, 'utf-8')
      if (file.endsWith('.json')) {
        const parsed = JSON.parse(raw) as { message?: unknown }
        messages.push(digestLine(parsed.message ?? parsed))
      } else {
        messages.push(digestLine(raw.trim()))
      }
      files.push(file)
    } catch (err) {
      console.error(
        `[loop] unreadable inbox file ${from} — quarantined as .bad:`,
        err instanceof Error ? err.message : String(err),
      )
      await rename(from, `${from}.bad`).catch(() => undefined)
    }
  }
  return { messages, files }
}

/** Archive consumed inbox files to processed/ — call ONLY after the round's
 * durable commit. Already-moved files (concurrent archiver) are ignored. */
export async function archiveInbox(paths: InstancePaths, files: string[]): Promise<void> {
  if (files.length === 0) return
  await mkdir(paths.processedDir, { recursive: true })
  for (const file of files) {
    await rename(join(paths.inboxDir, file), join(paths.processedDir, file)).catch(() => undefined)
  }
}

/** @deprecated Legacy destructive read — use readInbox + archiveInbox so
 * consumption stays transactional with round completion. */
export async function consumeInbox(paths: InstancePaths): Promise<string[]> {
  const { messages, files } = await readInbox(paths)
  await archiveInbox(paths, files)
  return messages
}
