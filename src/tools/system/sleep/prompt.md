Pause the current turn for a fixed delay, then continue.

Usage:
- duration_ms: milliseconds to sleep (max 1800000 = 30 minutes)
- This is the ONLY sanctioned way to wait longer than a shell command's timeout.
  Do NOT write `bash("sleep 180 && …")`: the bash tool clamps its own timeout,
  so a shell sleep longer than that limit is killed every time and the command
  after `&&` never runs.
- To poll long-running external work (CI run, training job, remote experiment):
  call `sleep`, then issue the check as a SEPARATE tool call. Each call gets its
  own full timeout that way, and the wait stays interruptible.
- Prefer the longest single sleep that fits the expected wait over many short
  ones — each poll cycle costs a model round trip.
- The wait is abortable: Ctrl+C (or any mid-turn interrupt) ends it immediately
  and reports how long it had waited, so nothing is stuck.
- Do not use sleep to wait for remote training expected to take longer than 1 hour;
  in plain Auto mode, use self_timer so the session is durably parked and resumed.
  `self_timer` is not available in interactive modes (robotics, agentic) — there,
  wait in `sleep`-sized steps and re-check between them.
