Run a sub-agent synchronously and wait for its result before continuing.

Unlike spawn_sub_agent (async, returns taskId immediately), run_agent blocks
until the sub-task completes and returns the final result.

When to use:
- When you need the sub-task result before taking the next step
- Short-running tasks (< 10 turns expected)
- Sequential workflows with data dependencies

When NOT to use:
- Long-running tasks (> 5 minutes) — use spawn_sub_agent instead
- Tasks you can run in parallel — use multiple spawn_sub_agent calls
- Tasks where failure should not block the main flow
