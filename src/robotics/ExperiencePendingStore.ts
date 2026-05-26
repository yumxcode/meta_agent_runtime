/**
 * ExperiencePendingStore — session-scoped buffer for AI-proposed experiences.
 *
 * When the AI calls experience_write, the entry is held here instead of
 * committing directly to the shared ExperienceStore.  The user reviews
 * pending entries via the `/experience review` REPL command (or at session
 * end when cleanup is triggered).
 *
 * Only approved entries are committed to the cross-session ExperienceStore.
 * This prevents low-quality, premature, or incorrect experiences from
 * polluting the shared knowledge base.
 *
 * Storage: in-memory + best-effort project-local persistence.  Pending entries
 * survive normal restarts so the user can review them after resuming the
 * robotics project; they are never auto-committed.
 */

import { createHash } from 'crypto'
import { mkdir, readFile, writeFile, rm } from 'fs/promises'
import { homedir } from 'os'
import { dirname, join } from 'path'
import type { ExperienceStore } from './ExperienceStore.js'
import { ROBOTICS_DOMAINS, type RoboticsDomain } from './types.js'

const PENDING_ROOT = join(homedir(), '.claude', 'meta-agent', 'robotics', 'pending-experiences')

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PendingExperience {
  /** Temporary pending ID (not the final ExperienceStore ID). */
  pendingId: string
  proposedAt: number
  /** Raw input exactly as the AI provided to experience_write. */
  input: Record<string, unknown>
}

// ── ExperiencePendingStore ────────────────────────────────────────────────────

export class ExperiencePendingStore {
  private readonly _pending: PendingExperience[] = []
  private readonly _filePath: string | null
  private _persistTail: Promise<void> = Promise.resolve()

  constructor(projectDir?: string, root = PENDING_ROOT) {
    this._filePath = projectDir
      ? join(root, `${createHash('sha256').update(projectDir).digest('hex').slice(0, 16)}.json`)
      : null
  }

  /** Load pending entries persisted for this project, if any. */
  async load(): Promise<void> {
    if (!this._filePath) return
    try {
      const raw = await readFile(this._filePath, 'utf-8')
      const parsed = JSON.parse(raw) as unknown
      if (!Array.isArray(parsed)) return
      this._pending.length = 0
      for (const item of parsed) {
        if (!isPendingExperience(item)) continue
        this._pending.push(item)
      }
    } catch {
      // Missing or malformed pending file: start with an empty queue.
    }
  }

  /** Queue an experience for later review. Returns the temporary pending ID. */
  add(input: Record<string, unknown>): string {
    const pendingId = `pending_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
    this._pending.push({ pendingId, proposedAt: Date.now(), input })
    this._persistSoon()
    return pendingId
  }

  /** All pending entries in proposal order. */
  list(): readonly PendingExperience[] {
    return this._pending
  }

  /** Number of pending entries awaiting review. */
  get count(): number {
    return this._pending.length
  }

  /** Remove one pending entry (after commit or discard). */
  remove(pendingId: string): boolean {
    const idx = this._pending.findIndex(p => p.pendingId === pendingId)
    if (idx < 0) return false
    this._pending.splice(idx, 1)
    this._persistSoon()
    return true
  }

  /** Clear all pending entries (e.g. on session end after review). */
  clear(): void {
    this._pending.length = 0
    this._persistSoon()
  }

  /** Wait for queued persistence writes to drain. Primarily useful in tests and graceful shutdown. */
  async flush(): Promise<void> {
    await this._persistTail
  }

  /**
   * Commit one pending entry to the ExperienceStore.
   * Returns the committed experience ID, or null on failure.
   */
  async commit(pendingId: string, store: ExperienceStore): Promise<string | null> {
    const entry = this._pending.find(p => p.pendingId === pendingId)
    if (!entry) return null

    try {
      const input = entry.input
      const normalized = validateExperienceInput(input)
      if (!normalized.ok) return null
      const id = await store.write({
        domain: normalized.value.domain,
        title: normalized.value.title,
        problem: normalized.value.problem,
        solution: normalized.value.solution,
        outcome: {
          success: normalized.value.success,
          summary: normalized.value.outcomeSummary,
          failureReason: normalized.value.failureReason,
          workarounds: normalized.value.workarounds,
        },
        algorithm: normalized.value.algorithm,
        tags: normalized.value.tags,
        robot: normalized.value.robot,
        difficulty: normalized.value.difficulty,
        metrics: normalized.value.metrics,
        relatedPapers: normalized.value.relatedPapers,
        sourceTaskId: normalized.value.sourceTaskId,
        fullReport: normalized.value.fullReport,
      })
      this.remove(pendingId)
      return id
    } catch {
      // ExperienceStore.add threw (validation error, disk failure).
      // Return null so the caller can surface the failure without crashing.
      return null
    }
  }

  private _persistSoon(): void {
    const snapshot = this._pending.map(item => ({
      pendingId: item.pendingId,
      proposedAt: item.proposedAt,
      input: { ...item.input },
    }))
    this._persistTail = this._persistTail
      .catch(() => {})
      .then(() => this._persist(snapshot))
      .catch(() => {})
  }

  private async _persist(snapshot: PendingExperience[]): Promise<void> {
    if (!this._filePath) return
    if (snapshot.length === 0) {
      await rm(this._filePath, { force: true }).catch(() => undefined)
      return
    }
    await mkdir(dirname(this._filePath), { recursive: true })
    await writeFile(this._filePath, JSON.stringify(snapshot, null, 2), 'utf-8')
  }
}

function isPendingExperience(value: unknown): value is PendingExperience {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record['pendingId'] === 'string' &&
    typeof record['proposedAt'] === 'number' &&
    Boolean(record['input']) &&
    typeof record['input'] === 'object'
}

type NormalizedExperienceInput = {
  domain: RoboticsDomain
  title: string
  problem: string
  solution: string
  success: boolean
  outcomeSummary: string
  difficulty: 'low' | 'medium' | 'high'
  tags: string[]
  algorithm?: string
  robot?: string
  failureReason?: string
  workarounds?: string[]
  metrics?: Record<string, number | string>
  relatedPapers?: string[]
  sourceTaskId?: string
  fullReport?: string
}

function validateExperienceInput(input: Record<string, unknown>): { ok: true; value: NormalizedExperienceInput } | { ok: false } {
  const domain = normalizeDomain(input['domain'])
  const title = requiredString(input['title'], 80)
  const problem = requiredString(input['problem'], 500)
  const solution = requiredString(input['solution'], 800)
  const outcomeSummary = requiredString(input['outcome_summary'], 200)
  if (!domain || !title || !problem || !solution || !outcomeSummary) return { ok: false }

  return {
    ok: true,
    value: {
      domain,
      title,
      problem,
      solution,
      success: Boolean(input['success']),
      outcomeSummary,
      difficulty: normalizeDifficulty(input['difficulty']),
      tags: normalizeStringArray(input['tags'], 20, 40) ?? [],
      algorithm: optionalString(input['algorithm'], 80),
      robot: optionalString(input['robot'], 80),
      failureReason: optionalString(input['failure_reason'], 300),
      workarounds: normalizeStringArray(input['workarounds'], 10, 200),
      metrics: normalizeMetrics(input['metrics']),
      relatedPapers: normalizeStringArray(input['related_papers'], 20, 120),
      sourceTaskId: optionalString(input['source_task_id'], 120),
      fullReport: optionalString(input['full_report'], 20_000),
    },
  }
}

function requiredString(value: unknown, max: number): string | null {
  const str = optionalString(value, max)
  return str && str.trim() ? str : null
}

function optionalString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, max) : undefined
}

function normalizeDomain(value: unknown): RoboticsDomain | null {
  return typeof value === 'string' && ROBOTICS_DOMAINS.includes(value as RoboticsDomain)
    ? value as RoboticsDomain
    : null
}

function normalizeDifficulty(value: unknown): 'low' | 'medium' | 'high' {
  return value === 'low' || value === 'medium' || value === 'high' ? value : 'medium'
}

function normalizeStringArray(value: unknown, maxItems: number, maxLen: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out = value
    .filter((v): v is string => typeof v === 'string')
    .map(v => v.trim().slice(0, maxLen))
    .filter(Boolean)
    .slice(0, maxItems)
  return out.length ? out : undefined
}

function normalizeMetrics(value: unknown): Record<string, number | string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const out: Record<string, number | string> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>).slice(0, 30)) {
    if (typeof raw !== 'number' && typeof raw !== 'string') continue
    const safeKey = key.trim().slice(0, 80)
    if (!safeKey) continue
    out[safeKey] = typeof raw === 'string' ? raw.slice(0, 200) : raw
  }
  return Object.keys(out).length ? out : undefined
}
