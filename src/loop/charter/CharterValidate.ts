/**
 * CharterValidate — create-time gate (spec C2). A charter that passes here can
 * be frozen and run; one that fails never touches a workspace. Errors are
 * written to be instructive (they feed the distiller's retry loop, mirroring
 * the planner-error feedback pattern that proved out in v1).
 */
import { parse, type Ast } from '../expr/Expr.js'
import { relativePathError, writeScopeRoot } from '../security/PathSafety.js'
import type { Charter, FrozenCharter, LegacyTripwireAction, MeterSpec, TripwireAction, TripwireSpec } from './CharterTypes.js'

const ID_RE = /^[a-z][a-z0-9_-]*$/i
const META_AGENT_RE = /\.meta-agent[/\\]/

// ── v3 migration: legacy {mode?, escalate?, stop?} → discriminated union ──────

function isLegacyAction(then: unknown): then is LegacyTripwireAction {
  return typeof then === 'object' && then !== null && !('act' in then)
}

/**
 * Map a pre-v3 action to its v3 equivalent, preserving the LEGACY KERNEL's
 * actual priority (escalate > stop/finalize > pivot; bare mode:'attention'
 * was intended as "hand to a human" → escalate).
 */
export function normalizeTripwireAction(then: TripwireAction | LegacyTripwireAction): TripwireAction {
  if (!isLegacyAction(then)) return then
  if (then.escalate) return { act: 'escalate', reason: then.escalate }
  if (then.stop === true || then.mode === 'finalize') return { act: 'finalize' }
  if (then.mode === 'pivot') return { act: 'pivot' }
  if (then.mode === 'attention') return { act: 'escalate', reason: 'attention' }
  // Empty legacy action — surfaces as a validation error downstream.
  return then as unknown as TripwireAction
}

/**
 * Upgrade a charter (or frozen charter) in place-shape: only tripwire actions
 * differ between v2 and v3. Deterministic and idempotent — safe to apply on
 * every load. Expressions/ASTs are untouched (`when` never changed shape).
 */
export function normalizeCharter<T extends Charter>(charter: T): T {
  if (!charter || typeof charter !== 'object' || !Array.isArray(charter.tripwires)) return charter
  const tripwires = charter.tripwires.map(tw =>
    tw && typeof tw === 'object'
      ? { ...tw, then: normalizeTripwireAction(tw.then as TripwireAction | LegacyTripwireAction) }
      : tw,
  )
  return { ...charter, tripwires }
}

export function validateCharter(rawCharter: Charter): string[] {
  const errs: string[] = []
  if (!rawCharter || typeof rawCharter !== 'object') return ['charter must be an object']
  const charter = normalizeCharter(rawCharter)
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
    // The validator is the source of truth for what the kernel can resolve.
    // Only `from:'judge'` is wired (collectObservables reads judge.data[key]);
    // anything else silently yields an unpopulated observable → dead
    // tripwires/meters. Reject it loudly at create time.
    const src = o.source as { from?: unknown; key?: unknown } | undefined
    if (!src || typeof src.from !== 'string') {
      errs.push(`observable[${o.name}] needs a source with a 'from'`)
    } else if (src.from !== 'judge') {
      errs.push(
        `observable[${o.name}].source.from must be 'judge' — the only source the kernel resolves ` +
        `(got '${src.from}'). Do NOT observe the worker: a failed worker round already increments ` +
        `stale_count, so route worker errors via a stale_count tripwire (pivot/attention).`,
      )
    } else if (typeof src.key !== 'string' || !src.key.trim()) {
      errs.push(`observable[${o.name}].source needs a non-empty 'key' (the judge return_result data field)`)
    }
  }
  if ((charter.observables?.length ?? 0) > 0 && !charter.seats?.judge) {
    errs.push("judge-sourced observables require seats.judge — otherwise they can never be populated")
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
  for (const [i, tw] of tripwires.entries()) errs.push(...validateTripwire(tw, i, declared, meterNames))

  // Guaranteed-termination guarantee. Loops end three ways: (a) built-in
  // acceptance (judge sets goal_satisfied → kernel finalizes); (b) built-in
  // lifetime budget (rounds/usd/deadline → kernel finalizes); (c) a charter
  // finalize tripwire. (a) is not guaranteed to fire, so we require at least
  // one GUARANTEED terminator: a finalize tripwire OR a lifetime budget.
  // (escalate does not count — it pauses for a human, it does not terminate.)
  const hasFinalizeTripwire = tripwires.some(tw => tw.then?.act === 'finalize')
  const lifeCap = charter.budgets?.lifetime
  const hasBudgetCap = !!(lifeCap && (lifeCap.rounds !== undefined || lifeCap.usd !== undefined || lifeCap.deadlineMs !== undefined))
  if (!hasFinalizeTripwire && !hasBudgetCap) {
    errs.push(
      "loop has no guaranteed terminator — declare a tripwire with {act:'finalize'} " +
      'OR a lifetime budget (budgets.lifetime.rounds/usd/deadlineMs). Built-in acceptance ' +
      '(judge goal_satisfied) ends the loop early, but is not guaranteed to fire.',
    )
  }

  // pivot ⇔ pivoter binding (both directions, so neither side can go dead).
  const hasPivotTripwire = tripwires.some(tw => tw.then?.act === 'pivot')
  if (hasPivotTripwire && !charter.seats?.pivoter) {
    errs.push("a tripwire uses {act:'pivot'} but seats.pivoter is not declared — the pivot round would degrade to a plain round")
  }
  if (charter.seats?.pivoter && !hasPivotTripwire) {
    errs.push("seats.pivoter is declared but no tripwire uses {act:'pivot'} — the pivoter seat would never run (dead seat)")
  }

  // Meter names for onResume validation + health expression check.
  if (charter.health) {
    if (typeof charter.health.staleWhen !== 'string' || !charter.health.staleWhen.trim()) {
      errs.push('health.staleWhen must be a non-empty expression')
    } else {
      try {
        parse(charter.health.staleWhen, declared)
      } catch (err) {
        errs.push(`health.staleWhen: ${(err as Error).message}`)
      }
    }
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
    for (const input of seat.inputs ?? []) {
      const pathErr = relativePathError(input)
      if (pathErr) errs.push(`seats.${name}.inputs '${input}' ${pathErr}`)
    }
    const wc = seat.budgetPerRound?.wallclockMin
    if (wc !== undefined && (!Number.isFinite(wc) || wc < 1)) {
      errs.push(`seats.${name}.budgetPerRound.wallclockMin must be a positive number of minutes`)
    }
  }
  if (charter.seats?.worker && charter.seats.worker.context === undefined) {
    errs.push("seats.worker.context is required ('lineage_loop' to accumulate context across rounds, or 'isolated' for fresh-eyes rounds)")
  }

  // Gates.
  const judgeGateNames: string[] = []
  for (const [name, gate] of Object.entries(charter.gates ?? {})) {
    if (gate.kind === 'judge') {
      judgeGateNames.push(name)
      if (!charter.seats?.judge) {
        errs.push(`gate[${name}] is a judge gate but no judge seat is declared`)
      }
      for (const evidence of gate.evidence) {
        const pathErr = relativePathError(evidence)
        if (pathErr) errs.push(`gate[${name}].evidence '${evidence}' ${pathErr}`)
      }
    }
    if (gate.kind === 'schema' && gate.files.length === 0) {
      errs.push(`gate[${name}] declares no files`)
    }
    if (gate.kind === 'schema') {
      for (const file of gate.files) {
        const pathErr = relativePathError(file)
        if (pathErr) errs.push(`gate[${name}].files '${file}' ${pathErr}`)
      }
    }
  }
  if (judgeGateNames.length > 1) {
    errs.push(
      `only ONE judge gate is supported (the kernel reads the first it finds) — ` +
      `declared: ${judgeGateNames.join(', ')}. Merge the evidence lists into a single gate.`,
    )
  }

  // Write scope hygiene (D8 + v1 postmortem).
  for (const scope of charter.writeScope ?? []) {
    if (META_AGENT_RE.test(scope)) errs.push(`writeScope '${scope}' is under .meta-agent/ (merge-excluded)`)
    try {
      writeScopeRoot(scope)
    } catch (err) {
      errs.push(`writeScope '${scope}' cannot be enforced safely: ${(err as Error).message}`)
    }
  }

  // Budgets sanity.
  const perRound = charter.budgets?.perRound
  if (perRound?.usd !== undefined && (!Number.isFinite(perRound.usd) || perRound.usd <= 0)) {
    errs.push('budgets.perRound.usd must be a positive number')
  }
  const life = charter.budgets?.lifetime
  if (life) {
    if (life.rounds !== undefined && (!Number.isInteger(life.rounds) || life.rounds < 1)) {
      errs.push('budgets.lifetime.rounds must be a positive integer')
    }
    if (life.usd !== undefined && (!Number.isFinite(life.usd) || life.usd <= 0)) {
      errs.push('budgets.lifetime.usd must be a positive number')
    }
    if (life.deadlineMs !== undefined && (!Number.isFinite(life.deadlineMs) || life.deadlineMs <= 0)) {
      errs.push('budgets.lifetime.deadlineMs must be a positive epoch-ms timestamp')
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

function validateTripwire(
  tw: TripwireSpec,
  index: number,
  declared: ReadonlySet<string>,
  meters: ReadonlySet<string>,
): string[] {
  const errs: string[] = []
  if (!tw.when?.trim()) { errs.push(`tripwire[${index}] needs a 'when' expression`); return errs }
  try {
    parse(tw.when, declared)
  } catch (err) {
    errs.push(`tripwire[${index}].when: ${(err as Error).message}`)
  }
  const t = tw.then as TripwireAction | undefined
  switch (t?.act) {
    case 'pivot':
      break
    case 'finalize':
      break
    case 'escalate': {
      if (typeof t.reason !== 'string' || !t.reason.trim()) {
        errs.push(`tripwire[${index}].then escalate needs a non-empty 'reason'`)
      }
      for (const name of t.onResume?.resetMeters ?? []) {
        if (!meters.has(name)) {
          errs.push(`tripwire[${index}].then.onResume.resetMeters references '${name}', which is not a declared meter`)
        }
      }
      break
    }
    default:
      errs.push(
        `tripwire[${index}].then must be {act:'pivot'} | {act:'finalize'} | {act:'escalate',reason} — ` +
        `got ${JSON.stringify(tw.then)}. (Pre-v3 {mode/escalate/stop} shapes are auto-migrated on create/load.)`,
      )
  }
  return errs
}

/** Parse every expression and attach ASTs — the instantiation-time freeze (D9).
 * Pre-v3 tripwire actions are migrated here, so a frozen charter always carries
 * the v3 discriminated union (the kernel never sees the legacy shape). */
export function freezeCharter(rawCharter: Charter): FrozenCharter {
  const errs = validateCharter(rawCharter)
  if (errs.length > 0) {
    throw new Error(`charter failed validation:\n- ${errs.join('\n- ')}`)
  }
  const charter = normalizeCharter(rawCharter)
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
      ...(charter.health ? { healthAst: parse(charter.health.staleWhen, declared) } : {}),
      declaredIdentifiers: [...declared].sort(),
      frozenAt: Date.now(),
    },
  }
}
