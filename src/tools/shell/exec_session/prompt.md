Start a PERSISTENT shell session and keep it alive across tool calls.

Unlike `bash` (which spawns a fresh shell, runs one command, and exits), a session keeps its process, its working directory, its environment and its running programs between calls. Use `write_stdin` to send more input to it and `close_session` to end it.

Use a session when:
- You need a REPL — `python3 -u -i`, `node`, `sqlite3`, a device console — where the next input depends on the previous output.
- Shell state must persist: `cd`, `export`, `source venv/bin/activate`, an interactive login.
- A command runs longer than a single tool call comfortably allows (a build, a test suite, a training run) and you want to watch it progress instead of waiting for one final blob.

Use `bash` instead when the command is self-contained and you only want its output. It is simpler and leaves nothing running.

Parameters:
- `command` — optional first input, sent as if typed at the prompt (a trailing newline is added). Omit it to open an idle shell.
- `cwd` — starting directory. Must be inside the workspace. Defaults to the workspace root.
- `shell` — program to run. Defaults to `bash`. Set it to run a REPL directly, e.g. `python3` with `shell_args: ["-u", "-i"]`.
- `shell_args` — argv for `shell`.
- `yield_time_ms` — how long to wait for output before returning. The call returns EARLY once the program goes quiet, so a small value costs nothing for fast commands. Raise it when you expect a slow first result.
- `label` — a short name to make `close_session` listings readable.

Returns the `session_id` you must pass to `write_stdin` / `close_session`, followed by whatever the session produced within the yield window.

One exception to the early return: a command that prints NOTHING (`cd`, `export`) has no output to go quiet after, so it waits out the whole `yield_time_ms`. Pass a small value (100–300) for commands you expect to be silent.

Important — sessions use pipes, not a terminal:
- Programs that block-buffer their output when stdout is not a TTY will appear silent. Run Python as `python3 -u`, or prefix with `stdbuf -oL`. This is the most common cause of "the session produced no output".
- Full-screen / TTY programs (`top`, `vim`, `less`) will not render usefully. Do not use them here.

If the read window elapses while the program is still running, the result says so; call `write_stdin` with an empty `input` to keep reading. When the process exits, the result reports the exit code and the session can no longer be written to.
