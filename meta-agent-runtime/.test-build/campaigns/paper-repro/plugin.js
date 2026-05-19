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
const PAPER_REPRO_PHASE_LABELS = {
    SEARCH: 'Searching for paper',
    ACCESS: 'Obtaining full text',
    PARSE: 'Parsing model & equations',
    PLAN: 'Awaiting reproduction plan approval',
    ENV_SETUP: 'Setting up environment (Docker)',
    IMPLEMENT: 'Implementing reproduction code',
    CODE_REVIEW: 'Awaiting code review',
    BASELINE_RUN: 'Running baseline case',
    SWEEP_RUN: 'Running parameter sweep',
    VALIDATE: 'Validating results',
    REPORT: 'Generating reproduction report',
    DONE: 'Reproduction complete',
    BLOCKED: 'Reproduction blocked',
};
const PAPER_REPRO_TRANSITIONS = {
    SEARCH: ['ACCESS', 'BLOCKED'],
    ACCESS: ['PARSE', 'BLOCKED'],
    PARSE: ['PLAN', 'BLOCKED'],
    PLAN: ['ENV_SETUP', 'BLOCKED'], // human approves → ENV_SETUP
    ENV_SETUP: ['IMPLEMENT', 'BLOCKED'],
    IMPLEMENT: ['CODE_REVIEW', 'BLOCKED'],
    CODE_REVIEW: ['BASELINE_RUN', 'IMPLEMENT', 'BLOCKED'], // human may send back
    BASELINE_RUN: ['SWEEP_RUN', 'VALIDATE', 'BLOCKED'], // skip sweep if paper has none
    SWEEP_RUN: ['VALIDATE', 'BLOCKED'],
    VALIDATE: ['REPORT', 'BLOCKED'],
    REPORT: ['DONE'],
    DONE: [],
    BLOCKED: ['SEARCH'], // restart from scratch if unblocked
};
const PAPER_REPRO_HUMAN_CHECKPOINTS = ['PLAN', 'CODE_REVIEW'];
const PAPER_REPRO_MACHINE_PHASES = [
    'SEARCH', 'ACCESS', 'PARSE', 'ENV_SETUP', 'IMPLEMENT',
    'BASELINE_RUN', 'SWEEP_RUN', 'VALIDATE', 'REPORT',
];
const paperReproPhaseDefinition = {
    initial: 'SEARCH',
    terminal: ['DONE', 'BLOCKED'],
    humanCheckpoints: PAPER_REPRO_HUMAN_CHECKPOINTS,
    machinePhases: PAPER_REPRO_MACHINE_PHASES,
    transitions: PAPER_REPRO_TRANSITIONS,
    labels: PAPER_REPRO_PHASE_LABELS,
};
// ─────────────────────────────────────────────────────────────────────────────
// Phase guidance strings
// ─────────────────────────────────────────────────────────────────────────────
const PAPER_REPRO_PHASE_GUIDANCE = {
    SEARCH: (`Search for the paper using DOI, title, or author+year. ` +
        `Try: Semantic Scholar, CrossRef, arXiv, Google Scholar. ` +
        `Record the DOI and canonical title before transitioning to ACCESS.`),
    ACCESS: (`Attempt to obtain the full text in this order: ` +
        `(1) open-access URL from CrossRef/Unpaywall, ` +
        `(2) arXiv preprint, ` +
        `(3) institutional proxy (if configured). ` +
        `If inaccessible, transition to BLOCKED with a clear reason.`),
    PARSE: (`Extract: key equations (LaTeX), numeric parameters with units, numerical method, ` +
        `software dependencies, and any ambiguous/missing information. ` +
        `Be conservative — flag anything unclear rather than assuming.`),
    PLAN: (`A reproduction plan has been prepared. ` +
        `Review the confirmed vs assumed parameters, target figures, and acceptance criteria. ` +
        `Approve the plan to proceed to environment setup, or request clarifications.`),
    ENV_SETUP: (`Create a Docker image with pinned dependencies (requirements.lock). ` +
        `Verify the environment runs a smoke-test import before proceeding. ` +
        `Record the exact docker image tag and requirements hash in state.`),
    IMPLEMENT: (`Implement the reproduction script following the plan exactly. ` +
        `Write unit tests for each equation / sub-model. ` +
        `Do NOT tune parameters to match results — use only confirmed/assumed values from PARSE.`),
    CODE_REVIEW: (`The implementation is ready for review. ` +
        `Check: (1) equations match the paper, (2) assumed parameters are disclosed, ` +
        `(3) unit tests pass. Approve to proceed to BASELINE_RUN, or return to IMPLEMENT.`),
    BASELINE_RUN: (`Run the baseline case from the paper. ` +
        `Record reproduced vs paper-reported values for each target metric. ` +
        `Do NOT modify code or parameters to improve agreement.`),
    SWEEP_RUN: (`Run the parameter sweeps described in the paper (if any). ` +
        `Record all results with provenance IDs. ` +
        `Transition to VALIDATE when all sweeps complete.`),
    VALIDATE: (`Compute signed % deviation for each metric. ` +
        `Apply acceptance criteria (default ±10%). ` +
        `For rejections, document root-cause hypotheses (mesh size, compiler diff, random seed). ` +
        `Proceed to REPORT regardless of pass/fail — partial reproduction is a valid outcome.`),
    REPORT: (`Generate the final reproduction report covering: ` +
        `Paper summary → Reproduction plan → Environment → Implementation → ` +
        `Results table (reproduced vs paper, deviation %) → Verdict → Limitations. ` +
        `Cite provenance IDs for all runs.`),
};
// ─────────────────────────────────────────────────────────────────────────────
// Capsule builder
// ─────────────────────────────────────────────────────────────────────────────
function buildPaperReproCapsule(state, phase) {
    const phaseLabel = PAPER_REPRO_PHASE_LABELS[phase];
    const paper = state.paper;
    const lines = [
        `### Paper Reproduction — ${phaseLabel}`,
        '',
        `**Paper:** ${paper.title} (${paper.year})`,
        paper.doi ? `**DOI:** ${paper.doi}` : `**Authors:** ${paper.authors.join(', ')}`,
        `**Access:** ${paper.accessStatus}`,
    ];
    if (state.reproductionPlan) {
        const plan = state.reproductionPlan;
        lines.push('', `**Targets:** ${plan.targetFigures.join(', ')}`, `**Confirmed params:** ${plan.confirmedParameters.length} | ` +
            `**Assumed:** ${plan.assumedParameters.length}`);
    }
    if (state.simulationResults.length > 0) {
        const passed = state.simulationResults.filter(r => r.acceptable).length;
        const total = state.simulationResults.length;
        lines.push('', `**Validation:** ${passed}/${total} cases within acceptance band`);
    }
    if (state.deviationSummary) {
        lines.push(`**Verdict:** ${state.deviationSummary.overallVerdict.toUpperCase()}`);
    }
    if (PAPER_REPRO_HUMAN_CHECKPOINTS.includes(phase)) {
        lines.push('', `> ⏸ **Awaiting your approval** before the campaign continues.`);
    }
    if (PAPER_REPRO_MACHINE_PHASES.includes(phase)) {
        lines.push('', `> ⚙ Machine phase — background work in progress.`);
    }
    if (phase === 'BLOCKED' && state.failureReason) {
        lines.push('', `> ❌ **Blocked:** ${state.failureReason}`);
    }
    return lines.join('\n');
}
// ─────────────────────────────────────────────────────────────────────────────
// Plugin implementation
// ─────────────────────────────────────────────────────────────────────────────
export const paperReproCampaignPlugin = {
    // ── Identity ───────────────────────────────────────────────────────────────
    type: 'paper-repro',
    version: '1.0.0',
    displayName: 'Paper Reproduction',
    description: 'Systematic reproduction of battery/engineering simulation papers with V&V.',
    // ── Phase topology ─────────────────────────────────────────────────────────
    phases: paperReproPhaseDefinition,
    // ── State lifecycle ────────────────────────────────────────────────────────
    createInitialState(params) {
        const title = String(params['title'] ?? 'Unknown paper');
        const authors = Array.isArray(params['authors'])
            ? params['authors'].map(String)
            : [];
        const year = typeof params['year'] === 'number' ? params['year'] : new Date().getFullYear();
        return {
            paper: {
                doi: params['doi'],
                title,
                authors,
                year,
                journal: params['journal'],
                accessStatus: 'unknown',
            },
            simulationResults: [],
            notes: [],
        };
    },
    validateState(raw) {
        if (!raw || typeof raw !== 'object')
            return false;
        const s = raw;
        return (typeof s['paper'] === 'object' &&
            s['paper'] !== null &&
            typeof s['paper']['title'] === 'string' &&
            Array.isArray(s['simulationResults']) &&
            Array.isArray(s['notes']));
    },
    migrateState(oldState, fromVersion) {
        // v1.0.0 → future: add any new required fields with defaults
        console.warn(`[paperReproCampaignPlugin] Migrating state from version ${fromVersion}`);
        const s = oldState;
        return {
            paper: s.paper ?? { title: 'Unknown', authors: [], year: 0, accessStatus: 'unknown' },
            simulationResults: s.simulationResults ?? [],
            notes: s.notes ?? [],
            extractedModel: s.extractedModel,
            reproductionPlan: s.reproductionPlan,
            environment: s.environment,
            implementation: s.implementation,
            deviationSummary: s.deviationSummary,
            failureReason: s.failureReason,
        };
    },
    // ── Context engineering ────────────────────────────────────────────────────
    buildCapsule: buildPaperReproCapsule,
    buildPhaseGuidance(phase, _state) {
        return PAPER_REPRO_PHASE_GUIDANCE[phase] ?? '';
    },
    // ── Tools ──────────────────────────────────────────────────────────────────
    // Paper-repro-specific tools (paper access, environment setup) will be
    // implemented in a follow-up and registered here.
    tools: [],
};
//# sourceMappingURL=plugin.js.map