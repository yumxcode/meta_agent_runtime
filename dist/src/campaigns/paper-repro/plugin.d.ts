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
import type { CampaignPlugin } from '../../campaign/types.js';
export type PaperReproPhase = 'SEARCH' | 'ACCESS' | 'PARSE' | 'PLAN' | 'ENV_SETUP' | 'IMPLEMENT' | 'CODE_REVIEW' | 'BASELINE_RUN' | 'SWEEP_RUN' | 'VALIDATE' | 'REPORT' | 'DONE' | 'BLOCKED';
export interface PaperInfo {
    /** Digital Object Identifier — may be unknown at SEARCH phase */
    doi?: string;
    title: string;
    authors: string[];
    year: number;
    journal?: string;
    /** 'open' | 'institutional' | 'unpaywall' | 'manual' | 'inaccessible' */
    accessStatus: string;
    /** Absolute path to local PDF, once obtained */
    pdfPath?: string;
    /** URL used to obtain the paper (for provenance) */
    sourceUrl?: string;
}
export interface ExtractedModel {
    /** Key equations as LaTeX strings */
    equations: string[];
    /** Extracted numeric parameters with units and values */
    parameters: Array<{
        name: string;
        value: number | string;
        unit?: string;
        source: string;
    }>;
    /** e.g. 'finite-difference', 'Runge-Kutta-4', 'DFT', 'MD' */
    numericalMethod: string;
    /** pip / conda / system dependencies identified in the paper */
    softwareDependencies: string[];
    /** Fields where the paper is ambiguous or silent */
    missingInfo: string[];
}
export interface ReproductionPlan {
    /** Parameters whose values are explicitly stated in the paper */
    confirmedParameters: string[];
    /** Parameters assumed from domain knowledge (must be disclosed in report) */
    assumedParameters: Array<{
        name: string;
        assumedValue: number | string;
        rationale: string;
    }>;
    /** Figure/table numbers from the paper that this reproduction targets */
    targetFigures: string[];
    /** Per-metric acceptance thresholds (default: 10%) */
    acceptanceCriteria: Array<{
        metric: string;
        maxDeviationPct: number;
    }>;
    /** Human approval timestamp */
    approvedAt?: string;
}
export interface EnvironmentSpec {
    dockerImage: string;
    /** Path to pip requirements.lock or conda environment.lock */
    requirementsLockPath: string;
    /** True once `docker run ... python -c "import ..."` passes */
    setupVerified: boolean;
    setupLog?: string;
}
export interface ImplementationArtifact {
    /** Path to main reproduction script relative to campaign dir */
    codeFilePath: string;
    /** True once `pytest` passes on unit tests */
    unitTestsPassed: boolean;
    /** Notes from human code review */
    reviewNotes?: string;
    /** Sub-agent task ID that ran the implementation */
    implementSubAgentId?: string;
}
export interface SimulationResult {
    /** Links to ProvenanceTracker run */
    provenanceId: string;
    /** e.g. 'Fig3a_thermal_profile' */
    caseLabel: string;
    /** The value reproduced in this run */
    reproduced: number;
    /** The value reported in the paper */
    paperReported: number;
    /** Signed % deviation: (reproduced - paperReported) / |paperReported| * 100 */
    deviationPct: number;
    /** True if |deviationPct| ≤ acceptanceCriteria[metric].maxDeviationPct */
    acceptable: boolean;
    unit?: string;
    notes?: string;
}
export interface DeviationSummary {
    /** 'pass' | 'partial' | 'fail' */
    overallVerdict: string;
    acceptedCases: string[];
    rejectedCases: string[];
    /** Hypotheses for cases outside the acceptance band */
    rootCauseHypotheses: string[];
}
export interface PaperReproState {
    paper: PaperInfo;
    extractedModel?: ExtractedModel;
    reproductionPlan?: ReproductionPlan;
    environment?: EnvironmentSpec;
    implementation?: ImplementationArtifact;
    simulationResults: SimulationResult[];
    deviationSummary?: DeviationSummary;
    /** Free-form notes accumulated throughout the campaign */
    notes: string[];
    /** Human-readable reason when phase === 'BLOCKED' */
    failureReason?: string;
}
export declare const paperReproCampaignPlugin: CampaignPlugin<PaperReproPhase, PaperReproState>;
//# sourceMappingURL=plugin.d.ts.map