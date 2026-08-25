/**
 * Risk tiering (implementation plan §10.1).
 *
 * The error this exists to prevent: judging risk by what an artifact *is*
 * rather than what it can *reach*. A prompt is text, so it reads as harmless —
 * but a prompt injected into an agent holding write tools, network access and
 * approval authority can change real side effects. Text is not a risk class.
 *
 * Risk is computed from four inputs:
 *
 *   effective capability — what the affected agent can actually do
 *   data scope          — whose data is in reach
 *   reversibility       — can the change be undone
 *   blast radius        — how many sessions/workspaces are exposed
 */

/** Ordered by how much damage the affected agent can do. */
export const EFFECTIVE_CAPABILITIES = [
  'read_only',
  'sandbox_write',
  'workspace_write',
  'external_side_effect',
] as const

export type EffectiveCapability = (typeof EFFECTIVE_CAPABILITIES)[number]

export const DATA_SCOPES = ['synthetic', 'single_workspace', 'cross_workspace'] as const
export type DataScope = (typeof DATA_SCOPES)[number]

export const REVERSIBILITY = ['instant', 'bounded', 'irreversible'] as const
export type Reversibility = (typeof REVERSIBILITY)[number]

export const BLAST_RADII = ['shadow', 'single_session', 'workspace', 'fleet'] as const
export type BlastRadius = (typeof BLAST_RADII)[number]

export type RiskTier = 'R1' | 'R2' | 'R3'

export interface RiskInputs {
  effectiveCapability: EffectiveCapability
  dataScope: DataScope
  reversibility: Reversibility
  blastRadius: BlastRadius
}

export interface RiskAssessment {
  tier: RiskTier
  /** Which inputs forced the tier — an operator should not have to guess. */
  drivers: string[]
}

/**
 * R1 is deliberately narrow: shadow runs, read-only workers, or execution in a
 * sandbox with no external side effects. Everything that can touch a real
 * workspace starts at R2.
 */
export function assessRisk(inputs: RiskInputs): RiskAssessment {
  const drivers: string[] = []
  let tier: RiskTier = 'R1'

  const raise = (to: RiskTier, driver: string): void => {
    drivers.push(driver)
    if (to === 'R3' || (to === 'R2' && tier === 'R1')) tier = to
  }

  if (inputs.effectiveCapability === 'workspace_write') {
    raise('R2', 'affected agent can write the real workspace')
  }
  if (inputs.effectiveCapability === 'external_side_effect') {
    raise('R3', 'affected agent can cause external side effects')
  }
  if (inputs.dataScope === 'cross_workspace') {
    raise('R3', 'reaches data across workspace boundaries')
  }
  if (inputs.reversibility === 'bounded') {
    raise('R2', 'change is reversible only within a bounded window')
  }
  if (inputs.reversibility === 'irreversible') {
    raise('R3', 'change cannot be undone')
  }
  if (inputs.blastRadius === 'workspace') {
    raise('R2', 'exposure spans a whole workspace')
  }
  if (inputs.blastRadius === 'fleet') {
    raise('R3', 'exposure spans the fleet')
  }

  if (drivers.length === 0) drivers.push('shadow or sandboxed, read-only, instantly reversible')
  return { tier, drivers }
}

/**
 * Guard for the specific mistake named in P1-5.
 *
 * Injected context is not R1 just because it is text. If the receiving agent
 * has any capability beyond read-only, or the exposure is not shadow, the
 * candidate is at least R2.
 */
export function assertInjectionRiskTier(
  declaredTier: RiskTier,
  inputs: RiskInputs,
): void {
  const assessed = assessRisk(inputs)
  const order: RiskTier[] = ['R1', 'R2', 'R3']
  if (order.indexOf(declaredTier) < order.indexOf(assessed.tier)) {
    throw new Error(
      `declared risk ${declaredTier} is below the assessed ${assessed.tier}: ${assessed.drivers.join('; ')}. ` +
      'Injected context is not low risk because it is text — risk follows what the receiving agent can reach.',
    )
  }
}

/** R1 candidates may skip sealed test and go straight to shadow evaluation. */
export function isShadowEligible(inputs: RiskInputs): boolean {
  return assessRisk(inputs).tier === 'R1'
}
