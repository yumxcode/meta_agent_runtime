import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { TRAJECTORY_ITEM_FIXTURES } from '../fixtures.js'
import { trajectoryJsonSchema, trajectorySchemaFingerprint } from '../schema.js'
import {
  TRAJECTORY_ITEM_SCHEMA_VERSION,
  TRAJECTORY_LINE_SCHEMA_VERSION,
  TrajectoryLineSchema,
} from '../types.js'

describe('trajectory schema governance', () => {
  it('keeps a valid fixture for every item variant', () => {
    const trajectoryId = '00000000-0000-4000-8000-000000000001'
    const variants = new Set<string>()
    TRAJECTORY_ITEM_FIXTURES.forEach((item, index) => {
      variants.add(item.type)
      expect(TrajectoryLineSchema.safeParse({
        schemaVersion: TRAJECTORY_LINE_SCHEMA_VERSION,
        ts: index + 1,
        ordinal: index + 1,
        trajectoryId,
        item,
      }).success, item.type).toBe(true)
    })
    expect(variants.size).toBe(15)
  })

  it('publishes envelope and item versions in JSON Schema', () => {
    const schema = trajectoryJsonSchema()
    expect(schema.lineVersion).toBe(TRAJECTORY_LINE_SCHEMA_VERSION)
    expect(schema.itemVersion).toBe(TRAJECTORY_ITEM_SCHEMA_VERSION)
    expect(schema.envelope).toHaveProperty('properties')
    expect(schema.item).toHaveProperty('oneOf')
  })

  it('matches the frozen schema fingerprint', () => {
    // Moved for item schema 1.3.0: run_started gained an optional `gitBase`
    // (G1-1). Additive, and only ever present on lines written after it — the
    // field is what finally makes a run's starting point recoverable, which
    // every EvalCase depends on.
    const hash = createHash('sha256').update(trajectorySchemaFingerprint()).digest('hex').slice(0, 16)
    expect(hash).toBe('55adba39f62b05fa')
  })
})
