/**
 * The operator-facing sandbox policy: external read/write grants, deny lists,
 * and the credential defaults that make the sandbox protect reads and not only
 * writes.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  resolveSandboxPolicy,
  applySandboxPolicy,
  expandHostPath,
  DEFAULT_CREDENTIAL_DENY_PATHS,
} from '../sandboxPolicyConfig.js'
import { buildMacOSProfile } from '../profiles/macos.js'
import { buildBwrapArgs } from '../profiles/bwrap.js'
import type { SandboxConfig } from '../types.js'

let projectDir: string

function writeProjectConfig(sandbox: Record<string, unknown>): void {
  const dir = join(projectDir, '.meta-agent')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ sandbox }, null, 2))
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'sandboxcfg-'))
})
afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true })
})

describe('resolveSandboxPolicy — external path grants from config.json', () => {
  it('reads writeAllowPaths and exposes them as allowedRoots', () => {
    const external = mkdtempSync(join(tmpdir(), 'grant-w-'))
    writeProjectConfig({ writeAllowPaths: [external] })
    const policy = resolveSandboxPolicy(projectDir)
    expect(policy.writeAllowPaths).toContain(external)
    expect(policy.allowedRoots).toContain(external)
    rmSync(external, { recursive: true, force: true })
  })

  it('reads readAllowPaths — readable, but NOT in the writable set', () => {
    const external = mkdtempSync(join(tmpdir(), 'grant-r-'))
    writeProjectConfig({ readAllowPaths: [external] })
    const policy = resolveSandboxPolicy(projectDir)
    expect(policy.readAllowPaths).toContain(external)
    expect(policy.writeAllowPaths).not.toContain(external)
    // Still a legal path to reference / cd into — that is what allowedRoots is.
    expect(policy.allowedRoots).toContain(external)
    rmSync(external, { recursive: true, force: true })
  })

  it('expands ~ and drops relative entries', () => {
    expect(expandHostPath('~')).toBeTruthy()
    expect(expandHostPath('relative/path')).toBeNull()
    expect(expandHostPath('  ')).toBeNull()
  })

  it('drops non-existent paths (a missing bind source fails every bwrap call)', () => {
    writeProjectConfig({ writeAllowPaths: ['/definitely/not/here/12345'] })
    expect(resolveSandboxPolicy(projectDir).writeAllowPaths).toHaveLength(0)
  })

  it('reads network and allowUnsandboxedFallback', () => {
    writeProjectConfig({ network: 'none', allowUnsandboxedFallback: false })
    const policy = resolveSandboxPolicy(projectDir)
    expect(policy.network).toBe('none')
    expect(policy.allowUnsandboxedFallback).toBe(false)
  })

  it('ignores a malformed sandbox section instead of throwing', () => {
    writeProjectConfig({ writeAllowPaths: 'not-an-array', network: 42 })
    const policy = resolveSandboxPolicy(projectDir)
    expect(policy.writeAllowPaths).toEqual([])
    expect(policy.network).toBeUndefined()
  })
})

describe('credential protection defaults', () => {
  it('denies reads of credential stores by default', () => {
    writeProjectConfig({})
    const policy = resolveSandboxPolicy(projectDir)
    // Only paths that exist on this machine survive the filter, so assert the
    // relationship rather than a specific entry.
    const expanded = DEFAULT_CREDENTIAL_DENY_PATHS.map(expandHostPath)
    for (const denied of policy.readDenyPaths) {
      expect(expanded).toContain(denied)
    }
  })

  it('protectCredentials: false removes them', () => {
    writeProjectConfig({ protectCredentials: false })
    expect(resolveSandboxPolicy(projectDir).readDenyPaths).toEqual([])
  })

  it('an explicit grant overrides the default deny for that path', () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'fakecred-'))
    writeProjectConfig({ readAllowPaths: [fakeHome], readDenyPaths: [fakeHome] })
    const policy = resolveSandboxPolicy(projectDir)
    // An EXPLICIT deny still wins over an explicit allow — only the credential
    // DEFAULTS yield to a grant.
    expect(policy.readDenyPaths).toContain(fakeHome)
    rmSync(fakeHome, { recursive: true, force: true })
  })
})

describe('applySandboxPolicy — merging operator policy into a tool declaration', () => {
  const policy = {
    writeAllowPaths: ['/w'],
    readAllowPaths: ['/r'],
    writeDenyPaths: ['/wd'],
    readDenyPaths: ['/rd'],
    network: undefined,
    allowUnsandboxedFallback: undefined,
    allowedRoots: ['/w', '/r'],
  }

  it('unions allow and deny lists', () => {
    const merged = applySandboxPolicy({ writeAllowPaths: ['/tool'] }, policy)
    expect(merged.writeAllowPaths).toEqual(expect.arrayContaining(['/tool', '/w']))
    expect(merged.readDenyPaths).toContain('/rd')
  })

  it("network: 'none' is sticky from either side", () => {
    expect(applySandboxPolicy({ network: 'none' }, policy).network).toBe('none')
    expect(
      applySandboxPolicy({ network: 'unrestricted' }, { ...policy, network: 'none' }).network,
    ).toBe('none')
  })

  it('does not fold read-only grants into the writable set', () => {
    const merged = applySandboxPolicy({}, policy)
    expect(merged.writeAllowPaths).not.toContain('/r')
    expect(merged.readAllowPaths).toContain('/r')
  })
})

describe('backends honour read grants and denies', () => {
  const config: SandboxConfig = {
    readDenyPaths: ['/home/u/.ssh', '/home/u/.aws'],
    readAllowPaths: ['/home/u/.aws'],
  }

  it('seatbelt emits deny file-read* for denied paths only', () => {
    const profile = buildMacOSProfile(config, '/ws')
    expect(profile).toContain('(deny file-read*')
    expect(profile).toContain('/home/u/.ssh')
    // Explicitly granted → not shadowed.
    expect(profile).not.toMatch(/deny file-read\*[\s\S]*\.aws/)
  })

  it('bwrap tmpfs-shadows denied paths but not granted ones', () => {
    const args = buildBwrapArgs(config, '/ws')
    const joined = args.join(' ')
    expect(joined).toContain('--tmpfs /home/u/.ssh')
    expect(joined).not.toContain('--tmpfs /home/u/.aws')
  })

  it('bwrap uses --bind-try so a stale grant cannot break every command', () => {
    const args = buildBwrapArgs({ writeAllowPaths: ['/data/scratch'] }, '/ws')
    expect(args).toContain('--bind-try')
    expect(args.join(' ')).toContain('--bind-try /data/scratch /data/scratch')
  })
})

/**
 * Regression: a deny NESTED under a grant used to be dropped by both backends,
 * so this config —
 *
 *   readAllowPaths: ["~/.ssh"]          (needed for known_hosts)
 *   readDenyPaths:  ["~/.ssh/id_ed25519"]
 *
 * — read like a precise carve-out and produced a fully readable ~/.ssh. It
 * also contradicted sandboxPolicyConfig's documented precedence ("an
 * operator's explicit deny always wins over an operator's allow").
 */
describe('an explicit deny nested under a grant survives', () => {
  const nested: SandboxConfig = {
    readAllowPaths: ['/home/u/.ssh'],
    readDenyPaths: ['/home/u/.ssh/id_ed25519'],
  }

  it('seatbelt still denies the key', () => {
    expect(buildMacOSProfile(nested, '/ws')).toContain('/home/u/.ssh/id_ed25519')
  })

  it('bwrap still shadows the key', () => {
    expect(buildBwrapArgs(nested, '/ws').join(' ')).toContain('--tmpfs /home/u/.ssh/id_ed25519')
  })

  it('an EXACT overlap is still treated as the caller contradicting itself', () => {
    // Unchanged behaviour: naming the same path in both lists is not a
    // carve-out, and resolveSandboxPolicy has already applied the one rule
    // where an allow legitimately cancels a deny (credential DEFAULTS).
    const exact: SandboxConfig = {
      readAllowPaths: ['/home/u/.aws'],
      readDenyPaths: ['/home/u/.aws'],
    }
    expect(buildMacOSProfile(exact, '/ws')).not.toContain('(deny file-read*')
    expect(buildBwrapArgs(exact, '/ws').join(' ')).not.toContain('--tmpfs /home/u/.aws')
  })
})
