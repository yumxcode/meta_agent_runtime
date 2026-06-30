Run a sub-agent synchronously and wait for its result before continuing.

Unlike spawn_sub_agent (async, returns a task_id immediately), run_agent blocks
until the sub-task completes and returns the final result.

When to use:
- When you need the sub-task result before taking the next step
- Short-running tasks (< 10 turns expected)
- Sequential workflows with data dependencies
- Code-producing tasks that should run in an isolated branch (workspace_mode: isolated_write)

When NOT to use:
- Tasks you can run in parallel — issue multiple spawn_sub_agent calls instead
- Tasks where failure should not block the main flow — use spawn_sub_agent
  (run_agent surfaces a failed sub-agent as an error)
- Literature / paper / web research — use `research_dispatch` instead, which
  reads sources in an isolated context and saves a report to disk
