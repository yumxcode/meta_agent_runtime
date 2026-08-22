/**
 * KernelEvent schema — the frozen, versioned description of what the kernel
 * emits.
 *
 * Why this exists
 * ---------------
 * `KernelEvent` is a TypeScript union. That is enough for in-process consumers,
 * who are compiled against it, and enough for nothing else. The moment an event
 * leaves the process — into a telemetry file, an external hook's stdin, an IDE
 * over a socket — the union stops being a contract and becomes an accident:
 * nothing states which fields are guaranteed, nothing detects a rename, and the
 * consumer discovers the change at runtime, usually as a missing field rather
 * than as an error.
 *
 * So the union stays the source of truth for the SHAPE, and this module adds
 * the three things a wire format needs: runtime validation, a published JSON
 * Schema, and a version that changes when the shape does.
 *
 * What is deliberately NOT done
 * -----------------------------
 * `schemaVersion` is NOT stamped onto every event object. Doing so would touch
 * every `yield` site in the kernel, inflate every event with a constant, and
 * break every existing consumer's object comparisons — all to restate something
 * that is a property of the STREAM, not of each item in it. The version travels
 * in the telemetry envelope and in the exported schema document, which is where
 * a reader actually looks for it.
 *
 * Compatibility rule
 * ------------------
 * `EVENT_SCHEMA_VERSION` is semver over the event contract:
 *   - PATCH: docs/comments only.
 *   - MINOR: a new event type, or a new OPTIONAL field. Existing consumers keep
 *     working, so fixtures from the previous version must still validate.
 *   - MAJOR: a removed/renamed field, a narrowed type, a new REQUIRED field, or
 *     a removed event type. Old fixtures are expected to fail; that failure is
 *     the point.
 *
 * `EventSchemaFixtures.test.ts` enforces this: it validates a stored corpus of
 * canonical events against the live schema, so a breaking edit cannot land
 * without either updating the corpus (a visible, reviewable diff) or bumping
 * the major version.
 */

import { z } from 'zod'

/**
 * Version of the event contract. See the compatibility rule above before
 * changing it — and change it in the same commit as the shape it describes.
 */
export const EVENT_SCHEMA_VERSION = '1.0.0'

// ── Shared fragments ──────────────────────────────────────────────────────────

/**
 * `sessionId` is on EVERY event and is the only field that is. It is what makes
 * a multiplexed stream demultiplexable, so it is required everywhere rather
 * than being merged in by a wrapper.
 */
const sessionId = z.string()

/**
 * Mirrors `kernel/types/TokenUsage.ts` — NOT the same-named interface in
 * `core/types.ts`, which spells the cache counters `cacheCreationInputTokens` /
 * `cacheReadInputTokens`.
 *
 * Two different types share the name `TokenUsage` in this codebase, and
 * `ResultEvent.usage` is the kernel one. Writing this schema against the core
 * spelling produced a published contract that did not match a single event the
 * runtime actually emits — caught only because the compiler checks the fixtures
 * against the real type. Worth stating loudly here: the next person to touch
 * this has the same 50/50 chance of picking the wrong one.
 */
const tokenUsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
})

const permissionDenialSchema = z.object({
  toolName: z.string(),
  toolUseId: z.string(),
  reason: z.string(),
  timestamp: z.number(),
})

const parkControlSchema = z.object({
  kind: z.literal('park'),
  afterMs: z.number(),
  reason: z.string(),
  checkpoint: z.record(z.string(), z.unknown()).optional(),
})

/**
 * `ExecutionFailure` is a rich, evolving domain type owned by
 * infra/failures. Pinning its full shape here would make every change to it a
 * breaking change to the EVENT contract, which is the wrong coupling: consumers
 * of the event stream care that a failure is present and roughly what kind, not
 * about its internal taxonomy. Kept permissive on purpose.
 */
const executionFailureSchema = z.looseObject({})

// ── Per-event schemas ─────────────────────────────────────────────────────────

export const textDeltaEventSchema = z.object({
  type: z.literal('text_delta'),
  delta: z.string(),
  sessionId,
})

export const thinkingDeltaEventSchema = z.object({
  type: z.literal('thinking_delta'),
  delta: z.string(),
  sessionId,
})

export const toolUseEventSchema = z.object({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.string(),
  // Tool inputs are arbitrary by design — the schema that constrains them is
  // the TOOL's, not the event's.
  input: z.unknown(),
  sessionId,
})

export const toolResultEventSchema = z.object({
  type: z.literal('tool_result'),
  id: z.string(),
  toolName: z.string(),
  content: z.string(),
  isError: z.boolean(),
  sessionId,
})

export const compactStartEventSchema = z.object({
  type: z.literal('compact_start'),
  sessionId,
})

export const compactBoundaryEventSchema = z.object({
  type: z.literal('compact_boundary'),
  compactMetadata: z.object({
    summaryTokens: z.number(),
    previousTokens: z.number(),
  }),
  sessionId,
})

export const compactFailedEventSchema = z.object({
  type: z.literal('compact_failed'),
  attempt: z.number(),
  querySource: z.string().optional(),
  error: z.string(),
  consecutiveFailures: z.number(),
  sessionId,
})

export const apiRetryEventSchema = z.object({
  type: z.literal('api_retry'),
  attempt: z.number(),
  maxRetries: z.number(),
  retryDelayMs: z.number(),
  errorStatus: z.number().nullable(),
  sessionId,
})

export const toolUseSummaryEventSchema = z.object({
  type: z.literal('tool_use_summary'),
  summary: z.string(),
  precedingToolUseIds: z.array(z.string()),
  sessionId,
})

export const systemMessageEventSchema = z.object({
  type: z.literal('system_message'),
  subtype: z.enum(['warning', 'info']),
  text: z.string(),
  sessionId,
})

export const resultSubtypeSchema = z.enum([
  'success',
  'parked',
  'error_max_turns',
  'error_max_budget_usd',
  'error_max_output_tokens',
  'error_during_execution',
  'error_blocking_limit',
])

export const resultEventSchema = z.object({
  type: z.literal('result'),
  subtype: resultSubtypeSchema,
  sessionId,
  usage: tokenUsageSchema,
  costUsd: z.number(),
  numTurns: z.number(),
  stopReason: z.string().nullable(),
  resultText: z.string(),
  errors: z.array(z.string()).optional(),
  failure: executionFailureSchema.optional(),
  permissionDenials: z.array(permissionDenialSchema).optional(),
  parkRequest: parkControlSchema.optional(),
})

// ── The union ─────────────────────────────────────────────────────────────────

/**
 * Keyed by `type` so a validation failure names the event that failed rather
 * than reporting "no union member matched", which for an 11-way union is not a
 * diagnosis.
 */
export const kernelEventSchema = z.discriminatedUnion('type', [
  textDeltaEventSchema,
  thinkingDeltaEventSchema,
  toolUseEventSchema,
  toolResultEventSchema,
  compactStartEventSchema,
  compactBoundaryEventSchema,
  compactFailedEventSchema,
  apiRetryEventSchema,
  toolUseSummaryEventSchema,
  systemMessageEventSchema,
  resultEventSchema,
])

/** Every event `type` the kernel may emit, in declaration order. */
export const KERNEL_EVENT_TYPES = [
  'text_delta',
  'thinking_delta',
  'tool_use',
  'tool_result',
  'compact_start',
  'compact_boundary',
  'compact_failed',
  'api_retry',
  'tool_use_summary',
  'system_message',
  'result',
] as const

export type KernelEventType = (typeof KERNEL_EVENT_TYPES)[number]

const SCHEMA_BY_TYPE: Record<KernelEventType, z.ZodTypeAny> = {
  text_delta: textDeltaEventSchema,
  thinking_delta: thinkingDeltaEventSchema,
  tool_use: toolUseEventSchema,
  tool_result: toolResultEventSchema,
  compact_start: compactStartEventSchema,
  compact_boundary: compactBoundaryEventSchema,
  compact_failed: compactFailedEventSchema,
  api_retry: apiRetryEventSchema,
  tool_use_summary: toolUseSummaryEventSchema,
  system_message: systemMessageEventSchema,
  result: resultEventSchema,
}

// ── Validation ────────────────────────────────────────────────────────────────

export interface EventValidationResult {
  ok: boolean
  /** Human-readable problems, empty when ok. */
  errors: string[]
}

/**
 * Validate one event against the frozen schema.
 *
 * Returns a result rather than throwing: this runs on a hot path (every event,
 * when validation is enabled) and in a telemetry sink, where a malformed event
 * must be REPORTED, never allowed to take down the run that produced it.
 */
export function validateKernelEvent(event: unknown): EventValidationResult {
  const parsed = kernelEventSchema.safeParse(event)
  if (parsed.success) return { ok: true, errors: [] }
  return {
    ok: false,
    errors: parsed.error.issues.map(
      issue => `${issue.path.join('.') || '<root>'}: ${issue.message}`,
    ),
  }
}

/** Validate against ONE event type — sharper errors when the type is known. */
export function validateEventOfType(
  type: KernelEventType,
  event: unknown,
): EventValidationResult {
  const schema = SCHEMA_BY_TYPE[type]
  if (!schema) return { ok: false, errors: [`unknown event type: ${type}`] }
  const parsed = schema.safeParse(event)
  if (parsed.success) return { ok: true, errors: [] }
  return {
    ok: false,
    errors: parsed.error.issues.map(
      issue => `${issue.path.join('.') || '<root>'}: ${issue.message}`,
    ),
  }
}

// ── JSON Schema export ────────────────────────────────────────────────────────

export interface KernelEventJsonSchema {
  $schema: string
  $id: string
  title: string
  description: string
  /** The contract version this document describes. */
  version: string
  oneOf: unknown[]
}

/**
 * Emit the published JSON Schema for the event stream.
 *
 * Generated from the same zod definitions that validate at runtime, so the
 * document and the check can never disagree — which is the failure mode of a
 * hand-maintained schema file, and the reason this is a function rather than a
 * checked-in `.json`.
 */
export function kernelEventJsonSchema(): KernelEventJsonSchema {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `https://meta-agent.dev/schemas/kernel-event/v${EVENT_SCHEMA_VERSION}.json`,
    title: 'KernelEvent',
    description:
      'Events emitted by KernelSession.submitMessage(). ' +
      'See kernel/events/schema.ts for the compatibility rule governing this version.',
    version: EVENT_SCHEMA_VERSION,
    oneOf: KERNEL_EVENT_TYPES.map(type => variantJsonSchema(SCHEMA_BY_TYPE[type])),
  }
}

/**
 * One union member as JSON Schema.
 *
 * `$schema` is stripped: zod stamps it on every schema it converts, but a
 * dialect declaration nested inside a `oneOf` member is meaningless — the
 * dialect belongs to the document, which declares it once at the root.
 * Leaving them in would also put eleven copies of the same string into the
 * fingerprint below, making it noisier without making it more sensitive.
 */
function variantJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const json = z.toJSONSchema(schema, {
    // The event stream is a wire format: consumers must be able to read a
    // field without first resolving a $ref into a definitions block they may
    // not have. Inlining keeps each variant self-contained.
    io: 'output',
    unrepresentable: 'any',
  }) as Record<string, unknown>
  const { $schema: _dialect, ...rest } = json
  return rest
}

/**
 * Stable fingerprint of the event contract.
 *
 * Compared in the fixture test so that ANY shape change — including one that
 * happens to leave the stored fixtures still valid, such as adding an optional
 * field — is surfaced and has to be acknowledged with a version bump. Fixture
 * validation alone would silently accept exactly that case.
 */
export function kernelEventSchemaFingerprint(): string {
  const doc = kernelEventJsonSchema()
  // Version is excluded: bumping it is the ACKNOWLEDGEMENT of a shape change,
  // so including it here would make the fingerprint self-satisfying — every
  // bump would "fix" the mismatch it was supposed to flag.
  return stableStringify(doc.oneOf)
}

/** Deterministic JSON: key order must not depend on construction order. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
}
