Load a skill from the `.claude/skills/` directory and return its contents.

Skills are Markdown (`.md`) files that contain specialised instructions, templates,
or domain knowledge.  Loading a skill injects its content into context so you can
follow its guidance for the current task.

Actions:
- `list`  — list all available skill names (no `name` required)
- `load`  — read and return the full contents of a named skill

Skill files are looked up at `<cwd>/.claude/skills/<name>.md` (and also
`<cwd>/.claude/skills/<name>/SKILL.md` for directory-style skills).
