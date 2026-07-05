/**
 * CharterValidate — create-time gate (spec C2). A charter that passes here can
 * be frozen and run; one that fails never touches a workspace. Errors are
 * written to be instructive (they feed the distiller's retry loop, mirroring
 * the planner-error feedback pattern that proved out in v1).
 */
import { parse, type Ast } from '../expr/Expr.js'
import type { Charter, FrozenCharter, MeterSpec, TripwireSpec } from './CharterTypes.js'

const ID_RE = /^[a-z][a-z0-9_-]*$/i
const META_AGENT_RE = /\.meta-agent[/\\]/

export function validateCharter(charter: Charter): string[] {
  const errs: string[] = []
  if (!charter || typeof charter !== 'object') return ['charter must be an object']
  if (!charter.id || !ID_RE.test(charter.id)) errs.push('charter.id must match [a-z][a-z0-9_-]*')
  if (!Number.isInteger(charter.version) || charter.version < 1) errs.push('charter.version must be a positive integer')
  if (!charter.goal?.trim()) errs.push('charter.goal is required')

  // Declared identifier universe for the DSL static check.
  const declared = new Set<string>(['budget.lifetime.exhausted'])
  const obsNames = new Set<string>()
  for (const o of charter.observables ?? []) {
    if (!o.name) { errs.push('observable needs a name'); continue }
    if (obsNames.has(o.name)) errs.push(`duplicate observable: ${o.name}`)
    obsNames.add(o.name)
    declared.add(o.name)
    if (!o.source || !('from' in o.source)) errs.push(`observable[${o.name}] needs a source`)
  }
  const meterNames = new Set<string>()
  for (const m of charter.meters ?? []) {
    if (!m.name) { errs.push('meter needs a name'); continue }
    if (meterNames.has(m.name) || obsNames.has(m.name)) errs.push(`duplicate/conflicting meter name: ${m.name}`)
    meterNames.add(m.name)
    declared.add(m.name)
  }

  // Expressions: parse + undeclared-identifier check.
  for (const m of charter.meters ?? []) errs.push(...validateMeterExprs(m, declared))
  const tripwires = charter.tripwires ?? []
  if (tripwires.length === 0) errs.push('at least one tripwire is required (a loop must be able to stop)')
  for (const [i, tw] of tripwires.entries()) errs.push(...validateTripwire(tw, i, declared))

  // Graceful-exit guarantee: SOME tripwire must be able to stop the loop.
  if (!tripwires.some(tw => tw.then?.stop === true || tw.then?.mode === 'finalize')) {
    errs.push(
      'no tripwire can stop the loop (need at least one with stop:true or mode:finalize) — ' +
      'a loop that can only exit via budget exhaustion is rejected by design',
    )
  }

  // Seats.
  if (!charter.seats?.worker?.prompt?.trim()) errs.push('seats.worker.prompt is required')
  for (const [name, seat] of Object.entries(charter.seats ?? {})) {
    if (!seat) continue
    if (name !== 'worker' && seat.context !== 'isolated') {
      errs.push(`seats.${name}.context must be 'isolated' (D6: reviewers physically cannot share lineage)`)
    }
    if (META_AGENT_RE.test(seat.prompt ?? '')) {
      errs.push(`seats.${name}.prompt references .meta-agent/ — runtime-internal, writes there are discarded`)
    }
  }
  if (charter.seats?.worker && charter.seats.worker.context === undefined) {
    errs.push("seats.worker.context is required ('lineage_round' recommended)")
  }

  // Gates.
  for (const [name, gate] of Object.entries(charter.gates ?? {})) {
    if (gate.kind === 'judge' && !charter.seats?.judge) {
      errs.push(`gate[${name}] is a judge gate but no judge seat is declared`)
    }
    if (gate.kind === 'schema' && gate.files.length === 0) {
      errs.push(`gate[${name}] declares no files`)
    }
  }

  // Write scope hygiene (D8 + v1 postmortem).
  for (const scope of charter.writeScope ?? []) {
    if (META_AGENT_RE.test(scope)) errs.push(`writeScope '${scope}' is under .meta-agent/ (merge-excluded)`)
    if (scope.startsWith('/') || scope.startsWith('..')) errs.push(`writeScope '${scope}' must be workspace-relative`)
  }

  // Budgets sanity.
  const life = charter.budgets?.lifetime
  if (life && life.rounds !== undefined && (!Number.isInteger(life.rounds) || life.rounds < 1)) {
    errs.push('budgets.lifetime.rounds must be a positive integer')
  }

  // Waits (M2): every wait needs a kind, a sane cadence, and a rule table in
  // which at least one rule can conclude the wait (otherwise it sleeps forever).
  const CONCLUDING: ReadonlySet<string> = new Set(['wake_harvest', 'terminate_and_harvest'])
  for (const [name, wait] of Object.entries(charter.waits ?? {})) {
    if (!wait.kind?.trim()) errs.push(`waits.${name} needs a kind (probe adapter)`)
    if (!Number.isFinite(wait.probeEveryMs) || wait.probeEveryMs <= 0) {
      errs.push(`waits.${name}.probeEveryMs must be a positive number`)
    }
    if (!wait.rules?.length) {
      errs.push(`waits.${name} needs at least one probe rule`)
    } else if (!wait.rules.some(r => CONCLUDING.has(r.do))) {
      errs.push(`waits.${name} has no rule that can conclude the wait (wake_harvest/terminate_and_harvest)`)
    }
    for (const r of wait.rules ?? []) {
      if (!r.when?.trim()) errs.push(`waits.${name} has a rule without 'when'`)
      if (!['sleep', 'wake_harvest', 'terminate_and_harvest', 'rotate_and_resubmit'].includes(r.do)) {
        errs.push(`waits.${name} rule '${r.when}' has unknown action '${r.do}'`)
      }
    }
  }
  return errs
}

function validateMeterExprs(m: MeterSpec, declared: ReadonlySet<string>): string[] {
  const errs: string[] = []
  if (m.inc === 'every_round' && (m.incWhen || m.resetWhen)) {
    errs.push(`meter[${m.name}]: 'inc: every_round' excludes incWhen/resetWhen`)
  }
  if (!m.inc && !m.incWhen) errs.push(`meter[${m.name}] needs 'inc: every_round' or an incWhen`)
  for (const [field, src] of [['incWhen', m.incWhen], ['resetWhen', m.resetWhen]] as const) {
    if (!src) continue
    try {
      parse(src, declared)
    } catch (err) {
      errs.push(`meter[${m.name}].${field}: ${(err as Error).message}`)
    }
  }
  return errs
}

function validateTripwire(tw: TripwireSpec, index: number, declared: ReadonlySet<string>): string[] {
  const errs: string[] = []
  if (!tw.when?.trim()) { errs.push(`tripwire[${index}] needs a 'when' expression`); return errs }
  try {
    parse(tw.when, declared)
  } catch (err) {
    errs.push(`tripwire[${index}].when: ${(err as Error).message}`)
  }
  const t = tw.then ?? {}
  if (!t.mode && !t.escalate && t.stop !== true) {
    errs.push(`tripwire[${index}].then must set mode, escalate, or stop`)
  }
  return errs
}

/** Parse every expression and attach ASTs — the instantiation-time freeze (D9). */
export function freezeCharter(charter: Charter): FrozenCharter {
  const errs = validateCharter(charter)
  if (errs.length > 0) {
    throw new Error(`charter failed validation:\n- ${errs.join('\n- ')}`)
  }
  const declared = new Set<string>(['budget.lifetime.exhausted'])
  for (const o of charter.observables) declared.add(o.name)
  for (const m of charter.meters) declared.add(m.name)

  const meterAsts: Record<string, { incWhen?: Ast; resetWhen?: Ast }> = {}
  for (const m of charter.meters) {
    meterAsts[m.name] = {
      ...(m.incWhen ? { incWhen: parse(m.incWhen, declared) } : {}),
      ...(m.resetWhen ? { resetWhen: parse(m.resetWhen, declared) } : {}),
    }
  }
  return {
    ...charter,
    frozen: {
      meterAsts,
      tripwireAsts: charter.tripwires.map(tw => parse(tw.when, declared)),
      declaredIdentifiers: [...declared].sort(),
      frozenAt: Date.now(),
    },
  }
}
