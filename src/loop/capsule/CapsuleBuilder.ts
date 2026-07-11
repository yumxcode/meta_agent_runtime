/**
 * CapsuleBuilder — the deterministic per-round context capsule (spec C6).
 *
 * The capsule is how a reborn worker "knows the conclusions without the
 * narrative" (D5): a size-bounded, template-rendered digest of the ledger +
 * inbox, computed by code so it is identical for every seat and replayable.
 * Nothing in here comes from any agent's memory of previous rounds.
 */
import { readFile, readdir, rename, mkdir } from 'fs/promises'
import { join } from 'path'
import { atomicWriteJson } from '../../infra/persist/index.js'
import { renderRoute, type InstancePaths, type RoundMode } from '../types.js'
import type { Ledger } from '../ledger/LedgerApi.js'

export interface Capsule {
  builtAt: number
  round: number
  mode: RoundMode
  goal: string
  meters: Record<string, number>
  bestMetric: number | null
  totalFindings: number
  /** Direction keys already tried (dedup guard for the worker). */
  directionsTried: string[]
  /** Last K findings, one-line digests. */
  recentFindings: string[]
  /** Last K round summaries (route + seat summary). */
  recentRounds: string[]
  /** Human/external feedback consumed from the inbox THIS round. */
  inboxMessages: string[]
  /** Pivot declaration from a pivoter seat, when this is a pivot round. */
  pivotDirective?: string
}

const MAX_LINE_CHARS = 400
const MAX_LIST_ITEMS = 8

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
   * Pre-consumed inbox messages. When the kernel builds MULTIPLE capsules in
   * one round (pivot rounds: pivoter + worker) it must consume the inbox once
   * and pass the messages here — otherwise the first build would move them to
   * processed/ and the later capsules would silently lose the human feedback.
   */
  inboxMessages?: string[]
}

/**
 * Build the capsule AND consume the inbox: messages are moved to processed/
 * so each piece of feedback influences exactly one round (auditable in the
 * capsule it entered through).
 */
export async function buildCapsule(input: BuildCapsuleInput): Promise<Capsule> {
  const view = await input.ledger.readView(MAX_LIST_ITEMS)
  const inboxMessages = input.inboxMessages ?? await consumeInbox(input.paths)

  const capsule: Capsule = {
    builtAt: Date.now(),
    round: input.round,
    mode: input.mode,
    goal: input.goal,
    meters: view.progress.meters,
    bestMetric: view.progress.bestMetric,
    totalFindings: view.findingsCount,
    directionsTried: view.directions
      .map(d => (typeof d === 'object' && d !== null && 'key' in d ? String((d as { key: unknown }).key) : digestLine(d)))
      .slice(-MAX_LIST_ITEMS * 4),
    recentFindings: view.lastFindings.map(digestLine),
    recentRounds: view.lastRounds.map(r =>
      digestLine(`#${r.round} [${r.mode}] route=${renderRoute(r.route)} ${Object.values(r.seatSummaries)[0] ?? ''}`),
    ),
    inboxMessages,
    ...(input.pivotDirective ? { pivotDirective: digestLine(input.pivotDirective) } : {}),
  }
  await atomicWriteJson(input.paths.capsuleJson, capsule)
  return capsule
}

/** Render the capsule as the prompt preamble seats receive. */
export function renderCapsule(capsule: Capsule): string {
  const lines = [
    '【本轮胶囊 — 由内核从账本确定性生成】',
    `轮次: ${capsule.round}  模式: ${capsule.mode}`,
    `计数器: ${JSON.stringify(capsule.meters)}  best_metric: ${capsule.bestMetric ?? 'null'}  累计findings: ${capsule.totalFindings}`,
    `目标: ${capsule.goal}`,
  ]
  if (capsule.pivotDirective) lines.push(`【结构性转向指令】${capsule.pivotDirective}`)
  if (capsule.inboxMessages.length) {
    lines.push('【人工/外部反馈（本轮生效）】', ...capsule.inboxMessages.map(m => `- ${m}`))
  }
  if (capsule.directionsTried.length) {
    lines.push(`【已试方向（禁止重复）】${capsule.directionsTried.join(' | ')}`)
  }
  if (capsule.recentFindings.length) {
    lines.push('【近期 findings】', ...capsule.recentFindings.map(f => `- ${f}`))
  }
  if (capsule.recentRounds.length) {
    lines.push('【近期轮次】', ...capsule.recentRounds.map(r => `- ${r}`))
  }
  return lines.join('\n')
}

/** Consume the inbox (messages move to processed/). Exported for the kernel's
 * once-per-round consumption on multi-capsule (pivot) rounds. */
export async function consumeInbox(paths: InstancePaths): Promise<string[]> {
  let files: string[]
  try {
    files = (await readdir(paths.inboxDir)).filter(f => f.endsWith('.json') || f.endsWith('.txt')).sort()
  } catch {
    return []
  }
  const messages: string[] = []
  await mkdir(paths.processedDir, { recursive: true })
  for (const file of files) {
    const from = join(paths.inboxDir, file)
    try {
      const raw = await readFile(from, 'utf-8')
      if (file.endsWith('.json')) {
        const parsed = JSON.parse(raw) as { message?: unknown }
        messages.push(digestLine(parsed.message ?? parsed))
      } else {
        messages.push(digestLine(raw.trim()))
      }
      await rename(from, join(paths.processedDir, file))
    } catch {
      // Unreadable inbox item: leave in place for the next round / human.
    }
  }
  return messages
}
