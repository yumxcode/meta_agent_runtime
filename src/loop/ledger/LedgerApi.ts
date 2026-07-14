/**
 * LedgerApi — the loop's single-writer ledger (spec C3, decisions D7/D13).
 *
 * WHY a dedicated API instead of "agents edit JSON files":
 *   • single writer — only the kernel process holds a Ledger instance; seats
 *     produce DRAFTS which the kernel admits after gates. An agent can never
 *     corrupt progress.json with hand-written JSON.
 *   • atomicity — appendJsonl appends one line in a single write() call;
 *     replaceJson goes through temp+rename. A process crash (kill -9) leaves
 *     either the old or the new state, never a torn file. NOTE: neither path
 *     fsyncs — durability is process-crash level, not power-loss level; a
 *     torn tail line from power loss is tolerated by readJsonl (skipped).
 *   • schema-checked writes — every file can register a validator; a write
 *     that violates its schema throws BEFORE touching disk (invariant gate).
 *   • derived views — readView() computes meters/last-K digests in one place,
 *     so CapsuleBuilder and budget checks share one truth (D13: ledger is the
 *     authority for lifetime accounting).
 */
import { appendFile, mkdir, open, readFile, rename } from 'fs/promises'
import { dirname } from 'path'
import { atomicWriteJson, readJsonFile } from '../../infra/persist/index.js'
import type { InstancePaths, ProgressStatus, RoundEntry } from '../types.js'

export type SchemaValidator = (value: unknown) => string[]

export interface ProgressView {
  schemaVersion: 4
  iteration: number
  meters: Record<string, number>
  /** Total function of the last round's RouteDecision — see ProgressStatus. */
  status: ProgressStatus
  /** One-shot directive: the next round runs as a pivot round (set by ROUTE, consumed by MODE). */
  nextRoundMode?: 'pivot'
  /** Best value of the optional Charter objective; absent objective stays null. */
  objectiveBestValue: number | null
  totalCostUsd: number
  updatedAt: number
}

export interface LedgerView {
  progress: ProgressView
  lastRounds: RoundEntry[]
}

export class LedgerCorruptionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LedgerCorruptionError'
  }
}

const DEFAULT_PROGRESS: ProgressView = {
  schemaVersion: 4,
  iteration: 0,
  meters: {},
  status: 'healthy',
  objectiveBestValue: null,
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
    if (lastK !== undefined) return readJsonlTail<T>(filePath, lastK)
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
    return rows
  }

  async readProgress(): Promise<ProgressView> {
    let progress: ProgressView | null = null
    let corrupt = false
    try {
      const candidate = normalizeProgress(
        JSON.parse(await readFile(this.paths.progressJson, 'utf-8')),
      )
      const schemaErrors = progressSchema(candidate)
      if (schemaErrors.length > 0) throw new Error(schemaErrors.join('; '))
      progress = candidate
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        corrupt = true
        await rename(this.paths.progressJson, `${this.paths.progressJson}.corrupt`).catch(() => undefined)
      }
    }

    const rounds = await this.readJsonl<RoundEntry>(this.paths.roundsJsonl, 1)
    const last = rounds.at(-1)
    if (!progress) {
      if (!last && !corrupt) return { ...DEFAULT_PROGRESS }
      if (!last?.postState) {
        throw new LedgerCorruptionError(
          `progress is ${corrupt ? 'corrupt' : 'missing'} and rounds do not contain a recoverable postState`,
        )
      }
      const rebuilt = normalizeProgress({ ...last.postState, updatedAt: Date.now() })
      await this.writeProgress(rebuilt)
      return rebuilt
    }

    if (last && last.round > progress.iteration) {
      if (!last.postState) {
        throw new LedgerCorruptionError(
          `progress is behind round ${last.round}, but that round has no recoverable postState`,
        )
      }
      const rebuilt = normalizeProgress({ ...last.postState, updatedAt: Date.now() })
      await this.writeProgress(rebuilt)
      return rebuilt
    }
    if (last && last.round < progress.iteration) {
      throw new LedgerCorruptionError(
        `progress iteration ${progress.iteration} is ahead of the last audited round ${last.round}`,
      )
    }
    return progress
  }

  /** One derived truth for capsule/budget/meter steps. */
  async readView(lastK = 5): Promise<LedgerView> {
    const [progress, lastRounds] = await Promise.all([
      this.readProgress(),
      this.readJsonl<RoundEntry>(this.paths.roundsJsonl, lastK),
    ])
    return { progress, lastRounds }
  }
}

function normalizeProgress(value: unknown): ProgressView {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return {
    schemaVersion: 4,
    iteration: raw['iteration'] as number,
    meters: raw['meters'] as Record<string, number>,
    status: raw['status'] as ProgressView['status'],
    ...(raw['nextRoundMode'] === 'pivot' ? { nextRoundMode: 'pivot' as const } : {}),
    objectiveBestValue: typeof raw['objectiveBestValue'] === 'number'
      ? raw['objectiveBestValue']
      : typeof raw['bestMetric'] === 'number' ? raw['bestMetric'] : null,
    totalCostUsd: raw['totalCostUsd'] as number,
    updatedAt: raw['updatedAt'] as number,
  }
}

/** Read the newest valid JSONL records without parsing the historical prefix.
 * Byte-wise newline scanning preserves UTF-8 characters split across chunks;
 * an incomplete/torn tail is skipped just like the full reader. */
async function readJsonlTail<T>(filePath: string, lastK: number): Promise<T[]> {
  if (lastK <= 0) return []
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(filePath, 'r')
  } catch {
    return []
  }
  try {
    const size = (await handle.stat()).size
    const rows: T[] = []
    let position = size
    let carry = Buffer.alloc(0)
    const parseLine = (line: Buffer): void => {
      const text = line.toString('utf-8').trim()
      if (!text) return
      try { rows.push(JSON.parse(text) as T) } catch { /* torn/corrupt line */ }
    }
    while (position > 0 && rows.length < lastK) {
      const length = Math.min(64 * 1024, position)
      position -= length
      const chunk = Buffer.allocUnsafe(length)
      await handle.read(chunk, 0, length, position)
      const data = Buffer.concat([chunk, carry])
      let end = data.length
      for (let i = data.length - 1; i >= 0 && rows.length < lastK; i--) {
        if (data[i] !== 0x0a) continue
        parseLine(data.subarray(i + 1, end))
        end = i
      }
      carry = data.subarray(0, end)
    }
    if (position === 0 && rows.length < lastK) parseLine(carry)
    return rows.reverse()
  } finally {
    await handle.close()
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
  if (p['schemaVersion'] !== 4) errs.push('schemaVersion must be 4')
  if (p['objectiveBestValue'] !== null && typeof p['objectiveBestValue'] !== 'number') {
    errs.push('objectiveBestValue must be a number or null')
  }
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
  if (r['observationResults'] !== undefined) {
    if (typeof r['observationResults'] !== 'object' || r['observationResults'] === null || Array.isArray(r['observationResults'])) {
      errs.push('observationResults must be an object')
    } else {
      for (const [name, raw] of Object.entries(r['observationResults'] as Record<string, unknown>)) {
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
          errs.push(`observationResults.${name} must be an object`)
          continue
        }
        const result = raw as Record<string, unknown>
        if (!['present', 'absent', 'error'].includes(String(result['status']))) {
          errs.push(`observationResults.${name}.status must be present | absent | error`)
        }
        if (typeof result['source'] !== 'string') errs.push(`observationResults.${name}.source must be a string`)
        if (typeof result['observedAt'] !== 'number') errs.push(`observationResults.${name}.observedAt must be a number`)
        if (!Array.isArray(result['provenance'])) errs.push(`observationResults.${name}.provenance must be an array`)
        if (result['status'] === 'present' && !('value' in result)) {
          errs.push(`observationResults.${name}.value is required when present`)
        }
        if (result['status'] === 'absent' && typeof result['reason'] !== 'string') {
          errs.push(`observationResults.${name}.reason is required when absent`)
        }
        if (result['status'] === 'error' && (
          typeof result['errorCode'] !== 'string' || typeof result['message'] !== 'string'
        )) {
          errs.push(`observationResults.${name}.errorCode/message are required when error`)
        }
      }
    }
  }
  if (r['postState'] !== undefined) {
    const p = r['postState'] as Record<string, unknown>
    if (typeof p !== 'object' || p === null) errs.push('postState must be an object')
    else {
      if (p['iteration'] !== r['round']) errs.push('postState.iteration must equal round')
      if (typeof p['totalCostUsd'] !== 'number') errs.push('postState.totalCostUsd must be a number')
      if (p['schemaVersion'] !== 4) errs.push('postState.schemaVersion must be 4')
    }
  }
  return errs
}

/** Wire the built-in validators onto a fresh Ledger. */
export function withBuiltinSchemas(ledger: Ledger, paths: InstancePaths): Ledger {
  ledger.registerSchema(paths.progressJson, progressSchema)
  ledger.registerSchema(paths.roundsJsonl, roundSchema)
  return ledger
}
