/**
 * experienceContentHash — the stable identity of an experience's *content*.
 *
 * G0-4 of the self-evolution plan. `InjectedKnowledgeEntrySchema` requires a
 * 64-hex `contentHash` for every entry that reaches the model, so that a later
 * analysis can tell "this run saw entry X" apart from "this run saw entry X
 * *as it read before the rewrite*". `ExperienceEntry` carries no revision
 * number and no hash, so the identity has to be derived from the content.
 *
 * ── Why an explicit field list instead of a generic stable-JSON walk ────────
 *
 * A generic walk over the object would silently fold every future field into
 * the hash, which means adding an unrelated bookkeeping field would invalidate
 * the identity of every entry already recorded in trajectories. The hash is a
 * cross-version contract, so its input is enumerated by hand and reviewed when
 * it changes. `EXPERIENCE_CONTENT_HASH_VERSION` moves whenever this list does.
 *
 * ── What is in the hash ─────────────────────────────────────────────────────
 *
 * Everything that either (a) reaches the model when the entry is injected, or
 * (b) changes how the selector ranks it. Both are things an attribution query
 * has to be able to distinguish, so a change in any of them is a new version:
 *
 *   domain · algorithm · robot · tags · difficulty · title · problem ·
 *   solution · outcome{success,summary,failureReason,workarounds} ·
 *   abstractPrinciple · confidenceTier · evidenceRefs · observationCount ·
 *   contradictionCount · invalidatedAssumptions · metrics · relatedPapers
 *
 * `observationCount` / `contradictionCount` are deliberately included even
 * though a re-observation does not edit a single word of the lesson: they are
 * rendered into the injected block ("Confidence: observed (3 observations)")
 * and they move `experienceRetrievalScore`, so a run that saw the 3-observation
 * form did not see the same thing as a run that saw the 1-observation form.
 *
 * ── What is NOT in the hash, and why ────────────────────────────────────────
 *
 * `id` — identity is recorded next to the hash as `entryId`. Leaving it out is
 *   what lets two entries with identical content hash alike, which is how
 *   duplicate knowledge becomes visible instead of hiding behind two ids.
 *
 * `schemaVersion` / `createdAt` / `updatedAt` / `lastVerifiedAt` — bookkeeping.
 *   `updatedAt` in particular moves on writes that do not change the content
 *   (index rebuilds, reference appends); folding it in would report a new
 *   version on every touch and make the hash useless as a change signal.
 *
 * `sourceTaskId` / `sourceSessionId` / `principleIds` / `anchorIds` — linkage,
 *   never rendered into the injected block and never read by the ranker.
 *
 * `fullReport` — REQUIRED exclusion, not a judgement call. `ExperienceStore`
 *   strips it from the search-index copies (`stripFullReport`), so `search()`
 *   returns entries without it while `load()` returns entries with it. Since
 *   retrieval for injection goes through `search()`, including `fullReport`
 *   would make the same entry hash differently depending on which code path
 *   fetched it — the hash would stop being an identity. It is also never
 *   injected into context, so it changes nothing the model saw.
 *
 * ── The rule that resolves "but that field IS rendered" ─────────────────────
 *
 * `experience_load` renders `**Created**: <createdAt>`, and `createdAt` is
 * excluded above. That is not an inconsistency, because the actual invariant is
 * narrower than "everything the model sees":
 *
 *   A field must be hashed when it can change *for the same entry id*.
 *   A field fixed at creation may be excluded even when it is rendered, because
 *   it can never produce two different versions of one entry.
 *
 * `createdAt` is immutable, so excluding it cannot make two versions collide.
 * `lastVerifiedAt` and `observationCount` are mutable *and* rendered, so they
 * are hashed wherever the renderer shows them.
 */

import { createHash } from 'crypto'
import type { ExperienceEntry } from './types.js'
import type { PhysicalAnchorEntry, PrincipleEntry } from '../../robotics/types.js'

/**
 * Bumped whenever the hashed field list or the normalisation below changes.
 * It is part of the hash input, so old and new hashes can never collide.
 */
export const EXPERIENCE_CONTENT_HASH_VERSION = 'exp-content-1'

/**
 * Normalised value for hashing: `undefined` and a missing key must produce the
 * same bytes, otherwise an entry written before a field existed would hash
 * differently from an entry that carries the field as `undefined`.
 */
type Canonical = string | number | boolean | null | Canonical[] | { [key: string]: Canonical }

function orNull<T extends string | number | boolean>(value: T | undefined): T | null {
  return value === undefined ? null : value
}

/**
 * Arrays keep their order. Reordering `workarounds` changes the rendered block
 * the model reads, so it is a genuine content change and must move the hash —
 * sorting here would erase that.
 */
function listOrNull(values: readonly string[] | undefined): string[] | null {
  return values === undefined ? null : [...values]
}

/** Record keys are sorted: object key order is not meaningful in JSON. */
function metricsOrNull(
  metrics: Record<string, number | string> | undefined,
): Record<string, Canonical> | null {
  if (metrics === undefined) return null
  const sorted: Record<string, Canonical> = {}
  for (const key of Object.keys(metrics).sort()) sorted[key] = metrics[key] as Canonical
  return sorted
}

/**
 * The exact bytes that are hashed. Exported for tests and for anyone debugging
 * why two entries that "look the same" produced different hashes.
 */
export function experienceCanonicalForm(entry: ExperienceEntry): string {
  const canonical: Canonical = {
    v: EXPERIENCE_CONTENT_HASH_VERSION,
    domain: entry.domain,
    algorithm: orNull(entry.algorithm),
    robot: orNull(entry.robot),
    tags: listOrNull(entry.tags) ?? [],
    difficulty: entry.difficulty,
    title: entry.title,
    problem: entry.problem,
    solution: entry.solution,
    outcome: {
      success: entry.outcome.success,
      summary: entry.outcome.summary,
      failureReason: orNull(entry.outcome.failureReason),
      workarounds: listOrNull(entry.outcome.workarounds),
    },
    abstractPrinciple: orNull(entry.abstractPrinciple),
    confidenceTier: orNull(entry.confidenceTier),
    evidenceRefs: listOrNull(entry.evidenceRefs),
    // Defaulted to match what ExperienceSource.toMatch surfaces, so an entry
    // written before these fields existed hashes identically to one that
    // carries the explicit default.
    observationCount: entry.observationCount ?? 1,
    contradictionCount: entry.contradictionCount ?? 0,
    invalidatedAssumptions: listOrNull(entry.invalidatedAssumptions),
    metrics: metricsOrNull(entry.metrics),
    relatedPapers: listOrNull(entry.relatedPapers),
  }
  return JSON.stringify(canonical)
}

/** 64-hex content hash, matching `InjectedKnowledgeEntrySchema.contentHash`. */
export function experienceContentHash(entry: ExperienceEntry): string {
  return createHash('sha256').update(experienceCanonicalForm(entry)).digest('hex')
}

// ─────────────────────────────────────────────────────────────────────────────
// Principles
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Excluded: `id` / `schemaVersion` / `createdAt` / `updatedAt` (identity and
 * bookkeeping, per the rule above), plus two that are genuinely never shown:
 *
 *   `promotionReason` — why it was promoted, not part of the principle;
 *   `sourceExperienceId` — superseded by `derivedFromExperienceIds`, which is
 *     what both renderers actually print.
 *
 * `lastVerifiedAt` is excluded here and included for anchors, because the
 * principle renderers do not print it and the anchor renderer does.
 */
export function principleCanonicalForm(entry: PrincipleEntry): string {
  const canonical: Canonical = {
    v: EXPERIENCE_CONTENT_HASH_VERSION,
    title: entry.title,
    statement: entry.statement,
    mechanism: entry.mechanism,
    firstPrinciplesSupport: [...entry.firstPrinciplesSupport],
    domains: [...entry.domains],
    abstractionLevel: entry.abstractionLevel,
    preconditions: [...entry.preconditions],
    applicabilityBounds: [...entry.applicabilityBounds],
    nonApplicableWhen: [...entry.nonApplicableWhen],
    derivedFromExperienceIds: [...entry.derivedFromExperienceIds],
    anchoredByPhysicalAnchorIds: [...entry.anchoredByPhysicalAnchorIds],
    evidenceRefs: [...entry.evidenceRefs],
    invalidatedAssumptions: [...entry.invalidatedAssumptions],
    counterExamples: [...entry.counterExamples],
    confidenceTier: entry.confidenceTier,
    observationCount: entry.observationCount,
    contradictionCount: entry.contradictionCount,
  }
  return JSON.stringify(canonical)
}

export function principleContentHash(entry: PrincipleEntry): string {
  return createHash('sha256').update(principleCanonicalForm(entry)).digest('hex')
}

// ─────────────────────────────────────────────────────────────────────────────
// Physical anchors
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `lastVerifiedAt` IS hashed here: `physical_anchor_load` prints it, and unlike
 * `createdAt` it moves for an entry that already exists. A run that read
 * "Last verified: 2026-01-01" did not read the same anchor as a run that read a
 * later date — for a physical fact, how recently it was checked is the claim.
 */
export function physicalAnchorCanonicalForm(entry: PhysicalAnchorEntry): string {
  const canonical: Canonical = {
    v: EXPERIENCE_CONTENT_HASH_VERSION,
    domain: entry.domain,
    scope: entry.scope,
    robot: orNull(entry.robot),
    title: entry.title,
    fact: entry.fact,
    mechanism: orNull(entry.mechanism),
    implication: entry.implication,
    tags: [...entry.tags],
    confidenceTier: entry.confidenceTier,
    evidenceRefs: [...entry.evidenceRefs],
    source: orNull(entry.source),
    lastVerifiedAt: orNull(entry.lastVerifiedAt),
    invalidates: listOrNull(entry.invalidates),
    // Defaults mirror what the renderers print for older entries.
    observationCount: entry.observationCount ?? 0,
    contradictionCount: entry.contradictionCount ?? 0,
    principleIds: listOrNull(entry.principleIds),
  }
  return JSON.stringify(canonical)
}

export function physicalAnchorContentHash(entry: PhysicalAnchorEntry): string {
  return createHash('sha256').update(physicalAnchorCanonicalForm(entry)).digest('hex')
}
