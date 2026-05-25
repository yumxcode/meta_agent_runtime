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
export function makeProvenanceId() {
    const uuid8 = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
    return `prov-${uuid8}`;
}
//# sourceMappingURL=types.js.map