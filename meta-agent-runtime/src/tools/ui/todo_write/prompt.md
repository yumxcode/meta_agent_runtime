Create and manage a structured task list for tracking progress.

Usage:
- todos: complete list of todos (replaces the current list on each call)
- Each todo: { id: string, content: string, status: "pending"|"in_progress"|"completed", priority: "high"|"medium"|"low" }
- Use proactively for complex multi-step tasks (3+ steps)
- Mark in_progress BEFORE starting work; completed when done
- Only one todo should be in_progress at a time
