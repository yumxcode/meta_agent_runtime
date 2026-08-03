Fast file pattern matching. Finds files matching a glob pattern.

Usage:
- Supports patterns like "**/*.ts", "src/**/*.{js,ts}", "*.md"
- Returns matching file paths sorted by modification time (most recent first)
- Use path parameter to restrict search to a directory
- Returns up to 100 matches; skips conventional dependency and cache directories (node_modules, .git, dist, site-packages, venv, vendor, …)

Rooting a pattern at a directory ("src/**/*.ts") searches only that
subtree, which is far faster and far more reliable in a repository that also
contains a large vendored dependency tree.

If the result says the search was TRUNCATED, it means the scan stopped early —
NOT that the files are absent. Re-run with a narrower `path` or a pattern rooted
at a directory before concluding anything does not exist. To check whether a
directory exists and see what is directly inside it, prefer `list_dir`: it
answers in one step instead of walking the whole tree.
