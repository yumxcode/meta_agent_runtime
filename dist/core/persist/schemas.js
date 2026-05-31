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
import { z } from 'zod';
// ── TeamState ─────────────────────────────────────────────────────────────────
//
// v2.0 collaboration model — see team/README.md for design intent.
//
// Core idea: team mode is a shared lab notebook, not a project manager.
// Three entities, that's it:
//   - unit:    a participant (human + machine)
//   - task:    something someone is doing (exclusive ownership when claimed)
//   - attempt: an append-only entry recording direction + outcome + ref
//
// No modules, no paths, no decisions, no branches, no GitHub sync — anything
// that smells like task assignment was deliberately removed.
export const TeamTaskStatusSchema = z.enum(['open', 'paused', 'done']);
export const TeamAttemptSchema = z.object({
    /** ISO timestamp of when this attempt was recorded. */
    at: z.string(),
    /** Which unit recorded this attempt. */
    unit: z.string(),
    /** One-line description of what was tried. */
    direction: z.string(),
    /** What happened — success/failure summary with brief reasoning. */
    outcome: z.string(),
    /** Optional pointer: git sha, wandb URL, S3 path, rosbag, video, … */
    ref: z.string().optional(),
});
export const TeamTaskSchema = z.object({
    id: z.string(),
    title: z.string(),
    status: TeamTaskStatusSchema,
    /** Non-empty = claimed; only the owner can note/drop/done. */
    ownerUnit: z.string().optional(),
    /** ISO of claim time — used for stale-claim visual warnings. */
    claimedAt: z.string().optional(),
    /** Append-only log of directions tried and their outcomes. */
    attempts: z.array(TeamAttemptSchema),
    updatedAt: z.string(),
});
export const TeamUnitSchema = z.object({
    id: z.string(),
    human: z.string().optional(),
    machine: z.string(),
    status: z.enum(['active', 'away']),
    currentTask: z.string().optional(),
    lastSeen: z.string(),
});
// ── Versioned schemas ────────────────────────────────────────────────────────
//
// v1.0 is the legacy "task-management" schema (modules, paths, decisions, …)
// v2.0 is the current "shared lab notebook" schema (open/paused/done, attempts)
//
// When v2.1 lands: add TeamStateV21Schema, wire it into the union, extend
// `migrateTeamState()` with a v2.0 → v2.1 step.
// Legacy v1.0 (still readable for migration only).
const LegacyV10TaskStatusSchema = z.enum([
    'backlog', 'claimed', 'in_progress', 'blocked',
    'review', 'done', 'paused', 'handoff', 'cancelled',
]);
const LegacyV10ModuleSchema = z.object({
    name: z.string(),
    ownerUnit: z.string().optional(),
    paths: z.array(z.string()),
    responsibilities: z.array(z.string()),
});
const LegacyV10TaskSchema = z.object({
    id: z.string(),
    title: z.string(),
    status: LegacyV10TaskStatusSchema,
    module: z.string().optional(),
    ownerUnit: z.string().optional(),
    branch: z.string().optional(),
    githubIssueNumber: z.number().optional(),
    githubIssueUrl: z.string().optional(),
    paths: z.array(z.string()),
    updatedAt: z.string(),
});
const LegacyV10UnitSchema = z.object({
    id: z.string(),
    human: z.string().optional(),
    machine: z.string(),
    status: z.enum(['active', 'idle', 'offline']),
    currentTask: z.string().optional(),
    lastSeen: z.string(),
});
export const TeamStateV10Schema = z.object({
    schemaVersion: z.literal('1.0'),
    project: z.string(),
    github: z.string().optional(),
    goals: z.array(z.string()),
    modules: z.array(LegacyV10ModuleSchema),
    tasks: z.array(LegacyV10TaskSchema),
    units: z.array(LegacyV10UnitSchema),
    decisions: z.array(z.string()),
    updatedAt: z.string(),
});
export const TeamStateV20Schema = z.object({
    schemaVersion: z.literal('2.0'),
    project: z.string(),
    github: z.string().optional(),
    goals: z.array(z.string()),
    tasks: z.array(TeamTaskSchema),
    units: z.array(TeamUnitSchema),
    updatedAt: z.string(),
});
// The canonical exported schema is always the latest version.
export const TeamStateSchema = TeamStateV20Schema;
/** Latest schema-version literal; bump alongside additions to the union. */
export const TEAM_STATE_LATEST_VERSION = '2.0';
/**
 * Migrate any historic team-state record forward to the latest schema, then
 * validate.  Currently handles:
 *   - v2.0 → no-op
 *   - v1.0 → drop modules/decisions/paths/branch/github-issue fields;
 *            collapse 9-state status into open|paused|done;
 *            initialise empty attempts[].
 *
 * Returns the upgraded + validated state, or null when the input is neither
 * a known historic shape nor a parseable current payload.
 */
export function migrateTeamState(raw) {
    if (!raw || typeof raw !== 'object')
        return null;
    const obj = raw;
    if (obj.schemaVersion === '2.0') {
        const parsed = TeamStateV20Schema.safeParse(raw);
        return parsed.success ? parsed.data : null;
    }
    if (obj.schemaVersion === '1.0') {
        const legacy = TeamStateV10Schema.safeParse(raw);
        if (!legacy.success)
            return null;
        const v10 = legacy.data;
        const upgraded = {
            schemaVersion: '2.0',
            project: v10.project,
            github: v10.github,
            goals: v10.goals,
            tasks: v10.tasks.map(t => ({
                id: t.id,
                title: t.title,
                status: mapLegacyStatus(t.status),
                ownerUnit: t.ownerUnit,
                attempts: [],
                updatedAt: t.updatedAt,
            })),
            units: v10.units.map(u => ({
                id: u.id,
                human: u.human,
                machine: u.machine,
                // v1.0 had active|idle|offline; collapse the two non-active states.
                status: u.status === 'active' ? 'active' : 'away',
                currentTask: u.currentTask,
                lastSeen: u.lastSeen,
            })),
            updatedAt: v10.updatedAt,
        };
        // Sanity-validate the migrated state with the canonical schema.
        const parsed = TeamStateV20Schema.safeParse(upgraded);
        return parsed.success ? parsed.data : null;
    }
    return null;
}
function mapLegacyStatus(status) {
    switch (status) {
        case 'done':
        case 'cancelled':
            return 'done';
        case 'paused':
        case 'blocked':
        case 'handoff':
            return 'paused';
        case 'backlog':
        case 'claimed':
        case 'in_progress':
        case 'review':
        default:
            return 'open';
    }
}
// ── EngineeringJob ────────────────────────────────────────────────────────────
export const JobStatusSchema = z.enum([
    'submitted', 'queued', 'running', 'completed', 'failed', 'cancelled',
]);
export const JobMetricsSchema = z.object({
    submittedAt: z.number(),
    startedAt: z.number().optional(),
    completedAt: z.number().optional(),
    wallTimeMs: z.number().optional(),
    cpuTimeMs: z.number().optional(),
});
export const JobArtifactSchema = z.object({
    artifactId: z.string(),
    name: z.string(),
    path: z.string(),
    mimeType: z.string().optional(),
    sizeBytes: z.number().optional(),
});
export const EngineeringJobSchema = z.object({
    jobId: z.string(),
    toolName: z.string(),
    domain: z.string(),
    fidelityLevel: z.number(),
    input: z.record(z.string(), z.unknown()),
    status: JobStatusSchema,
    metrics: JobMetricsSchema,
    agentId: z.string(),
    sessionId: z.string(),
    error: z.string().optional(),
    artifacts: z.array(JobArtifactSchema).optional(),
});
// ── SessionMeta (SessionStore index) ─────────────────────────────────────────
export const SessionMetaSchema = z.object({
    sessionId: z.string(),
    mode: z.string(),
    startTime: z.number(),
    lastActivity: z.number(),
    messageCount: z.number(),
    firstPrompt: z.string(),
    workspace: z.string().optional(),
});
// ── Helpers ───────────────────────────────────────────────────────────────────
/**
 * Parse `value` against `schema` and return the typed result, or `null` if
 * validation fails.  Never throws.
 *
 * Used at every JSON.parse boundary so callers see `null` for corrupt/stale
 * data rather than a runtime error from accessing missing fields.
 */
export function parseOrNull(schema, value) {
    const result = schema.safeParse(value);
    return result.success ? result.data : null;
}
/**
 * Parse an array payload: validate each element individually, drop invalid
 * ones, and return the filtered list with a warning count.
 *
 * Useful for JSONL / array deserialization where a single corrupt entry
 * should not invalidate the rest of the batch.
 */
export function parseArrayFiltered(schema, values) {
    const valid = [];
    let dropped = 0;
    for (const v of values) {
        const result = schema.safeParse(v);
        if (result.success)
            valid.push(result.data);
        else
            dropped++;
    }
    return { valid, dropped };
}
//# sourceMappingURL=schemas.js.map