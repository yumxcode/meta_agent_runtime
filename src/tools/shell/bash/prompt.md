Execute a bash shell command. Returns stdout, stderr, and exit code.

Usage:
- command: the bash command to run
- timeout_ms: max execution time in ms (default: 30000, max: 120000)
- cwd: working directory (default: process.cwd())
- Large outputs are truncated to 100KB
- Avoid interactive commands requiring stdin
- For long-running commands (large pip/npm installs, compilation/builds, big downloads, etc.) always pass an explicit `timeout_ms` (up to 120000); the default 30000 will kill the process mid-command.
- For `git pull` / `git push`, prefer SSH over HTTPS — SSH is faster.
