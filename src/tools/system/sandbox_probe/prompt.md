Report the sandbox policy actually in effect for this session: which external
paths are granted, which environment variables survive the child-process
filter, which `toolAccess` presets applied, and what was silently dropped.

Read-only. Executes nothing, spawns nothing, and reveals no credential VALUES —
environment variables are reported as set/unset only.

Use this when a command that works in the user's own terminal fails inside the
session, before speculating about the cause. Typical answers it gives directly:

- a configured path was dropped because it does not exist on this host
- a `toolAccess` preset was narrowed away because the mode is autonomous
- an environment variable is on the credential blocklist and no config can forward it
- a config file was never loaded (wrong filename, wrong directory)
- a preset needs network egress but `sandbox.network` is `none`

Optional `verbose` (boolean) additionally prints each preset's rationale and the
full expansion of every granted preset.
