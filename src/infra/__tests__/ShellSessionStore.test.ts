/**
 * ShellSessionStore — the properties that make a persistent session safe and
 * usable. Each block names the failure it exists to prevent.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ShellSessionStore,
  ShellSessionExited,
  ShellSessionNotFound,
  shellSessionStore,
  resetShellSessionStore,
} from '../exec/ShellSessionStore.js'
import { ShellCommandRefused } from '../exec/runShellCommand.js'

const OWNER = 'agent-a'
const OTHER = 'agent-b'

let workspace: string
let store: ShellSessionStore

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'shell-session-'))
  store = new ShellSessionStore()
})

afterEach(() => {
  store.destroyAll()
  rmSync(workspace, { recursive: true, force: true })
})

/** Read until the predicate holds or the budget runs out. */
async function readUntil(
  s: ShellSessionStore,
  id: string,
  pred: (acc: string) => boolean,
  budgetMs = 8_000,
): Promise<string> {
  let acc = ''
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    const r = await s.read(OWNER, id, { yieldTimeMs: 400, idleMs: 100 })
    acc += r.output
    if (pred(acc)) return acc
    if (!r.running) return acc
  }
  return acc
}

describe('ShellSessionStore — state persists across calls', () => {
  it('keeps shell state (cd / export) between separate writes', async () => {
    // The single reason this module exists: a one-shot spawn starts from a
    // fresh shell every time, so state set by one call is invisible to the next.
    mkdirSync(join(workspace, 'sub'))
    const info = store.open({ owner: OWNER, cwd: workspace, workspaceRoot: workspace })

    // Each of these is a SEPARATE tool call as far as the store is concerned.
    // Under one-shot exec every one of them would start from a fresh shell and
    // the final echo would print the original cwd and an empty MARKER.
    // Short windows on the silent commands: a command that prints nothing has
    // no output to go quiet AFTER, so its read can only end when the window
    // elapses. That is the documented cost of not having a PTY prompt to
    // detect, and it is why the tool defaults are tuned for commands that talk.
    // Short windows on the silent commands: a command that prints nothing has
    // no output to go quiet AFTER, so its read can only end when the window
    // elapses. That is the documented cost of not having a PTY prompt to
    // detect, and it is why the tool defaults are tuned for commands that talk.
    await store.write(OWNER, info.id, 'cd sub\n', { yieldTimeMs: 100 })
    await store.write(OWNER, info.id, 'export MARKER=persisted\n', { yieldTimeMs: 100 })
    const res = await store.write(OWNER, info.id, 'echo "MARK:$PWD|$MARKER"\n', {
      yieldTimeMs: 3_000,
    })
    const out = res.output.includes('MARK:')
      ? res.output
      : res.output + (await readUntil(store, info.id, acc => acc.includes('MARK:'), 3_000))

    expect(out).toContain('persisted')
    expect(out).toContain('/sub')
  }, 15_000)

  it('returns output incrementally — a read only shows what is new', async () => {
    const info = store.open({ owner: OWNER, cwd: workspace, workspaceRoot: workspace })
    const first = await store.write(OWNER, info.id, 'echo alpha\n', { yieldTimeMs: 2_000 })
    expect(first.output).toContain('alpha')

    const second = await store.write(OWNER, info.id, 'echo beta\n', { yieldTimeMs: 2_000 })
    expect(second.output).toContain('beta')
    // The regression this guards: re-returning the whole transcript on every
    // read, which makes watching a long build cost O(n^2) context.
    expect(second.output).not.toContain('alpha')
  })

  it('reports exit code and refuses further writes once the shell is gone', async () => {
    const info = store.open({ owner: OWNER, cwd: workspace, workspaceRoot: workspace })
    await store.write(OWNER, info.id, 'exit 7\n', { yieldTimeMs: 3_000 })

    const after = await store.read(OWNER, info.id, { yieldTimeMs: 500 })
    expect(after.running).toBe(false)
    expect(after.exitCode).toBe(7)

    // Writing into a dead session must fail loudly: silently discarding input
    // looks exactly like a command that produced no output.
    await expect(
      store.write(OWNER, info.id, 'echo still-here\n', { yieldTimeMs: 200 }),
    ).rejects.toBeInstanceOf(ShellSessionExited)
  })
})

describe('ShellSessionStore — read windows', () => {
  it('returns early when the program goes quiet instead of burning the window', async () => {
    const info = store.open({ owner: OWNER, cwd: workspace, workspaceRoot: workspace })
    const started = Date.now()
    const res = await store.write(OWNER, info.id, 'echo quick\n', {
      yieldTimeMs: 10_000,
      idleMs: 150,
    })
    const elapsed = Date.now() - started

    expect(res.output).toContain('quick')
    // Without the idle-based early return every REPL round-trip costs the full
    // window, which is what makes an interactive session unusable in practice.
    expect(elapsed).toBeLessThan(4_000)
  })

  it('flags `yielded` when the window elapses while the command is still running', async () => {
    const info = store.open({ owner: OWNER, cwd: workspace, workspaceRoot: workspace })
    const res = await store.write(OWNER, info.id, 'sleep 5\n', {
      yieldTimeMs: 300,
      idleMs: 0,
    })
    expect(res.yielded).toBe(true)
    expect(res.running).toBe(true)
  })

  it('honours an abort signal instead of holding the caller for the whole window', async () => {
    const info = store.open({ owner: OWNER, cwd: workspace, workspaceRoot: workspace })
    const ac = new AbortController()
    const started = Date.now()
    setTimeout(() => ac.abort(), 150)
    await store.write(OWNER, info.id, 'sleep 10\n', {
      yieldTimeMs: 30_000,
      idleMs: 0,
      signal: ac.signal,
    })
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('drains a slow producer across successive reads', async () => {
    const info = store.open({ owner: OWNER, cwd: workspace, workspaceRoot: workspace })
    await store.write(
      OWNER,
      info.id,
      'for i in 1 2 3; do echo "tick-$i"; sleep 0.2; done\n',
      { yieldTimeMs: 250, idleMs: 0 },
    )
    const acc = await readUntil(store, info.id, a => a.includes('tick-3'), 8_000)
    expect(acc).toContain('tick-3')
  })
})

describe('ShellSessionStore — the guard stack is not weaker than one-shot exec', () => {
  it('refuses a cwd outside the workspace before spawning anything', () => {
    const outside = mkdtempSync(join(tmpdir(), 'outside-'))
    try {
      expect(() =>
        store.open({ owner: OWNER, cwd: outside, workspaceRoot: workspace }),
      ).toThrow(ShellCommandRefused)
      expect(store.list(OWNER)).toHaveLength(0)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('accepts a cwd under an operator-granted external root', () => {
    const granted = mkdtempSync(join(tmpdir(), 'granted-'))
    try {
      const info = store.open({
        owner: OWNER,
        cwd: granted,
        workspaceRoot: workspace,
        allowedRoots: [granted],
      })
      expect(info.running).toBe(true)
    } finally {
      rmSync(granted, { recursive: true, force: true })
    }
  })

  it('does NOT accept a sibling of a granted root (segment-wise containment)', () => {
    const base = mkdtempSync(join(tmpdir(), 'grant-'))
    const granted = join(base, 'shared')
    const sibling = join(base, 'shared-backup')
    mkdirSync(granted)
    mkdirSync(sibling)
    try {
      // The classic prefix-match hole: `/x/shared-backup`.startsWith('/x/shared').
      expect(() =>
        store.open({
          owner: OWNER,
          cwd: sibling,
          workspaceRoot: workspace,
          allowedRoots: [granted],
        }),
      ).toThrow(ShellCommandRefused)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('redacts credentials the session prints', async () => {
    const info = store.open({
      owner: OWNER,
      cwd: workspace,
      workspaceRoot: workspace,
      envPolicy: 'empty',
    })
    const res = await store.write(
      OWNER,
      info.id,
      'echo "ghp_abcdefghijklmnopqrstuvwxyz0123456789"\n',
      { yieldTimeMs: 3_000 },
    )
    expect(res.output).not.toContain('ghp_abcdefghij')
    expect(res.output).toContain('[REDACTED]')
  })

  it('filters credentials out of the session environment', async () => {
    process.env['SHELLSESSION_FAKE_API_KEY'] = 'super-secret-value'
    try {
      const info = store.open({ owner: OWNER, cwd: workspace, workspaceRoot: workspace })
      const res = await store.write(
        OWNER,
        info.id,
        'echo "[${SHELLSESSION_FAKE_API_KEY:-absent}]"\n',
        { yieldTimeMs: 3_000 },
      )
      expect(res.output).toContain('[absent]')
    } finally {
      delete process.env['SHELLSESSION_FAKE_API_KEY']
    }
  })
})

describe('ShellSessionStore — ownership isolation', () => {
  it('hides another agent\'s session, and does not reveal that it exists', async () => {
    const info = store.open({ owner: OWNER, cwd: workspace, workspaceRoot: workspace })

    // A sub-agent guessing an id must not be able to type into the main
    // agent's live REPL. The error must also be indistinguishable from "no such
    // session", or it becomes an oracle for probing ids.
    await expect(store.write(OTHER, info.id, 'echo x\n')).rejects.toBeInstanceOf(
      ShellSessionNotFound,
    )
    expect(() => store.close(OTHER, info.id)).toThrow(ShellSessionNotFound)
    expect(store.list(OTHER)).toHaveLength(0)

    const missing = await store
      .read(OTHER, info.id)
      .catch((e: Error) => e.message)
    const bogus = await store.read(OTHER, 'sh_deadbeef').catch((e: Error) => e.message)
    expect(String(missing).replace(info.id, 'ID')).toBe(
      String(bogus).replace('sh_deadbeef', 'ID'),
    )
  })

  it('closeAll only reaps the calling owner\'s sessions', () => {
    store.open({ owner: OWNER, cwd: workspace, workspaceRoot: workspace })
    store.open({ owner: OWNER, cwd: workspace, workspaceRoot: workspace })
    store.open({ owner: OTHER, cwd: workspace, workspaceRoot: workspace })

    expect(store.closeAll(OWNER)).toBe(2)
    expect(store.list(OWNER)).toHaveLength(0)
    expect(store.list(OTHER)).toHaveLength(1)
  })
})

describe('ShellSessionStore — resource limits', () => {
  it('evicts the least recently used session past the per-owner ceiling', async () => {
    const limited = new ShellSessionStore({ maxSessionsPerOwner: 2 })
    try {
      const a = limited.open({ owner: OWNER, cwd: workspace, workspaceRoot: workspace })
      await new Promise(r => setTimeout(r, 5))
      const b = limited.open({ owner: OWNER, cwd: workspace, workspaceRoot: workspace })
      await new Promise(r => setTimeout(r, 5))
      // Opening the third must evict `a`, the coldest — refusing instead would
      // stall the caller, which has no way to know which session is safe to drop.
      const c = limited.open({ owner: OWNER, cwd: workspace, workspaceRoot: workspace })

      const ids = limited.list(OWNER).map(s => s.id)
      expect(ids).not.toContain(a.id)
      expect(ids).toContain(b.id)
      expect(ids).toContain(c.id)
    } finally {
      limited.destroyAll()
    }
  })

  it('reaps sessions idle past the TTL', async () => {
    const shortTtl = new ShellSessionStore({ idleTtlMs: 1 })
    try {
      shortTtl.open({ owner: OWNER, cwd: workspace, workspaceRoot: workspace })
      await new Promise(r => setTimeout(r, 20))
      expect(shortTtl.list(OWNER)).toHaveLength(0)
    } finally {
      shortTtl.destroyAll()
    }
  })

  it('drops the OLDEST bytes when the ring buffer wraps, and reports the loss', async () => {
    const tiny = new ShellSessionStore()
    try {
      const info = tiny.open({
        owner: OWNER,
        cwd: workspace,
        workspaceRoot: workspace,
        bufferChars: 256,
      })
      const res = await tiny.write(
        OWNER,
        info.id,
        'for i in $(seq 1 200); do echo "line-$i-padding-padding"; done\n',
        { yieldTimeMs: 5_000, idleMs: 300 },
      )
      expect(res.droppedBytes).toBeGreaterThan(0)
      expect(res.output.length).toBeLessThanOrEqual(256)
      // Newest bytes survive — they are the ones the caller is waiting for.
      expect(res.output).toContain('line-200')
      expect(res.output).not.toContain('line-1-padding')
    } finally {
      tiny.destroyAll()
    }
  })
})

describe('ShellSessionStore — lifecycle', () => {
  it('close reports whether it actually terminated something', async () => {
    const live = store.open({ owner: OWNER, cwd: workspace, workspaceRoot: workspace })
    expect(store.close(OWNER, live.id).running).toBe(true)

    const dead = store.open({ owner: OWNER, cwd: workspace, workspaceRoot: workspace })
    await store.write(OWNER, dead.id, 'exit 0\n', { yieldTimeMs: 3_000 })
    await store.read(OWNER, dead.id, { yieldTimeMs: 300 })
    expect(store.close(OWNER, dead.id).running).toBe(false)
  })

  it('kills the whole process group so background children do not survive', async () => {
    const marker = join(workspace, 'orphan.txt')
    const info = store.open({ owner: OWNER, cwd: workspace, workspaceRoot: workspace })
    // A backgrounded child outlives its parent shell unless the GROUP is killed
    // — that is how orphaned build/training processes accumulate on a machine.
    await store.write(
      OWNER,
      info.id,
      `( sleep 1.5; echo leaked > ${JSON.stringify(marker)} ) &\n`,
      { yieldTimeMs: 500 },
    )
    store.close(OWNER, info.id)
    await new Promise(r => setTimeout(r, 2_500))

    const { existsSync } = await import('node:fs')
    expect(existsSync(marker)).toBe(false)
  })

  it('close_stdin delivers EOF to a program that reads until it', async () => {
    const outFile = join(workspace, 'eof.txt')
    writeFileSync(outFile, '')
    const info = store.open({
      owner: OWNER,
      cwd: workspace,
      workspaceRoot: workspace,
      shell: 'bash',
      shellArgs: ['-c', 'cat > eof.txt'],
    })
    await store.write(OWNER, info.id, 'first\nsecond\n', { yieldTimeMs: 200 })
    await store.write(OWNER, info.id, '', { yieldTimeMs: 2_000, closeStdin: true })
    await new Promise(r => setTimeout(r, 300))

    const { readFileSync } = await import('node:fs')
    expect(readFileSync(outFile, 'utf-8')).toBe('first\nsecond\n')
  })

  it('interleaves stdout and stderr in arrival order', async () => {
    const info = store.open({ owner: OWNER, cwd: workspace, workspaceRoot: workspace })
    const res = await store.write(
      OWNER,
      info.id,
      'echo to-stdout; echo to-stderr 1>&2\n',
      { yieldTimeMs: 3_000 },
    )
    // Splitting the streams would force the caller to reassemble an ordering we
    // already had — every REPL prompt/answer pair depends on it.
    expect(res.output).toContain('to-stdout')
    expect(res.output).toContain('to-stderr')
  })
})

describe('shellSessionStore() — the process-global instance', () => {
  afterEach(() => resetShellSessionStore())

  it('returns the same store so sessions survive between tool calls', () => {
    // A per-call store would be constructed and thrown away on every tool
    // invocation, and no session would ever outlive the call that made it —
    // which is the entire point of the module.
    expect(shellSessionStore()).toBe(shellSessionStore())
  })

  it('reset kills everything it owned', () => {
    const s = shellSessionStore()
    s.open({ owner: OWNER, cwd: workspace, workspaceRoot: workspace })
    expect(s.list(OWNER)).toHaveLength(1)
    resetShellSessionStore()
    expect(shellSessionStore().list(OWNER)).toHaveLength(0)
  })
})
