Send input to a running shell session (see `exec_session`) and read what it produces.

Parameters:
- `session_id` — the id returned by `exec_session`.
- `input` — text written to the program's stdin. A trailing newline is added unless `raw: true`. Pass an EMPTY string to read more output without sending anything — this is how you keep watching a long-running command after a previous call yielded.
- `yield_time_ms` — how long to wait for output. The call returns early once the program goes quiet.
- `raw` — write `input` byte-for-byte with no trailing newline. Use for programs that read single keypresses or expect a precise byte sequence.
- `close_stdin` — close the input stream after writing. Use for programs that process stdin until EOF (`cat > file`, `sort`, a here-doc consumer).

Returns the output produced since the previous read.

Notes:
- Output is incremental: each call returns only what appeared since the last one, so you can poll a build without re-reading its whole log.
- Control characters work when sent with `raw: true`: send `\u0003` (Ctrl-C) to interrupt the running command while keeping the shell alive, `\u0004` (Ctrl-D) for EOF.
- If the session has exited, this returns an error — open a new one with `exec_session`. Writing to a dead session is never silently ignored.
