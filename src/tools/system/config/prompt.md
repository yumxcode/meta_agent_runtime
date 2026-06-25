Read and write the layered runtime configuration. This is the SAME config the
runtime reads for model/provider selection — changes here actually take effect.

Config is merged across three layers (more specific wins):
- `global`  — `~/.meta-agent/config.json`               (applies everywhere)
- `project` — `<cwd>/.meta-agent/config.json`            (this workspace)
- `session` — in-memory overrides for the current run    (not persisted)

Actions:
- `get`    — read a key (dot-notation, e.g. `LLM.mainModel`). Omit `scope` for the merged effective value; pass `scope` to read one layer.
- `set`    — write a key. `scope` defaults to `project`. Value may be any JSON type.
- `list`   — dump the merged effective config, or one layer when `scope` is given.
- `delete` — remove a key from a layer (`scope` defaults to `project`).

Model / provider keys (live under the `LLM` section):
- `LLM.mainModel`, `LLM.fallbackModel`, `LLM.flashModel`, `LLM.compactModel`
- `LLM.apiKey`, `LLM.baseURL`
- `web_search.tavilyApiKey`

Example: `config set key=LLM.mainModel value="glm-4.7"` pins the main model for
this project.

IMPORTANT: model/provider keys are read once when a session starts, so a change
applies to the NEXT session, not the one currently running. Other keys (your own
bookkeeping) are readable immediately via `get`. The runtime ignores unknown
keys, so arbitrary per-project preferences can be stored here too.
