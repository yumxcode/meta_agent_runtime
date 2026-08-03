List what is directly inside a directory. One step, exact answer.

Usage:
- Pass `path` (relative paths resolve against the workspace root)
- Directories are listed first, with how many entries each contains; files show their size
- Returns up to 200 entries

Use this — not `glob` — to answer "does this directory exist" and "what is in
it". `glob` walks the whole tree to answer, which is slow and can stop early in
a repository that also contains large vendored dependency directories.

This tool distinguishes three outcomes that a pattern search cannot:
- `Directory does not exist: …` — a definite negative you may act on
- `Directory exists but is EMPTY: …` — present, nothing inside
- a listing — present, with contents

Before recording that a file or directory is missing, confirm it here.
