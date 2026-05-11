/**
 * DOE Campaign Plugin
 *
 * Wraps the existing CampaignStateStore / CapsuleBuilder infrastructure
 * so that DOE campaigns participate in the CampaignPlugin framework
 * without any changes to those files.
 *
 * The DOE plugin uses its OWN CampaignStateStore for persistence —
 * GenericCampaignStore is NOT used here.  That means all existing DOE
 * code (Monitor, Coordinator, ParetoAnalyzer) continues to work unchanged.
 *
 * What the plugin provides to the framework:
 *  - buildCapsule()       → delegates to CapsuleBuilder (moved inline)
 *  - buildPhaseGuidance() → returns the PHASE_GUIDANCE strings from dynamicPrompt
 *  - tools                → empty here; DOE tools are registered separately by
 *                           the Coordinator when it creates the DOE session
 *  - phases               → derived from VALID_TRANSITIONS / PHASE_LABELS / sets
 */

import type { CampaignPlugin } from '../../campaign/types.js'
import {
  CampaignPhase,
  VALID_TRANSITIONS,
  PHASE_LABELS,
  MACHINE_PHASES,
  USER_CHECKPOINT_PHASES,
  DesignSpace,
} from '../../coordination/types.js'

// ─────────────────────────────────────────────────────────────────────────────
// DOE business state (what the DOE plugin stores as its TState)
//
// For the DOE campaign the "state" lives in CampaignStateStore, NOT in
// GenericCampaignStore.  So DOEBusinessState is only used as the TState
// type param to satisfy the CampaignPlugin interface; the framework never
// actually serialises it through GenericPersistedState.
// ─────────────────────────────────────────────────────────────────────────────

export interface DOEBusinessState {
  designSpace: DesignSpace
  sampledPointCount: number
  completedPointCount: number
  failedPointCount: number
  pendingPointCount: number
  paretoFrontSize: number
  hypervolume: number | null
  failureReason?: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase guidance strings (extracted from dynamicPrompt.ts — single source of truth)
// ─────────────────────────────────────────────────────────────────────────────

const DOE_PHASE_GUIDANCE: Partial<Record<CampaignPhase, string>> = {
  SAMPLING: (
    `Focus on calling simulation tools to generate design-point evaluations. ` +
    `Check \`find_duplicate_computation\` before each call. ` +
    `Report sampling progress; do not attempt Pareto analysis yet.`
  ),
  EVALUATING_L0: (
    `L0 evaluation is running in the background. ` +
    `Do not call additional simulation tools. ` +
    `If the user asks for status, report that evaluation is in progress.`
  ),
  ESCALATING_L1: (
    `L1 escalation is running in the background. ` +
    `Do not call additional simulation tools. ` +
    `Await \`PARETO_READY_L1\` before taking further action.`
  ),
  ESCALATING_L2: (
    `L2 escalation is running in the background. ` +
    `Do not call additional simulation tools. ` +
    `Await \`PARETO_READY_L2\` before taking further action.`
  ),
  PARETO_READY_L0: (
    `L0 Pareto front is ready. Review the Pareto summary in campaign_context. ` +
    `Decide whether to escalate to L1, proceed directly to REPORTING, or request additional samples. ` +
    `Present the Pareto evidence to the user before acting.`
  ),
  PARETO_READY_L1: (
    `L1 Pareto front is ready. Review the updated Pareto summary. ` +
    `Decide whether to escalate to L2 or proceed to REPORTING. ` +
    `Present the Pareto evidence and get user acknowledgment before escalating to L2.`
  ),
  PARETO_READY_L2: (
    `L2 Pareto front is ready. This is the highest fidelity available. ` +
    `Compile findings into an engineering report and transition to REPORTING.`
  ),
  REPORTING: (
    `Compile all campaign results into a structured engineering report: ` +
    `Objectives → DOE Setup → Results (Pareto table) → Recommended Designs → Conclusions. ` +
    `Cite provenance IDs for all key results.`
  ),
}

// ─────────────────────────────────────────────────────────────────────────────
// DOE Campaign Plugin
// ─────────────────────────────────────────────────────────────────────────────

export const doeCampaignPlugin: CampaignPlugin<CampaignPhase, DOEBusinessState> = {
  // ── Identity ───────────────────────────────────────────────────────────────
  type:        'doe',
  version:     '1.0.0',
  displayName: 'DOE Engineering Optimization',
  description: 'Multi-fidelity Design-of-Experiments campaign with Pareto front analysis.',

  // ── Phase topology ─────────────────────────────────────────────────────────
  phases: {
    initial:          'IDLE',
    terminal:         ['DONE', 'FAILED'],
    humanCheckpoints: [...USER_CHECKPOINT_PHASES] as CampaignPhase[],
    machinePhases:    [...MACHINE_PHASES] as CampaignPhase[],
    transitions:      VALID_TRANSITIONS,
    labels:           PHASE_LABELS,
  },

  // ── State lifecycle ────────────────────────────────────────────────────────

  createInitialState(params: Record<string, unknown>): DOEBusinessState {
    return {
      designSpace: (params['designSpace'] ?? { variables: [], objectives: [], constraints: [] }) as DesignSpace,
      sampledPointCount:   0,
      completedPointCount: 0,
      failedPointCount:    0,
      pendingPointCount:   0,
      paretoFrontSize:     0,
      hypervolume:         null,
    }
  },

  validateState(raw: unknown): raw is DOEBusinessState {
    if (!raw || typeof raw !== 'object') return false
    const s = raw as Record<string, unknown>
    return (
      typeof s['sampledPointCount']   === 'number' &&
      typeof s['completedPointCount'] === 'number' &&
      typeof s['failedPointCount']    === 'number' &&
      typeof s['pendingPointCount']   === 'number' &&
      typeof s['paretoFrontSize']     === 'number'
    )
  },

  // No migrateState — DOE state lives in CampaignStateStore, not here.

  // ── Context engineering ────────────────────────────────────────────────────

  buildCapsule(state: DOEBusinessState, phase: CampaignPhase): string {
    const phaseLabel = PHASE_LABELS[phase]
    const total = state.sampledPointCount
    const done  = state.completedPointCount
    const fail  = state.failedPointCount
    const pend  = state.pendingPointCount

    const lines: string[] = [
      `### DOE Campaign — ${phaseLabel}`,
      '',
      `| Metric | Value |`,
      `|--------|-------|`,
      `| Sampled points | ${total} |`,
      `| Completed | ${done} |`,
      `| Pending | ${pend} |`,
      `| Failed | ${fail} |`,
      `| Pareto front size | ${state.paretoFrontSize} |`,
    ]

    if (state.hypervolume !== null) {
      lines.push(`| Hypervolume | ${state.hypervolume.toFixed(4)} |`)
    }

    if (USER_CHECKPOINT_PHASES.has(phase)) {
      lines.push('', `> ⏸ **Awaiting your decision** before the campaign continues.`)
    }

    if (MACHINE_PHASES.has(phase)) {
      lines.push('', `> ⚙ Background job running — no action needed.`)
    }

    if (phase === 'FAILED' && state.failureReason) {
      lines.push('', `> ❌ **Failure:** ${state.failureReason}`)
    }

    return lines.join('\n')
  },

  buildPhaseGuidance(phase: CampaignPhase, _state: DOEBusinessState): string {
    return DOE_PHASE_GUIDANCE[phase] ?? ''
  },

  // ── Tools ──────────────────────────────────────────────────────────────────

  // DOE tools are registered by the Coordinator at campaign-session start,
  // not statically here.  Keeping this empty avoids circular imports between
  // the plugin and the tool implementations.
  tools: [],
}
