Execute a PowerShell command. Windows only. Returns stdout, stderr, and exit code.

Usage:
- command: the PowerShell command to run
- timeout_ms: max execution time in ms (default: 30000, max: 120000)
- cwd: working directory (default: workspace root; must stay inside the workspace)
- Runs with -NoProfile -NonInteractive; avoid commands that prompt for input
- Output is capped at a 10MB buffer; exceeding it fails the command
- For long-running commands (large installs, builds, big downloads, etc.) always pass an explicit `timeout_ms` (up to 120000); the default 30000 will kill the process mid-command.
