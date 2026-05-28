Load or list skills from the user's skill library.

- `list` — show available skill names (no `name` needed)
- `load` — return the full content of a named skill

Skills are `.md` files in `~/.meta-agent/skills/<mode>/` (global) or `<projectDir>/.meta-agent/skills/` (project). Loading a skill injects its instructions into context.
