Execute a bash shell command. Returns stdout, stderr, and exit code.

Usage:
- command: the bash command to run
- timeout_ms: max execution time in ms (default: 30000, max: 120000)
- cwd: working directory (default: process.cwd())
- Large outputs are truncated to 100KB
- Avoid interactive commands requiring stdin
- 对耗时命令（大体积 pip/npm 安装、编译构建、大文件下载等）务必显式传 `timeout_ms`（可至 120000）；默认 30000 会在命令中途杀掉进程。
