/**
 * Blackboard — a run-scoped shared channel between orchestration nodes, with
 * target addressing.
 *
 * Why addressing: a single undifferentiated queue ("whoever runs next takes
 * everything") only works for a single-executor immediate back-edge loop. The
 * moment a graph has several distinct executors (auth / api / …) or fan-in, a
 * reviewer's feedback for node B could be wrongly consumed by node C. Each entry
 * therefore carries an optional `to` (target node id); a reader fetches only what
 * is addressed to it (or broadcast). This is also the prerequisite for safe
 * parallel siblings.
 *
 * Who sets the address: the ORCHESTRATOR derives it from topology — when a node's
 * verdict carries corrective messages, PlanRunner posts them addressed to the
 * node the verdict routes to (the back-edge target). Agents stay address-agnostic.
 *
 * Consumption semantics by kind:
 *   • 'corrective' — consume-once. Drained when its addressee reads it, so a fix
 *     is applied exactly once.
 *   • everything else ('output' / 'note' / …) — persistent. `readFor` does NOT
 *     consume, so multiple downstream nodes can read the same output (fan-in).
 *
 * Scope: one Blackboard per plan execution, owned by PlanRunner. In-memory,
 * single-run; NOT the durable checkpoint store. A full post log is retained for
 * observability.
 */

export interface BlackboardEntry {
  /** Node id / role that wrote this entry. */
  from: string
  /** Target node id; undefined = broadcast (any reader). */
  to?: string
  /** Entry kind: 'corrective' (consume-once) | 'output' | 'note' | custom (persistent). */
  kind: string
  /** Free-text payload (correctives, unfinished items, …). */
  messages?: string[]
  /** Structured payload for non-text outputs. */
  data?: unknown
  /** Epoch ms when posted. */
  at: number
}

interface PendingCorrective {
  from: string
  to?: string
  messages: string[]
  consumed: boolean
}

export class Blackboard {
  private readonly log: BlackboardEntry[] = []
  private readonly correctives: PendingCorrective[] = []
  private _correctiveRounds = 0

  /** Append an arbitrary (persistent) entry to the log — e.g. outputs/notes. */
  post(entry: Omit<BlackboardEntry, 'at'>): void {
    this.log.push({ ...entry, at: Date.now() })
  }

  /**
   * Post corrective feedback, optionally addressed to a target node (`to`).
   * Empty/whitespace messages are dropped. Increments the corrective-round
   * counter (surfaced in the run summary).
   */
  postCorrective(entry: { from: string; to?: string; messages: readonly string[] }): void {
    const msgs = entry.messages.map(m => String(m)).filter(m => m.trim().length > 0)
    if (msgs.length === 0) return
    this.post({ from: entry.from, to: entry.to, kind: 'corrective', messages: msgs })
    this.correctives.push({ from: entry.from, to: entry.to, messages: msgs, consumed: false })
    this._correctiveRounds++
  }

  /** Does `nodeId` have unconsumed correctives (addressed to it or broadcast)? */
  hasCorrectivesFor(nodeId: string): boolean {
    return this.correctives.some(c => !c.consumed && (c.to === undefined || c.to === nodeId))
  }

  /**
   * Return + consume the correctives addressed to `nodeId` (or broadcast).
   * Consume-once: each corrective is delivered to exactly one reader.
   */
  takeCorrectivesFor(nodeId: string): { from: string; messages: string[] }[] {
    const taken: { from: string; messages: string[] }[] = []
    for (const c of this.correctives) {
      if (c.consumed) continue
      if (c.to === undefined || c.to === nodeId) {
        c.consumed = true
        taken.push({ from: c.from, messages: c.messages })
      }
    }
    return taken
  }

  /**
   * Consume the correctives for `nodeId` and render them as an injectable task
   * preface. Returns '' when there is nothing addressed to this node.
   */
  takeCorrectivePrefaceFor(nodeId: string): string {
    const taken = this.takeCorrectivesFor(nodeId)
    if (taken.length === 0) return ''
    const lines = taken.flatMap(t => t.messages.map(m => `  - ${m}（来自 ${t.from}）`))
    return [
      '【上一轮审查反馈 —— 本次执行请优先修正以下未达成项】',
      ...lines,
      '',
    ].join('\n')
  }

  /**
   * Non-consuming read of PERSISTENT entries (not correctives) addressed to
   * `nodeId` or broadcast, optionally filtered by kind. Supports fan-in: several
   * nodes can read the same output. Does NOT consume.
   */
  readFor(nodeId: string, kind?: string): BlackboardEntry[] {
    return this.log.filter(
      e =>
        e.kind !== 'corrective' &&
        (kind === undefined || e.kind === kind) &&
        (e.to === undefined || e.to === nodeId),
    )
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
