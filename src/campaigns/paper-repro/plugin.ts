/**
 * PaperRepro Campaign Plugin
 *
 * Systematic paper reproduction campaign for battery / engineering domain papers.
 *
 * Phase flow:
 *   SEARCH → ACCESS → PARSE → PLAN (human) → ENV_SETUP → IMPLEMENT
 *     → CODE_REVIEW (human) → BASELINE_RUN → SWEEP_RUN → VALIDATE
 *     → REPORT → DONE
 *                         (any phase) → BLOCKED
 *
 * Human checkpoints: PLAN, CODE_REVIEW
 * Machine phases:    SEARCH, ACCESS, PARSE, ENV_SETUP, IMPLEMENT,
 *                    BASELINE_RUN, SWEEP_RUN, VALIDATE, REPORT
 *
 * V&V acceptance criterion: ±10% deviation per key metric (configurable).
 * Systematic deviations are documented rather than treated as failures.
 *
 * Environment isolation: Docker image + requirements.lock for reproducibility.
 */

import type { CampaignPlugin, PhaseDefinition } from '../../campaign/types.js'

// ─────────────────────────────────────────────────────────────────────────────
// Phase definition
// ─────────────────────────────────────────────────────────────────────────────

export type PaperReproPhase =
  | 'SEARCH'       // locate paper (DOI, title, journal search)
  | 'ACCESS'       // obtain full text (open access, library, institutional)
  | 'PARSE'        // extract model equations, parameters, numerical method
  | 'PLAN'         // human checkpoint — confirm reproduction plan
  | 'ENV_SETUP'    // create Docker image + requirements.lock
  | 'IMPLEMENT'    // write reproduction code, unit tests
  | 'CODE_REVIEW'  // human checkpoint — review implementation
  | 'BASELINE_RUN' // run paper's baseline case, compare vs paper values
  | 'SWEEP_RUN'    // run parameter sweeps if paper has sensitivity analysis
  | 'VALIDATE'     // compute deviations, decide pass/fail per metric
  | 'REPORT'       // generate final reproduction report
  | 'DONE'         // campaign complete
  | 'BLOCKED'      // campaign blocked (paper inaccessible, model unclear, etc.)

const PAPER_REPRO_PHASE_LABELS: Record<PaperReproPhase, string> = {
  SEARCH:       'Searching for paper',
  ACCESS:       'Obtaining full text',
  PARSE:        'Parsing model & equations',
  PLAN:         'Awaiting reproduction plan approval',
  ENV_SETUP:    'Setting up environment (Docker)',
  IMPLEMENT:    'Implementing reproduction code',
  CODE_REVIEW:  'Awaiting code review',
  BASELINE_RUN: 'Running baseline case',
  SWEEP_RUN:    'Running parameter sweep',
  VALIDATE:     'Validating results',
  REPORT:       'Generating reproduction report',
  DONE:         'Reproduction complete',
  BLOCKED:      'Reproduction blocked',
}

const PAPER_REPRO_TRANSITIONS: Partial<Record<PaperReproPhase, readonly PaperReproPhase[]>> = {
  SEARCH:       ['ACCESS',       'BLOCKED'],
  ACCESS:       ['PARSE',        'BLOCKED'],
  PARSE:        ['PLAN',         'BLOCKED'],
  PLAN:         ['ENV_SETUP',    'BLOCKED'],  // human approves → ENV_SETUP
  ENV_SETUP:    ['IMPLEMENT',    'BLOCKED'],
  IMPLEMENT:    ['CODE_REVIEW',  'BLOCKED'],
  CODE_REVIEW:  ['BASELINE_RUN', 'IMPLEMENT', 'BLOCKED'],  // human may send back
  BASELINE_RUN: ['SWEEP_RUN', 'VALIDATE', 'BLOCKED'],      // skip sweep if paper has none
  SWEEP_RUN:    ['VALIDATE',     'BLOCKED'],
  VALIDATE:     ['REPORT',       'BLOCKED'],
  REPORT:       ['DONE'],
  DONE:         [],
  BLOCKED:      ['SEARCH'],  // restart from scratch if unblocked
}

const PAPER_REPRO_HUMAN_CHECKPOINTS: readonly PaperReproPhase[] = ['PLAN', 'CODE_REVIEW']

const PAPER_REPRO_MACHINE_PHASES: readonly PaperReproPhase[] = [
  'SEARCH', 'ACCESS', 'PARSE', 'ENV_SETUP', 'IMPLEMENT',
  'BASELINE_RUN', 'SWEEP_RUN', 'VALIDATE', 'REPORT',
]

const paperReproPhaseDefinition: PhaseDefinition<PaperReproPhase> = {
  initial:          'SEARCH',
  terminal:         ['DONE', 'BLOCKED'],
  humanCheckpoints: PAPER_REPRO_HUMAN_CHECKPOINTS,
  machinePhases:    PAPER_REPRO_MACHINE_PHASES,
  transitions:      PAPER_REPRO_TRANSITIONS,
  labels:           PAPER_REPRO_PHASE_LABELS,
}

// ─────────────────────────────────────────────────────────────────────────────
// Business state
// ─────────────────────────────────────────────────────────────────────────────

export interface PaperInfo {
  /** Digital Object Identifier — may be unknown at SEARCH phase */
  doi?: string
  title: string
  authors: string[]
  year: number
  journal?: string
  /** 'open' | 'institutional' | 'unpaywall' | 'manual' | 'inaccessible' */
  accessStatus: string
  /** Absolute path to local PDF, once obtained */
  pdfPath?: string
  /** URL used to obtain the paper (for provenance) */
  sourceUrl?: string
}

export interface ExtractedModel {
  /** Key equations as LaTeX strings */
  equations: string[]
  /** Extracted numeric parameters with units and values */
  parameters: Array<{ name: string; value: number | string; unit?: string; source: string }>
  /** e.g. 'finite-difference', 'Runge-Kutta-4', 'DFT', 'MD' */
  numericalMethod: string
  /** pip / conda / system dependencies identified in the paper */
  softwareDependencies: string[]
  /** Fields where the paper is ambiguous or silent */
  missingInfo: string[]
}

export interface ReproductionPlan {
  /** Parameters whose values are explicitly stated in the paper */
  confirmedParameters: string[]
  /** Parameters assumed from domain knowledge (must be disclosed in report) */
  assumedParameters: Array<{ name: string; assumedValue: number | string; rationale: string }>
  /** Figure/table numbers from the paper that this reproduction targets */
  targetFigures: string[]
  /** Per-metric acceptance thresholds (default: 10%) */
  acceptanceCriteria: Array<{ metric: string; maxDeviationPct: number }>
  /** Human approval timestamp */
  approvedAt?: string
}

export interface EnvironmentSpec {
  dockerImage: string
  /** Path to pip requirements.lock or conda environment.lock */
  requirementsLockPath: string
  /** True once `docker run ... python -c "import ..."` passes */
  setupVerified: boolean
  setupLog?: string
}

export interface ImplementationArtifact {
  /** Path to main reproduction script relative to campaign dir */
  codeFilePath: string
  /** True once `pytest` passes on unit tests */
  unitTestsPassed: boolean
  /** Notes from human code review */
  reviewNotes?: string
  /** Sub-agent task ID that ran the implementation */
  implementSubAgentId?: string
}

export interface SimulationResult {
  /** Links to ProvenanceTracker run */
  provenanceId: string
  /** e.g. 'Fig3a_thermal_profile' */
  caseLabel: string
  /** The value reproduced in this run */
  reproduced: number
  /** The value reported in the paper */
  paperReported: number
  /** Signed % deviation: (reproduced - paperReported) / |paperReported| * 100 */
  deviationPct: number
  /** True if |deviationPct| ≤ acceptanceCriteria[metric].maxDeviationPct */
  acceptable: boolean
  unit?: string
  notes?: string
}

export interface DeviationSummary {
  /** 'pass' | 'partial' | 'fail' */
  overallVerdict: string
  acceptedCases: string[]
  rejectedCases: string[]
  /** Hypotheses for cases outside the acceptance band */
  rootCauseHypotheses: string[]
}

export interface PaperReproState {
  paper: PaperInfo
  extractedModel?: ExtractedModel
  reproductionPlan?: ReproductionPlan
  environment?: EnvironmentSpec
  implementation?: ImplementationArtifact
  simulationResults: SimulationResult[]
  deviationSummary?: DeviationSummary
  /** Free-form notes accumulated throughout the campaign */
  notes: string[]
  /** Human-readable reason when phase === 'BLOCKED' */
  failureReason?: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase guidance strings
// ─────────────────────────────────────────────────────────────────────────────

const PAPER_REPRO_PHASE_GUIDANCE: Partial<Record<PaperReproPhase, string>> = {
  SEARCH: (
    `Search for the paper using DOI, title, or author+year. ` +
    `Try: Semantic Scholar, CrossRef, arXiv, Google Scholar. ` +
    `Record the DOI and canonical title before transitioning to ACCESS.`
  ),
  ACCESS: (
    `Attempt to obtain the full text in this order: ` +
    `(1) open-access URL from CrossRef/Unpaywall, ` +
    `(2) arXiv preprint, ` +
    `(3) institutional proxy (if configured). ` +
    `If inaccessible, transition to BLOCKED with a clear reason.`
  ),
  PARSE: (
    `Extract: key equations (LaTeX), numeric parameters with units, numerical method, ` +
    `software dependencies, and any ambiguous/missing information. ` +
    `Be conservative — flag anything unclear rather than assuming.`
  ),
  PLAN: (
    `A reproduction plan has been prepared. ` +
    `Review the confirmed vs assumed parameters, target figures, and acceptance criteria. ` +
    `Approve the plan to proceed to environment setup, or request clarifications.`
  ),
  ENV_SETUP: (
    `Create a Docker image with pinned dependencies (requirements.lock). ` +
    `Verify the environment runs a smoke-test import before proceeding. ` +
    `Record the exact docker image tag and requirements hash in state.`
  ),
  IMPLEMENT: (
    `Implement the reproduction script following the plan exactly. ` +
    `Write unit tests for each equation / sub-model. ` +
    `Do NOT tune parameters to match results — use only confirmed/assumed values from PARSE.`
  ),
  CODE_REVIEW: (
    `The implementation is ready for review. ` +
    `Check: (1) equations match the paper, (2) assumed parameters are disclosed, ` +
    `(3) unit tests pass. Approve to proceed to BASELINE_RUN, or return to IMPLEMENT.`
  ),
  BASELINE_RUN: (
    `Run the baseline case from the paper. ` +
    `Record reproduced vs paper-reported values for each target metric. ` +
    `Do NOT modify code or parameters to improve agreement.`
  ),
  SWEEP_RUN: (
    `Run the parameter sweeps described in the paper (if any). ` +
    `Record all results with provenance IDs. ` +
    `Transition to VALIDATE when all sweeps complete.`
  ),
  VALIDATE: (
    `Compute signed % deviation for each metric. ` +
    `Apply acceptance criteria (default ±10%). ` +
    `For rejections, document root-cause hypotheses (mesh size, compiler diff, random seed). ` +
    `Proceed to REPORT regardless of pass/fail — partial reproduction is a valid outcome.`
  ),
  REPORT: (
    `Generate the final reproduction report covering: ` +
    `Paper summary → Reproduction plan → Environment → Implementation → ` +
    `Results table (reproduced vs paper, deviation %) → Verdict → Limitations. ` +
    `Cite provenance IDs for all runs.`
  ),
}

// ─────────────────────────────────────────────────────────────────────────────
// Capsule builder
// ─────────────────────────────────────────────────────────────────────────────

function buildPaperReproCapsule(state: PaperReproState, phase: PaperReproPhase): string {
  const phaseLabel = PAPER_REPRO_PHASE_LABELS[phase]
  const paper = state.paper

  const lines: string[] = [
    `### Paper Reproduction — ${phaseLabel}`,
    '',
    `**Paper:** ${paper.title} (${paper.year})`,
    paper.doi ? `**DOI:** ${paper.doi}` : `**Authors:** ${paper.authors.join(', ')}`,
    `**Access:** ${paper.accessStatus}`,
  ]

  if (state.reproductionPlan) {
    const plan = state.reproductionPlan
    lines.push(
      '',
      `**Targets:** ${plan.targetFigures.join(', ')}`,
      `**Confirmed params:** ${plan.confirmedParameters.length} | ` +
        `**Assumed:** ${plan.assumedParameters.length}`,
    )
  }

  if (state.simulationResults.length > 0) {
    const passed = state.simulationResults.filter(r => r.acceptable).length
    const total  = state.simulationResults.length
    lines.push('', `**Validation:** ${passed}/${total} cases within acceptance band`)
  }

  if (state.deviationSummary) {
    lines.push(`**Verdict:** ${state.deviationSummary.overallVerdict.toUpperCase()}`)
  }

  if (PAPER_REPRO_HUMAN_CHECKPOINTS.includes(phase)) {
    lines.push('', `> ⏸ **Awaiting your approval** before the campaign continues.`)
  }

  if (PAPER_REPRO_MACHINE_PHASES.includes(phase)) {
    lines.push('', `> ⚙ Machine phase — background work in progress.`)
  }

  if (phase === 'BLOCKED' && state.failureReason) {
    lines.push('', `> ❌ **Blocked:** ${state.failureReason}`)
  }

  return lines.join('\n')
}

// ─────────────────────────────────────────────────────────────────────────────
// Plugin implementation
// ─────────────────────────────────────────────────────────────────────────────

export const paperReproCampaignPlugin: CampaignPlugin<PaperReproPhase, PaperReproState> = {
  // ── Identity ───────────────────────────────────────────────────────────────
  type:        'paper-repro',
  version:     '1.0.0',
  displayName: 'Paper Reproduction',
  description: 'Systematic reproduction of battery/engineering simulation papers with V&V.',

  // ── Phase topology ─────────────────────────────────────────────────────────
  phases: paperReproPhaseDefinition,

  // ── State lifecycle ────────────────────────────────────────────────────────

  createInitialState(params: Record<string, unknown>): PaperReproState {
    const title   = String(params['title']   ?? 'Unknown paper')
    const authors = Array.isArray(params['authors'])
      ? (params['authors'] as unknown[]).map(String)
      : []
    const year = typeof params['year'] === 'number' ? params['year'] : new Date().getFullYear()

    return {
      paper: {
        doi:          params['doi'] as string | undefined,
        title,
        authors,
        year,
        journal:      params['journal'] as string | undefined,
        accessStatus: 'unknown',
      },
      simulationResults: [],
      notes: [],
    }
  },

  validateState(raw: unknown): raw is PaperReproState {
    if (!raw || typeof raw !== 'object') return false
    const s = raw as Record<string, unknown>
    return (
      typeof s['paper'] === 'object' &&
      s['paper'] !== null &&
      typeof (s['paper'] as Record<string, unknown>)['title'] === 'string' &&
      Array.isArray(s['simulationResults']) &&
      Array.isArray(s['notes'])
    )
  },

  migrateState(oldState: unknown, fromVersion: string): PaperReproState {
    // v1.0.0 → future: add any new required fields with defaults
    console.warn(`[paperReproCampaignPlugin] Migrating state from version ${fromVersion}`)
    const s = oldState as Partial<PaperReproState>
    return {
      paper:             s.paper ?? { title: 'Unknown', authors: [], year: 0, accessStatus: 'unknown' },
      simulationResults: s.simulationResults ?? [],
      notes:             s.notes ?? [],
      extractedModel:    s.extractedModel,
      reproductionPlan:  s.reproductionPlan,
      environment:       s.environment,
      implementation:    s.implementation,
      deviationSummary:  s.deviationSummary,
      failureReason:     s.failureReason,
    }
  },

  // ── Context engineering ────────────────────────────────────────────────────

  buildCapsule: buildPaperReproCapsule,

  buildPhaseGuidance(phase: PaperReproPhase, _state: PaperReproState): string {
    return PAPER_REPRO_PHASE_GUIDANCE[phase] ?? ''
  },

  // ── Tools ──────────────────────────────────────────────────────────────────

  // Paper-repro-specific tools (paper access, environment setup) will be
  // implemented in a follow-up and registered here.
  tools: [],
}
