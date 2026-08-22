End a persistent shell session, or list the sessions you have open.

Parameters:
- `session_id` — the session to terminate. Omit it to list your open sessions instead of closing anything.

Closing kills the whole process group, so anything the session started — background jobs, a build, a training run — is terminated with it. There is no way to detach a running program from its session; if it must outlive the session, start it with `nohup`/`setsid` and redirect its output to a file.

Close sessions you are done with. They hold a live process and a share of the per-agent session limit; when that limit is reached, opening a new session evicts the least recently used one.
