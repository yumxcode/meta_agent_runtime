/**
 * Blackboard — a run-scoped shared channel between orchestration nodes.
 *
 * Without it, a role node's `fail` verdict carries concrete corrective items
 * (e.g. "add the missing tests", "fix the null check") that go NOWHERE: the
 * graph's back-edge just re-runs the executor with its ORIGINAL task, discarding
 * the reviewer's feedback. The blackboard closes that loop — a reviewer posts its
 * correctives, and the next executor reads (and consumes) them as a task preface,
 * so generate→verify→fix actually fixes the cited gaps.
 *
 * Scope & ownership: one Blackboard per plan execution, owned by PlanRunner and
 * handed to nodes via PlanRunContext. It is in-memory and single-run — NOT the
 * durable checkpoint store. A full post log is retained for observability; the
 * pending-corrective queue is drained on read so feedback is applied exactly once.
 *
 * This is the minimal cross-node channel; richer addressing (per-target keys,
 * sibling outputs) can extend `post`/`entries` without changing the corrective
 * fast-path the runner uses today.
 */

export interface BlackboardEntry {
  /** Node id / role that wrote this entry. */
  from: string
  /** Entry kind: 'corrective' | 'output' | 'note' | any custom tag. */
  kind: string
  /** Free-text payload (correctives, unfinished items, …). */
  messages?: string[]
  /** Structured payload for non-text outputs. */
  data?: unknown
  /** Epoch ms when posted. */
  at: number
}

export class Blackboard {
  private readonly log: BlackboardEntry[] = []
  private pendingCorrectives: { from: string; messages: string[] }[] = []
  private _correctiveRounds = 0

  /** Append an arbitrary entry to the (observability) log. */
  post(entry: Omit<BlackboardEntry, 'at'>): void {
    this.log.push({ ...entry, at: Date.now() })
  }

  /**
   * Post corrective feedback from a reviewer. Empty/whitespace messages are
   * dropped. Increments the corrective-round counter (surfaced in the summary).
   */
  postCorrective(from: string, messages: readonly string[]): void {
    const msgs = messages.map(m => String(m)).filter(m => m.trim().length > 0)
    if (msgs.length === 0) return
    this.post({ from, kind: 'corrective', messages: msgs })
    this.pendingCorrectives.push({ from, messages: msgs })
    this._correctiveRounds++
  }

  /** True when there is unconsumed corrective feedback. */
  hasPendingCorrectives(): boolean {
    return this.pendingCorrectives.length > 0
  }

  /** Return the pending correctives and clear them (consumed exactly once). */
  drainCorrectives(): { from: string; messages: string[] }[] {
    const out = this.pendingCorrectives
    this.pendingCorrectives = []
    return out
  }

  /**
   * Drain pending correctives and render them as an injectable task preface.
   * Returns '' when there is nothing pending (executor task is unchanged).
   */
  takeCorrectivePreface(): string {
    const pending = this.drainCorrectives()
    if (pending.length === 0) return ''
    const lines = pending.flatMap(p => p.messages.map(m => `  - ${m}（来自 ${p.from}）`))
    return [
      '【上一轮审查反馈 —— 本次执行请优先修正以下未达成项】',
      ...lines,
      '',
    ].join('\n')
  }

  /** How many times correctives were posted this run (for the run summary). */
  correctiveRounds(): number {
    return this._correctiveRounds
  }

  /** Full post log (observability). */
  entries(): readonly BlackboardEntry[] {
    return this.log
  }
}
