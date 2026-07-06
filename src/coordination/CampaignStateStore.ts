/**
 * CampaignStateStore — disk-backed state machine for a DOE campaign.
 *
 * Storage layout under ~/.meta-agent/campaigns/<campaignId>/:
 *   state.json          — phase + metadata (overwrite on each transition)
 *   evaluations.jsonl   — EvaluationResult lines (append-only, concurrent-safe)
 *   capsule.json        — pre-computed CampaignContextCapsule
 *   workers/            — per-worker log files
 *   snapshots/          — immutable phase-boundary snapshots
 *   report.md           — final report (written on DONE)
 *
 * Key invariants:
 *   • evaluations.jsonl is append-only: multiple Workers can write concurrently.
 *   • state.json is overwrite on each phase transition (single writer: Monitor).
 *   • campaignId encodes projectName so directories are human-readable.
 */

import { createHash } from 'crypto'
import {
  appendFile,
  open,
  readFile,
  readdir,
  stat,
  writeFile,
} from 'fs/promises'
import { homedir } from 'os'
import { META_AGENT_HOME } from '../core/metaAgentHome.js'
import { join } from 'path'
import { atomicWriteJson, ensureDir, readJsonFile, withFileLock } from '../core/persist/index.js'
import { RuntimeEnv } from '../infra/env/RuntimeEnv.js'
import type {
  CampaignContextCapsule,
  CampaignPhase,
  DesignPoint,
  DesignSpace,
  EvaluationResult,
  PersistedCampaignState,
} from './types.js'
import { MACHINE_PHASES, USER_CHECKPOINT_PHASES, VALID_TRANSITIONS } from './types.js'

// ── Zombie detection thresholds ───────────────────────────────────────────────
//
// A campaign is a "zombie" if it has been stuck in a non-terminal phase without
// any state update for longer than the phase-appropriate threshold.
//
//   Machine phases (SAMPLING, EVALUATING_*, ESCALATING_*, REPORTING, IDLE):
//     48 h — background workers don't run this long on real hardware; if
//     nothing updated state.json in 48 h the campaign was abandoned.
//
//   User checkpoint phases (PARETO_READY_*):
//     7 days — user may be reviewing Pareto results; give ample time before
//     expiring. After 7 days with no user action, treat as abandoned.

const ZOMBIE_MACHINE_MS     = 48 * 60 * 60 * 1_000        // 48 h
const ZOMBIE_CHECKPOINT_MS  = 7 * 24 * 60 * 60 * 1_000    // 7 days

// ── Path helpers ──────────────────────────────────────────────────────────────

export const META_AGENT_ROOT = join(META_AGENT_HOME)
export const CAMPAIGNS_ROOT = join(META_AGENT_ROOT, 'campaigns')

function campaignDir(id: string): string {
  return join(CAMPAIGNS_ROOT, id)
}

/** Slugify projectName for use in directory name */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 40)
}

/** Generate a campaign ID: c_<6-char hash>_<slug> */
export function makeCampaignId(projectName: string): string {
  const hash = createHash('sha256')
    .update(projectName + Date.now())
    .digest('hex')
    .slice(0, 6)
  return `c_${hash}_${slugify(projectName)}`
}

// ── CampaignStateStore ────────────────────────────────────────────────────────

export class CampaignStateStore {
  // ── Per-campaign incremental JSONL read cache ────────────────────────────────
  // evaluations.jsonl is append-only; tracking the byte offset avoids re-reading
  // the entire file on every 5 s poll tick (O(N) → O(new_bytes)).
  // Keyed by campaignId — survives across load() calls (new instances per tick).
  //
  // S5: capped LRU.  Without the cap, listing many historical campaigns would
  // keep their EvaluationResult arrays in memory forever even after the
  // monitors stopped.  Most-recently-touched campaigns stay in cache; cold
  // campaigns are evicted automatically.  Configurable via
  // META_AGENT_CAMPAIGN_EVAL_CACHE env var (default 32).
  private static readonly _evalCache = new Map<
    string,
    { offset: number; results: EvaluationResult[] }
  >()
  private static readonly _EVAL_CACHE_MAX = RuntimeEnv.campaignEvalCacheCap() ?? 32

  /**
   * S5: read with LRU touch — caller passes the cached entry to indicate it was
   * just used.  Re-inserting in a Map moves the key to the back of insertion
   * order, which gives us O(1) LRU semantics for free.
   */
  private static _touchEvalCache(
    campaignId: string,
    entry: { offset: number; results: EvaluationResult[] },
  ): void {
    CampaignStateStore._evalCache.delete(campaignId)
    CampaignStateStore._evalCache.set(campaignId, entry)
    while (CampaignStateStore._evalCache.size > CampaignStateStore._EVAL_CACHE_MAX) {
      const oldest = CampaignStateStore._evalCache.keys().next().value
      if (oldest === undefined) break
      CampaignStateStore._evalCache.delete(oldest)
    }
  }

  // ── Global reference-counted lock pool ───────────────────────────────────────
  //
  // Problem (P0): the original implementation used a plain Map<string, Promise>.
  // Multiple CampaignStateStore instances for the same campaignId all modify that
  // shared entry.  If instance A calls cleanup() while instance B still has
  // operations queued, the stored tail is deleted — B's next _withLock() call
  // starts a NEW, unrelated chain that races with A's still-running operations.
  //
  // Fix: each entry now carries a `count` of in-flight _withLock() calls.
  // The entry self-destructs when count reaches 0.  cleanup() only force-removes
  // an entry when no operations are in flight, making it safe to call at any time.
  //
  // This ensures that two store instances for the same campaignId always chain
  // onto the SAME promise tail, regardless of which instance acquired the lock.
  private static readonly _mutationLock = new Map<
    string,
    { chain: Promise<void>; count: number }
  >()

  /**
   * Release all per-campaign runtime state (eval cache + mutation lock).
   * Called by CampaignMonitor._stop() when a campaign finishes or is cancelled.
   *
   * The lock entry is self-cleaning: _withLock() decrements count after each
   * operation and removes the entry when count reaches 0.  This call is
   * therefore a best-effort nudge for the case where count is already 0
   * (e.g., no operations ran between campaign start and stop).
   */
  /**
   * Flush ALL static state for test isolation.
   *
   * Clears every campaign's eval cache and lock entry from the process-level maps.
   * Safe to call only when no campaign operations are in flight (i.e., at the start
   * or end of a test — never during a running campaign).
   *
   * @testonly — not intended for production use.
   */
  static resetAllForTest(): void {
    CampaignStateStore._evalCache.clear()
    CampaignStateStore._mutationLock.clear()
  }

  static cleanup(campaignId: string): void {
    CampaignStateStore._evalCache.delete(campaignId)
    // Only remove lock entry when no operations are in flight — otherwise
    // the in-flight operations are responsible for cleaning up.
    const entry = CampaignStateStore._mutationLock.get(campaignId)
    if (entry && entry.count === 0) {
      CampaignStateStore._mutationLock.delete(campaignId)
    }
  }

  readonly campaignId: string
  readonly projectName: string
  readonly dir: string

  readonly paths: {
    state: string
    evaluations: string
    capsule: string
    report: string
    workers: string
    snapshots: string
  }

  private _state: PersistedCampaignState

  /**
   * Serialise an async operation within this campaign's mutation lock.
   *
   * Builds a promise-queue (linked chain of .then() calls) so that only one
   * reload→mutate→write triple runs at a time per campaign, even when multiple
   * WorkerCoordinator tasks or CampaignStateStore instances call concurrently
   * in the same Node.js event loop.
   *
   * Reference-counting (P0 fix):
   *   count is incremented before queuing the operation and decremented when
   *   the operation settles (success or error).  When count reaches 0 the entry
   *   is removed from the pool, freeing the Map entry automatically.
   *
   * Error behaviour: if `fn` rejects, the error propagates to the caller but
   * the lock is still released (the stored tail always resolves).
   */
  private _withLock<T>(fn: () => Promise<T>): Promise<T> {
    const campaignId = this.campaignId
    let entry = CampaignStateStore._mutationLock.get(campaignId)
    if (!entry) {
      entry = { chain: Promise.resolve(), count: 0 }
      CampaignStateStore._mutationLock.set(campaignId, entry)
    }

    entry.count++
    // M6-fix: the in-process promise chain only serialises callers within ONE
    // process. Workers running as separate processes would still interleave
    // their reload→mutate→write triples (lost updates). Wrapping the critical
    // section in the cross-process file lock closes that hole; in the common
    // single-process case the lock is uncontended (one open()+unlink()).
    const run = entry.chain.then(() => withFileLock(this.paths.state, fn))
    // Advance the stored tail to always-resolving so the next waiter chains correctly
    entry.chain = run.then(() => {}, () => {})
    // Decrement ref-count when this operation settles; self-destruct when at 0
    void run.then(
      () => CampaignStateStore._releaseLock(campaignId),
      () => CampaignStateStore._releaseLock(campaignId),
    )
    return run
  }

  private static _releaseLock(campaignId: string): void {
    const entry = CampaignStateStore._mutationLock.get(campaignId)
    if (!entry) return
    entry.count--
    if (entry.count === 0) {
      CampaignStateStore._mutationLock.delete(campaignId)
    }
  }

  private constructor(state: PersistedCampaignState) {
    this._state = state
    this.campaignId = state.campaignId
    this.projectName = state.projectName
    this.dir = campaignDir(state.campaignId)
    this.paths = {
      state:       join(this.dir, 'state.json'),
      evaluations: join(this.dir, 'evaluations.jsonl'),
      capsule:     join(this.dir, 'capsule.json'),
      report:      join(this.dir, 'report.md'),
      workers:     join(this.dir, 'workers'),
      snapshots:   join(this.dir, 'snapshots'),
    }
  }

  // ── Factory methods ─────────────────────────────────────────────────────────

  /** Create a brand-new campaign. Persists state.json immediately. */
  static async create(
    projectName: string,
    designSpace: DesignSpace,
  ): Promise<CampaignStateStore> {
    const campaignId = makeCampaignId(projectName)
    const dir = campaignDir(campaignId)
    await ensureDir(dir)
    await ensureDir(join(dir, 'workers'))
    await ensureDir(join(dir, 'snapshots'))

    const now = new Date().toISOString()
    const state: PersistedCampaignState = {
      schemaVersion: '1.0',
      campaignId,
      projectName,
      createdAt: now,
      updatedAt: now,
      phase: 'IDLE',
      designSpace,
      sampledPoints: [],
      pendingTaskIds: [],
      completedTaskIds: [],
      failedTaskIds: [],
    }

    const store = new CampaignStateStore(state)
    await store._writeState()
    return store
  }

  /** Load an existing campaign from disk. Throws if not found or corrupt. */
  static async load(campaignId: string): Promise<CampaignStateStore> {
    const state = await readJsonFile<PersistedCampaignState>(
      join(campaignDir(campaignId), 'state.json'),
    )
    if (!state) throw new Error(`Campaign "${campaignId}" not found or corrupt`)
    return new CampaignStateStore(state)
  }

  /**
   * List campaigns that are genuinely active — not terminal, not zombie.
   *
   * Zombie detection: any non-terminal campaign whose `updatedAt` timestamp
   * is older than the phase-appropriate threshold is automatically marked
   * FAILED on disk and excluded from the result.
   *
   *   Machine phases  (SAMPLING / EVALUATING_* / ESCALATING_* / REPORTING / IDLE)
   *     → 48 h threshold. Workers don't silently run for 2 days; if no update
   *       in that window the campaign was abandoned without a clean shutdown.
   *
   *   User checkpoint phases  (PARETO_READY_*)
   *     → 7-day threshold. The user may be reviewing Pareto results.
   *
   * This is the *only* place zombie expiry fires. `listActive()` is called by
   * CampaignSession bootstrap and by CLI status commands, which is sufficient
   * to keep the disk clean without a dedicated background sweeper.
   */
  static async listActive(): Promise<CampaignStateStore[]> {
    const all = await CampaignStateStore._loadAll()
    const now  = Date.now()
    const active: CampaignStateStore[] = []

    for (const store of all) {
      const { phase } = store
      if (phase === 'DONE' || phase === 'FAILED') continue

      // Determine zombie threshold for this phase
      let thresholdMs: number | null = null
      if (phase === 'IDLE' || MACHINE_PHASES.has(phase)) {
        thresholdMs = ZOMBIE_MACHINE_MS
      } else if (USER_CHECKPOINT_PHASES.has(phase)) {
        thresholdMs = ZOMBIE_CHECKPOINT_MS
      }

      if (thresholdMs !== null) {
        const ageMs = now - new Date(store._state.updatedAt).getTime()
        if (ageMs > thresholdMs) {
          const ageH = Math.round(ageMs / 3_600_000)
          const limitH = Math.round(thresholdMs / 3_600_000)
          try {
            await store.markFailed(
              `Abandoned: no progress for ${ageH} h ` +
              `(auto-expired after ${limitH} h threshold in phase ${phase})`,
            )
          } catch {
            // Already terminal or transition blocked — ignore; still exclude.
          }
          continue  // not included in active list
        }
      }

      active.push(store)
    }
    return active
  }

  /** List ALL campaigns (including DONE/FAILED), sorted by createdAt desc. */
  static async listAll(): Promise<CampaignStateStore[]> {
    const all = await CampaignStateStore._loadAll()
    return all.sort(
      (a, b) =>
        new Date(b._state.createdAt).getTime() -
        new Date(a._state.createdAt).getTime(),
    )
  }

  /**
   * Scan CAMPAIGNS_ROOT and load every campaign directory that can be parsed.
   * Silently skips corrupted or partially-written directories.
   */
  private static async _loadAll(): Promise<CampaignStateStore[]> {
    let entries: string[]
    try {
      entries = await readdir(CAMPAIGNS_ROOT)
    } catch {
      return []
    }

    const stores: CampaignStateStore[] = []
    for (const entry of entries) {
      try {
        stores.push(await CampaignStateStore.load(entry))
      } catch {
        // Corrupted or partial directory — skip
      }
    }
    return stores
  }

  // ── Read accessors ──────────────────────────────────────────────────────────

  get phase(): CampaignPhase {
    return this._state.phase
  }

  /** ISO-8601 timestamp of the most recent state mutation. */
  get updatedAt(): string {
    return this._state.updatedAt
  }

  get designSpace(): DesignSpace {
    return this._state.designSpace
  }

  get sampledPoints(): DesignPoint[] {
    return this._state.sampledPoints
  }

  get pendingTaskCount(): number {
    return this._state.pendingTaskIds.length
  }

  get completedTaskCount(): number {
    return this._state.completedTaskIds.length
  }

  get failedTaskCount(): number {
    return this._state.failedTaskIds.length
  }

  /**
   * True when at least one task has been registered AND all registered tasks
   * have completed or failed (pendingTaskIds is empty).
   *
   * Returns false if no tasks have ever been registered for this phase —
   * distinguishes "not yet started" from "all done".
   */
  isCurrentPhaseComplete(): boolean {
    const total =
      this._state.pendingTaskIds.length +
      this._state.completedTaskIds.length +
      this._state.failedTaskIds.length
    return total > 0 && this._state.pendingTaskIds.length === 0
  }

  // ── Mutation: design points ─────────────────────────────────────────────────

  /** Record the DOE-sampled points and transition IDLE → SAMPLING. */
  async setSampledPoints(points: DesignPoint[]): Promise<void> {
    // H2: serialise through the same lock + reload protocol as the other
    // mutations. Writing without reload could clobber a concurrent Worker's
    // task completion (lost update); omitting updatedAt also skewed the zombie
    // detector's age calculation.
    return this._withLock(async () => {
      await this.reload()
      this._state.sampledPoints = points
      this._state.updatedAt = new Date().toISOString()
      await this._writeState()
    })
  }

  // ── Mutation: task registry ─────────────────────────────────────────────────

  /**
   * Register task IDs that have been dispatched to background Workers.
   * Called by the Coordinator just before spawning Workers.
   */
  async registerPendingTasks(taskIds: string[]): Promise<void> {
    // H2: serialise through the lock + reload so a Worker's concurrent
    // completeTask()/failTask() (which run under the same lock) cannot be
    // overwritten by a stale in-memory snapshot here (lost update).
    return this._withLock(async () => {
      await this.reload()
      this._state.pendingTaskIds = [
        ...new Set([...this._state.pendingTaskIds, ...taskIds]),
      ]
      this._state.updatedAt = new Date().toISOString()
      await this._writeState()
    })
  }

  /**
   * Mark a task as completed. Called by Worker via submit_evaluation_results tool.
   * Serialised through _withLock so concurrent calls from the same process
   * cannot interleave their reload→mutate→write sequences.
   */
  async completeTask(taskId: string): Promise<void> {
    return this._withLock(async () => {
      await this.reload()
      this._state.pendingTaskIds = this._state.pendingTaskIds.filter(
        id => id !== taskId,
      )
      if (!this._state.completedTaskIds.includes(taskId)) {
        this._state.completedTaskIds.push(taskId)
      }
      this._state.updatedAt = new Date().toISOString()
      await this._writeState()
    })
  }

  /**
   * Mark a task as failed.
   * Serialised through _withLock (same reason as completeTask).
   */
  async failTask(taskId: string, reason?: string): Promise<void> {
    return this._withLock(async () => {
      await this.reload()
      this._state.pendingTaskIds = this._state.pendingTaskIds.filter(
        id => id !== taskId,
      )
      if (!this._state.failedTaskIds.includes(taskId)) {
        this._state.failedTaskIds.push(taskId)
      }
      this._state.updatedAt = new Date().toISOString()
      if (reason && !this._state.failureReason) {
        this._state.failureReason = reason
      }
      await this._writeState()
    })
  }

  // ── Mutation: evaluation results (append-only JSONL) ───────────────────────

  /**
   * Append an EvaluationResult to evaluations.jsonl.
   * POSIX appendFile is atomic for small writes — multiple Workers can call
   * this concurrently without corrupting the file.
   */
  async submitResult(result: EvaluationResult): Promise<void> {
    const line = JSON.stringify(result) + '\n'
    await appendFile(this.paths.evaluations, line, 'utf-8')
  }

  /**
   * Read evaluation results from evaluations.jsonl using incremental byte-offset
   * tracking. Only newly-appended bytes are read on each call — avoiding a full
   * O(N) file read on every 5 s poll tick.
   *
   * The cumulative result set is stored in a static per-campaign cache that
   * persists across CampaignStateStore.load() calls (new instance per tick).
   * Filters are applied at query time over the full accumulated set.
   *
   * Safe to call concurrently with Workers appending to the file: partial last
   * lines (no trailing newline yet) are left for the next call.
   */
  async getEvaluations(filter?: {
    feasibleOnly?: boolean
    fidelity?: number
  }): Promise<EvaluationResult[]> {
    const cached = CampaignStateStore._evalCache.get(this.campaignId) ?? {
      offset: 0,
      results: [],
    }

    // Read only the bytes appended since the last call
    let newOffset = cached.offset
    const newResults: EvaluationResult[] = []

    let fh: Awaited<ReturnType<typeof open>> | null = null
    try {
      fh = await open(this.paths.evaluations, 'r')
      const { size } = await fh.stat()

      // M6-fix: detect truncation/recreation. If the file is now SHORTER than
      // our cached offset (campaign dir cleaned and recreated, file rotated…),
      // the incremental cursor is meaningless — reset and re-read from the
      // start instead of silently never seeing new results again.
      if (size < cached.offset) {
        cached.offset = 0
        cached.results = []
        newOffset = 0
      }

      if (size > cached.offset) {
        const toRead = size - cached.offset
        const buf = Buffer.allocUnsafe(toRead)
        const { bytesRead } = await fh.read(buf, 0, toRead, cached.offset)
        const chunk = buf.subarray(0, bytesRead).toString('utf-8')

        // Only consume up to the last complete newline — a Worker may be mid-write
        const lastNL = chunk.lastIndexOf('\n')
        if (lastNL >= 0) {
          const complete = chunk.slice(0, lastNL)
          // Advance offset past the consumed bytes (including the trailing newline)
          newOffset = cached.offset + Buffer.byteLength(chunk.slice(0, lastNL + 1), 'utf-8')

          for (const line of complete.split('\n')) {
            const trimmed = line.trim()
            if (!trimmed) continue
            try {
              newResults.push(JSON.parse(trimmed) as EvaluationResult)
            } catch {
              // skip malformed lines
            }
          }
        }
      }
    } catch {
      // File not yet created (no evaluations submitted) — return cached results
    } finally {
      await fh?.close()
    }

    // Merge into the accumulated cache (unfiltered — filters applied below)
    const allResults = newResults.length > 0
      ? [...cached.results, ...newResults]
      : cached.results

    if (newResults.length > 0) {
      CampaignStateStore._touchEvalCache(this.campaignId, {
        offset: newOffset,
        results: allResults,
      })
    } else if (cached.results.length > 0) {
      // S5: even a "cache hit, no new results" path touches the LRU so the
      // entry is promoted to most-recently-used and survives eviction.
      CampaignStateStore._touchEvalCache(this.campaignId, cached)
    }

    // Apply caller filters at query time.
    // M2: return a shallow copy so callers can't mutate (push/sort/splice) the
    // array held inside the process-level static eval cache.
    if (!filter) return [...allResults]
    return allResults.filter(r => {
      if (filter.feasibleOnly && !r.feasible) return false
      if (filter.fidelity !== undefined && r.fidelity !== filter.fidelity) return false
      return true
    })
  }

  /**
   * For each designPoint.id, keep only the highest-fidelity result.
   * Used by ParetoAnalyzer to avoid double-counting multi-fidelity evaluations.
   */
  async getBestFidelityEvaluations(feasibleOnly = true): Promise<EvaluationResult[]> {
    const all = await this.getEvaluations({ feasibleOnly })
    const best = new Map<string, EvaluationResult>()
    for (const r of all) {
      const existing = best.get(r.designPoint.id)
      if (!existing || r.fidelity > existing.fidelity) {
        best.set(r.designPoint.id, r)
      }
    }
    return [...best.values()]
  }

  // ── Mutation: phase transitions ─────────────────────────────────────────────

  /**
   * Transition to a new phase. Validates against VALID_TRANSITIONS.
   * Saves an immutable snapshot of state.json before overwriting.
   * Serialised through _withLock to prevent concurrent phase transitions.
   */
  async transitionPhase(to: CampaignPhase): Promise<void> {
    return this._withLock(async () => {
      const from = this._state.phase
      const valid = VALID_TRANSITIONS[from]
      if (!valid.includes(to)) {
        throw new Error(
          `Invalid phase transition: ${from} → ${to}. Valid: ${valid.join(', ')}`,
        )
      }

      // Save snapshot before transition (immutable record)
      await this._saveSnapshot(from)

      this._state.phase = to
      this._state.updatedAt = new Date().toISOString()
      await this._writeState()
    })
  }

  /**
   * Atomically mark this campaign as FAILED with a reason string.
   *
   * Unlike `transitionPhase('FAILED')`, this method:
   *   • reloads state from disk first (picks up any concurrent writes)
   *   • sets `failureReason` in the same locked write
   *   • silently no-ops if the campaign is already terminal (DONE / FAILED)
   *
   * Used by:
   *   • `listActive()` zombie auto-expiry
   *   • `CampaignMonitor` 24 h safety ceiling
   */
  async markFailed(reason: string): Promise<void> {
    return this._withLock(async () => {
      await this.reload()
      const from = this._state.phase
      // No-op if already terminal
      if (from === 'DONE' || from === 'FAILED') return
      // Save immutable snapshot of the phase we're leaving
      await this._saveSnapshot(from)
      this._state.phase         = 'FAILED'
      this._state.updatedAt     = new Date().toISOString()
      this._state.failureReason = reason
      await this._writeState()
    })
  }

  // ── Capsule read/write ──────────────────────────────────────────────────────

  /** Persist a pre-computed context capsule. Called by CampaignMonitor. */
  async saveCapsule(capsule: CampaignContextCapsule): Promise<void> {
    await atomicWriteJson(this.paths.capsule, capsule)
  }

  /** Read the most recent capsule, or null if not yet generated. */
  async getCapsule(): Promise<CampaignContextCapsule | null> {
    return readJsonFile<CampaignContextCapsule>(this.paths.capsule)
  }

  // ── Report ──────────────────────────────────────────────────────────────────

  async saveReport(markdown: string): Promise<void> {
    await writeFile(this.paths.report, markdown, 'utf-8')
  }

  // ── Reload (for CampaignMonitor polling) ───────────────────────────────────

  /**
   * Re-read state.json from disk. Called by CampaignMonitor between poll
   * intervals to pick up task completions written by Workers, and by the
   * mutation methods (_withLock) before each state write.
   *
   * Error handling:
   *   EBUSY / EMFILE — transient disk contention (e.g., concurrent rename on
   *     some OS/FS). Safe to silently keep the current in-memory state.
   *   All other errors (ENOENT, EPERM, JSON parse failure…) — re-thrown so the
   *     caller can detect genuine problems (e.g., campaign directory deleted).
   *     CampaignMonitor's setInterval catch-all will absorb the error, and the
   *     next tick will call load() which will also fail → watcher stops cleanly.
   */
  async reload(): Promise<void> {
    try {
      const raw = await readFile(this.paths.state, 'utf-8')
      this._state = JSON.parse(raw) as PersistedCampaignState
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'EBUSY' && code !== 'EMFILE') throw err
      // EBUSY/EMFILE: transient — keep current in-memory state and return normally
    }
  }

  // ── Worker log ──────────────────────────────────────────────────────────────

  async appendWorkerLog(workerId: string, line: string): Promise<void> {
    const path = join(this.paths.workers, `${workerId}.log`)
    await appendFile(path, `[${new Date().toISOString()}] ${line}\n`, 'utf-8')
  }

  // ── Internal helpers ────────────────────────────────────────────────────────

  private async _writeState(): Promise<void> {
    await atomicWriteJson(this.paths.state, this._state)
  }

  private async _saveSnapshot(phase: CampaignPhase): Promise<void> {
    const slug = phase.toLowerCase().replace(/_/g, '-')
    const snapPath = join(this.paths.snapshots, `${slug}.json`)
    // Only save once per phase (don't overwrite existing snapshot)
    try {
      await stat(snapPath)
      return // already exists
    } catch {
      // doesn't exist — write it
    }
    await atomicWriteJson(snapPath, this._state)
  }
}
