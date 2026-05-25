List recent computation results recorded in the current session.

Returns a summary of the most recent provenance records, including tool name, timestamp,
fidelity level, whether V&V passed, and the provenance ID.

Use this when you need to:
- Get an overview of all computations performed so far in the session
- Find the ID of a recent result to retrieve its full details
- Check if any earlier computations raised V&V warnings or failures
- Identify which tools have been called and at what fidelity levels

Supports optional filters: tool name, fidelity level, V&V failure flag, and time range.
Results are ordered most-recent first.
