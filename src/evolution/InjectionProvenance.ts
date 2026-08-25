/**
 * InjectionProvenance — turning this turn's retrieval and rendering traces into
 * canonical trajectory records (G0-2).
 *
 * The read side of this already exists: `KnowledgeItemSchema` carries the five
 * states and `TrajectoryReviewScanner.renderInjectionProvenance()` renders them.
 * Nothing wrote them. Until something does, every turn that injects an
 * experience is permanently unattributable, and that gap cannot be backfilled —
 * which is why this is the most urgent item in G0 despite being the least
 * interesting.
 *
 * ── Why three items and not five ────────────────────────────────────────────
 *
 * The plan names five states (recalled → eligible → selected → rendered →
 * injected). They are five *states*, not five *events*, and emitting one item
 * per state per turn would put five bookkeeping lines in every trajectory while
 * duplicating the same id lists. What is emitted instead:
 *
 *   recalled  — only when the store was actually queried this turn. A turn
 *               served from the cached candidate pool did not recall anything;
 *               saying it did would inflate every retrieval statistic.
 *   selected  — the selector's verdict, with every unselected candidate carried
 *               as an exclusion. `eligible` lives here as a reason code rather
 *               than as its own item, because the two selection routes disagree
 *               about what eligible means (see ExperienceSelectionPath) and a
 *               single `eligible` item would have to pick one and lie.
 *   injected  — what the pager actually rendered.
 *
 * `rendered` and `injected` would be the same list emitted twice: this builder
 * runs on the pager's render trace, and the rendered string *is* what goes into
 * the prompt. The gap the two states exist to expose — checked out but never
 * seen — shows up as exclusions on the injected item, which is where an
 * analysis would look for it anyway.
 *
 * ── What this cannot tell you ───────────────────────────────────────────────
 *
 * Exposure, never causation. Several entries are injected together, the
 * selector picks by task difficulty, and entries share origins — so "was this
 * run exposed to that entry, at which version" is answerable and "did that
 * entry help" is not. The latter needs randomised assignment or ablation, for
 * which these records are an input and not a substitute.
 */

import { createHash } from 'crypto'
import type { TrajectoryItem } from '../trajectory/types.js'
import type { PagerRenderTrace, SlotDropRecord, SlotProvenance } from '../context/types.js'
import { estimateTokens } from '../context/TokenEstimator.js'

/**
 * Why a recalled candidate did not reach the model.
 *
 * Codes only — never the entry body. These rows exist so a counterfactual
 * analysis can reconstruct the candidate set, not to copy knowledge text into
 * trajectories where it would then need its own redaction and retention story.
 */
export const INJECTION_EXCLUSION_REASONS = {
  /**
   * The judge ran and picked other candidates. An informative negative: some
   * process actually considered this entry and declined it.
   */
  NOT_SELECTED_BY_JUDGE: 'not_selected_by_judge',
  /**
   * No judgement was obtained, and this candidate did not clear the local
   * applicability threshold.
   *
   * Distinct from NOT_SELECTED_BY_JUDGE on purpose: nothing rejected this entry
   * on its merits — the fallback path simply never asked. Collapsing the two
   * would recreate exactly the ambiguity this module was written to remove.
   */
  BELOW_SCORE_THRESHOLD: 'below_score_threshold',
  /**
   * No judgement was obtained, this candidate did clear the threshold, and it
   * still lost — the injection limit filled up with higher-ranked entries.
   */
  CROWDED_OUT_BY_RANK: 'crowded_out_by_rank',
  /** Selected, but the pager refused it — larger than the whole budget. */
  SLOT_OVERSIZED: 'slot_oversized',
  /** Checked out, then evicted by a later checkout needing room. */
  EVICTED_FOR_ROOM: 'evicted_for_room',
  /** Present at render time but dropped for budget. Unreachable today. */
  SKIPPED_FOR_BUDGET: 'skipped_for_budget',
} as const

export type InjectionExclusionReason =
  typeof INJECTION_EXCLUSION_REASONS[keyof typeof INJECTION_EXCLUSION_REASONS]

/** Schema caps, mirrored here so the builder never emits an invalid item. */
const MAX_INJECTED_ENTRIES = 32
const MAX_EXCLUDED_CANDIDATES = 64
const CONTENT_HASH_RE = /^[a-f0-9]{64}$/

/** One candidate as the selector saw it. Mirrors ExperienceCandidateRecord. */
export interface SelectionCandidateInput {
  entryId: string
  contentHash: string
  eligibleByThreshold: boolean
}

/**
 * The selector's view of this turn. Shaped to match what
 * `ExperienceWorkingSetManager.lastPreloadTrace` exposes, but declared
 * independently so this module stays a pure function of plain data.
 */
export interface SelectionTraceInput {
  queryHash: string
  selectorVersion: string
  /** Whether the store was queried this turn, or the cached pool was reused. */
  candidateSource: 'store' | 'cache' | 'none'
  /** True when a judgement was obtained; drives which exclusion code applies. */
  judgementObtained: boolean
  pool: SelectionCandidateInput[]
  selectedEntryIds: string[]
  /** Selected but refused by the pager. */
  checkoutRejected: SelectionCandidateInput[]
}

export interface InjectionProvenanceInput {
  selection: SelectionTraceInput | null
  render: PagerRenderTrace | null
  /** Drops drained from the pager for this turn. */
  drops: SlotDropRecord[]
}

type KnowledgeItem = Extract<TrajectoryItem, { type: 'knowledge' }>

function isUsableProvenance(p: SlotProvenance | undefined): p is SlotProvenance {
  // A slot without full identity is not recorded as an injection. Emitting a
  // partial row would put an entry in the record that no later analysis can
  // resolve, which reads as attributable and is not.
  return Boolean(p && p.entryId && p.queryHash && p.selectorVersion && CONTENT_HASH_RE.test(p.contentHash))
}

function excluded(
  candidate: { entryId: string; contentHash: string },
  reasonCode: InjectionExclusionReason,
): { entryId: string; contentHash: string; reasonCode: string } {
  return { entryId: candidate.entryId, contentHash: candidate.contentHash, reasonCode }
}

/**
 * Build the knowledge items for one turn.
 *
 * Returns an empty array when nothing was recalled, selected or injected — a
 * session that never touches experience must not accumulate one bookkeeping
 * line per turn, both because it is noise and because "no injection happened"
 * should be readable as the absence of records rather than as a stream of
 * empty ones.
 */
export function buildInjectionProvenanceItems(
  input: InjectionProvenanceInput,
): KnowledgeItem[] {
  const items: KnowledgeItem[] = []
  const { selection, render, drops } = input

  // ── recalled ──────────────────────────────────────────────────────────────
  if (selection && selection.candidateSource === 'store' && selection.pool.length > 0) {
    items.push({
      type: 'knowledge',
      kind: 'experience',
      action: 'recalled',
      entryIds: selection.pool.map(c => c.entryId),
      query: selection.queryHash,
      operation: 'recall',
    })
  }

  // ── selected ──────────────────────────────────────────────────────────────
  if (selection && selection.pool.length > 0) {
    const selectedIds = new Set(selection.selectedEntryIds)

    const exclusions = selection.pool
      .filter(c => !selectedIds.has(c.entryId))
      .map(c => excluded(
        c,
        selection.judgementObtained
          // The judge sees the whole pool, threshold included, so its verdict
          // covers every unselected candidate regardless of local score.
          ? INJECTION_EXCLUSION_REASONS.NOT_SELECTED_BY_JUDGE
          : c.eligibleByThreshold
            ? INJECTION_EXCLUSION_REASONS.CROWDED_OUT_BY_RANK
            : INJECTION_EXCLUSION_REASONS.BELOW_SCORE_THRESHOLD,
      ))

    // Selected-then-refused is a different fact from never-selected, and it is
    // the one that hides a silent drop, so it is recorded even though the entry
    // also appears in entryIds.
    for (const rejected of selection.checkoutRejected) {
      exclusions.push(excluded(rejected, INJECTION_EXCLUSION_REASONS.SLOT_OVERSIZED))
    }

    items.push({
      type: 'knowledge',
      kind: 'experience',
      action: 'selected',
      // Everything the selector chose, including entries the pager then
      // refused. `selected` means selected; the refusal is a separate later
      // fact and appears as an exclusion, so an entry legitimately shows up in
      // both lists. Filtering it out here would hide the silent drop inside a
      // shorter list rather than reporting it.
      entryIds: selection.selectedEntryIds,
      query: selection.queryHash,
      operation: 'inject',
      ...(exclusions.length > 0
        ? { excludedCandidates: exclusions.slice(0, MAX_EXCLUDED_CANDIDATES) }
        : {}),
    })
  }

  // ── injected ──────────────────────────────────────────────────────────────
  const renderedEntries = (render?.rendered ?? [])
    .filter(slot => isUsableProvenance(slot.provenance))
    .slice(0, MAX_INJECTED_ENTRIES)

  if (render && renderedEntries.length > 0) {
    const dropExclusions = drops
      .filter(drop => isUsableProvenance(drop.provenance))
      .map(drop => excluded(
        drop.provenance!,
        drop.reason === 'oversized'
          ? INJECTION_EXCLUSION_REASONS.SLOT_OVERSIZED
          : INJECTION_EXCLUSION_REASONS.EVICTED_FOR_ROOM,
      ))

    const skipExclusions = render.skippedForBudget
      .filter(skipped => isUsableProvenance(skipped.provenance))
      .map(skipped => excluded(
        skipped.provenance!,
        INJECTION_EXCLUSION_REASONS.SKIPPED_FOR_BUDGET,
      ))

    const exclusions = [...dropExclusions, ...skipExclusions]

    items.push({
      type: 'knowledge',
      kind: 'experience',
      action: 'injected',
      entryIds: renderedEntries.map(slot => slot.provenance!.entryId),
      operation: 'inject',
      injected: renderedEntries.map((slot, index) => ({
        entryId:     slot.provenance!.entryId,
        contentHash: slot.provenance!.contentHash,
        // Empty by design: the store keeps no revision history, so there is no
        // chain to walk. A synthetic single-element chain would imply one
        // exists. contentHash already identifies the version.
        versionChain: [],
        selectorVersion: slot.provenance!.selectorVersion,
        // The query that retrieved this slot, which for a surviving slot is an
        // earlier turn's query — not this turn's.
        queryHash:   slot.provenance!.queryHash,
        // assignmentProbability is deliberately absent: the selector is
        // deterministic. Writing 1.0 would let a later off-policy analysis
        // mistake this for a logged propensity.
        slot:        index,
        order:       slot.order,
      })),
      ...(exclusions.length > 0
        ? { excludedCandidates: exclusions.slice(0, MAX_EXCLUDED_CANDIDATES) }
        : {}),
      // Both cover the whole rendered block, including slots with no knowledge
      // identity behind them (hardware profiles, query-analysis pages). They
      // describe the context that was assembled, not just the itemised entries,
      // which is what makes contextHash reconcilable against the prompt.
      contextHash: render.contentHash,
      tokenCost:   render.tokens,
    })
  }

  return items
}

// ─────────────────────────────────────────────────────────────────────────────
// Explicit knowledge tools (G0-3)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The second injection channel: the model asking for knowledge by hand.
 *
 * All six knowledge tools recorded `action: 'recalled'`, which is right for the
 * search tools and wrong for the load tools — `experience_load` puts an entire
 * entry, full report included, straight into the model's context. That is an
 * injection by any definition, and filing it as a recall meant a query for
 * "what was this run exposed to" silently skipped everything the model fetched
 * for itself.
 *
 * The search tools are not lightweight indexes either: `experience_search`
 * prints problem, solution, failure reason and workarounds for every hit. So a
 * search both recalls (a query ran) and injects (the bodies landed in context).
 * Those are two different facts about one call and both are recorded — with the
 * zero-hit case emitting only the recall, since nothing entered context.
 */

/** Prefix marking a selector that is the model itself rather than an algorithm. */
export const EXPLICIT_TOOL_SELECTOR_PREFIX = 'tool:'

/**
 * Short digest used for `queryHash` across every injection channel.
 *
 * Twelve hex characters, matching what the automatic path already writes, so
 * the two channels' query hashes are comparable rather than merely both
 * present. It identifies a query; it is not a security boundary.
 */
export function knowledgeQueryHash(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? ''
  return createHash('sha256').update(text).digest('hex').slice(0, 12)
}

export interface ExplicitToolInjectionInput {
  kind: 'experience' | 'principle' | 'anchor'
  /** Tool name, e.g. 'experience_load'. Becomes part of the selector identity. */
  tool: string
  /** The tool's raw input, hashed into queryHash. Never stored verbatim. */
  toolInput: unknown
  /** Entries whose bodies are present in `content`, in the order rendered. */
  entries: Array<{ entryId: string; contentHash: string }>
  /**
   * Exactly what the tool returns to the model.
   *
   * These tools declare no `maxResultSizeChars`, so ToolResultBudget leaves
   * them alone and this string is what reaches the context verbatim. If any of
   * them ever gains a size limit, this hash stops being what the model saw and
   * the emit point has to move downstream of truncation.
   */
  content: string
}

/**
 * Build the `injected` record for one explicit knowledge tool call.
 *
 * Returns an empty array when the call surfaced no entries, so a search that
 * found nothing produces no injection record — it still has its own `recalled`
 * item, emitted by the tool itself and deliberately left untouched.
 */
export function buildExplicitToolInjectionItems(
  input: ExplicitToolInjectionInput,
): KnowledgeItem[] {
  const usable = input.entries
    .filter(entry => entry.entryId && CONTENT_HASH_RE.test(entry.contentHash))
    .slice(0, MAX_INJECTED_ENTRIES)
  if (usable.length === 0) return []

  const queryHash = knowledgeQueryHash(input.toolInput)

  return [{
    type: 'knowledge',
    kind: input.kind,
    action: 'injected',
    entryIds: usable.map(entry => entry.entryId),
    operation: 'inject',
    injected: usable.map((entry, index) => ({
      entryId:     entry.entryId,
      contentHash: entry.contentHash,
      versionChain: [],
      // The model chose this entry, so the selector is the tool call itself.
      // Kept distinct from the automatic channel's selector versions: an
      // analysis that cannot separate "the system decided to show this" from
      // "the model went and fetched it" would credit the wrong mechanism.
      selectorVersion: `${EXPLICIT_TOOL_SELECTOR_PREFIX}${input.tool}`,
      queryHash,
      slot:  index,
      order: index,
    })),
    contextHash: createHash('sha256').update(input.content).digest('hex'),
    tokenCost:   estimateTokens(input.content),
  }]
}
