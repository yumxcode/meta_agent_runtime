/**
 * Provenance — core types
 *
 * Every engineering result in meta-agent carries a full audit trail:
 * what was computed, with what inputs, by which tool at which fidelity,
 * what the V&V checks said, and which earlier result it was derived from.
 *
 * This enables:
 *   • Reproducibility: replay any computation from its ProvenanceRecord
 *   • Audit: regulators / reviewers can trace every design decision
 *   • Debugging: find where a bad number entered the system
 *   • DOE traceability: link Pareto-optimal points back to their simulations
 *
 * Storage: ~/.meta-agent/sessions/{sessionId}/provenance/{provenanceId}.json
 */

import type { DimensionalRecord, JobArtifact } from '../jobs/types.js'
import type { VVResult } from '../validation/types.js'

// ─────────────────────────────────────────────────────────────────────────────
// Provenance ID
// ─────────────────────────────────────────────────────────────────────────────

export type ProvenanceId = string

export function makeProvenanceId(): ProvenanceId {
  const uuid8 = crypto.randomUUID().replace(/-/g, '').slice(0, 12)
  return `prov-${uuid8}`
}

// ─────────────────────────────────────────────────────────────────────────────
// Core record
// ─────────────────────────────────────────────────────────────────────────────

export interface ProvenanceRecord {
  /** Unique provenance ID — referenced by JobResult and downstream records */
  id: ProvenanceId
  timestamp: number           // epoch ms when record() was called

  // ── Identity ──────────────────────────────────────────────────────────────
  sessionId: string
  agentId: string

  // ── Tool ──────────────────────────────────────────────────────────────────
  toolName: string
  /** Semver or git SHA of the tool; empty string if unknown */
  toolVersion: string
  /** 0–4 per FidelityLevel */
  fidelityLevel: number
  /** Job ID if the tool ran as an async job; undefined for sync tools */
  jobId?: string

  // ── Input ─────────────────────────────────────────────────────────────────
  /** Verbatim tool input (full record, including units if present) */
  input: DimensionalRecord
  /** SHA-256 hex of JSON.stringify(input) — for fast equality checks */
  inputHash: string

  // ── Runtime environment ───────────────────────────────────────────────────
  /** Claude model name used for this session (e.g. "claude-opus-4-6") */
  modelName: string
  /** SHA-256 hex of the system prompt — detects prompt drift across runs */
  systemPromptHash: string

  // ── Output ────────────────────────────────────────────────────────────────
  /** Verbatim tool output */
  output: DimensionalRecord
  /** V&V results that ran against this output */
  validationResults: VVResult[]
  /** Files produced by this tool call (reports, plots, mesh files…) */
  artifacts: JobArtifact[]

  // ── Lineage ───────────────────────────────────────────────────────────────
  /** ID of the ProvenanceRecord this result was directly derived from */
  parentProvenanceId?: ProvenanceId
  /** DOE design-point ID when this call is part of a design space exploration */
  designPointId?: string
  /** Free-form tags for grouping / filtering */
  tags?: string[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Input shape for ProvenanceTracker.record()
// (auto-generated fields omitted — tracker fills them in)
// ─────────────────────────────────────────────────────────────────────────────

export type ProvenanceInput = Omit<ProvenanceRecord,
  'id' | 'timestamp' | 'inputHash' | 'systemPromptHash'>
  & {
    /** Raw system prompt text — tracker hashes it */
    systemPrompt?: string
  }

// ─────────────────────────────────────────────────────────────────────────────
// Filter for list() / query()
// ─────────────────────────────────────────────────────────────────────────────

export interface ProvenanceFilter {
  agentId?: string
  toolName?: string
  /** Only records with fidelityLevel in this set */
  fidelityLevels?: number[]
  /** Only records whose validationResults contain a failure */
  hasVVFailure?: boolean
  /** Only records derived from a specific parent */
  parentProvenanceId?: ProvenanceId
  designPointId?: string
  tags?: string[]
  /** Epoch ms range */
  since?: number
  until?: number
}
