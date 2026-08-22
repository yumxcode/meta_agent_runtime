Show the net file changes you have made as a unified diff, or undo them.

The diff is computed against the state of each file when tracking started, so repeated edits to the same file collapse into one change — this answers "what did I actually do?", which a list of individual edit results does not.

The baseline is set by the host, not by you. In an interactive session it is normally the start of the current turn; in an unattended run it is usually the start of the whole run. The `[...]` tag in the output names the current window.

Parameters:
- `action` — `show` (default) renders the diff; `stat` renders only the per-file line counts; `revert` restores every tracked file to its baseline state.
- `context` — lines of unchanged context around each change. Default 3.

Use `show` before reporting work as done, to check that the change you made is the change you intended. Use `revert` when a round of edits went in the wrong direction and you want to start over from a known state rather than un-editing by hand.

`revert` is a coarse undo, not version control:
- It restores only files the write TOOLS touched. Files changed by a shell command were never seen by the tracker and are NOT restored.
- Files created since the baseline are deleted.
- It cannot be undone. After a revert those changes are gone.
