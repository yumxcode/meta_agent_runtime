Check whether an identical computation has already been performed in this session.

Provide the tool name and the exact input object you are about to pass.  The
system computes a SHA-256 hash of `input`, then searches existing provenance
records for records where both the hash and `tool_name` match.  If a duplicate
is found, the most recent matching record is returned so you can reuse its
result instead of running the tool again.

Required fields
---------------
- `tool_name` (string): The exact name of the tool you are about to call
  (e.g. `"battery_capacity_sim"`).
- `input` (object): The complete input object you would pass to that tool.
  Must match field-for-field — even a minor difference (e.g. a changed unit or
  added key) will produce a different hash and return `{ duplicate: false }`.

When to call this tool
-----------------------
- Before any expensive simulation or numerical tool call
- After a tool call fails, to check whether an earlier successful run used the
  same inputs (so you can recover the earlier result via its provenance ID)
- When you want to confirm a result is reproducible (same inputs → same hash →
  same provenance record)

Return value
------------
`{ duplicate: false }` — no identical call has been recorded for this tool.
Proceed with the tool call normally.

`{ duplicate: true, provenanceId, timestamp, summary }` — a matching record
exists.  You SHOULD use `provenanceId` to reference the earlier result rather
than repeating the computation.  Only re-run the tool if you have a specific
reason to believe the earlier result is stale or incorrect.
