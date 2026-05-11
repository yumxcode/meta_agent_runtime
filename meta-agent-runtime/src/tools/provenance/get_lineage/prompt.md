Retrieve the full computation lineage (ancestor chain) for a provenance record.

Follows the parentProvenanceId links from the specified record back to the root
computation, returning the chain in chronological order (root first, most recent last).

Use this when you need to:
- Understand the full derivation path of a result (what earlier computations fed into it)
- Audit a multi-step analysis to verify each step was valid
- Find the original source data or boundary conditions behind a derived result
- Detect where a propagated error first entered the computation chain

Returns an array of provenance summaries from root to the specified record.
