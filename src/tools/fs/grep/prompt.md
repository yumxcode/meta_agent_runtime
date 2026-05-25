Search file contents using regular expressions. Uses ripgrep (rg) when available, falls back to Node.js.

Usage:
- pattern: regular expression to search for
- path: file or directory to search (default: cwd)
- glob: glob pattern to filter files (e.g. "*.ts")
- output_mode: "content" (matching lines with line numbers), "files_with_matches" (file paths, default), "count"
- context: lines of context around each match
- case_insensitive: case-insensitive matching
- head_limit: max results to return (default: 250)
