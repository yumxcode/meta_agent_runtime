Retrieve the full provenance record for a specific computation by its provenance ID.

Returns the complete audit trail including: tool name, fidelity level, input parameters,
output results, V&V validation findings, any artifacts produced, and the parent provenance
ID if this result was derived from an earlier computation.

Use this when you need to:
- Inspect exactly what inputs produced a given result
- Check which V&V hooks ran and whether any warnings were raised
- Trace a result back to the specific tool version and model that produced it
- Verify an earlier computation before building on it

The provenance ID is always appended to tool results in the format [provenance: prov-xxxxxxxxxxxx].
