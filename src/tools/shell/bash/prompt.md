Execute a bash shell command. Returns stdout, stderr, and exit code.

Usage:
- command: the bash command to run
- timeout_ms: max execution time in ms (default 30000; the enforced maximum is shown in this tool's schema and follows `timeouts.toolMs`)
- cwd: working directory (default: process.cwd())
- Large outputs are truncated to 100KB
- Avoid interactive commands requiring stdin
- For long-running commands (large pip/npm installs, compilation/builds, big downloads, etc.) always pass an explicit `timeout_ms`; the default 30000 will kill the process mid-command.
- NEVER wait inside a command (`sleep 180 && …`). The sleep burns this call's
  entire timeout, the command after `&&` never runs, and the whole call is
  killed. To wait for external work, call the `sleep` tool and then issue the
  check as a SEPARATE bash call — each gets its own full timeout.
- For `git pull` / `git push`, prefer SSH over HTTPS — SSH is faster.
