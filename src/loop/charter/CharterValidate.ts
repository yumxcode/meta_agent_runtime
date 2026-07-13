/**
 * CharterValidate — create-time gate (spec C2). A charter that passes here can
 * be frozen and run; one that fails never touches a workspace. Errors are
 * written to be instructive (they feed the distiller's retry loop, mirroring
 * the planner-error feedback pattern that proved out in v1).
 */
import { collectRefs, parse, type Ast } from '../expr/Expr.js'
import { relativePathError, writeScopeRoot } from '../security/PathSafety.js'
import { PRODUCER_OK_OBSERVABLE } from './CharterTypes.js'
import { buildExecutionPlan, validateExecutionPlan } from './ExecutionPlan.js'
import { DEFAULT_SCENARIO_ID, scenarioDefinition } from '../scenarios/ScenarioDefinitions.js'
import { freezeEffectBindings, validateEffectBindings } from '../effects/EffectRules.js'
import type {
  ArtifactSpec,
  Charter,
  FrozenCharter,
  LegacyTripwireAction,
  MeterSpec,
  ObservableObligation,
  ProjectionBinding,
  EffectBinding,
  ShapeSpec,
  TripwireAction,
  TripwireSpec,
} from './CharterTypes.js'

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
      ? {
          ...tw,
          then: normalizeTripwireAction(tw.then as TripwireAction | LegacyTripwireAction),
          onAbsent: tw.onAbsent === undefined ? 'false' : tw.onAbsent,
          onError: tw.onError === undefined ? 'false' : tw.onError,
        }
      : tw,
  )
  return {
    ...charter,
    tripwires,
    ...(charter.metric
      ? {
          metric: {
            ...charter.metric,
            onAbsent: charter.metric.onAbsent === undefined ? 'skip_update' : charter.metric.onAbsent,
            onError: charter.metric.onError === undefined ? 'skip_update' : charter.metric.onError,
            onNull: charter.metric.onNull === undefined ? 'skip_update' : charter.metric.onNull,
          },
        }
      : {}),
    ...(charter.health
      ? {
          health: {
            ...charter.health,
            onAbsent: charter.health.onAbsent === undefined ? 'false' : charter.health.onAbsent,
            onError: charter.health.onError === undefined ? 'false' : charter.health.onError,
          },
        }
      : {}),
  }
}

export function validateCharter(rawCharter: Charter): string[] {
  const errs: string[] = []
  if (!rawCharter || typeof rawCharter !== 'object') return ['charter must be an object']
  const normalized = normalizeCharter(rawCharter)
  const rawBindings = (normalized as { gateBindings?: unknown }).gateBindings
  const rawArtifacts = (normalized as { artifacts?: unknown }).artifacts
  const rawProjections = (normalized as { projections?: unknown }).projections
  const rawEffects = (normalized as { effects?: unknown }).effects
  if (rawBindings !== undefined && !Array.isArray(rawBindings)) {
    errs.push('gateBindings must be an array')
  }
  if (rawArtifacts !== undefined &&
      (typeof rawArtifacts !== 'object' || rawArtifacts === null || Array.isArray(rawArtifacts))) {
    errs.push('artifacts must be an object map')
  }
  if (rawProjections !== undefined && !Array.isArray(rawProjections)) {
    errs.push('projections must be an array')
  }
  errs.push(...validateEffectBindings(rawEffects))
  const safeNormalized: Charter = {
    ...normalized,
    gateBindings: Array.isArray(rawBindings) ? rawBindings as FrozenCharter['gateBindings'] : undefined,
    artifacts: typeof rawArtifacts === 'object' && rawArtifacts !== null && !Array.isArray(rawArtifacts)
      ? rawArtifacts as Record<string, ArtifactSpec>
      : undefined,
    projections: Array.isArray(rawProjections) ? rawProjections as ProjectionBinding[] : undefined,
    effects: typeof rawEffects === 'object' && rawEffects !== null && !Array.isArray(rawEffects)
      ? rawEffects as Record<string, EffectBinding>
      : undefined,
  }
  const scenarioId = safeNormalized.scenario ?? DEFAULT_SCENARIO_ID
  const definition = scenarioDefinition(scenarioId)
  if (!definition) errs.push(`scenario '${scenarioId}' is not registered`)
  const executionPlan = buildExecutionPlan({ ...safeNormalized, scenario: scenarioId })
  const charter: Charter = {
    ...safeNormalized,
    scenario: scenarioId,
    artifacts: normalized.artifacts ?? definition?.artifacts(normalized) ?? {},
    gateBindings: executionPlan.gates,
  }
  charter.projections = safeNormalized.projections ?? defaultProjectionBindings(charter)
  if (!charter.id || !ID_RE.test(charter.id)) errs.push('charter.id must match [a-z][a-z0-9_-]*')
  if (!Number.isInteger(charter.version) || charter.version < 1) errs.push('charter.version must be a positive integer')
  if (!charter.goal?.trim()) errs.push('charter.goal is required')
  if (charter.metric && charter.metric.direction !== 'max' && charter.metric.direction !== 'min') {
    errs.push("metric.direction must be 'max' or 'min'")
  }
  if (charter.metric) errs.push(...validateObjectivePolicies(charter.metric, 'metric'))

  // Declared identifier universe for the DSL static check.
  const declared = new Set<string>(['budget.lifetime.exhausted'])
  const obsNames = new Set<string>()
  for (const o of charter.observables ?? []) {
    if (!o.name) { errs.push('observable needs a name'); continue }
    if (o.name === PRODUCER_OK_OBSERVABLE) {
      errs.push(`observable name '${PRODUCER_OK_OBSERVABLE}' is reserved by the kernel and cannot be declared`)
    }
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
    errs.push(...validateObservationPolicies(charter.health, 'health'))
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
      if (!gate.spec) errs.push(`gate[${name}] schema gate requires a versioned spec (legacy parse-only gates may only be loaded, not newly frozen)`)
      else errs.push(...validateShapeSpec(gate.spec, `gate[${name}].spec`))
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

  errs.push(...validateGenericBindings(
    charter,
    definition?.gateBindings.map(binding => binding.id) ?? [],
    Object.keys(definition?.artifacts(charter) ?? {}),
    definition?.artifactGateIds ?? [],
    definition?.mandatoryArtifactGateIds ?? [],
    definition?.allowAdditionalArtifacts ?? false,
  ))
  errs.push(...validateProjectionBindings(charter))

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

function validateShapeSpec(spec: ShapeSpec, at: string): string[] {
  const errs: string[] = []
  if (!spec || typeof spec !== 'object' || typeof (spec as { type?: unknown }).type !== 'string') {
    return [`${at} must declare a type`]
  }
  const common = new Set(['type'])
  const allowedByType: Record<string, string[]> = {
    object: ['required', 'properties', 'additionalProperties'],
    array: ['minItems', 'items'],
    string: ['minLength', 'enum'],
    number: ['minimum', 'maximum'],
    integer: ['minimum', 'maximum'],
    boolean: [],
    null: [],
  }
  const allowed = new Set([...common, ...(allowedByType[spec.type] ?? [])])
  for (const key of Object.keys(spec)) if (!allowed.has(key)) errs.push(`${at}.${key} is not supported`)
  switch (spec.type) {
    case 'object': {
      if (spec.required && (!Array.isArray(spec.required) || spec.required.some(k => typeof k !== 'string' || !k))) {
        errs.push(`${at}.required must contain non-empty strings`)
      }
      for (const [key, child] of Object.entries(spec.properties ?? {})) {
        errs.push(...validateShapeSpec(child, `${at}.properties.${key}`))
      }
      break
    }
    case 'array':
      if (spec.minItems !== undefined && (!Number.isInteger(spec.minItems) || spec.minItems < 0)) {
        errs.push(`${at}.minItems must be a non-negative integer`)
      }
      if (spec.items) errs.push(...validateShapeSpec(spec.items, `${at}.items`))
      break
    case 'string':
      if (spec.minLength !== undefined && (!Number.isInteger(spec.minLength) || spec.minLength < 0)) {
        errs.push(`${at}.minLength must be a non-negative integer`)
      }
      break
    case 'number':
    case 'integer':
      if (spec.minimum !== undefined && !Number.isFinite(spec.minimum)) errs.push(`${at}.minimum must be finite`)
      if (spec.maximum !== undefined && !Number.isFinite(spec.maximum)) errs.push(`${at}.maximum must be finite`)
      if (spec.minimum !== undefined && spec.maximum !== undefined && spec.minimum > spec.maximum) {
        errs.push(`${at}.minimum must not exceed maximum`)
      }
      break
    case 'boolean':
    case 'null':
      break
    default:
      errs.push(`${at}.type is unsupported`)
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
  errs.push(...validateObservationPolicies(tw, `tripwire[${index}]`))
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

function validateObservationPolicies(
  rule: { onAbsent?: unknown; onError?: unknown },
  at: string,
): string[] {
  const allowed = new Set(['skip', 'false', 'fail_stop'])
  const errs: string[] = []
  if (!allowed.has(String(rule.onAbsent))) {
    errs.push(`${at}.onAbsent must be 'skip' | 'false' | 'fail_stop'`)
  }
  if (!allowed.has(String(rule.onError))) {
    errs.push(`${at}.onError must be 'skip' | 'false' | 'fail_stop'`)
  }
  return errs
}

function validateObjectivePolicies(
  objective: { onAbsent?: unknown; onError?: unknown; onNull?: unknown },
  at: string,
): string[] {
  const allowed = new Set(['skip_update', 'fail_stop'])
  const errs: string[] = []
  for (const field of ['onAbsent', 'onError', 'onNull'] as const) {
    if (!allowed.has(String(objective[field]))) {
      errs.push(`${at}.${field} must be 'skip_update' | 'fail_stop'`)
    }
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
  const normalized = normalizeCharter(rawCharter)
  const scenario = normalized.scenario ?? DEFAULT_SCENARIO_ID
  const definition = scenarioDefinition(scenario)!
  const initialPlan = buildExecutionPlan({ ...normalized, scenario })
  const baseArtifacts = normalized.artifacts ?? definition.artifacts(normalized)
  const charter: Charter & Required<Pick<Charter, 'scenario' | 'artifacts' | 'gateBindings' | 'projections' | 'effects'>> = {
    ...normalized,
    scenario,
    artifacts: baseArtifacts,
    gateBindings: initialPlan.gates,
    projections: normalized.projections ?? defaultProjectionBindings({
      ...normalized, scenario, artifacts: baseArtifacts,
    }),
    effects: normalized.effects ?? {},
  }
  const declared = new Set<string>(['budget.lifetime.exhausted'])
  for (const o of charter.observables) declared.add(o.name)
  for (const m of charter.meters) declared.add(m.name)
  const judgeObservables = new Set(
    charter.observables
      .filter(o => o.source.from === 'judge')
      .map(o => o.name),
  )

  const meterAsts: Record<string, { incWhen?: Ast; resetWhen?: Ast }> = {}
  for (const m of charter.meters) {
    const incWhen = m.incWhen ? parse(m.incWhen, declared) : undefined
    meterAsts[m.name] = {
      ...(incWhen ? { incWhen: withProducerOkForMissingJudge(incWhen, judgeObservables) } : {}),
      ...(m.resetWhen ? { resetWhen: parse(m.resetWhen, declared) } : {}),
    }
  }
  const tripwireAsts = charter.tripwires.map(tw => parse(tw.when, declared))
  const healthAst = charter.health ? parse(charter.health.staleWhen, declared) : undefined
  const observableObligations = buildObservableObligations(
    charter,
    meterAsts,
    tripwireAsts,
    healthAst,
  )
  const executionPlan = buildExecutionPlan(charter)
  const executionPlanErrors = validateExecutionPlan(executionPlan)
  if (executionPlanErrors.length > 0) {
    throw new Error(`execution plan failed validation:\n- ${executionPlanErrors.join('\n- ')}`)
  }
  return {
    ...charter,
    effects: freezeEffectBindings(charter.effects),
    frozen: {
      meterAsts,
      tripwireAsts,
      ...(healthAst ? { healthAst } : {}),
      declaredIdentifiers: [...declared, PRODUCER_OK_OBSERVABLE].sort(),
      observableObligations,
      executionPlan,
      frozenAt: Date.now(),
    },
  }
}

/**
 * Upgrade derived runtime data from an older frozen snapshot without mutating
 * the on-disk charter or its recorded hash. This is deliberately idempotent:
 * current snapshots already containing producer_ok remain byte-equivalent in
 * meaning, while pre-G0 snapshots receive the same AST compatibility rewrite
 * in memory when resumed.
 */
export function normalizeFrozenCharterForRuntime(raw: FrozenCharter): FrozenCharter {
  const normalized = normalizeCharter(raw)
  const scenario = normalized.scenario ?? DEFAULT_SCENARIO_ID
  const definition = scenarioDefinition(scenario)
  if (!definition) throw new Error(`frozen charter references unregistered scenario '${scenario}'`)
  const initialPlan = buildExecutionPlan({ ...normalized, scenario })
  const charter: FrozenCharter = {
    ...normalized,
    scenario,
    artifacts: normalized.artifacts ?? definition.artifacts(normalized),
    gateBindings: normalized.gateBindings ?? initialPlan.gates,
    projections: normalized.projections ?? defaultProjectionBindings({
      ...normalized,
      scenario,
      artifacts: normalized.artifacts ?? definition.artifacts(normalized),
    }),
    effects: Object.fromEntries(Object.entries(normalized.effects ?? {}).map(([id, binding]) => [
      id,
      'frozen' in binding ? binding : freezeEffectBindings({ [id]: binding })[id]!,
    ])),
  }
  const judgeObservables = new Set(
    charter.observables
      .filter(o => o.source.from === 'judge')
      .map(o => o.name),
  )
  const meterAsts = Object.fromEntries(
    Object.entries(charter.frozen.meterAsts).map(([name, asts]) => [
      name,
      {
        ...asts,
        ...(asts.incWhen
          ? { incWhen: withProducerOkForMissingJudge(asts.incWhen, judgeObservables) }
          : {}),
      },
    ]),
  )
  const observableObligations = buildObservableObligations(
    charter,
    meterAsts,
    charter.frozen.tripwireAsts,
    charter.frozen.healthAst,
  )
  const executionPlan = buildExecutionPlan(charter)
  return {
    ...charter,
    frozen: {
      ...charter.frozen,
      meterAsts,
      observableObligations,
      executionPlan,
      declaredIdentifiers: [
        ...new Set([...charter.frozen.declaredIdentifiers, PRODUCER_OK_OBSERVABLE]),
      ].sort(),
    },
  }
}

function defaultProjectionBindings(charter: Charter): ProjectionBinding[] {
  if (charter.scenario === DEFAULT_SCENARIO_ID) return []
  return Object.values(charter.artifacts ?? {})
    .filter((artifact): artifact is ArtifactSpec => !!artifact && typeof artifact === 'object')
    .map(artifact => ({
    id: `artifact-${artifact.id}`,
    source: { kind: 'artifact_stream' as const, stream: artifact.stream },
    reducer: 'builtin/artifact-view@1' as const,
    mode: artifact.commitMode === 'replace' || artifact.commitMode === 'versioned'
      ? 'latest' as const
      : 'window' as const,
    ...(artifact.commitMode === 'append' ? { maxItems: 100 } : {}),
    }))
}

function validateProjectionBindings(charter: Charter): string[] {
  const errs: string[] = []
  const streams = new Set(Object.values(charter.artifacts ?? {})
    .filter((artifact): artifact is ArtifactSpec => !!artifact && typeof artifact === 'object')
    .map(artifact => artifact.stream))
  const ids = new Set<string>()
  for (const [index, binding] of (charter.projections ?? []).entries()) {
    const at = `projections[${index}]`
    if (!binding || typeof binding !== 'object') { errs.push(`${at} must be an object`); continue }
    if (!binding.id?.trim()) errs.push(`${at}.id is required`)
    if (ids.has(binding.id)) errs.push(`${at}.id '${binding.id}' is duplicated`)
    ids.add(binding.id)
    if (binding.source?.kind !== 'artifact_stream' || !streams.has(binding.source.stream)) {
      errs.push(`${at}.source must reference a declared Artifact stream`)
    }
    if (binding.reducer !== 'builtin/artifact-view@1') errs.push(`${at}.reducer is unsupported`)
    if (!['count', 'latest', 'window'].includes(binding.mode)) errs.push(`${at}.mode is unsupported`)
    if (binding.mode === 'window') {
      if (!Number.isInteger(binding.maxItems) || (binding.maxItems ?? 0) < 1 || (binding.maxItems ?? 0) > 10_000) {
        errs.push(`${at}.maxItems must be an integer in 1..10000 for window mode`)
      }
    } else if (binding.maxItems !== undefined) {
      errs.push(`${at}.maxItems is only valid for window mode`)
    }
  }
  return errs
}

function validateGenericBindings(
  charter: Charter,
  scenarioGateIds: readonly string[],
  requiredArtifactIds: readonly string[],
  supportedArtifactGateIds: readonly string[],
  mandatoryArtifactGateIds: readonly string[],
  allowAdditionalArtifacts: boolean,
): string[] {
  const errs: string[] = []
  const bindings = charter.gateBindings ?? []
  errs.push(...validateExecutionPlan(buildExecutionPlan(charter)))
  const bindingIds = new Set(bindings.map(binding => binding.id))
  for (const required of ['producer', 'wait_contract']) {
    if (!bindingIds.has(required)) errs.push(`gateBindings must include kernel binding '${required}'`)
  }
  if (Object.values(charter.gates ?? {}).some(gate => gate.kind === 'schema') && !bindingIds.has('schema')) {
    errs.push("gateBindings must include 'schema' when schema gates are declared")
  }
  if (charter.seats?.judge && !bindingIds.has('judge')) {
    errs.push("gateBindings must include 'judge' when seats.judge is declared")
  }
  const declaredGateIds = new Set(Object.keys(charter.gates ?? {}))
  const schemaGateIds = Object.entries(charter.gates ?? {})
    .filter(([, gate]) => gate.kind === 'schema').map(([id]) => id)
  const judgeGateIds = Object.entries(charter.gates ?? {})
    .filter(([, gate]) => gate.kind === 'judge').map(([id]) => id)
  const supportedScenarioGates = new Set(scenarioGateIds)
  for (const [index, binding] of bindings.entries()) {
    if (!binding.id?.trim()) errs.push(`gateBindings[${index}].id is required`)
    for (const gateId of binding.gateIds) {
      if (!declaredGateIds.has(gateId)) {
        errs.push(`gateBindings[${index}].gateIds references undeclared charter gate '${gateId}'`)
      } else {
        const gate = charter.gates[gateId]!
        if (binding.kind === 'shape' && gate.kind !== 'schema') {
          errs.push(`gateBindings[${index}] shape binding references non-schema gate '${gateId}'`)
        }
        if (binding.kind === 'judge' && gate.kind !== 'judge') {
          errs.push(`gateBindings[${index}] judge binding references non-judge gate '${gateId}'`)
        }
      }
    }
    if (binding.handler === 'scenario' && !supportedScenarioGates.has(binding.id)) {
      errs.push(`scenario '${charter.scenario}' does not provide Gate '${binding.id}'`)
    }
    if (binding.handler === 'kernel' &&
        !['producer', 'wait_contract', 'schema', 'judge'].includes(binding.id)) {
      errs.push(`kernel does not provide Gate '${binding.id}'`)
    }
    if (['producer', 'wait_contract', 'schema', 'judge'].includes(binding.id) && binding.handler !== 'kernel') {
      errs.push(`gateBindings[${index}] '${binding.id}' must use the kernel handler`)
    }
  }
  const schemaBinding = bindings.find(binding => binding.id === 'schema')
  if (schemaBinding && !sameStringSet(schemaBinding.gateIds, schemaGateIds)) {
    errs.push("gateBindings 'schema' must bind every declared schema gate exactly once")
  }
  const judgeBinding = bindings.find(binding => binding.id === 'judge')
  if (judgeBinding && !sameStringSet(judgeBinding.gateIds, judgeGateIds)) {
    errs.push("gateBindings 'judge' must bind every declared judge gate exactly once")
  }
  for (const artifactId of requiredArtifactIds) {
    if (!charter.artifacts?.[artifactId]) {
      errs.push(`scenario '${charter.scenario}' requires ArtifactSpec '${artifactId}'`)
    }
  }
  for (const [key, artifact] of Object.entries(charter.artifacts ?? {})) {
    if (!allowAdditionalArtifacts && !requiredArtifactIds.includes(key)) {
      errs.push(`scenario '${charter.scenario}' does not provide Artifact '${key}'`)
    }
    errs.push(...validateArtifactSpec(
      key,
      artifact,
      bindingIds,
      new Set(supportedArtifactGateIds),
      mandatoryArtifactGateIds,
    ))
  }
  const streamModes = new Map<string, string>()
  for (const artifact of Object.values(charter.artifacts ?? {})) {
    if (!artifact?.stream) continue
    const prior = streamModes.get(artifact.stream)
    if (prior && prior !== artifact.commitMode) {
      errs.push(
        `Artifact stream '${artifact.stream}' mixes commitMode '${prior}' and '${artifact.commitMode}'`,
      )
    } else {
      streamModes.set(artifact.stream, artifact.commitMode)
    }
  }
  return errs
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && new Set(left).size === left.length &&
    left.every(value => right.includes(value))
}

function validateArtifactSpec(
  key: string,
  artifact: ArtifactSpec,
  bindingIds: ReadonlySet<string>,
  supportedGateIds: ReadonlySet<string>,
  mandatoryGateIds: readonly string[],
): string[] {
  const errs: string[] = []
  const at = `artifacts.${key}`
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
    return [`${at} must be an object`]
  }
  if (artifact.id !== key) errs.push(`${at}.id must equal its map key '${key}'`)
  if (!artifact.stream?.trim()) errs.push(`${at}.stream is required`)
  const pathErr = relativePathError(artifact.draftPath)
  if (pathErr) errs.push(`${at}.draftPath '${artifact.draftPath}' ${pathErr}`)
  if (!artifact.draftPath.startsWith('drafts/')) {
    errs.push(`${at}.draftPath must be under 'drafts/'`)
  }
  if (!['json', 'text', 'workspace_diff', 'external_ref'].includes(artifact.kind)) {
    errs.push(`${at}.kind is unsupported`)
  }
  if (!['append', 'replace', 'versioned'].includes(artifact.commitMode)) {
    errs.push(`${at}.commitMode is unsupported`)
  }
  const seen = new Set<string>()
  for (const gateId of artifact.requiredGates ?? []) {
    if (seen.has(gateId)) errs.push(`${at}.requiredGates contains duplicate '${gateId}'`)
    seen.add(gateId)
    if (!bindingIds.has(gateId)) errs.push(`${at}.requiredGates references missing binding '${gateId}'`)
    if (!supportedGateIds.has(gateId)) {
      errs.push(`scenario Artifact executor does not support Gate '${gateId}' for ${at}`)
    }
  }
  for (const gateId of mandatoryGateIds) {
    if (!seen.has(gateId)) errs.push(`${at}.requiredGates must include '${gateId}'`)
  }
  return errs
}

function buildObservableObligations(
  charter: Charter,
  meterAsts: Record<string, { incWhen?: Ast; resetWhen?: Ast }>,
  tripwireAsts: Ast[],
  healthAst: Ast | undefined,
): Record<string, ObservableObligation> {
  const obligations: Record<string, ObservableObligation> = {
    [PRODUCER_OK_OBSERVABLE]: {
      source: 'kernel',
      outputKey: PRODUCER_OK_OBSERVABLE,
      consumers: [],
    },
    '@objective.metric': {
      source: 'judge',
      outputKey: 'metric',
      consumers: [{ kind: 'objective', id: 'metric', field: 'source' }],
    },
  }
  for (const observable of charter.observables) {
    obligations[observable.name] = {
      source: 'judge',
      outputKey: observable.source.key,
      consumers: [],
    }
  }
  const add = (ast: Ast | undefined, consumer: ObservableObligation['consumers'][number]): void => {
    if (!ast) return
    for (const ref of collectRefs(ast)) {
      const obligation = obligations[ref]
      if (obligation) obligation.consumers.push(consumer)
    }
  }
  for (const [meter, asts] of Object.entries(meterAsts)) {
    add(asts.incWhen, { kind: 'meter', id: meter, field: 'incWhen' })
    add(asts.resetWhen, { kind: 'meter', id: meter, field: 'resetWhen' })
  }
  tripwireAsts.forEach((ast, index) => {
    add(ast, { kind: 'tripwire', id: String(index), field: 'when' })
  })
  add(healthAst, { kind: 'health', id: 'health', field: 'staleWhen' })
  return obligations
}

/**
 * Legacy meter compatibility without a context-sensitive runtime fallback.
 *
 * Historically an incWhen evaluation error incremented only when the producer
 * failed. Such errors normally came from absent judge observables because the
 * judge never ran. Encode that dependency in the frozen AST so evaluation can
 * use one explicit retain-on-error policy. Meter-only expressions are left
 * untouched: a failed producer must not make `iteration > 3` become true.
 */
function withProducerOkForMissingJudge(
  ast: Ast,
  judgeObservables: ReadonlySet<string>,
): Ast {
  const refs = collectRefs(ast)
  if (refs.includes(PRODUCER_OK_OBSERVABLE)) return ast
  if (!refs.some(ref => judgeObservables.has(ref))) return ast
  return {
    kind: 'binary',
    op: '||',
    left: {
      kind: 'binary',
      op: '==',
      left: { kind: 'ref', name: PRODUCER_OK_OBSERVABLE },
      right: { kind: 'lit', value: false },
    },
    right: ast,
  }
}
