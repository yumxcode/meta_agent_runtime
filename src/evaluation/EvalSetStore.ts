/**
 * EvalSetStore — persistence for eval cases and sets (G1-4).
 *
 * Follows the house conventions: `metaAgentPath`, 0o700 directories, atomic
 * writes, file locks around read-modify-write, and an id regex guard on every
 * path join so a crafted id cannot walk out of the store directory.
 *
 * Two behaviours are specific to this store and both are refusals:
 *
 *   - **Frozen sets are immutable.** Adding a case to a frozen set is rejected,
 *     not merged. A set is frozen precisely so that a result computed over it
 *     can be attributed to a known population; silently growing it afterwards
 *     invalidates every comparison already run against it, retroactively and
 *     invisibly.
 *   - **Adding a case that would straddle splits is rejected.** Leakage found
 *     at write time is one refused write; leakage found later is a corpus
 *     re-audit and every number computed in between is suspect.
 */

import { join } from 'path'
import { chmod, readdir, rm } from 'fs/promises'
import { metaAgentPath } from '../infra/metaAgentHome.js'
import {
  atomicWriteJson,
  ensureDir,
  readJsonFile,
  withFileLock,
} from '../infra/persist/index.js'
import {
  EvalCaseSchema,
  EvalSetSchema,
  detectSplitLeakage,
  type EvalCase,
  type EvalSet,
} from './types.js'

const DIR_MODE = 0o700
const FILE_MODE = 0o600

export class EvalSetStoreError extends Error {}

function assertCaseId(id: string): void {
  if (!/^evalcase_[a-f0-9]{24}$/.test(id)) {
    throw new EvalSetStoreError(`invalid eval case id: ${id}`)
  }
}

function assertSetId(id: string): void {
  if (!/^evalset_[a-z0-9][a-z0-9_-]{2,63}$/.test(id)) {
    throw new EvalSetStoreError(`invalid eval set id: ${id}`)
  }
}

export class EvalSetStore {
  private readonly root: string

  constructor(root?: string) {
    this.root = root ?? metaAgentPath('evalset')
  }

  get casesDir(): string { return join(this.root, 'cases') }
  get setsDir(): string { return join(this.root, 'sets') }

  async ensureDirs(): Promise<void> {
    await ensureDir(this.casesDir)
    await ensureDir(this.setsDir)
    // ensureDir does not narrow an existing directory's mode, and these hold
    // prompts and workspace paths recovered from real sessions.
    await chmod(this.root, DIR_MODE).catch(() => undefined)
    await chmod(this.casesDir, DIR_MODE).catch(() => undefined)
    await chmod(this.setsDir, DIR_MODE).catch(() => undefined)
  }

  private casePath(id: string): string {
    assertCaseId(id)
    return join(this.casesDir, `${id}.json`)
  }

  private setPath(id: string): string {
    assertSetId(id)
    return join(this.setsDir, `${id}.json`)
  }

  // ── Cases ─────────────────────────────────────────────────────────────────

  async writeCase(evalCase: EvalCase): Promise<void> {
    // Validate before writing: a case that fails the split rules must never
    // reach disk, where it would be read back by something that trusts it.
    const parsed = EvalCaseSchema.parse(evalCase)
    await this.ensureDirs()
    const path = this.casePath(parsed.id)
    await atomicWriteJson(path, parsed)
    await chmod(path, FILE_MODE).catch(() => undefined)
  }

  async loadCase(id: string): Promise<EvalCase | null> {
    const raw = await readJsonFile<unknown>(this.casePath(id))
    if (!raw) return null
    const parsed = EvalCaseSchema.safeParse(raw)
    // A case that no longer validates is treated as absent rather than
    // repaired: silently coercing it would put a case that violates the split
    // rules back into circulation.
    return parsed.success ? parsed.data : null
  }

  async listCaseIds(): Promise<string[]> {
    await this.ensureDirs()
    const entries = await readdir(this.casesDir).catch(() => [] as string[])
    return entries
      .filter(name => name.endsWith('.json'))
      .map(name => name.slice(0, -'.json'.length))
      .filter(id => /^evalcase_[a-f0-9]{24}$/.test(id))
      .sort()
  }

  async loadAllCases(): Promise<EvalCase[]> {
    const ids = await this.listCaseIds()
    const loaded = await Promise.all(ids.map(id => this.loadCase(id)))
    return loaded.filter((c): c is EvalCase => c !== null)
  }

  async deleteCase(id: string): Promise<void> {
    await rm(this.casePath(id), { force: true })
  }

  // ── Sets ──────────────────────────────────────────────────────────────────

  async writeSet(set: EvalSet): Promise<void> {
    const parsed = EvalSetSchema.parse(set)
    await this.ensureDirs()
    const path = this.setPath(parsed.id)
    await atomicWriteJson(path, parsed)
    await chmod(path, FILE_MODE).catch(() => undefined)
  }

  async loadSet(id: string): Promise<EvalSet | null> {
    const raw = await readJsonFile<unknown>(this.setPath(id))
    if (!raw) return null
    const parsed = EvalSetSchema.safeParse(raw)
    return parsed.success ? parsed.data : null
  }

  async listSetIds(): Promise<string[]> {
    await this.ensureDirs()
    const entries = await readdir(this.setsDir).catch(() => [] as string[])
    return entries
      .filter(name => name.endsWith('.json'))
      .map(name => name.slice(0, -'.json'.length))
      .filter(id => /^evalset_[a-z0-9][a-z0-9_-]{2,63}$/.test(id))
      .sort()
  }

  /**
   * Add a case to a set, under a lock, refusing both immutability and leakage
   * violations.
   *
   * The lock is around the whole read-modify-write because two concurrent adds
   * would otherwise each read the same `caseIds`, and the second write would
   * drop the first case with no error anywhere.
   */
  async addCaseToSet(setId: string, caseId: string): Promise<EvalSet> {
    assertCaseId(caseId)
    const path = this.setPath(setId)

    return withFileLock(path, async () => {
      const set = await this.loadSet(setId)
      if (!set) throw new EvalSetStoreError(`eval set not found: ${setId}`)

      if (set.frozenAt !== undefined) {
        throw new EvalSetStoreError(
          `eval set ${setId} was frozen at ${set.frozenAt}; adding a case would retroactively ` +
          'change the population every result already computed over it refers to',
        )
      }

      if (set.caseIds.includes(caseId)) return set

      const added = await this.loadCase(caseId)
      if (!added) throw new EvalSetStoreError(`eval case not found or invalid: ${caseId}`)

      const existing = await Promise.all(set.caseIds.map(id => this.loadCase(id)))
      const members = existing.filter((c): c is EvalCase => c !== null)
      const leaks = detectSplitLeakage([...members, added])
      if (leaks.length > 0) {
        const leak = leaks[0]!
        throw new EvalSetStoreError(
          `adding ${caseId} would spread contamination group '${leak.contaminationGroupId}' ` +
          `across splits ${leak.splits.join(' + ')}; the same task must not appear on both ` +
          'sides of a split',
        )
      }

      const next: EvalSet = { ...set, caseIds: [...set.caseIds, caseId].sort() }
      await atomicWriteJson(path, next)
      await chmod(path, FILE_MODE).catch(() => undefined)
      return next
    })
  }

  /**
   * Freeze a set. Idempotent — freezing an already-frozen set keeps the
   * original timestamp rather than moving it, since the original is what every
   * existing result refers to.
   */
  async freezeSet(setId: string, at: number = Date.now()): Promise<EvalSet> {
    const path = this.setPath(setId)
    return withFileLock(path, async () => {
      const set = await this.loadSet(setId)
      if (!set) throw new EvalSetStoreError(`eval set not found: ${setId}`)
      if (set.frozenAt !== undefined) return set

      const next: EvalSet = { ...set, frozenAt: at }
      await atomicWriteJson(path, next)
      await chmod(path, FILE_MODE).catch(() => undefined)
      return next
    })
  }

  /** Load every case belonging to a set, skipping ids that no longer resolve. */
  async loadSetCases(setId: string): Promise<EvalCase[]> {
    const set = await this.loadSet(setId)
    if (!set) return []
    const loaded = await Promise.all(set.caseIds.map(id => this.loadCase(id)))
    return loaded.filter((c): c is EvalCase => c !== null)
  }
}
