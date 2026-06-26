/**
 * HookRegistry — the (B) middleware layer over the kernel's main-loop phases.
 *
 * The kernel exposes four intra-turn transitions via the PhaseHookFn contract
 * (see kernel/loop/PhaseHooks.ts). A HookRegistry is the implementation injected
 * there: it holds a list of registered phase hooks, each with a trigger
 * predicate, and on every transition runs the ones whose point + predicate match,
 * then folds their unified verdicts into the minimal PhaseHookOutcome the kernel
 * understands (inject / abort).
 *
 * This is the generalisation of the two hard-coded gate slots into an open
 * registry: drift/verify are just two role agents that happen to mount on
 * structural boundaries; a phase hook is a role agent mounted on an intra-turn
 * transition. The kernel never imports this class — it only sees `PhaseHookFn`.
 */
import type {
  PhaseHookFn,
  PhaseHookEvent,
  PhaseHookOutcome,
  PhaseHookPoint,
} from '../../kernel/loop/PhaseHooks.js'
import type { OrchVerdict } from './Verdict.js'
import { evalPredicate, validatePredicate, type LoopStateView, type Predicate } from './predicates.js'

/** Context a phase hook receives — the kernel event plus the derived state view. */
export interface PhaseHookContext {
  event: PhaseHookEvent
  state: LoopStateView
}

/** A role agent mounted on an intra-turn transition. Returns a unified verdict. */
export type PhaseHookHandler = (ctx: PhaseHookContext) => Promise<OrchVerdict> | OrchVerdict

/** A registered phase hook. */
export interface RegisteredPhaseHook {
  /** Stable id for observability / dedupe. */
  id: string
  /** Which transition it mounts on. */
  point: PhaseHookPoint
  /** Trigger predicate; defaults to `always` when omitted. */
  when?: Predicate
  /** The role agent. */
  handler: PhaseHookHandler
  /** Optional role label (e.g. 'reviewer', 'cost_guard') for observability. */
  role?: string
}

/** Validate a hook spec is structurally sound. Returns problems; empty = ok. */
export function validatePhaseHook(h: RegisteredPhaseHook): string[] {
  const errs: string[] = []
  if (!h.id) errs.push('hook.id is required')
  if (typeof h.handler !== 'function') errs.push(`hook[${h.id}].handler must be a function`)
  if (h.when) errs.push(...validatePredicate(h.when, `hook[${h.id}].when`))
  return errs
}

export class HookRegistry {
  private readonly hooks: RegisteredPhaseHook[] = []

  /** Register a phase hook. Throws on a structurally invalid spec. */
  register(hook: RegisteredPhaseHook): this {
    const errs = validatePhaseHook(hook)
    if (errs.length) throw new Error(`invalid phase hook: ${errs.join('; ')}`)
    this.hooks.push(hook)
    return this
  }

  /** True when no hooks are registered (lets the host skip wiring entirely). */
  get isEmpty(): boolean {
    return this.hooks.length === 0
  }

  /** Hooks mounted on a given transition (predicate not yet evaluated). */
  hooksAt(point: PhaseHookPoint): readonly RegisteredPhaseHook[] {
    return this.hooks.filter(h => h.point === point)
  }

  /**
   * Build the kernel-facing PhaseHookFn. On each transition it derives a state
   * view, runs matching hooks IN REGISTRATION ORDER, and folds their verdicts:
   *   • inject/reject verdicts contribute their messages (deduped, in order);
   *   • an abort verdict sets abort=true (applied after all injects);
   *   • continue/done/branch/skipped contribute nothing at the phase level.
   * A throwing hook is swallowed (fail-open) so one bad role can't wedge the loop.
   */
  toPhaseHookFn(): PhaseHookFn {
    return async (event: PhaseHookEvent): Promise<PhaseHookOutcome> => {
      const state = deriveStateView(event)
      const matched = this.hooks.filter(
        h => h.point === event.point && evalPredicate(h.when ?? { kind: 'always' }, state),
      )
      if (matched.length === 0) return {}

      const messages: string[] = []
      const seen = new Set<string>()
      let abort = false
      const notes: string[] = []

      for (const h of matched) {
        if (event.signal.aborted) break
        let verdict: OrchVerdict
        try {
          verdict = await h.handler({ event, state })
        } catch (err) {
          notes.push(`hook[${h.id}] failed: ${(err as Error).message}`)
          continue
        }
        if (verdict.skipped) continue
        if (verdict.action === 'inject' || verdict.action === 'reject') {
          for (const m of verdict.messages ?? []) {
            if (!seen.has(m)) {
              seen.add(m)
              messages.push(m)
            }
          }
        }
        if (verdict.action === 'abort') abort = true
        if (verdict.note) notes.push(`hook[${h.id}]: ${verdict.note}`)
      }

      const outcome: PhaseHookOutcome = {}
      if (messages.length) outcome.inject = messages
      if (abort) outcome.abort = true
      if (notes.length) outcome.note = notes.join(' | ')
      return outcome
    }
  }
}

/** Map a kernel PhaseHookEvent onto the predicate evaluator's state view. */
function deriveStateView(event: PhaseHookEvent): LoopStateView {
  return {
    turnCount: event.state.turnCount,
    estimatedCostUsd: event.state.estimatedCostUsd,
    point: event.point,
    toolNames: event.state.toolNames,
    erroredToolNames: event.state.erroredToolNames,
  }
}
