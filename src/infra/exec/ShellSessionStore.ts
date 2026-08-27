/**
 * ShellSessionStore — long-lived, workspace-jailed shell processes.
 *
 * Why this module exists
 * ----------------------
 * `runShellCommand` is one-shot by construction: it spawns, waits for the
 * process to close, and returns. That is the right shape for "run a command,
 * read the output", and it stays the default. But it makes three things
 * impossible, and all three show up constantly in engineering work:
 *
 *   1. REPLs. `python3 -i`, `node`, `sqlite3`, a robot's own debug console —
 *      anything where the NEXT input depends on the PREVIOUS output. A
 *      one-shot call can only ever send a script written in advance.
 *   2. Long builds. A 10-minute compile either fits in the timeout or is
 *      killed; there is no way to watch it and no partial output until the end.
 *   3. Shell state. `cd`, `export`, `source venv/bin/activate`, an ssh session
 *      — every one-shot call starts from a fresh shell, so state set by one
 *      call is invisible to the next.
 *
 * This module keeps the process alive between tool calls and hands the caller
 * an incremental view of its output. The security stack is IDENTICAL to
 * `runShellCommand` — same cwd jail, same credential-filtered env, same OS
 * sandbox wrapping, same output redaction — because a session that skipped any
 * of them would be a hole straight through controls the one-shot path enforces.
 * The guard code is deliberately duplicated in shape rather than shared through
 * a clever abstraction: these are the five things a spawn site must not forget,
 * and they should be visible at every spawn site.
 *
 * Pipes, not PTYs
 * ---------------
 * Sessions use pipes (`stdio: ['pipe','pipe','pipe']`), not a pseudo-terminal.
 * A real PTY needs a native addon (node-pty), and this runtime deliberately
 * ships three pure-JS runtime dependencies. The practical consequences:
 *
 *   - Programs that require a TTY (`top`, `vim`, anything calling isatty())
 *     will not render usefully. Use the one-shot `bash` tool for those, or
 *     don't use them.
 *   - Programs that BLOCK-buffer when stdout is not a TTY (CPython is the
 *     notable one) need their unbuffered flag: `python3 -u -i`, `stdbuf -oL`.
 *     The tool description tells the model this; it is the single most common
 *     way a session appears to "produce no output".
 *
 * Everything else — shell state, incremental output, interleaved stdout/stderr
 * — works exactly as it would in a terminal.
 */

import { spawn, type ChildProcess } from 'child_process'
import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'string_decoder'
import type { SandboxHandle } from '../../sandbox/types.js'
import { buildChildEnv, type ChildEnvPolicy } from '../env/childProcessEnv.js'
import { redactSecrets } from '../redaction/secretRedaction.js'
import { resolveJailedCwd, ShellCommandRefused } from './runShellCommand.js'

// ── Tunables ──────────────────────────────────────────────────────────────────

/**
 * Retained output per session, in characters.
 *
 * This is a RING buffer, not a cap that stops capture: a session that has been
 * alive for an hour must not pin an hour of build log in memory, but it also
 * must not silently stop showing new output — the newest bytes are the ones the
 * caller is waiting for. So old bytes are dropped from the FRONT and the drop
 * is reported, rather than new bytes being dropped from the back (which is what
 * `runShellCommand`'s one-shot captureLimit does, correctly, for its own case:
 * there the INTERESTING output is usually at the start, before the failure).
 */
const DEFAULT_BUFFER_CHARS = 256 * 1024

/** Default window a read waits before giving up and returning what it has. */
const DEFAULT_YIELD_MS = 5_000

/** Hard ceiling on a single read window — a read must never outlive the kernel's per-tool budget. */
const MAX_YIELD_MS = 120_000

/**
 * Quiet period that ends a read EARLY once output has started.
 *
 * Without this, every REPL interaction costs the full yield window: the answer
 * arrives in 5 ms and the caller still waits 5 s for the timer. With it, a read
 * returns ~200 ms after the process stops talking, which is what makes an
 * interactive session feel interactive instead of merely possible.
 */
const DEFAULT_IDLE_MS = 200

/** Max concurrently-open sessions per owner. Oldest idle session is evicted past this. */
const DEFAULT_MAX_SESSIONS_PER_OWNER = 8

/** A session untouched for this long is reaped by the next store operation. */
const DEFAULT_IDLE_TTL_MS = 30 * 60_000

// ── Public types ──────────────────────────────────────────────────────────────

export interface OpenShellSessionOptions {
  /**
   * Owner scope — the calling agent's session id. Sessions are addressable ONLY
   * by their owner: a sub-agent must not be able to write into the main agent's
   * python REPL by guessing a session id.
   */
  owner: string
  cwd: string
  workspaceRoot?: string
  allowedRoots?: readonly string[]
  envPolicy?: ChildEnvPolicy
  sandboxHandle?: SandboxHandle
  /** Shell program. Default: `bash`. */
  shell?: string
  /** Extra argv for the shell. Default: none (reads a script from stdin). */
  shellArgs?: readonly string[]
  bufferChars?: number
  /** Human-supplied label to make `list()` output readable. */
  label?: string
}

export interface ShellSessionInfo {
  id: string
  owner: string
  cwd: string
  shell: string
  label?: string
  createdAt: number
  lastUsedAt: number
  running: boolean
  exitCode: number | null
  /** True when the process died from a signal / group kill rather than exiting. */
  killed: boolean
  sandboxed: boolean
}

export interface ShellReadResult {
  /** Output produced since the previous read, already redacted. */
  output: string
  /** True when the ring buffer dropped older bytes before this read drained it. */
  droppedBytes: number
  running: boolean
  exitCode: number | null
  /** True when the yield window elapsed while the process was still running. */
  yielded: boolean
}

export interface ReadOptions {
  /** Max time to wait for output before returning. Clamped to [0, MAX_YIELD_MS]. */
  yieldTimeMs?: number
  /** Return early once the process has been quiet this long. 0 disables. */
  idleMs?: number
  /** Abort the wait (kernel per-tool timeout / session interrupt). */
  signal?: AbortSignal
}

/** Raised when a session id is unknown, or is not owned by the caller. */
export class ShellSessionNotFound extends Error {
  constructor(id: string) {
    super(`no such shell session: ${id}`)
    this.name = 'ShellSessionNotFound'
  }
}

/** Raised when input is written to a session whose process has already exited. */
export class ShellSessionExited extends Error {
  constructor(id: string, code: number | null) {
    super(`shell session ${id} has exited (code ${code ?? 'unknown'}); open a new session`)
    this.name = 'ShellSessionExited'
  }
}

// ── Internal record ───────────────────────────────────────────────────────────

interface SessionRecord {
  info: ShellSessionInfo
  child: ChildProcess
  /** Undrained output. Reads drain this; the process appends to it. */
  buffer: string
  /** Characters discarded from the FRONT of `buffer` because it hit the cap. */
  dropped: number
  bufferChars: number
  /** Resolvers waiting for output or exit. Woken on data / close. */
  waiters: Set<() => void>
  outDecoder: StringDecoder
  errDecoder: StringDecoder
  /** Wall-clock of the most recent byte, for the idle-based early return. */
  lastOutputAt: number
  useGroup: boolean
}

// ── The store ─────────────────────────────────────────────────────────────────

export class ShellSessionStore {
  private readonly sessions = new Map<string, SessionRecord>()

  constructor(
    private readonly limits: {
      maxSessionsPerOwner?: number
      idleTtlMs?: number
    } = {},
  ) {}

  private get maxPerOwner(): number {
    return this.limits.maxSessionsPerOwner ?? DEFAULT_MAX_SESSIONS_PER_OWNER
  }

  private get idleTtlMs(): number {
    return this.limits.idleTtlMs ?? DEFAULT_IDLE_TTL_MS
  }

  /**
   * Spawn a shell and keep it alive.
   *
   * The guard order mirrors `runShellCommand` exactly: jail the cwd BEFORE
   * anything spawns, then filter the env, then wrap in the OS sandbox.
   */
  open(opts: OpenShellSessionOptions): ShellSessionInfo {
    this.reapIdle()

    const jailed = resolveJailedCwd(opts.cwd, opts.workspaceRoot, opts.allowedRoots)
    if (!jailed.ok) throw new ShellCommandRefused(jailed.error)
    const cwd = jailed.path

    this.evictOverflow(opts.owner)

    const shell = opts.shell ?? 'bash'
    const shellArgs = opts.shellArgs ? [...opts.shellArgs] : []

    // Sandbox wrapping. `wrapExec` takes a COMMAND STRING because that is what
    // the one-shot path has; here we hand it an `exec` of the shell so the
    // sandboxed process the caller talks to over stdin IS the shell, not a
    // wrapper that has already exited.
    const spec = opts.sandboxHandle
      ? opts.sandboxHandle.wrapExec(
          [shell, ...shellArgs].map(quoteForShell).join(' '),
          cwd,
        )
      : { file: shell, args: shellArgs }

    const useGroup = process.platform !== 'win32'
    const child = spawn(spec.file, spec.args, {
      cwd,
      env: buildChildEnv(opts.envPolicy ?? 'filtered'),
      detached: useGroup, // own process group → group-killable
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const id = `sh_${randomUUID().slice(0, 8)}`
    const now = Date.now()
    const record: SessionRecord = {
      info: {
        id,
        owner: opts.owner,
        cwd,
        shell,
        ...(opts.label ? { label: opts.label } : {}),
        createdAt: now,
        lastUsedAt: now,
        running: true,
        exitCode: null,
        killed: false,
        sandboxed: !!opts.sandboxHandle,
      },
      child,
      buffer: '',
      dropped: 0,
      bufferChars: opts.bufferChars ?? DEFAULT_BUFFER_CHARS,
      waiters: new Set(),
      outDecoder: new StringDecoder('utf8'),
      errDecoder: new StringDecoder('utf8'),
      lastOutputAt: now,
      useGroup,
    }

    // stdout and stderr are merged into ONE buffer in arrival order. A terminal
    // shows them interleaved, every REPL prompt-vs-answer pair depends on that
    // ordering (Python writes its `>>>` prompt to stderr and the value to
    // stdout), and splitting them would force the caller to reassemble an
    // ordering we already had.
    child.stdout?.on('data', (chunk: Buffer) =>
      this.append(record, record.outDecoder.write(chunk)))
    child.stderr?.on('data', (chunk: Buffer) =>
      this.append(record, record.errDecoder.write(chunk)))

    child.on('error', err => {
      this.append(record, `\n[session error: ${err.message}]\n`)
      record.info.running = false
      this.wake(record)
    })

    child.on('close', (code, signal) => {
      // Flush bytes the decoders held back at a chunk boundary.
      this.append(record, record.outDecoder.end() + record.errDecoder.end())
      record.info.running = false
      record.info.exitCode = code
      record.info.killed = signal !== null
      this.wake(record)
    })

    // stdin EPIPE after the shell exits is expected, not an error worth
    // crashing the host process over.
    child.stdin?.on('error', () => { /* peer gone */ })

    this.sessions.set(id, record)
    return { ...record.info }
  }

  /**
   * Drain output produced since the last read.
   *
   * Returns when ANY of these happens, whichever comes first:
   *   - the process exits;
   *   - output arrived and then went quiet for `idleMs`;
   *   - `yieldTimeMs` elapsed;
   *   - `signal` aborted.
   */
  async read(owner: string, id: string, opts: ReadOptions = {}): Promise<ShellReadResult> {
    const record = this.require(owner, id)
    const yieldMs = clamp(opts.yieldTimeMs ?? DEFAULT_YIELD_MS, 0, MAX_YIELD_MS)
    const idleMs = Math.max(0, opts.idleMs ?? DEFAULT_IDLE_MS)
    const deadline = Date.now() + yieldMs

    let yielded = false
    for (;;) {
      if (opts.signal?.aborted) break
      if (!record.info.running) break // exited: drain and report, do not wait
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        yielded = true
        break
      }
      // Early return once the process has gone quiet, but only after it has
      // actually said something in this read — otherwise a session that is
      // simply busy (a compile with no output yet) would return instantly and
      // the caller would poll in a hot loop.
      //
      // The consequence, which the tool descriptions state plainly: a command
      // that prints NOTHING (`cd`, `export`) has no output to go quiet after,
      // so its read costs the whole window. Detecting "the shell is back at its
      // prompt" would need either a PTY or an injected sentinel appended to the
      // user's command; the first needs a native addon and the second corrupts
      // the output of every REPL that is not a shell. Waiting is the honest
      // option, and callers pass a small yield for commands they know are quiet.
      if (record.buffer.length > 0 && idleMs > 0) {
        const quietFor = Date.now() - record.lastOutputAt
        if (quietFor >= idleMs) break
        await this.waitFor(record, Math.min(idleMs - quietFor, remaining), opts.signal)
        continue
      }
      await this.waitFor(record, remaining, opts.signal)
    }

    record.info.lastUsedAt = Date.now()
    const output = record.buffer
    const dropped = record.dropped
    record.buffer = ''
    record.dropped = 0
    return {
      // Redact on the way out, once, for every caller — same rule as
      // runShellCommand. A tool formatting the stream itself cannot forget it.
      output: redactSecrets(output),
      droppedBytes: dropped,
      running: record.info.running,
      exitCode: record.info.exitCode,
      yielded,
    }
  }

  /**
   * Write to the session's stdin, then read the response.
   *
   * `data` is written verbatim: the caller decides whether it ends with a
   * newline. A shell reading a command without a trailing newline simply waits,
   * which looks exactly like a hung session, so the tool layer appends one.
   */
  async write(
    owner: string,
    id: string,
    data: string,
    opts: ReadOptions & { closeStdin?: boolean } = {},
  ): Promise<ShellReadResult> {
    const record = this.require(owner, id)
    if (!record.info.running) throw new ShellSessionExited(id, record.info.exitCode)

    if (data) {
      await new Promise<void>((resolve, reject) => {
        record.child.stdin?.write(data, err => (err ? reject(err) : resolve()))
      })
    }
    if (opts.closeStdin) record.child.stdin?.end()
    record.info.lastUsedAt = Date.now()
    // Reset the idle clock so the read below measures quiet time since OUR
    // input, not since output that arrived before it.
    record.lastOutputAt = Date.now()
    return this.read(owner, id, opts)
  }

  /**
   * Terminate a session and free it.
   *
   * Kills the whole PROCESS GROUP, not just the shell: a session that ran
   * `npm install &` or started a training script leaves children that outlive
   * their parent, and those are exactly the orphans `runShellCommand` was
   * written to prevent accumulating.
   */
  close(owner: string, id: string): ShellSessionInfo {
    const record = this.require(owner, id)
    // Snapshot BEFORE killing. The caller's next question is always "was there
    // something running that I just terminated, or had it already finished?",
    // and a snapshot taken after the kill can only ever answer "not running".
    const before = { ...record.info }
    this.kill(record)
    this.sessions.delete(id)
    record.info.running = false
    return before
  }

  /** Sessions belonging to `owner`, newest first. */
  list(owner: string): ShellSessionInfo[] {
    this.reapIdle()
    return [...this.sessions.values()]
      .filter(r => r.info.owner === owner)
      .sort((a, b) => b.info.lastUsedAt - a.info.lastUsedAt)
      .map(r => ({ ...r.info }))
  }

  /** Peek without draining — used by `list` renderers and tests. */
  pendingChars(owner: string, id: string): number {
    return this.require(owner, id).buffer.length
  }

  /** Kill and forget every session owned by `owner` (session teardown). */
  closeAll(owner: string): number {
    let n = 0
    for (const [id, record] of [...this.sessions]) {
      if (record.info.owner !== owner) continue
      this.kill(record)
      this.sessions.delete(id)
      n++
    }
    return n
  }

  /** Kill and forget everything (process shutdown, tests). */
  destroyAll(): void {
    for (const [id, record] of [...this.sessions]) {
      this.kill(record)
      this.sessions.delete(id)
    }
  }

  // ── internals ───────────────────────────────────────────────────────────────

  private require(owner: string, id: string): SessionRecord {
    const record = this.sessions.get(id)
    // Ownership is checked as part of EXISTENCE, and the error does not
    // distinguish the two cases: "wrong owner" and "no such session" must look
    // identical, or the message becomes an oracle for probing other agents'
    // session ids.
    if (!record || record.info.owner !== owner) throw new ShellSessionNotFound(id)
    return record
  }

  private append(record: SessionRecord, text: string): void {
    if (!text) return
    record.buffer += text
    record.lastOutputAt = Date.now()
    if (record.buffer.length > record.bufferChars) {
      const overflow = record.buffer.length - record.bufferChars
      record.buffer = record.buffer.slice(overflow)
      record.dropped += overflow
    }
    this.wake(record)
  }

  private wake(record: SessionRecord): void {
    for (const resolve of [...record.waiters]) resolve()
    record.waiters.clear()
  }

  /** Sleep until output/exit wakes us, `ms` elapses, or `signal` aborts. */
  private waitFor(record: SessionRecord, ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>(resolve => {
      let settled = false
      const done = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        record.waiters.delete(done)
        signal?.removeEventListener('abort', done)
        resolve()
      }
      const timer = setTimeout(done, ms)
      // Never hold the event loop open for a wait — a pending read must not be
      // the reason a CLI process refuses to exit.
      timer.unref?.()
      record.waiters.add(done)
      signal?.addEventListener('abort', done, { once: true })
    })
  }

  private kill(record: SessionRecord): void {
    const pid = record.child.pid
    if (pid === undefined) return
    try {
      if (record.useGroup) process.kill(-pid, 'SIGKILL') // negative pid = whole group
      else record.child.kill('SIGKILL')
    } catch {
      /* already exited */
    }
    try {
      record.child.stdin?.end()
    } catch {
      /* already closed */
    }
  }

  /**
   * Enforce the per-owner ceiling by evicting the LEAST RECENTLY USED session.
   *
   * Refusing to open would be the other option, and it is worse: the model has
   * no way to know which of its old sessions is safe to close, so it would
   * stall. Evicting the coldest one and saying so lets it continue, and the
   * eviction is visible in the returned notice.
   */
  private evictOverflow(owner: string): void {
    const owned = [...this.sessions.values()]
      .filter(r => r.info.owner === owner)
      .sort((a, b) => a.info.lastUsedAt - b.info.lastUsedAt)
    while (owned.length >= this.maxPerOwner) {
      const victim = owned.shift()
      if (!victim) break
      this.kill(victim)
      this.sessions.delete(victim.info.id)
    }
  }

  /** Drop sessions nobody has touched for `idleTtlMs`. */
  private reapIdle(): void {
    const cutoff = Date.now() - this.idleTtlMs
    for (const [id, record] of [...this.sessions]) {
      if (record.info.lastUsedAt > cutoff) continue
      this.kill(record)
      this.sessions.delete(id)
    }
  }
}

// ── Process-global store ──────────────────────────────────────────────────────

/**
 * One store per Node process.
 *
 * Sub-agents run INSIDE the parent's process, so a per-session store would be
 * created and thrown away on each tool construction and sessions would never
 * survive between calls — which is the entire point. Isolation between agents
 * comes from the `owner` scope, not from separate stores.
 */
let _globalStore: ShellSessionStore | null = null

/**
 * P3-1 (review 2026-08-27): a NAMED, install-once exit handler.
 *
 * This used to be an inline `process.once('exit', () => _globalStore?.…)`
 * registered inside the lazy initialiser, and `resetShellSessionStore()` only
 * nulled the store — so every reset/recreate cycle added another listener that
 * was never removed. The full test suite reliably tripped Node's warning:
 *
 *   MaxListenersExceededWarning: 11 exit listeners added to [process]
 *
 * Each stale closure also still referenced the module-level `_globalStore`, so
 * on exit the CURRENT store got `destroyAll()` called once per accumulated
 * listener. Idempotent in practice, but only by luck.
 *
 * Being a named function is what makes it removable and, since Node dedupes
 * nothing for us, `_exitHandlerInstalled` is what makes it install-once.
 */
function destroyGlobalStoreOnExit(): void {
  _globalStore?.destroyAll()
}

let _exitHandlerInstalled = false

export function shellSessionStore(): ShellSessionStore {
  if (!_globalStore) {
    _globalStore = new ShellSessionStore()
    // Best-effort: do not leave orphaned process groups behind when the host
    // exits normally. `exit` only runs sync code, and kill() is sync.
    //
    // Registered ONCE for the process lifetime, not once per store. The
    // handler reads the live `_globalStore` binding, so a store created after
    // a reset is still covered without a second registration.
    if (!_exitHandlerInstalled) {
      _exitHandlerInstalled = true
      process.on('exit', destroyGlobalStoreOnExit)
    }
  }
  return _globalStore
}

/** Tests: drop the global store and kill everything it owned. */
export function resetShellSessionStore(): void {
  _globalStore?.destroyAll()
  _globalStore = null
  // Symmetric with the install above: leaving the handler registered across a
  // reset would be harmless (it reads the live binding), but removing it keeps
  // the process listener count at zero when no store exists, which is what
  // makes "repeated reset does not grow listeners" assertable.
  if (_exitHandlerInstalled) {
    process.removeListener('exit', destroyGlobalStoreOnExit)
    _exitHandlerInstalled = false
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

function clamp(n: unknown, min: number, max: number): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return min === 0 ? DEFAULT_YIELD_MS : min
  return Math.min(max, Math.max(min, n))
}

/**
 * Single-quote a token for safe inclusion in the command string handed to
 * `wrapExec`. Only used for the shell program name and its argv, which are
 * operator/tool controlled rather than model controlled — but a shell name
 * containing a space would still break the wrapper without this.
 */
function quoteForShell(token: string): string {
  return `'${token.replace(/'/g, `'\\''`)}'`
}

export const SHELL_SESSION_DEFAULTS = {
  DEFAULT_BUFFER_CHARS,
  DEFAULT_YIELD_MS,
  MAX_YIELD_MS,
  DEFAULT_IDLE_MS,
  DEFAULT_MAX_SESSIONS_PER_OWNER,
  DEFAULT_IDLE_TTL_MS,
} as const
