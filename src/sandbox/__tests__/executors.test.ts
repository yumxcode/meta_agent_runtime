/**
 * Sandbox executors and factory.
 *
 * These three executors plus the factory are the code that decides WHETHER a
 * shell command gets an OS jail at all — the runtime's only real containment
 * boundary. A coverage run put them at 0%, and that is exactly where the ESM
 * `require` bug lived (nested-bwrap detection silently never worked, so bwrap
 * failed at exec time with an opaque EPERM on every command).
 *
 * All of this is testable WITHOUT bwrap or macOS installed: `create()` branches
 * only on the three boolean probes in ./detect.js, so mocking that module gives
 * full control of the decision table.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../detect.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../detect.js')>()
  return {
    ...actual,
    isMacOS: vi.fn(() => false),
    isLinux: vi.fn(() => false),
    isSandboxExecAvailable: vi.fn(() => false),
    isBwrapAvailable: vi.fn(() => false),
    isInsideBwrap: vi.fn(() => false),
  }
})

import {
  isMacOS, isLinux, isSandboxExecAvailable, isBwrapAvailable, isInsideBwrap,
} from '../detect.js'
import { LinuxSandboxExecutor } from '../LinuxSandboxExecutor.js'
import { MacOSSandboxExecutor } from '../MacOSSandboxExecutor.js'
import { NoopSandboxExecutor } from '../NoopSandboxExecutor.js'
import { createSandboxExecutor, describeSandboxBackend, resetSandboxDegradationWarning } from '../index.js'

const mockMacOS = vi.mocked(isMacOS)
const mockLinux = vi.mocked(isLinux)
const mockSandboxExec = vi.mocked(isSandboxExecAvailable)
const mockBwrap = vi.mocked(isBwrapAvailable)
const mockNested = vi.mocked(isInsideBwrap)

const WORKSPACE = '/tmp/sandbox-exec-ws'

/** Set the platform decision table in one call. */
function platform(opts: {
  macos?: boolean; linux?: boolean
  sandboxExec?: boolean; bwrap?: boolean; nested?: boolean
}): void {
  mockMacOS.mockReturnValue(opts.macos ?? false)
  mockLinux.mockReturnValue(opts.linux ?? false)
  mockSandboxExec.mockReturnValue(opts.sandboxExec ?? false)
  mockBwrap.mockReturnValue(opts.bwrap ?? false)
  mockNested.mockReturnValue(opts.nested ?? false)
}

let stderrSpy: ReturnType<typeof vi.spyOn>
let stderrOut: string

beforeEach(() => {
  resetSandboxDegradationWarning()
  stderrOut = ''
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderrOut += String(chunk)
    return true
  })
})

afterEach(() => {
  stderrSpy.mockRestore()
  vi.clearAllMocks()
})

// ── wrapExec: the command must never be re-parsed as shell text ──────────────

describe('wrapExec argv construction', () => {
  it('Noop passes the command straight to bash -c', () => {
    const handle = new (class extends NoopSandboxExecutor {})().create({}, WORKSPACE)
    return handle.then(h => {
      expect(h.wrapExec('echo hi', WORKSPACE)).toEqual({ file: 'bash', args: ['-c', 'echo hi'] })
    })
  })

  it('Linux appends `bash -c <cmd>` after the bwrap separator', async () => {
    platform({ linux: true, bwrap: true })
    const handle = await new LinuxSandboxExecutor().create({}, WORKSPACE)
    const spec = handle.wrapExec('echo hi', WORKSPACE)
    expect(spec.file).toBe('bwrap')
    // The last three argv entries must be exactly the shell invocation, and the
    // separator must sit immediately before them.
    expect(spec.args.slice(-4)).toEqual(['--', 'bash', '-c', 'echo hi'])
  })

  it('macOS passes the profile via -p and the command as a single argv entry', async () => {
    platform({ macos: true, sandboxExec: true })
    const handle = await new MacOSSandboxExecutor().create({}, WORKSPACE)
    const spec = handle.wrapExec('echo hi', WORKSPACE)
    expect(spec.file).toBe('sandbox-exec')
    expect(spec.args[0]).toBe('-p')
    expect(spec.args.slice(-3)).toEqual(['bash', '-c', 'echo hi'])
  })

  it('a command containing spaces, quotes and newlines stays ONE argv entry', async () => {
    // The whole point of argv-based exec: no string concatenation happens here,
    // so the command can never be re-split or injected into the wrapper's flags.
    const nasty = `echo "a b"; rm -rf /\n--unshare-net $(whoami)`
    platform({ linux: true, bwrap: true })
    const linux = await new LinuxSandboxExecutor().create({}, WORKSPACE)
    expect(linux.wrapExec(nasty, WORKSPACE).args.at(-1)).toBe(nasty)

    platform({ macos: true, sandboxExec: true })
    const mac = await new MacOSSandboxExecutor().create({}, WORKSPACE)
    expect(mac.wrapExec(nasty, WORKSPACE).args.at(-1)).toBe(nasty)

    const noop = await new NoopSandboxExecutor().create({}, WORKSPACE)
    expect(noop.wrapExec(nasty, WORKSPACE).args.at(-1)).toBe(nasty)
  })
})

// ── create(): the availability / fallback decision table ─────────────────────

describe('LinuxSandboxExecutor.create', () => {
  it('throws with install guidance when bwrap is missing', async () => {
    platform({ linux: true, bwrap: false })
    await expect(new LinuxSandboxExecutor().create({}, WORKSPACE))
      .rejects.toThrow(/bwrap not found on PATH/)
  })

  it('FAILS CLOSED on nested bwrap when fallback is not allowed', async () => {
    // This is the branch auto / simple_auto depend on: lockWorkspace forces
    // allowUnsandboxedFallback:false, so an unsandboxable host must error rather
    // than quietly run the agent unjailed.
    platform({ linux: true, bwrap: true, nested: true })
    await expect(
      new LinuxSandboxExecutor().create({ allowUnsandboxedFallback: false }, WORKSPACE),
    ).rejects.toThrow(/nested bwrap detected/)
  })

  it('degrades to a passthrough handle on nested bwrap when fallback IS allowed', async () => {
    platform({ linux: true, bwrap: true, nested: true })
    const handle = await new LinuxSandboxExecutor().create(
      { allowUnsandboxedFallback: true }, WORKSPACE,
    )
    expect(handle.description).toMatch(/noop-fallback/)
    expect(handle.wrapExec('ls', WORKSPACE)).toEqual({ file: 'bash', args: ['-c', 'ls'] })
    // Degrading silently is the failure mode we are guarding against.
    expect(stderrOut).toMatch(/WARNING.*nested bwrap/)
  })

  it('produces a real jail when bwrap is available and not nested', async () => {
    platform({ linux: true, bwrap: true, nested: false })
    const handle = await new LinuxSandboxExecutor().create({}, WORKSPACE)
    expect(handle.description).toMatch(/linux\/bwrap/)
    expect(handle.wrapExec('ls', WORKSPACE).file).toBe('bwrap')
  })
})

describe('MacOSSandboxExecutor.create', () => {
  it('throws when sandbox-exec is unavailable', async () => {
    platform({ macos: true, sandboxExec: false })
    await expect(new MacOSSandboxExecutor().create({}, WORKSPACE))
      .rejects.toThrow(/sandbox-exec not available/)
  })

  it('embeds the generated profile in the handle', async () => {
    platform({ macos: true, sandboxExec: true })
    const handle = await new MacOSSandboxExecutor().create({ network: 'none' }, WORKSPACE)
    const profile = handle.wrapExec('ls', WORKSPACE).args[1]!
    expect(profile).toContain('(deny file-write*)')
    expect(profile).toContain('(deny network*)')
  })
})

// ── factory selection + one-shot degradation warning ─────────────────────────

describe('createSandboxExecutor', () => {
  it('selects macOS when sandbox-exec is present', () => {
    platform({ macos: true, sandboxExec: true })
    expect(createSandboxExecutor().platform).toBe('macos')
  })

  it('selects Linux when bwrap is present', () => {
    platform({ linux: true, bwrap: true })
    expect(createSandboxExecutor().platform).toBe('linux')
  })

  it('falls back to noop when neither backend exists', () => {
    platform({})
    expect(createSandboxExecutor().platform).toBe('noop')
  })

  it('warns LOUDLY but only ONCE when degrading to noop', () => {
    platform({})
    createSandboxExecutor()
    createSandboxExecutor()
    createSandboxExecutor()
    const warnings = stderrOut.match(/no OS sandbox backend available/g) ?? []
    expect(warnings).toHaveLength(1)
    // The warning has to say the jail is gone, not just that a tool is missing.
    expect(stderrOut).toMatch(/WITHOUT an OS-enforced workspace jail/)
  })

  it('does not warn when a real backend is selected', () => {
    platform({ linux: true, bwrap: true })
    createSandboxExecutor()
    expect(stderrOut).toBe('')
  })
})

describe('describeSandboxBackend', () => {
  it('reports an enforced macOS backend', () => {
    platform({ macos: true, sandboxExec: true })
    expect(describeSandboxBackend()).toEqual({ backend: 'macos/sandbox-exec', enforced: true })
  })

  it('reports an enforced Linux backend', () => {
    platform({ linux: true, bwrap: true })
    expect(describeSandboxBackend()).toEqual({ backend: 'linux/bwrap', enforced: true })
  })

  it('explains WHY macOS is unenforced', () => {
    platform({ macos: true, sandboxExec: false })
    const info = describeSandboxBackend()
    expect(info).toMatchObject({ backend: 'none', enforced: false })
    expect(info.reason).toMatch(/sandbox-exec/)
  })

  it('explains WHY Linux is unenforced — missing bwrap', () => {
    platform({ linux: true, bwrap: false })
    const info = describeSandboxBackend()
    expect(info).toMatchObject({ backend: 'none', enforced: false })
    expect(info.reason).toMatch(/bubblewrap|bwrap not installed/)
  })

  it('explains WHY Linux is unenforced — already nested', () => {
    platform({ linux: true, bwrap: true, nested: true })
    const info = describeSandboxBackend()
    expect(info).toMatchObject({ backend: 'none', enforced: false })
    expect(info.reason).toMatch(/nested|already running inside/)
  })

  it('names the platform when no backend exists at all', () => {
    platform({})
    const info = describeSandboxBackend()
    expect(info.enforced).toBe(false)
    expect(info.reason).toContain(process.platform)
  })

  it('an unenforced result ALWAYS carries a reason', () => {
    for (const combo of [
      {}, { macos: true }, { linux: true },
      { linux: true, bwrap: true, nested: true },
    ]) {
      platform(combo)
      const info = describeSandboxBackend()
      if (!info.enforced) expect(info.reason, JSON.stringify(combo)).toBeTruthy()
    }
  })
})
