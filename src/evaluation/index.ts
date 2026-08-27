/**
 * Evaluation base (G1).
 *
 * The re-execution foundation: what a case *is* (`types`), where cases live
 * (`EvalSetStore`), and how a case's starting state is captured and restored
 * (`BaseSnapshot`).
 *
 * The comparison side — manifests, pre-registration, promotion blockers — lives
 * in `src/evolution` and is deliberately not re-exported here: one gate defines
 * what is compared, the other defines what a comparison is allowed to claim.
 *
 * Still to come in G1: evaluator bundles with an independent identity (G1-6),
 * the four-phase isolated runner (G1-7), and the metrics layer (G1-10).
 *
 * See docs/知识系统/自进化实施计划.md, gate G1.
 */
export * from './types.js'
export * from './BaseSnapshot.js'
export * from './EvalSetStore.js'
export * from './CorpusSurvey.js'
export * from './EvaluatorBundle.js'
export * from './EvalRunner.js'
export * from './Metrics.js'
export * from './PairedComparison.js'
export * from './CaseExtractor.js'
