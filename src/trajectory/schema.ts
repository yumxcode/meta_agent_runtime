import { z } from 'zod'
import {
  TRAJECTORY_ITEM_SCHEMA_VERSION,
  TRAJECTORY_LINE_SCHEMA_VERSION,
  TrajectoryItemSchema,
  TrajectoryLineSchema,
} from './types.js'

export interface TrajectoryJsonSchema {
  $schema: string
  $id: string
  title: string
  lineVersion: string
  itemVersion: string
  envelope: Record<string, unknown>
  item: Record<string, unknown>
}

export function trajectoryJsonSchema(): TrajectoryJsonSchema {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `https://meta-agent.dev/schemas/trajectory/${TRAJECTORY_LINE_SCHEMA_VERSION}.json`,
    title: 'MetaAgentTrajectory',
    lineVersion: TRAJECTORY_LINE_SCHEMA_VERSION,
    itemVersion: TRAJECTORY_ITEM_SCHEMA_VERSION,
    envelope: withoutDialect(z.toJSONSchema(TrajectoryLineSchema, schemaOptions)),
    item: withoutDialect(z.toJSONSchema(TrajectoryItemSchema, schemaOptions)),
  }
}

export function trajectorySchemaFingerprint(): string {
  const doc = trajectoryJsonSchema()
  return stableStringify({ envelope: doc.envelope, item: doc.item })
}

const schemaOptions = { io: 'output', unrepresentable: 'any' } as const

function withoutDialect(value: unknown): Record<string, unknown> {
  const { $schema: _dialect, ...schema } = value as Record<string, unknown>
  return schema
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`).join(',')}}`
}
