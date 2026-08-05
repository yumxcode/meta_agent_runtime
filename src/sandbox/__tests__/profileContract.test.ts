/**
 * Sandbox profile contract.
 *
 * The sandbox module carries the runtime's actual containment boundary but had
 * a single test file, and a code review found three defects in it: a `require`
 * call inside an ESM module (so nested-sandbox detection never ran), silent
 * degradation to no sandbox at all, and profiles that restrict writes but not
 * reads. These tests pin the generated bwrap arguments and Seatbelt profile so
 * a change to the containment policy has to be made deliberately.
 *
 * If an assertion here fails, decide whether the policy change was intended
 * before relaxing the expectation.
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { buildBwrapArgs } from '../profiles/bwrap.js'
import { buildMacOSProfile } from '../profiles/macos.js'
import { describeSandboxBackend, resetSandboxDegradationWarning } from '../index.js'
import { isInsideBwrap } from '../detect.js'

const WORKSPACE = '/tmp/sandbox-profile-ws'

describe('bwrap argument contract', () => {
  it('mounts host root read-only and the workspace read-write', () => {
    const joined = buildBwrapArgs({}, WORKSPACE).join(' ')
    expect(joined).toContain('--ro-bind / /')
    expect(joined).toContain(`--bind ${WORKSPACE} ${WORKSPACE}`)
  })

  it('isolates the pseudo-filesystems and dies with its parent', () => {
    const joined = buildBwrapArgs({}, WORKSPACE).join(' ')
    expect(joined).toContain('--dev /dev')      // fresh /dev hides host block devices
    expect(joined).toContain('--proc /proc')
    expect(joined).toContain('--tmpfs /tmp')    // /tmp not shared with the host
    expect(joined).toContain('--unshare-pid')
    expect(joined).toContain('--die-with-parent')
  })

  it('ends with the -- separator so the command cannot be parsed as a bwrap flag', () => {
    expect(buildBwrapArgs({}, WORKSPACE).at(-1)).toBe('--')
  })

  it('orders writeDeny after writeAllow so the later mount shadows the earlier', () => {
    const joined = buildBwrapArgs({
      writeAllowPaths: ['/data/out'],
      writeDenyPaths:  ['/data/out/protected'],
      readDenyPaths:   ['/home/u/.ssh'],
    }, WORKSPACE).join(' ')
    expect(joined).toContain('--bind /data/out /data/out')
    expect(joined).toContain('--ro-bind-try /data/out/protected /data/out/protected')
    expect(joined).toContain('--tmpfs /home/u/.ssh')
    expect(joined.indexOf('--bind /data/out /data/out'))
      .toBeLessThan(joined.indexOf('--ro-bind-try /data/out/protected'))
  })

  it('only unshares the network when the policy asks for it', () => {
    expect(buildBwrapArgs({}, WORKSPACE)).not.toContain('--unshare-net')
    expect(buildBwrapArgs({ network: 'none' }, WORKSPACE)).toContain('--unshare-net')
  })

  it('DOCUMENTED GAP: reads are unrestricted and the network is open by default', () => {
    // `--ro-bind / /` makes the whole host filesystem READABLE inside the
    // sandbox, and nothing sets readDenyPaths by default — so
    // ~/.meta-agent/config.json (which may hold apiKey), ~/.ssh and ~/.aws stay
    // readable, with network access available to send them somewhere. This is
    // the review's P1-1 finding, currently accepted rather than fixed; the test
    // keeps the gap visible in the suite instead of only in a document.
    const args = buildBwrapArgs({}, WORKSPACE)
    expect(args.filter(a => a === '--tmpfs')).toHaveLength(1)   // only /tmp — no read denies
    expect(args).not.toContain('--unshare-net')
  })
})

describe('macOS Seatbelt profile contract', () => {
  it('denies all writes before re-allowing the workspace (last match wins)', () => {
    const profile = buildMacOSProfile({}, WORKSPACE)
    expect(profile).toContain('(version 1)')
    expect(profile).toContain('(deny file-write*)')
    expect(profile).toContain(`(allow file-write* (subpath "${WORKSPACE}"))`)
    expect(profile.indexOf('(deny file-write*)'))
      .toBeLessThan(profile.indexOf(`(allow file-write* (subpath "${WORKSPACE}")`))
  })

  it('keeps the device nodes and temp dirs the Node runtime needs writable', () => {
    const profile = buildMacOSProfile({}, WORKSPACE)
    for (const needed of ['/dev/null', '/dev/zero', '/dev/random', '/dev/urandom']) {
      expect(profile).toContain(`(literal "${needed}")`)
    }
    expect(profile).toContain('(subpath "/private/var/folders")')
    expect(profile).toContain('^/dev/fd/[0-9]+$')
  })

  it('escapes quotes so a crafted workspace path cannot break out of the SBPL string', () => {
    expect(buildMacOSProfile({}, '/tmp/we"ird')).toContain('/tmp/we\\"ird')
  })

  it('only denies the network when the policy asks for it', () => {
    expect(buildMacOSProfile({}, WORKSPACE)).not.toContain('(deny network*)')
    expect(buildMacOSProfile({ network: 'none' }, WORKSPACE)).toContain('(deny network*)')
  })

  it('DOCUMENTED GAP: the base is (allow default), so reads are unrestricted', () => {
    const profile = buildMacOSProfile({}, WORKSPACE)
    expect(profile).toContain('(allow default)')
    expect(profile).not.toContain('(deny file-read*')
  })
})

describe('sandbox backend detection', () => {
  beforeEach(() => resetSandboxDegradationWarning())

  it('reports the backend and whether it is actually enforced', () => {
    const info = describeSandboxBackend()
    expect(['macos/sandbox-exec', 'linux/bwrap', 'none']).toContain(info.backend)
    // A non-enforced backend must explain itself: the point of exposing this is
    // that an operator can tell "jailed" from "not jailed".
    if (info.enforced) expect(info.backend).not.toBe('none')
    else expect(info.reason).toBeTruthy()
  })

  it('isInsideBwrap returns a boolean rather than throwing', () => {
    // Regression: this used `require('fs')` inside an ESM module, so the
    // /proc/1/cmdline probe threw ReferenceError on every call, was swallowed
    // by the surrounding catch, and nested-sandbox detection silently never
    // worked — leaving bwrap to fail at exec time with an opaque EPERM.
    expect(typeof isInsideBwrap()).toBe('boolean')
  })

  it('isInsideBwrap honours the BWRAP_SANDBOX_PID marker', () => {
    const previous = process.env['BWRAP_SANDBOX_PID']
    process.env['BWRAP_SANDBOX_PID'] = '1234'
    try {
      expect(isInsideBwrap()).toBe(true)
    } finally {
      if (previous === undefined) delete process.env['BWRAP_SANDBOX_PID']
      else process.env['BWRAP_SANDBOX_PID'] = previous
    }
  })
})
