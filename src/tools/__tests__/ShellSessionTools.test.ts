/**
 * exec_session / write_stdin / close_session — the tool layer.
 *
 * The store has its own tests; this file covers what the TOOLS add on top:
 * input validation, owner scoping via ToolCallContext, the rendering contract
 * (a caller must be able to tell "exited" from "still running" from "output was
 * dropped"), and the promise that adding these tools changes nothing about the
 * one-shot `bash` path.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MetaAgentTool, ToolCallContext } from '../../core/types.js'
import { createExecSessionTool } from '../shell/exec_session/index.js'
import { createWriteStdinTool } from '../shell/write_stdin/index.js'
import { createCloseSessionTool } from '../shell/close_session/index.js'
import { createShellTools } from '../shell/index.js'
import { resetShellSessionStore } from '../../infra/exec/ShellSessionStore.js'

let workspace: string
let execSession: MetaAgentTool
let writeStdin: MetaAgentTool
let closeSession: MetaAgentTool

function ctx(overrides: Partial<ToolCallContext> = {}): ToolCallContext {
  return {
    sessionId: 'sess-1',
    agentId: 'agent-1',
    abortSignal: new AbortController().signal,
    workspaceRoot: workspace,
    ...overrides,
  }
}

/** Pull the `session_id: sh_xxxx` header out of an exec_session result. */
function sessionIdOf(content: string): string {
  const m = /session_id: (\S+)/.exec(content)
  if (!m) throw new Error(`no session_id in: ${content}`)
  return m[1] as string
}

beforeEach(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'session-tools-'))
  ;[execSession, writeStdin, closeSession] = await Promise.all([
    createExecSessionTool(),
    createWriteStdinTool(),
    createCloseSessionTool(),
  ])
})

afterEach(() => {
  resetShellSessionStore()
  rmSync(workspace, { recursive: true, force: true })
})

describe('exec_session', () => {
  it('returns a session id and the first command output', async () => {
    const res = await execSession.call(
      { command: 'echo hello-from-session', yield_time_ms: 3_000 },
      ctx(),
    )
    expect(res.isError).toBe(false)
    expect(res.content).toMatch(/session_id: sh_/)
    expect(res.content).toContain('hello-from-session')
  })

  it('opens an idle shell when no command is given', async () => {
    const res = await execSession.call({ yield_time_ms: 200 }, ctx())
    expect(res.isError).toBe(false)
    const id = sessionIdOf(res.content)

    const after = await writeStdin.call(
      { session_id: id, input: 'echo later', yield_time_ms: 3_000 },
      ctx(),
    )
    expect(after.content).toContain('later')
  })

  it('runs a non-bash program directly (the REPL case)', async () => {
    const res = await execSession.call(
      {
        shell: 'bash',
        shell_args: ['-c', 'read line; echo "got:$line"'],
        yield_time_ms: 300,
      },
      ctx(),
    )
    const id = sessionIdOf(res.content)
    const reply = await writeStdin.call(
      { session_id: id, input: 'ping', yield_time_ms: 3_000 },
      ctx(),
    )
    expect(reply.content).toContain('got:ping')
  })

  it('rejects a cwd outside the workspace without leaking a session', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'outside-'))
    try {
      const res = await execSession.call({ cwd: outside, yield_time_ms: 100 }, ctx())
      expect(res.isError).toBe(true)
      expect(res.content).toMatch(/outside the workspace/)

      // The failed open must not leave a live process nobody can address: the
      // caller never learned an id, so nothing could ever close it.
      const list = await closeSession.call({}, ctx())
      expect(list.content).toContain('No open shell sessions')
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('rejects a malformed shell_args instead of silently ignoring it', async () => {
    const res = await execSession.call({ shell_args: [1, 2], yield_time_ms: 100 }, ctx())
    expect(res.isError).toBe(true)
    expect(res.content).toMatch(/shell_args/)
  })

  it('declares the kernel command guards so it cannot be a softer path than bash', () => {
    // Losing commandField here would make exec_session a way to run a command
    // the bash tool's sensitive-command detection would have stopped.
    expect(execSession.permission?.commandField).toBe('command')
    expect(execSession.permission?.cwdField).toBe('cwd')
    expect(execSession.permission?.requiresWorkspace).toBe(true)
    expect(execSession.permission?.sensitive).toBe(true)
    expect(execSession.permission?.sandbox).toBeDefined()
  })
})

describe('write_stdin', () => {
  it('adds a trailing newline so the shell actually runs the line', async () => {
    // Without this a command sits in the shell's line buffer forever, which is
    // indistinguishable from a hung session.
    const open = await execSession.call({ yield_time_ms: 200 }, ctx())
    const id = sessionIdOf(open.content)
    const res = await writeStdin.call(
      { session_id: id, input: 'echo no-newline-needed', yield_time_ms: 3_000 },
      ctx(),
    )
    expect(res.content).toContain('no-newline-needed')
  })

  it('reads more output with an empty input', async () => {
    const open = await execSession.call(
      { command: 'sleep 0.4; echo delayed', yield_time_ms: 100 },
      ctx(),
    )
    const id = sessionIdOf(open.content)
    expect(open.content).not.toContain('delayed')

    const more = await writeStdin.call(
      { session_id: id, input: '', yield_time_ms: 4_000 },
      ctx(),
    )
    expect(more.content).toContain('delayed')
  })

  it('reads the final output of a session that has already exited', async () => {
    // A pure read must not be rejected just because the process is gone — the
    // last thing a command printed is often the thing the caller needs most.
    const open = await execSession.call(
      { command: 'echo last-words; exit 3', yield_time_ms: 3_000 },
      ctx(),
    )
    const id = sessionIdOf(open.content)
    const res = await writeStdin.call({ session_id: id, input: '', yield_time_ms: 500 }, ctx())
    expect(res.isError).toBe(false)
    expect(res.content).toMatch(/exited with code 3/)
  })

  it('errors when writing into an exited session', async () => {
    const open = await execSession.call({ command: 'exit 0', yield_time_ms: 3_000 }, ctx())
    const id = sessionIdOf(open.content)
    const res = await writeStdin.call(
      { session_id: id, input: 'echo zombie', yield_time_ms: 500 },
      ctx(),
    )
    expect(res.isError).toBe(true)
    expect(res.content).toMatch(/has exited/)
  })

  it('validates its inputs', async () => {
    expect((await writeStdin.call({}, ctx())).isError).toBe(true)
    expect((await writeStdin.call({ session_id: 42 }, ctx())).isError).toBe(true)
    expect(
      (await writeStdin.call({ session_id: 'sh_x', input: 5 }, ctx())).isError,
    ).toBe(true)
  })

  it('returns an actionable error for an unknown session', async () => {
    const res = await writeStdin.call(
      { session_id: 'sh_nope', input: 'x', yield_time_ms: 100 },
      ctx(),
    )
    expect(res.isError).toBe(true)
    expect(res.content).toMatch(/no such shell session/)
  })

  it('delivers EOF with close_stdin', async () => {
    const open = await execSession.call(
      { shell: 'bash', shell_args: ['-c', 'wc -l'], yield_time_ms: 200 },
      ctx(),
    )
    const id = sessionIdOf(open.content)
    await writeStdin.call({ session_id: id, input: 'a\nb\nc', yield_time_ms: 100 }, ctx())
    const res = await writeStdin.call(
      { session_id: id, input: '', close_stdin: true, yield_time_ms: 3_000 },
      ctx(),
    )
    expect(res.content).toMatch(/3/)
  })

  it('does NOT subscribe stdin to the shell command guards', () => {
    // stdin is arbitrary bytes — a REPL expression, a password, a keypress.
    // Scanning it as if it were a shell command produces false positives
    // without adding protection: the SESSION was approved when it was opened.
    expect(writeStdin.permission?.commandField).toBeUndefined()
    expect(writeStdin.permission?.sensitive).toBe(true)
  })
})

describe('close_session', () => {
  it('lists open sessions when called with no id', async () => {
    const a = await execSession.call({ label: 'first', yield_time_ms: 100 }, ctx())
    await execSession.call({ label: 'second', yield_time_ms: 100 }, ctx())
    const res = await closeSession.call({}, ctx())

    expect(res.content).toContain('2 session(s)')
    expect(res.content).toContain('label=first')
    expect(res.content).toContain(sessionIdOf(a.content))
  })

  it('terminates a session and says whether it was running', async () => {
    const open = await execSession.call({ yield_time_ms: 100 }, ctx())
    const id = sessionIdOf(open.content)
    const res = await closeSession.call({ session_id: id }, ctx())
    expect(res.isError).toBe(false)
    expect(res.content).toMatch(/process group killed/)

    const after = await writeStdin.call({ session_id: id, input: '' }, ctx())
    expect(after.isError).toBe(true)
  })

  it('reports an already-exited session honestly', async () => {
    const open = await execSession.call({ command: 'exit 5', yield_time_ms: 3_000 }, ctx())
    const id = sessionIdOf(open.content)
    const res = await closeSession.call({ session_id: id }, ctx())
    expect(res.content).toMatch(/already exited with code 5/)
  })

  it('is cheap enough to always be worth calling', () => {
    // Prompting for cleanup would make the model stop doing it, and the cost of
    // NOT cleaning up is a live process per abandoned session.
    expect(closeSession.permission?.sensitive).toBe(false)
    expect(closeSession.permission?.planMode).toBe('allow')
  })
})

describe('owner scoping through ToolCallContext', () => {
  it('scopes sessions by agentId, not by conversation id', async () => {
    // A sub-agent runs inside the parent's Node process and shares the store.
    // Keying on sessionId would let it type into the main agent's live REPL.
    const parent = ctx({ agentId: 'main', sessionId: 'shared' })
    const child = ctx({ agentId: 'sub-1', sessionId: 'shared' })

    const open = await execSession.call({ yield_time_ms: 100 }, parent)
    const id = sessionIdOf(open.content)

    const stolen = await writeStdin.call(
      { session_id: id, input: 'echo pwned', yield_time_ms: 200 },
      child,
    )
    expect(stolen.isError).toBe(true)
    expect(stolen.content).toMatch(/no such shell session/)

    const childList = await closeSession.call({}, child)
    expect(childList.content).toContain('No open shell sessions')
  })

  it('falls back to sessionId when agentId is absent', async () => {
    const bare = { ...ctx(), agentId: '' } as ToolCallContext
    const open = await execSession.call({ yield_time_ms: 100 }, bare)
    expect(open.isError).toBe(false)
    const list = await closeSession.call({}, bare)
    expect(list.content).toContain('1 session(s)')
  })
})

describe('registration', () => {
  it('createShellTools includes the session tools by default', async () => {
    const names = (await createShellTools()).map(t => t.name)
    expect(names).toEqual(
      expect.arrayContaining(['bash', 'powershell', 'exec_session', 'write_stdin', 'close_session']),
    )
  })

  it('sessions: false leaves the one-shot pair untouched', async () => {
    const names = (await createShellTools({ sessions: false })).map(t => t.name)
    expect(names).toEqual(['bash', 'powershell'])
  })

  it('every session tool declares an abort contract (auto mode rejects undeclared)', async () => {
    for (const tool of await createShellTools()) {
      expect(tool.abortSupport, tool.name).toBeDefined()
    }
  })
})
