/**
 * Edge cases across the three A1 features.
 *
 * These are the branches the main suites do not reach: option resolution,
 * output-budget rendering, error mapping, and the failure modes that only
 * appear when something is already going wrong.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MetaAgentTool, ToolCallContext } from '../../core/types.js'
import {
  resolveSessionSandboxPolicy,
  renderReadResult,
  renderSessionInfo,
  toToolError,
  maxSessionOutputChars,
  sessionExternalRoots,
  resetSessionGrantCache,
  ownerOf,
  DEFAULT_SESSION_SANDBOX,
} from '../shell/sessionSupport.js'
import { ShellSessionNotFound, ShellSessionExited, resetShellSessionStore } from '../../infra/exec/ShellSessionStore.js'
import { ShellCommandRefused } from '../../infra/exec/runShellCommand.js'
import { createApplyPatchTool } from '../fs/apply_patch/index.js'
import { createTurnDiffTool } from '../fs/turn_diff/index.js'
import { createExecSessionTool } from '../shell/exec_session/index.js'
import { createCloseSessionTool } from '../shell/close_session/index.js'
import { TurnDiffTracker } from '../../infra/fs/TurnDiffTracker.js'

let ws: string
const p = (n: string): string => join(ws, n)
const wrap = (b: string): string => `*** Begin Patch\n${b}\n*** End Patch`

function ctx(o: Partial<ToolCallContext> = {}): ToolCallContext {
  return {
    sessionId: 's', agentId: 'a',
    abortSignal: new AbortController().signal,
    workspaceRoot: ws,
    ...o,
  }
}

beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'a1-edge-')) })
afterEach(() => {
  resetShellSessionStore()
  resetSessionGrantCache()
  rmSync(ws, { recursive: true, force: true })
})

describe('session sandbox policy resolution', () => {
  it('maps undefined and true to the same default as the bash tool', () => {
    // A session that sandboxed differently from `bash` would be a way to pick
    // the weaker of two policies by choosing a tool.
    expect(resolveSessionSandboxPolicy({})).toBe(DEFAULT_SESSION_SANDBOX)
    expect(resolveSessionSandboxPolicy({ sandbox: true })).toBe(DEFAULT_SESSION_SANDBOX)
  })

  it('honours an explicit disable and an explicit policy object', () => {
    expect(resolveSessionSandboxPolicy({ sandbox: false })).toBeUndefined()
    const custom = { network: 'none' as const }
    expect(resolveSessionSandboxPolicy({ sandbox: custom })).toBe(custom)
  })
})

describe('session grant cache', () => {
  it('memoises per workspace and can be dropped', () => {
    const first = sessionExternalRoots(ws)
    expect(sessionExternalRoots(ws)).toBe(first)
    resetSessionGrantCache()
    expect(sessionExternalRoots(ws)).not.toBe(first)
  })

  it('keys the workspace-less case separately', () => {
    expect(Array.isArray(sessionExternalRoots(undefined))).toBe(true)
  })
})

describe('owner scoping helper', () => {
  it('prefers agentId and falls back to sessionId', () => {
    expect(ownerOf({ agentId: 'sub', sessionId: 'main' } as ToolCallContext)).toBe('sub')
    expect(ownerOf({ agentId: '', sessionId: 'main' } as ToolCallContext)).toBe('main')
  })
})

describe('renderReadResult', () => {
  const base = { output: 'hello', droppedBytes: 0, running: true, exitCode: null, yielded: false }

  it('says nothing extra for a plain successful read', () => {
    expect(renderReadResult('sh_1', base)).toBe('hello')
  })

  it('reports a dropped-output hole', () => {
    // The transcript has a gap. Not saying so lets the caller read a build log
    // that skipped its own error and conclude the build was fine.
    const out = renderReadResult('sh_1', { ...base, droppedBytes: 4096 })
    expect(out).toMatch(/4096 earlier chars dropped/)
    expect(out).toContain('hello')
  })

  it('reports exit, and does not also suggest reading more', () => {
    const out = renderReadResult('sh_1', { ...base, running: false, exitCode: 3, yielded: true })
    expect(out).toMatch(/exited with code 3/)
    expect(out).not.toMatch(/still running/)
  })

  it('tells the caller how to keep reading after a yield', () => {
    const out = renderReadResult('sh_1', { ...base, yielded: true })
    expect(out).toMatch(/still running/)
    expect(out).toContain('sh_1')
  })

  it('keeps the NEWEST bytes when truncating', () => {
    // Opposite of the one-shot rule: in a session the interesting output is the
    // most recent, not the earliest.
    const limit = maxSessionOutputChars()
    const long = 'A'.repeat(limit) + 'TAIL_MARKER'
    const out = renderReadResult('sh_1', { ...base, output: long })
    expect(out).toContain('TAIL_MARKER')
    expect(out).toMatch(/kept the last/)
  })

  it('says "no output yet" rather than returning nothing', () => {
    expect(renderReadResult('sh_1', { ...base, output: '' })).toBe('(no output yet)')
  })

  it('can prefix the session id header', () => {
    expect(renderReadResult('sh_1', base, { includeHeader: true })).toMatch(/^session_id: sh_1/)
  })

  it('handles an unknown exit code', () => {
    const out = renderReadResult('sh_1', { ...base, running: false, exitCode: null })
    expect(out).toMatch(/exited with code unknown/)
  })
})

describe('renderSessionInfo', () => {
  const info = {
    id: 'sh_a', owner: 'o', cwd: '/w', shell: 'bash',
    createdAt: Date.now() - 5_000, lastUsedAt: Date.now(),
    running: true, exitCode: null, killed: false, sandboxed: false,
  }

  it('renders a running session', () => {
    const out = renderSessionInfo(info)
    expect(out).toMatch(/sh_a\s+running\s+shell=bash/)
    expect(out).not.toContain('sandboxed')
  })

  it('distinguishes exited from killed', () => {
    expect(renderSessionInfo({ ...info, running: false, exitCode: 2 })).toMatch(/exited\(2\)/)
    expect(renderSessionInfo({ ...info, running: false, exitCode: null, killed: true })).toMatch(/exited\(killed\)/)
  })

  it('shows the sandbox flag and label when present', () => {
    const out = renderSessionInfo({ ...info, sandboxed: true, label: 'build' })
    expect(out).toContain('sandboxed')
    expect(out).toContain('label=build')
  })
})

describe('toToolError', () => {
  it('surfaces the remediation hint each store error carries', () => {
    expect(toToolError(new ShellSessionNotFound('sh_x'))).toEqual({
      content: 'Error: no such shell session: sh_x', isError: true,
    })
    expect(toToolError(new ShellSessionExited('sh_x', 1)).content).toMatch(/open a new session/)
    expect(toToolError(new ShellCommandRefused('nope')).content).toBe('Error: nope')
  })

  it('does not let an unexpected error escape as a crash', () => {
    expect(toToolError(new Error('boom')).content).toBe('Error: boom')
    expect(toToolError('a bare string').content).toBe('Error: a bare string')
  })
})

describe('exec_session option handling', () => {
  it('clamps an absurd yield_time_ms instead of hanging', async () => {
    const tool = await createExecSessionTool()
    const started = Date.now()
    const res = await tool.call(
      { command: 'echo fast', yield_time_ms: 999_999_999 },
      ctx(),
    )
    expect(res.isError).toBe(false)
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  it('falls back to the default for a non-numeric yield', async () => {
    const tool = await createExecSessionTool()
    const res = await tool.call({ command: 'echo x', yield_time_ms: 'soon' }, ctx())
    expect(res.isError).toBe(false)
    expect(res.content).toContain('x')
  })

  it('surfaces a spawn failure for a shell that does not exist', async () => {
    const tool = await createExecSessionTool()
    const res = await tool.call(
      { shell: 'definitely-not-a-real-shell-binary', yield_time_ms: 1_500 },
      ctx(),
    )
    // Either the spawn error is reported, or it surfaces as an immediate exit.
    expect(res.content).toMatch(/error|exited|ENOENT/i)
  })
})

describe('close_session edge cases', () => {
  it('rejects a non-string session_id', async () => {
    const tool = await createCloseSessionTool()
    const res = await tool.call({ session_id: 99 }, ctx())
    expect(res.isError).toBe(true)
    expect(res.content).toMatch(/must be a string/)
  })

  it('treats an empty session_id as a list request', async () => {
    const tool = await createCloseSessionTool()
    const res = await tool.call({ session_id: '' }, ctx())
    expect(res.content).toContain('No open shell sessions')
  })

  it('reports an unknown session rather than pretending it closed', async () => {
    const tool = await createCloseSessionTool()
    const res = await tool.call({ session_id: 'sh_ghost' }, ctx())
    expect(res.isError).toBe(true)
    expect(res.content).toMatch(/no such shell session/)
  })
})

describe('apply_patch rendering and rarer paths', () => {
  let applyPatch: MetaAgentTool
  beforeEach(async () => { applyPatch = await createApplyPatchTool() })

  it('marks a rename with R and shows both paths', async () => {
    writeFileSync(p('a.ts'), 'x\n')
    const res = await applyPatch.call(
      { patch: wrap('*** Update File: a.ts\n*** Move to: b.ts\n-x\n+y') },
      ctx(),
    )
    expect(res.content).toMatch(/R a\.ts → b\.ts/)
  })

  it('marks add with A and delete with D', async () => {
    writeFileSync(p('gone.ts'), 'bye\n')
    const res = await applyPatch.call(
      { patch: wrap('*** Add File: new.ts\n+hi\n*** Delete File: gone.ts') },
      ctx(),
    )
    expect(res.content).toMatch(/A new\.ts/)
    expect(res.content).toMatch(/D gone\.ts/)
  })

  it('refuses a file too large to patch safely', async () => {
    writeFileSync(p('big.ts'), 'x'.repeat(5 * 1024 * 1024 + 10))
    const res = await applyPatch.call(
      { patch: wrap('*** Update File: big.ts\n-x\n+y') },
      ctx(),
    )
    expect(res.isError).toBe(true)
    expect(res.content).toMatch(/too large to patch/)
  })

  it('serialises through the write mutex when one is present', async () => {
    // Validating against content a concurrent sub-agent then changes would let
    // a patch apply cleanly to a file it was never checked against.
    const acquired: string[] = []
    const released: string[] = []
    const mutex = {
      async acquire(path: string) {
        acquired.push(path)
        return () => { released.push(path) }
      },
    } as unknown as ToolCallContext['writeMutex']

    writeFileSync(p('a.ts'), 'x\n')
    const res = await applyPatch.call(
      { patch: wrap('*** Update File: a.ts\n-x\n+y') },
      ctx({ writeMutex: mutex }),
    )
    expect(res.isError).toBe(false)
    expect(acquired).toContain(p('a.ts'))
    expect(released).toEqual(acquired)
  })

  it('releases the mutex even when the patch fails', async () => {
    const released: string[] = []
    const mutex = {
      async acquire(path: string) { return () => { released.push(path) } },
    } as unknown as ToolCallContext['writeMutex']

    writeFileSync(p('a.ts'), 'x\n')
    await applyPatch.call(
      { patch: wrap('*** Update File: a.ts\n-not-there\n+y') },
      ctx({ writeMutex: mutex }),
    )
    expect(released).toHaveLength(1)
  })

  it('applies a patch that empties a file without deleting it', async () => {
    writeFileSync(p('a.ts'), 'only\n')
    const res = await applyPatch.call(
      { patch: wrap('*** Update File: a.ts\n-only') },
      ctx(),
    )
    expect(res.isError).toBe(false)
    expect(readFileSync(p('a.ts'), 'utf-8')).toBe('')
  })
})

describe('turn_diff option handling', () => {
  let turnDiff: MetaAgentTool
  let tracker: TurnDiffTracker

  beforeEach(async () => {
    turnDiff = await createTurnDiffTool()
    tracker = new TurnDiffTracker()
    tracker.beginTurn('t')
  })

  it('clamps the context setting', async () => {
    writeFileSync(p('a.txt'), Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n') + '\n')
    await tracker.capture(p('a.txt'))
    writeFileSync(p('a.txt'), Array.from({ length: 30 }, (_, i) => (i === 15 ? 'CHANGED' : `l${i}`)).join('\n') + '\n')

    const tight = await turnDiff.call({ context: -5 }, ctx({ turnDiff: tracker }))
    const loose = await turnDiff.call({ context: 999 }, ctx({ turnDiff: tracker }))
    expect(tight.isError).toBe(false)
    expect(loose.content.length).toBeGreaterThan(tight.content.length)
  })

  it('stat reports no changes when nothing was touched', async () => {
    const res = await turnDiff.call({ action: 'stat' }, ctx({ turnDiff: tracker }))
    expect(res.content).toBe('No file changes in this turn.')
  })

  it('revert on an untouched turn is a no-op, not an error', async () => {
    const res = await turnDiff.call({ action: 'revert' }, ctx({ turnDiff: tracker }))
    expect(res.isError).toBe(false)
    expect(res.content).toMatch(/Nothing to revert/)
  })

  it('reports files it could not revert as an error', async () => {
    const big = p('big.bin')
    writeFileSync(big, 'x'.repeat(2 * 1024 * 1024 + 10))
    await tracker.capture(big)
    writeFileSync(big, 'small')

    const res = await turnDiff.call({ action: 'revert' }, ctx({ turnDiff: tracker }))
    expect(res.isError).toBe(true)
    expect(res.content).toMatch(/fix these by hand/)
  })

  it('lists both restored and removed files after a mixed revert', async () => {
    writeFileSync(p('keep.txt'), 'v1\n')
    await tracker.capture(p('keep.txt'))
    writeFileSync(p('keep.txt'), 'v2\n')
    await tracker.capture(p('made.txt'))
    writeFileSync(p('made.txt'), 'new\n')

    const res = await turnDiff.call({ action: 'revert' }, ctx({ turnDiff: tracker }))
    expect(res.content).toMatch(/Restored 1 file/)
    expect(res.content).toMatch(/Removed 1 file/)
  })
})
