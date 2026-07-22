export interface GraphSoakSnapshot {
  status: string
  activationCount: number
  liveActivations: number
  journalSequence?: number
  checkpointBytes?: number
}

export interface GraphSoakDriver<TTick = unknown> {
  tick(now: number, step: number): Promise<TTick>
  snapshot(): Promise<GraphSoakSnapshot>
  restart?(): Promise<void>
}

export type GraphChaosAction = 'restart-before-tick' | 'restart-after-tick' | 'skip-tick'

export interface GraphChaosContext<TTick = unknown> {
  step: number
  now: number
  phase: 'before' | 'after'
  tickResult?: TTick
  snapshot?: GraphSoakSnapshot
}

export interface GraphChaosRule<TTick = unknown> {
  id: string
  when(context: GraphChaosContext<TTick>): boolean | Promise<boolean>
  action: GraphChaosAction
}

export interface GraphSoakInvariantContext<TTick = unknown> {
  step: number
  now: number
  tickResult?: TTick
  snapshot: GraphSoakSnapshot
}

export interface GraphSoakOptions<TTick = unknown> {
  steps: number
  startAt?: number
  stepMs?: number
  stopStatuses?: string[]
  chaos?: GraphChaosRule<TTick>[]
  invariants?: Array<(context: GraphSoakInvariantContext<TTick>) => void | Promise<void>>
}

export interface GraphSoakReport {
  schemaVersion: 'graph-soak-report-1.0'
  stepsRequested: number
  stepsCompleted: number
  ticksExecuted: number
  restarts: number
  chaosApplied: Array<{ ruleId: string; action: GraphChaosAction; step: number }>
  maxLiveActivations: number
  maxCheckpointBytes?: number
  finalSnapshot: GraphSoakSnapshot
}

/**
 * Deterministic clock-driven soak/chaos orchestration. The driver owns all
 * Runtime details, which lets this harness test the real Kernel, a CLI runner,
 * or a storage migration without adding hooks to GraphKernel itself.
 */
export async function runGraphSoak<TTick>(driver: GraphSoakDriver<TTick>, options: GraphSoakOptions<TTick>): Promise<GraphSoakReport> {
  if (!Number.isInteger(options.steps) || options.steps < 1) throw new Error('graph soak steps must be a positive integer')
  const stepMs = options.stepMs ?? 1_000
  if (!Number.isFinite(stepMs) || stepMs <= 0) throw new Error('graph soak stepMs must be positive')
  const stopStatuses = new Set(options.stopStatuses ?? ['done', 'failed', 'exhausted'])
  const applied = new Set<string>()
  const chaosApplied: GraphSoakReport['chaosApplied'] = []
  let ticksExecuted = 0
  let restarts = 0
  let maxLiveActivations = 0
  let maxCheckpointBytes: number | undefined
  let finalSnapshot = await driver.snapshot()
  let stepsCompleted = 0

  for (let step = 0; step < options.steps; step++) {
    const now = (options.startAt ?? 0) + step * stepMs
    let skipTick = false
    for (const rule of options.chaos ?? []) {
      if (rule.action === 'restart-after-tick') continue
      const key = `${rule.id}:before:${step}`
      if (applied.has(key) || !(await rule.when({ step, now, phase: 'before', snapshot: finalSnapshot }))) continue
      applied.add(key)
      chaosApplied.push({ ruleId: rule.id, action: rule.action, step })
      if (rule.action === 'skip-tick') skipTick = true
      else if (rule.action === 'restart-before-tick') {
        if (!driver.restart) throw new Error(`chaos rule '${rule.id}' requires driver.restart`)
        await driver.restart(); restarts++
      }
    }
    const tickResult = skipTick ? undefined : await driver.tick(now, step)
    if (!skipTick) ticksExecuted++
    finalSnapshot = await driver.snapshot()
    for (const rule of options.chaos ?? []) {
      if (rule.action !== 'restart-after-tick') continue
      const key = `${rule.id}:after:${step}`
      if (applied.has(key) || !(await rule.when({ step, now, phase: 'after', tickResult, snapshot: finalSnapshot }))) continue
      applied.add(key)
      chaosApplied.push({ ruleId: rule.id, action: rule.action, step })
      if (rule.action === 'restart-after-tick') {
        if (!driver.restart) throw new Error(`chaos rule '${rule.id}' requires driver.restart`)
        await driver.restart(); restarts++
        finalSnapshot = await driver.snapshot()
      }
    }
    maxLiveActivations = Math.max(maxLiveActivations, finalSnapshot.liveActivations)
    if (finalSnapshot.checkpointBytes !== undefined) {
      maxCheckpointBytes = Math.max(maxCheckpointBytes ?? 0, finalSnapshot.checkpointBytes)
    }
    for (const invariant of options.invariants ?? []) await invariant({ step, now, tickResult, snapshot: finalSnapshot })
    stepsCompleted = step + 1
    if (stopStatuses.has(finalSnapshot.status)) break
  }

  return {
    schemaVersion: 'graph-soak-report-1.0',
    stepsRequested: options.steps,
    stepsCompleted,
    ticksExecuted,
    restarts,
    chaosApplied,
    maxLiveActivations,
    ...(maxCheckpointBytes !== undefined ? { maxCheckpointBytes } : {}),
    finalSnapshot,
  }
}
