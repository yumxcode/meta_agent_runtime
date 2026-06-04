Propose a durable memory about the **user** — their profile/preferences or feedback on how you should work. The entry is queued for human review and is NOT saved until the user approves it via the `/memory review` command.

Memory stores only two kinds of information:

- `user` — the user's role, background, technical depth, and preferred way of collaborating. Save when you learn who they are or how they like to work.
- `feedback` — the user's corrections or confirmations about your approach (record both). Use the body structure: **规则:** core rule. **原因:** why. **适用范围:** when it applies.

Call this when you learn something durable about the user that should persist across future sessions — e.g. "I'm a robotics control engineer", or "don't merge sub-agent code without my approval".

Do NOT use memory for engineering knowledge. Successes/failures, algorithm pitfalls, tuning records, domain facts, computation results, and task state all have dedicated systems (ExperienceStore via `experience_write`, provenance, project docs, the auto-injected context sections) — never memory. Proposals with a disallowed `type` are rejected.

Before proposing: nothing is written immediately. The user reviews every proposal and decides whether to commit, edit, or discard it.
