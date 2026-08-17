/**
 * In-process cron job store.
 *
 * Implements a lightweight cron scheduler using a chained-setTimeout loop.
 * Each job is keyed by a UUID.  Jobs run within the current process for the
 * lifetime of the session (or until explicitly deleted).
 *
 * H2-fix: the previous implementation approximated every expression as a
 * fixed setInterval and mapped ANY fixed-second expression (e.g. the daily
 * `0 0 0 * * *`) to a 60 s interval — daily jobs fired 1440×/day.  This
 * version computes the actual next wall-clock occurrence and re-schedules
 * after each run, which also makes overlapping runs impossible (the next
 * timer is only armed after the callback settles).
 *
 * Supported expression forms (6-field: second minute hour dom month dow):
 *   - "*"                  in any field
 *   - step syntax "* /N"   (no space) in second / minute / hour
 *   - fixed N              in second / minute / hour
 *   - dom / month / dow MUST be "*" — anything else throws at creation time
 *     (explicit rejection instead of silently running on the wrong schedule).
 */

import { randomUUID } from 'crypto'

export interface CronJob {
  id: string
  expression: string
  description: string
  sessionId: string
  createdAt: Date
  lastRunAt: Date | null
  runCount: number
  active: boolean
}

type CronCallback = () => void | Promise<void>

interface CronEntry extends CronJob {
  timer: ReturnType<typeof setTimeout> | null
  callback: CronCallback
}

// Global store — keyed by job ID.  One store per process, shared across sessions.
const store = new Map<string, CronEntry>()

// ─────────────────────────────────────────────────────────────────────────────
// Cron expression parser (6-field: second minute hour dom month dow)
// ─────────────────────────────────────────────────────────────────────────────

type FieldSpec =
  | { kind: 'any' }
  | { kind: 'step'; n: number }
  | { kind: 'fixed'; v: number }

interface CronSpec {
  sec: FieldSpec
  min: FieldSpec
  hour: FieldSpec
}

function parseField(raw: string, name: string, max: number): FieldSpec {
  if (raw === '*') return { kind: 'any' }
  if (raw.startsWith('*/')) {
    const n = Number.parseInt(raw.slice(2), 10)
    if (!Number.isInteger(n) || n < 1 || n > max) {
      throw new Error(`Invalid cron ${name} step "${raw}" (expected */1..*/${max})`)
    }
    return { kind: 'step', n }
  }
  const v = Number.parseInt(raw, 10)
  if (!Number.isInteger(v) || v < 0 || v > max || String(v) !== raw.trim()) {
    throw new Error(`Invalid cron ${name} value "${raw}" (expected 0..${max}, */N, or *)`)
  }
  return { kind: 'fixed', v }
}

/** Parse and validate a 6-field cron expression. Throws on unsupported forms. */
export function parseCronExpression(expression: string): CronSpec {
  const parts = expression.trim().split(/\s+/)
  if (parts.length !== 6) {
    throw new Error(`Invalid cron expression (expected 6 fields): "${expression}"`)
  }
  const [sec, min, hour, dom, month, dow] = parts as [string, string, string, string, string, string]
  // Calendar fields are not implemented — refuse loudly rather than running
  // on a schedule the caller did not ask for.
  if (dom !== '*' || month !== '*' || dow !== '*') {
    throw new Error(
      `Unsupported cron expression "${expression}": day-of-month / month / day-of-week ` +
      `must be "*" (calendar fields are not supported by this scheduler).`,
    )
  }
  return {
    sec: parseField(sec, 'second', 59),
    min: parseField(min, 'minute', 59),
    hour: parseField(hour, 'hour', 23),
  }
}

function fieldMatches(value: number, spec: FieldSpec): boolean {
  switch (spec.kind) {
    case 'any': return true
    case 'step': return value % spec.n === 0
    case 'fixed': return value === spec.v
  }
}

/**
 * First instant on `day`'s calendar date that matches `spec` and is at or after
 * `day`'s own time-of-day. Returns null when the rest of that day has no match.
 *
 * Iterates over the FIELD DOMAINS (24 hours × 60 minutes × 60 seconds, each
 * with an early `continue`), not over every second on the clock. A matching
 * hour is normally found within a few steps and the minute/second loops exit on
 * their first match, so a typical call examines on the order of a hundred
 * values.
 */
function firstMatchOnDay(day: Date, spec: CronSpec): number | null {
  const fromH = day.getHours()
  const fromM = day.getMinutes()
  const fromS = day.getSeconds()
  for (let h = fromH; h <= 23; h++) {
    if (!fieldMatches(h, spec.hour)) continue
    for (let m = h === fromH ? fromM : 0; m <= 59; m++) {
      if (!fieldMatches(m, spec.min)) continue
      for (let s = h === fromH && m === fromM ? fromS : 0; s <= 59; s++) {
        if (!fieldMatches(s, spec.sec)) continue
        const hit = new Date(day)
        hit.setHours(h, m, s, 0)
        return hit.getTime()
      }
    }
  }
  return null
}

/**
 * Milliseconds until the next wall-clock instant matching `spec`, strictly
 * after `fromMs`.
 *
 * The previous implementation stepped one second at a time across a 25 h
 * horizon, so arming a DAILY job allocated ~86,400 `Date` objects and blocked
 * the event loop for the whole walk — on every re-arm, i.e. after every run.
 *
 * Local time, deliberately: someone writing `0 0 9 * * *` means 09:00 where
 * they are. A consequence is that DST transitions make a daily job fire 23 or
 * 25 hours after the previous one, which is standard cron behaviour.
 */
export function nextRunDelayMs(spec: CronSpec, fromMs = Date.now()): number {
  // Strictly after `fromMs`: begin at the next whole second.
  const start = new Date(Math.floor(fromMs / 1000) * 1000 + 1000)

  // Today (from `start` onward), then the two following days from midnight.
  // Every supported expression recurs at least daily, so a match always exists
  // within that window; the third day is slack for a DST-shifted boundary.
  for (let offset = 0; offset < 3; offset++) {
    const day = new Date(start)
    if (offset > 0) {
      day.setDate(day.getDate() + offset)
      day.setHours(0, 0, 0, 0)
    }
    const hit = firstMatchOnDay(day, spec)
    if (hit !== null && hit > fromMs) return hit - fromMs
  }

  // Unreachable for validated specs. Re-check in a second rather than throwing
  // and killing the job: a scheduler that stops silently is worse than one that
  // is briefly imprecise.
  return 1000
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/** Arm the next run for an entry. No-op when the entry was deleted. */
function scheduleNext(entry: CronEntry, spec: CronSpec): void {
  if (!entry.active || !store.has(entry.id)) return
  const delay = nextRunDelayMs(spec)
  entry.timer = setTimeout(async () => {
    entry.lastRunAt = new Date()
    entry.runCount++
    try {
      await entry.callback()
    } catch {
      /* swallow — cron jobs must not crash the process */
    }
    // Re-arm only after the callback settles → overlapping runs are impossible
    // even when the callback takes longer than the schedule interval.
    scheduleNext(entry, spec)
  }, delay)
  // Allow Node to exit even if timers are still pending
  if (entry.timer.unref) entry.timer.unref()
}

export function createCronJob(
  expression: string,
  description: string,
  sessionId: string,
  callback: CronCallback,
): CronJob {
  const spec = parseCronExpression(expression)  // throws on bad expression
  const id = randomUUID()

  const entry: CronEntry = {
    id,
    expression,
    description,
    sessionId,
    createdAt: new Date(),
    lastRunAt: null,
    runCount: 0,
    active: true,
    callback,
    timer: null,
  }

  store.set(id, entry)
  scheduleNext(entry, spec)
  return publicView(entry)
}

export function deleteCronJob(id: string): boolean {
  const entry = store.get(id)
  if (!entry) return false
  if (entry.timer) clearTimeout(entry.timer)
  entry.active = false
  store.delete(id)
  return true
}

/**
 * Cancel and remove all cron jobs belonging to a session.
 *
 * Call this when a session ends to prevent dangling timer callbacks
 * from accumulating in the module-level store (memory leak + wasted CPU).
 * Returns the number of jobs that were cancelled.
 */
export function deleteJobsForSession(sessionId: string): number {
  let count = 0
  for (const [id, entry] of store) {
    if (entry.sessionId === sessionId) {
      if (entry.timer) clearTimeout(entry.timer)
      entry.active = false
      store.delete(id)
      count++
    }
  }
  return count
}

export function listCronJobs(sessionId?: string): CronJob[] {
  return [...store.values()]
    .filter(e => sessionId === undefined || e.sessionId === sessionId)
    .map(publicView)
}

function publicView(e: CronEntry): CronJob {
  return {
    id: e.id,
    expression: e.expression,
    description: e.description,
    sessionId: e.sessionId,
    createdAt: e.createdAt,
    lastRunAt: e.lastRunAt,
    runCount: e.runCount,
    active: e.active,
  }
}
