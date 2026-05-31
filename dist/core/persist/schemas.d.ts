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
export declare const TeamTaskStatusSchema: z.ZodEnum<{
    open: "open";
    paused: "paused";
    done: "done";
}>;
export declare const TeamAttemptSchema: z.ZodObject<{
    at: z.ZodString;
    unit: z.ZodString;
    direction: z.ZodString;
    outcome: z.ZodString;
    ref: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const TeamTaskSchema: z.ZodObject<{
    id: z.ZodString;
    title: z.ZodString;
    status: z.ZodEnum<{
        open: "open";
        paused: "paused";
        done: "done";
    }>;
    ownerUnit: z.ZodOptional<z.ZodString>;
    claimedAt: z.ZodOptional<z.ZodString>;
    attempts: z.ZodArray<z.ZodObject<{
        at: z.ZodString;
        unit: z.ZodString;
        direction: z.ZodString;
        outcome: z.ZodString;
        ref: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    updatedAt: z.ZodString;
}, z.core.$strip>;
export declare const TeamUnitSchema: z.ZodObject<{
    id: z.ZodString;
    human: z.ZodOptional<z.ZodString>;
    machine: z.ZodString;
    status: z.ZodEnum<{
        active: "active";
        away: "away";
    }>;
    currentTask: z.ZodOptional<z.ZodString>;
    lastSeen: z.ZodString;
}, z.core.$strip>;
export declare const TeamStateV10Schema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<"1.0">;
    project: z.ZodString;
    github: z.ZodOptional<z.ZodString>;
    goals: z.ZodArray<z.ZodString>;
    modules: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        ownerUnit: z.ZodOptional<z.ZodString>;
        paths: z.ZodArray<z.ZodString>;
        responsibilities: z.ZodArray<z.ZodString>;
    }, z.core.$strip>>;
    tasks: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        title: z.ZodString;
        status: z.ZodEnum<{
            cancelled: "cancelled";
            paused: "paused";
            done: "done";
            backlog: "backlog";
            claimed: "claimed";
            in_progress: "in_progress";
            blocked: "blocked";
            review: "review";
            handoff: "handoff";
        }>;
        module: z.ZodOptional<z.ZodString>;
        ownerUnit: z.ZodOptional<z.ZodString>;
        branch: z.ZodOptional<z.ZodString>;
        githubIssueNumber: z.ZodOptional<z.ZodNumber>;
        githubIssueUrl: z.ZodOptional<z.ZodString>;
        paths: z.ZodArray<z.ZodString>;
        updatedAt: z.ZodString;
    }, z.core.$strip>>;
    units: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        human: z.ZodOptional<z.ZodString>;
        machine: z.ZodString;
        status: z.ZodEnum<{
            active: "active";
            idle: "idle";
            offline: "offline";
        }>;
        currentTask: z.ZodOptional<z.ZodString>;
        lastSeen: z.ZodString;
    }, z.core.$strip>>;
    decisions: z.ZodArray<z.ZodString>;
    updatedAt: z.ZodString;
}, z.core.$strip>;
export declare const TeamStateV20Schema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<"2.0">;
    project: z.ZodString;
    github: z.ZodOptional<z.ZodString>;
    goals: z.ZodArray<z.ZodString>;
    tasks: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        title: z.ZodString;
        status: z.ZodEnum<{
            open: "open";
            paused: "paused";
            done: "done";
        }>;
        ownerUnit: z.ZodOptional<z.ZodString>;
        claimedAt: z.ZodOptional<z.ZodString>;
        attempts: z.ZodArray<z.ZodObject<{
            at: z.ZodString;
            unit: z.ZodString;
            direction: z.ZodString;
            outcome: z.ZodString;
            ref: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
        updatedAt: z.ZodString;
    }, z.core.$strip>>;
    units: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        human: z.ZodOptional<z.ZodString>;
        machine: z.ZodString;
        status: z.ZodEnum<{
            active: "active";
            away: "away";
        }>;
        currentTask: z.ZodOptional<z.ZodString>;
        lastSeen: z.ZodString;
    }, z.core.$strip>>;
    updatedAt: z.ZodString;
}, z.core.$strip>;
export declare const TeamStateSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<"2.0">;
    project: z.ZodString;
    github: z.ZodOptional<z.ZodString>;
    goals: z.ZodArray<z.ZodString>;
    tasks: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        title: z.ZodString;
        status: z.ZodEnum<{
            open: "open";
            paused: "paused";
            done: "done";
        }>;
        ownerUnit: z.ZodOptional<z.ZodString>;
        claimedAt: z.ZodOptional<z.ZodString>;
        attempts: z.ZodArray<z.ZodObject<{
            at: z.ZodString;
            unit: z.ZodString;
            direction: z.ZodString;
            outcome: z.ZodString;
            ref: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
        updatedAt: z.ZodString;
    }, z.core.$strip>>;
    units: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        human: z.ZodOptional<z.ZodString>;
        machine: z.ZodString;
        status: z.ZodEnum<{
            active: "active";
            away: "away";
        }>;
        currentTask: z.ZodOptional<z.ZodString>;
        lastSeen: z.ZodString;
    }, z.core.$strip>>;
    updatedAt: z.ZodString;
}, z.core.$strip>;
export type TeamStateV10 = z.infer<typeof TeamStateV10Schema>;
export type TeamStateV20 = z.infer<typeof TeamStateV20Schema>;
export type TeamStateValidated = TeamStateV20;
/** Latest schema-version literal; bump alongside additions to the union. */
export declare const TEAM_STATE_LATEST_VERSION: "2.0";
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
export declare function migrateTeamState(raw: unknown): TeamStateValidated | null;
export declare const JobStatusSchema: z.ZodEnum<{
    submitted: "submitted";
    queued: "queued";
    running: "running";
    completed: "completed";
    failed: "failed";
    cancelled: "cancelled";
}>;
export declare const JobMetricsSchema: z.ZodObject<{
    submittedAt: z.ZodNumber;
    startedAt: z.ZodOptional<z.ZodNumber>;
    completedAt: z.ZodOptional<z.ZodNumber>;
    wallTimeMs: z.ZodOptional<z.ZodNumber>;
    cpuTimeMs: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export declare const JobArtifactSchema: z.ZodObject<{
    artifactId: z.ZodString;
    name: z.ZodString;
    path: z.ZodString;
    mimeType: z.ZodOptional<z.ZodString>;
    sizeBytes: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export declare const EngineeringJobSchema: z.ZodObject<{
    jobId: z.ZodString;
    toolName: z.ZodString;
    domain: z.ZodString;
    fidelityLevel: z.ZodNumber;
    input: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    status: z.ZodEnum<{
        submitted: "submitted";
        queued: "queued";
        running: "running";
        completed: "completed";
        failed: "failed";
        cancelled: "cancelled";
    }>;
    metrics: z.ZodObject<{
        submittedAt: z.ZodNumber;
        startedAt: z.ZodOptional<z.ZodNumber>;
        completedAt: z.ZodOptional<z.ZodNumber>;
        wallTimeMs: z.ZodOptional<z.ZodNumber>;
        cpuTimeMs: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>;
    agentId: z.ZodString;
    sessionId: z.ZodString;
    error: z.ZodOptional<z.ZodString>;
    artifacts: z.ZodOptional<z.ZodArray<z.ZodObject<{
        artifactId: z.ZodString;
        name: z.ZodString;
        path: z.ZodString;
        mimeType: z.ZodOptional<z.ZodString>;
        sizeBytes: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>>;
}, z.core.$strip>;
export type EngineeringJobValidated = z.infer<typeof EngineeringJobSchema>;
export declare const SessionMetaSchema: z.ZodObject<{
    sessionId: z.ZodString;
    mode: z.ZodString;
    startTime: z.ZodNumber;
    lastActivity: z.ZodNumber;
    messageCount: z.ZodNumber;
    firstPrompt: z.ZodString;
    workspace: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type SessionMetaValidated = z.infer<typeof SessionMetaSchema>;
/**
 * Parse `value` against `schema` and return the typed result, or `null` if
 * validation fails.  Never throws.
 *
 * Used at every JSON.parse boundary so callers see `null` for corrupt/stale
 * data rather than a runtime error from accessing missing fields.
 */
export declare function parseOrNull<T>(schema: z.ZodType<T>, value: unknown): T | null;
/**
 * Parse an array payload: validate each element individually, drop invalid
 * ones, and return the filtered list with a warning count.
 *
 * Useful for JSONL / array deserialization where a single corrupt entry
 * should not invalidate the rest of the batch.
 */
export declare function parseArrayFiltered<T>(schema: z.ZodType<T>, values: unknown[]): {
    valid: T[];
    dropped: number;
};
//# sourceMappingURL=schemas.d.ts.map