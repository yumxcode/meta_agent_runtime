Switch the session into **plan mode**.

In plan mode every tool call that has side-effects (writes, shell commands, MCP mutations) requires explicit user approval before it executes. Read-only tools (read_file, glob, grep, web_fetch, etc.) are unaffected and continue to run freely.

Use plan mode when you want to show the user what you intend to do before committing any changes.  
Call `exit_plan_mode` to return to normal execution.
