import { join } from 'path'
import type { InstancePaths } from '../../types.js'

/** Pre-v4 compatibility projections owned exclusively by Research Scenario. */
export function researchPaths(paths: Pick<InstancePaths, 'ledgerDir'>): {
  findingsJsonl: string
  directionsJson: string
  projectionIndexJson: string
} {
  return {
    findingsJsonl: join(paths.ledgerDir, 'findings.jsonl'),
    directionsJson: join(paths.ledgerDir, 'directions.json'),
    projectionIndexJson: join(paths.ledgerDir, 'research.projection.json'),
  }
}
