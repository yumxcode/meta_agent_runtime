Fast file pattern matching. Finds files matching a glob pattern.

Usage:
- Supports patterns like "**/*.ts", "src/**/*.{js,ts}", "*.md"
- Returns matching file paths sorted by modification time (most recent first)
- Use path parameter to restrict search to a directory
- Returns up to 100 results; skips node_modules, .git, dist
