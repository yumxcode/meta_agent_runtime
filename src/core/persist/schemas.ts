/**
 * Zod runtime schemas for the three most critical persistence types.
 *
 * Usage pattern (P2-A):
 *
 *   import { TeamStateSchema, EngineeringJobSchema, parseOrNull } from '../core/persist/schemas.js'
 *
 *   const raw = JSON.parse(text)
 *   const state = parseOrNull(TeamStateSchema, raw)
 *   if (!state) return null   // corrupt / migrated-away format
 *
 * Rationale: `JSON.parse(...) as T` gives TypeScript safety but zero runtime
 * protection.  These schemas catch field-level corruption (wrong types, missing
 * required fields) that a plain schemaVersion string-check misses.
 *
 * Kept intentionally minimal — partial schemas that validate the critical
 * structural invariants rather than every leaf field.  This keeps them easy
 * to maintain as types evolve.
 */

import { z } from 'zod'

// ── TeamState ─────────────────────────────────────────────────────────────────

export const TeamTaskStatusSchema = z.enum([
  'backlog', 'claimed', 'in_progress', 'blocked',
  'review', 'done', 'paused', 'handoff', 'cancelled',
])

export const TeamTaskSchema = z.object({
  id:               z.string(),
  title:            z.string(),
  status:           TeamTaskStatusSchema,
  module:           z.string().optional(),
  ownerUnit:        z.string().optional(),
  branch:           z.string().optional(),
  githubIssueNumber: z.number().optional(),
  githubIssueUrl:   z.string().optional(),
  paths:            z.array(z.string()),
  updatedAt:        z.string(),
})

export const TeamUnitSchema = z.object({
  id:          z.string(),
  human:       z.string().optional(),
  machine:     z.string(),
  status:      z.enum(['active', 'idle', 'offline']),
  currentTask: z.string().optional(),
  lastSeen:    z.string(),
})

export const TeamModuleSchema = z.object({
  name:             z.string(),
  ownerUnit:        z.string().optional(),
  paths:            z.array(z.string()),
  responsibilities: z.array(z.string()),
})

export const TeamStateSchema = z.object({
  schemaVersion: z.literal('1.0'),
  project:       z.string(),
  github:        z.string().optional(),
  goals:         z.array(z.string()),
  modules:       z.array(TeamModuleSchema),
  tasks:         z.array(TeamTaskSchema),
  units:         z.array(TeamUnitSchema),
  decisions:     z.array(z.string()),
  updatedAt:     z.string(),
})

export type TeamStateValidated = z.infer<typeof TeamStateSchema>

// ── EngineeringJob ────────────────────────────────────────────────────────────

export const JobStatusSchema = z.enum([
  'submitted', 'queued', 'running', 'completed', 'failed', 'cancelled',
])

export const JobMetricsSchema = z.object({
  submittedAt:  z.number(),
  startedAt:    z.number().optional(),
  completedAt:  z.number().optional(),
  wallTimeMs:   z.number().optional(),
  cpuTimeMs:    z.number().optional(),
})

export const JobArtifactSchema = z.object({
  artifactId: z.string(),
  name:       z.string(),
  path:       z.string(),
  mimeType:   z.string().optional(),
  sizeBytes:  z.number().optional(),
})

export const EngineeringJobSchema = z.object({
  jobId:         z.string(),
  toolName:      z.string(),
  domain:        z.string(),
  fidelityLevel: z.number(),
  input:         z.record(z.string(), z.unknown()),
  status:        JobStatusSchema,
  metrics:       JobMetricsSchema,
  agentId:       z.string(),
  sessionId:     z.string(),
  error:         z.string().optional(),
  artifacts:     z.array(JobArtifactSchema).optional(),
})

export type EngineeringJobValidated = z.infer<typeof EngineeringJobSchema>

// ── SessionMeta (SessionStore index) ─────────────────────────────────────────

export const SessionMetaSchema = z.object({
  sessionId:     z.string(),
  mode:          z.string(),
  startTime:     z.number(),
  lastActivity:  z.number(),
  messageCount:  z.number(),
  firstPrompt:   z.string(),
  workspace:     z.string().optional(),
})

export type SessionMetaValidated = z.infer<typeof SessionMetaSchema>

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Parse `value` against `schema` and return the typed result, or `null` if
 * validation fails.  Never throws.
 *
 * Used at every JSON.parse boundary so callers see `null` for corrupt/stale
 * data rather than a runtime error from accessing missing fields.
 */
export function parseOrNull<T>(
  schema: z.ZodType<T>,
  value: unknown,
): T | null {
  const result = schema.safeParse(value)
  return result.success ? result.data : null
}

/**
 * Parse an array payload: validate each element individually, drop invalid
 * ones, and return the filtered list with a warning count.
 *
 * Useful for JSONL / array deserialization where a single corrupt entry
 * should not invalidate the rest of the batch.
 */
export function parseArrayFiltered<T>(
  schema: z.ZodType<T>,
  values: unknown[],
): { valid: T[]; dropped: number } {
  const valid: T[] = []
  let dropped = 0
  for (const v of values) {
    const result = schema.safeParse(v)
    if (result.success) valid.push(result.data)
    else dropped++
  }
  return { valid, dropped }
}
