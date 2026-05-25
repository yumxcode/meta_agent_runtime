Read and write session configuration stored in `.claude/settings.json`.

Actions:
- `get`   — read the value of a specific key (dot-notation supported, e.g. `model.default`)
- `set`   — write a value to a key (value may be any JSON-serialisable type)
- `list`  — return the entire settings object as pretty-printed JSON
- `delete` — remove a key from the settings

Settings are persisted to `<cwd>/.claude/settings.json`.
If the file does not exist it is created on the first `set`.

Use this tool to store per-project preferences, model overrides, tool defaults, or any
key-value data that should survive across turns.
