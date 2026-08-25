/**
 * Evolution contracts (G0).
 *
 * Mostly pure contracts: no store, no behaviour change. They exist ahead of
 * their consumers so that the two decisions most likely to drift under schedule
 * pressure are facts in code rather than prose in a document:
 *
 *   - an LLM judge is not a reward (`EvaluatorTrust`);
 *   - auditable is not the same as usable (`Eligibility`).
 *
 * `InjectionProvenance` is the exception that proves the gate is moving: it is
 * still a pure function, but it has a live caller (RoboticsSession) and its
 * output reaches disk. It records what was injected; it changes nothing about
 * what gets injected.
 *
 * See docs/知识系统/自进化实施计划.md, gate G0.
 */
export * from './EvaluatorTrust.js'
export * from './Eligibility.js'
export * from './ArtifactRegistry.js'
export * from './ExperimentManifest.js'
export * from './RiskTier.js'
export * from './InjectionProvenance.js'
