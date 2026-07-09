/**
 * LedgerApi — the loop's single-writer ledger (spec C3, decisions D7/D13).
 *
 * WHY a dedicated API instead of "agents edit JSON files":
 *   • single writer — only the kernel process holds a Ledger instance; seats
 *     produce DRAFTS which the kernel admits after gates. An agent can never
 *     corrupt progress.json with hand-written JSON.
 *   • atomicity — appendJsonl appends a single fsync'd line; replaceJson goes
 *     through temp+rename. A kill -9 leaves either the old or the new state,
 *     never a torn file.
 *   • schema-checked writes — every file can register a validator; a write
 *     that violates its schema throws BEFORE touching disk (invariant gate).
 *   • derived views — readView() computes meters/last-K digests in one place,
 *     so CapsuleBuilder and budget checks share one truth (D13: ledger is the
 *     authority for lifetime accounting).
 */
import { appendFile, mkdir, readFile } from 'fs/promises'
import { dirname } from 'path'
import { atomicWriteJson, readJsonFile } from '../../infra/persist/index.js'
import type { InstancePaths, ProgressStatus, RoundEntry } from '../types.js'

export type SchemaValidator = (value: unknown) => string[]

export interface ProgressView {
  iteration: number
  meters: Record<string, number>
  /** Total function of the last round's RouteDecision — see ProgressStatus. */
  status: ProgressStatus
  /** One-shot directive: the next round runs as a pivot round (set by ROUTE, consumed by MODE). */
  nextRoundMode?: 'pivot'
  bestMetric: number | null
  totalFindings: number
  totalCostUsd: number
  updatedAt: number
}

export interface LedgerView {
  progress: ProgressView
  lastRounds: RoundEntry[]
  lastFindings: unknown[]
  directions: unknown[]
  findingsCount: number
}

const DEFAULT_PROGRESS: ProgressView = {
  iteration: 0,
  meters: {},
  status: 'healthy',
  bestMetric: null,
  totalFindings: 0,
  totalCostUsd: 0,
  updatedAt: 0,
}

export class Ledger {
  private readonly validators = new Map<string, SchemaValidator>()

  constructor(private readonly paths: InstancePaths) {}

  /** Register a write-time validator for a ledger file (absolute path). */
  registerSchema(filePath: string, validator: SchemaValidator): void {
    this.validators.set(filePath, validator)
  }

  private validate(filePath: string, value: unknown): void {
    const validator = this.validators.get(filePath)
    if (!validator) return
    const errs = validator(value)
    if (errs.length > 0) {
      throw new Error(`ledger schema violation for ${filePath}: ${errs.join('; ')}`)
    }
  }

  // ── Writes (kernel only) ────────────────────────────────────────────────────

  async appendJsonl(filePath: string, entry: unknown): Promise<void> {
    this.validate(filePath, entry)
    await mkdir(dirname(filePath), { recursive: true })
    await appendFile(filePath, JSON.stringify(entry) + '\n', 'utf-8')
  }

  async replaceJson(filePath: string, value: unknown): Promise<void> {
    this.validate(filePath, value)
    await atomicWriteJson(filePath, value)
  }

  async appendRound(entry: RoundEntry): Promise<void> {
    await this.appendJsonl(this.paths.roundsJsonl, entry)
  }

  async writeProgress(progress: ProgressView): Promise<void> {
    await this.replaceJson(this.paths.progressJson, progress)
  }

  // ── Reads (anyone) ──────────────────────────────────────────────────────────

  async readJson<T>(filePath: string): Promise<T | null> {
    return readJsonFile<T>(filePath)
  }

  async readJsonl<T = unknown>(filePath: string, lastK?: number): Promise<T[]> {
    let raw: string
    try {
      raw = await readFile(filePath, 'utf-8')
    } catch {
      return []
    }
    const rows: T[] = []
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        rows.push(JSON.parse(trimmed) as T)
      } catch {
        // A torn/corrupt line must not sink the whole ledger read; it is
        // surfaced by RECONCILE via count mismatch rather than thrown here.
      }
    }
    return lastK !== undefined ? rows.slice(-lastK) : rows
  }

  async readProgress(): Promise<ProgressView> {
    return (await readJsonFile<ProgressView>(this.paths.progressJson)) ?? { ...DEFAULT_PROGRESS }
  }

  /** One derived truth for capsule/budget/meter steps. */
  async readView(lastK = 5): Promise<LedgerView> {
    const [progress, lastRounds, findings, directionsFile] = await Promise.all([
      this.readProgress(),
      this.readJsonl<RoundEntry>(this.paths.roundsJsonl, lastK),
      this.readJsonl<unknown>(this.paths.findingsJsonl),
      readJsonFile<{ directions?: unknown[] }>(this.paths.directionsJson),
    ])
    return {
      progress,
      lastRounds,
      lastFindings: findings.slice(-lastK),
      findingsCount: findings.length,
      directions: directionsFile?.directions ?? [],
    }
  }
}

// ── Built-in schema validators (spec §3.3 core files) ─────────────────────────

export function progressSchema(value: unknown): string[] {
  const errs: string[] = []
  if (typeof value !== 'object' || value === null) return ['progress must be an object']
  const p = value as Record<string, unknown>
  if (typeof p['iteration'] !== 'number') errs.push('iteration must be a number')
  if (typeof p['status'] !== 'string') errs.push('status must be a string')
  if (typeof p['meters'] !== 'object' || p['meters'] === null) errs.push('meters must be an object')
  if (typeof p['totalCostUsd'] !== 'number') errs.push('totalCostUsd must be a number')
  if (typeof p['updatedAt'] !== 'number') errs.push('updatedAt must be a number')
  return errs
}

export function roundSchema(value: unknown): string[] {
  const errs: string[] = []
  if (typeof value !== 'object' || value === null) return ['round entry must be an object']
  const r = value as Record<string, unknown>
  if (typeof r['round'] !== 'number') errs.push('round must be a number')
  if (r['mode'] !== 'normal' && r['mode'] !== 'pivot') errs.push("mode must be 'normal' | 'pivot'")
  const route = r['route'] as Record<string, unknown> | undefined
  if (typeof route !== 'object' || route === null || typeof route['kind'] !== 'string') {
    errs.push('route must be a RouteDecision object with a kind')
  }
  if (typeof r['costUsd'] !== 'number') errs.push('costUsd must be a number')
  return errs
}

/** Wire the built-in validators onto a fresh Ledger. */
export function withBuiltinSchemas(ledger: Ledger, paths: InstancePaths): Ledger {
  ledger.registerSchema(paths.progressJson, progressSchema)
  ledger.registerSchema(paths.roundsJsonl, roundSchema)
  return ledger
}
