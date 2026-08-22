import type { TrajectoryItem } from './types.js'

export interface TrajectoryPersistencePolicy {
  /** Audit facts enabled by default. Reserved for centrally-governed opt-outs. */
  persistAuditFacts: boolean
}

export const DEFAULT_TRAJECTORY_PERSISTENCE_POLICY: TrajectoryPersistencePolicy = {
  persistAuditFacts: true,
}

/**
 * The single persistence-policy locus. Modes decide which facts they emit, but
 * never implement their own filtering rules. Streaming deltas and raw thinking
 * are absent from TrajectoryItem entirely; privacy sanitization runs next.
 */
export function shouldPersistTrajectoryItem(
  item: TrajectoryItem,
  policy: TrajectoryPersistencePolicy = DEFAULT_TRAJECTORY_PERSISTENCE_POLICY,
): boolean {
  // Identity is required even under a future reduced-audit policy.
  if (item.type === 'trajectory_meta') return true
  return policy.persistAuditFacts
}
