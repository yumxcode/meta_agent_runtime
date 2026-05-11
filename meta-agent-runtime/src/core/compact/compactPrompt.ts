/**
 * Meta-Agent Compact Prompt
 *
 * Used by two paths:
 *   A. MetaAgentSession auto-compact (replaces conversation history when context fills)
 *   B. KernelBridge compact instructions (injected into CC's compact via system prompt)
 *
 * Differs from CC's compact (src/services/compact/prompt.ts) in three ways:
 *   1. Chapter 3 "Campaign State" replaces "Files and Code Sections"
 *   2. Chapter 4 "Computations and Results" is new — preserves provenance IDs verbatim
 *   3. Chapter 5 "V&V Events" replaces/extends "Errors and fixes"
 *
 * The <analysis> scratchpad pattern and NO_TOOLS preamble are identical to CC.
 */

import type { RuntimeContext } from '../../runtime/RuntimeContext.js'
import { MetaAgentContextStore } from '../../coordination/MetaAgentContextStore.js'
import type { CompactStateSnapshot } from './stateSnapshot.js'

// ─────────────────────────────────────────────────────────────────────────────
// Shared blocks (identical purpose to CC's equivalents)
// ─────────────────────────────────────────────────────────────────────────────

export const NO_TOOLS_PREAMBLE = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

- Do NOT call find_duplicate_computation, get_provenance, list_recent_results, or ANY other tool.
- You already have all the context you need in the conversation above.
- Tool calls will be REJECTED and will waste your only turn — you will fail the task.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.

`

const NO_TOOLS_TRAILER =
  '\n\nREMINDER: Do NOT call any tools. Respond with plain text only — ' +
  'an <analysis> block followed by a <summary> block. ' +
  'Tool calls will be rejected and you will fail the task.'

const DETAILED_ANALYSIS_INSTRUCTION = `Before providing your final summary, wrap your analysis in <analysis> tags. In your analysis:

1. Chronologically analyse each message and identify:
   - The user's explicit engineering requests and intents
   - Every tool call made, its provenance ID, and whether it passed V&V
   - Escalation decisions and their supporting evidence
   - V&V abort/warning events and how they were handled
2. Double-check that EVERY provenance ID (prov-xxx) appearing in the conversation is captured in Chapter 4.
3. Verify that the Optional Next Step quotes verbatim from the most recent messages.`

// ─────────────────────────────────────────────────────────────────────────────
// Meta-Agent Compact Prompt (10 chapters)
// ─────────────────────────────────────────────────────────────────────────────

const METAAGENT_COMPACT_BODY = `Your task is to create a detailed summary of this engineering session so that work can continue without losing any computational context.

${DETAILED_ANALYSIS_INSTRUCTION}

Your summary MUST include the following sections:

1. Primary Request and Intent
   Capture all of the user's explicit engineering requests and intents in detail.

2. Key Technical Concepts
   List all important engineering concepts, DOE strategies, simulation tools, domain constants, and frameworks discussed.

3. Campaign State
   [Skip this section entirely if no engineering campaign was active.]
   - Campaign ID, project name, and current phase
   - Timeline: how and why the campaign reached its current phase (escalation decisions with numerical evidence, e.g. "L0 Pareto hypervolume 0.73 < threshold 0.85 → escalate to L1")
   - Current Pareto front: number of non-dominated designs, objective values of key trade-off points
   - Next intended action for the campaign

4. Computations and Results  ← CRITICAL: include every provenance ID verbatim
   List EVERY tool call recorded in this session. Format each as:
     [prov-xxx] tool_name(key=val, key=val, ...) → ✓/⚠/✗  fidelity=L0/L1/L2
   These IDs are required to query computation history after compaction.
   Do NOT summarise or omit any ID — they are permanent handles to disk-persisted records.
   After compaction: use \`get_provenance(<id>)\` to recall a specific record, or
   \`list_recent_results\` to search by tool name or time range.

5. V&V Events
   List all validation/verification events:
   - PRE-CALL ABORTs: [prov-xxx] tool_name — which hook triggered, what was wrong, how resolved
   - POST-CALL ABORTs: [prov-xxx] tool_name — raw output issue, alternative action taken
   - WARNINGs: [prov-xxx] tool_name — concern raised, whether result was used with caveats

6. Problem Solving
   Document engineering problems solved and any ongoing troubleshooting efforts.

7. All user messages
   List ALL user messages verbatim (not tool results), up to the most recent 30.
   If more than 30 exist, include the first 2 and then the most recent 28.
   These are critical for understanding intent and direction changes.

8. Pending Tasks
   Outline any pending tasks explicitly requested by the user.

9. Current Work
   Describe precisely what was being worked on immediately before this compaction, including the most recent tool call and its result.

10. Optional Next Step
    The next step DIRECTLY in line with the user's most recent explicit request.
    IMPORTANT: include direct verbatim quotes from the most recent messages showing exactly what was being worked on.
    For campaign work, include the current phase name and the last provenance ID referenced.

Here is the required output structure:

<example>
<analysis>
[Chronological analysis covering all provenance IDs and key decisions]
</analysis>

<summary>
1. Primary Request and Intent:
   [Detail]

2. Key Technical Concepts:
   - [Concept]

3. Campaign State:
   Campaign: my-battery-project (ID: camp-abc) | Phase: PARETO_READY_L1
   Reached via: L0 complete (24 pts) → hypervolume 0.73 < 0.85 threshold → user approved L1 escalation
   Pareto front (L1): 3 non-dominated designs; best trade-off at capacity=4.2 Ah, η=0.91
   Next action: review L1 Pareto, decide escalate-L2 or report

4. Computations and Results:
   [prov-a1b2c3] battery_capacity_sim(capacity=4.2, temp=25) → ✓  fidelity=L0
   [prov-d4e5f6] battery_capacity_sim(capacity=4.5, temp=35) → ⚠  fidelity=L0
   [prov-g7h8i9] surrogate_eval(design_id=42) → ✓  fidelity=L1

5. V&V Events:
   ⚠ [prov-d4e5f6] battery_capacity_sim — POST-CALL WARNING: efficiency 1.12 > 1.0 (physical limit); used with caveat pending L1 confirmation

6. Problem Solving:
   [Description]

7. All user messages:
   - "Run DOE for battery optimisation, capacity 4–5 Ah, temperature 20–40 °C"
   - "Approve L1 escalation"

8. Pending Tasks:
   - Review L1 Pareto front and decide escalation path

9. Current Work:
   Reviewing L1 Pareto front results. Last computation: [prov-g7h8i9] surrogate_eval returned 3 non-dominated designs.

10. Optional Next Step:
    Present L1 Pareto front to user and ask: "Escalate to L2 or proceed to REPORTING?"
    (From most recent message: "Approve L1 escalation")
</summary>
</example>

Please provide your summary based on the conversation, following this structure with precision.
`

// ─────────────────────────────────────────────────────────────────────────────
// Public: full compact prompt for MetaAgentSession path
// ─────────────────────────────────────────────────────────────────────────────

export function getMetaAgentCompactPrompt(): string {
  return NO_TOOLS_PREAMBLE + METAAGENT_COMPACT_BODY + NO_TOOLS_TRAILER
}

// ─────────────────────────────────────────────────────────────────────────────
// Public: parse compact summary (strips <analysis> scratchpad)
// ─────────────────────────────────────────────────────────────────────────────

export function formatCompactSummary(raw: string): string {
  // Strip analysis scratchpad
  let out = raw.replace(/<analysis>[\s\S]*?<\/analysis>/, '')

  // Unwrap <summary> tags
  const match = out.match(/<summary>([\s\S]*?)<\/summary>/)
  if (match) {
    out = out.replace(/<summary>[\s\S]*?<\/summary>/, `Summary:\n${(match[1] ?? '').trim()}`)
  }

  return out.replace(/\n\n+/g, '\n\n').trim()
}

// ─────────────────────────────────────────────────────────────────────────────
// Public: ## Compact Instructions block for KernelBridge path
//
// CC's compact prompt explicitly checks for "## Compact Instructions" in the
// conversation context and follows those instructions when compacting.
// KernelBridge appends this to its system prompt so CC's auto-compact
// preserves provenance IDs and campaign state.
// ─────────────────────────────────────────────────────────────────────────────

export async function buildCompactInstructions(
  rtx: RuntimeContext | undefined,
  sessionId: string,
  sessionStartMs: number,
  /** Optional pre-compact snapshot — used to fill records produced during the
   *  current turn that aren't yet reflected in the live provenanceTracker
   *  query (race condition: compact fires mid-turn). */
  snapshot: CompactStateSnapshot | null = null,
  /**
   * Pre-fetched provenance records (Fix #10).  When the caller has already
   * queried the tracker (e.g. KernelBridge fetches them to build the snapshot),
   * pass them here to avoid a redundant list() call inside this function.
   * When omitted, the function fetches them itself.
   */
  prefetchedRecords?: Awaited<ReturnType<NonNullable<RuntimeContext['provenanceTracker']>['list']>>,
): Promise<string> {
  const lines: string[] = [
    '## Compact Instructions',
    '',
    'When compacting this conversation, in addition to the standard sections, always include:',
    '',
    '**Computations and Results** (CRITICAL — do not omit any provenance ID):',
    'List every tool call as: [prov-xxx] tool_name(key_params) → ✓/⚠/✗ fidelity=L0/L1/L2',
    '',
    '**V&V Events**:',
    'List all PRE-CALL ABORTs, POST-CALL ABORTs, and WARNINGs with their provenance IDs.',
    '',
    '**Campaign State** (if a campaign is active):',
    'Include phase, escalation decisions with numerical evidence, and current Pareto summary.',
    '',
    '**Optional Next Step** must include verbatim quotes from the most recent messages.',
  ]

  // ── Provenance records ────────────────────────────────────────────────────
  //
  // Strategy: collect live records from the tracker, then backfill any IDs
  // present in the snapshot but NOT in the live list (these are records produced
  // after _buildEnrichedSuffix() ran — the snapshot was written more recently).

  const liveLines: string[] = []
  const seenIds = new Set<string>()

  if (rtx?.provenanceTracker) {
    try {
      // Use pre-fetched records when available to avoid a redundant list() call
      // (Fix #10: KernelBridge._buildEnrichedSuffix already fetches them for
      // the snapshot; passing them here eliminates a second round-trip).
      const records = prefetchedRecords
        ?? await rtx.provenanceTracker.list({ since: sessionStartMs })
      for (const r of records) {
        seenIds.add(r.id)
        const vv = r.validationResults.some(v => !v.passed) ? '✗'
          : r.validationResults.some(v => v.severity === 'warning') ? '⚠'
          : '✓'
        const inputSummary = Object.entries(r.input ?? {})
          .slice(0, 3)
          .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
          .join(', ')
        liveLines.push(`  [${r.id}] ${r.toolName}(${inputSummary}) → ${vv} fidelity=L${r.fidelityLevel}`)
      }
    } catch { /* swallow — compact instructions are advisory */ }
  }

  // Backfill from snapshot: records the live tracker doesn't know about yet
  const snapshotLines: string[] = []
  if (snapshot && snapshot.provenanceRecords.length > 0) {
    for (const r of snapshot.provenanceRecords) {
      if (!seenIds.has(r.id)) {
        snapshotLines.push(
          `  [${r.id}] ${r.toolName}(${r.inputSummary}) → ${r.vv} fidelity=L${r.fidelityLevel}  ` +
          `[from snapshot@${new Date(snapshot.capturedAt).toISOString().slice(11, 16)}Z]`,
        )
      }
    }
  }

  if (liveLines.length > 0 || snapshotLines.length > 0) {
    lines.push('', 'Current session provenance records (must all appear in the compact):')
    lines.push(...liveLines)
    if (snapshotLines.length > 0) {
      lines.push('  [snapshot backfill — produced after compact instructions were built:]')
      lines.push(...snapshotLines)
    }
  }

  // ── Campaign state ────────────────────────────────────────────────────────
  //
  // Prefer live context store; fall back to snapshot if available.

  let campaignLines: string[] = []
  try {
    const ctx = await MetaAgentContextStore.read()
    if (ctx && ctx.activeCampaigns.length > 0) {
      campaignLines = ctx.activeCampaigns.map(
        c => `  Campaign "${c.projectName ?? c.campaignId}" | Phase: ${c.phase}`,
      )
    }
  } catch { /* swallow */ }

  if (campaignLines.length === 0 && snapshot && snapshot.activeCampaigns.length > 0) {
    campaignLines = snapshot.activeCampaigns.map(
      c => `  Campaign "${c.projectName ?? c.campaignId}" | Phase: ${c.phase}  [from snapshot]`,
    )
  }

  if (campaignLines.length > 0) {
    lines.push('', 'Current campaign state (must appear in Campaign State section):')
    lines.push(...campaignLines)
  }

  return lines.join('\n')
}
