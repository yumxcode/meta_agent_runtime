Execute a bash shell command. Returns stdout, stderr, and exit code.

Usage:
- command: the bash command to run
- timeout_ms: max execution time in ms (default: 30000, max: 120000)
- cwd: working directory (default: process.cwd())
- Large outputs are truncated to 100KB
- Avoid interactive commands requiring stdin
