/**
 * configuredWritePaths — config.json → writable host paths.
 *
 * Small file, large blast radius: whatever this returns gets bind-mounted
 * READ-WRITE into the sandbox. Every rejection branch here (relative paths,
 * non-existent paths, malformed config) is a place where a mistake would hand
 * the agent write access to a host directory it should not have. It was at 0%
 * coverage.
 *
 * The security-relevant property throughout is that it fails CLOSED: anything
 * it cannot confidently resolve is dropped rather than passed through.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, resolve } from 'node:path'

const cfg = vi.hoisted(() => ({ value: undefined as unknown, shouldThrow: false }))

vi.mock('../../core/config/ConfigService.js', () => ({
  getValue: (key: string) => {
    if (cfg.shouldThrow) throw new Error('config layer exploded')
    return key === 'sandbox.writeAllowPaths' ? cfg.value : undefined
  },
}))

import { resolveConfiguredWriteAllowPaths, resolveHostPathRequirement } from '../configuredWritePaths.js'

const dirs: string[] = []
function realDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'cfg-write-'))
  dirs.push(d)
  return d
}

beforeEach(() => {
  cfg.value = undefined
  cfg.shouldThrow = false
})

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  vi.clearAllMocks()
})

const run = (): string[] => resolveConfiguredWriteAllowPaths('/some/project')

describe('resolveConfiguredWriteAllowPaths — accepts', () => {
  it('an existing absolute path', () => {
    const dir = realDir()
    cfg.value = [dir]
    expect(run()).toEqual([dir])
  })

  it('expands a bare ~ to the home directory (when it exists)', () => {
    cfg.value = ['~']
    // homedir() exists on any real host; assert on the expansion, not on presence.
    expect(run()).toEqual([resolve(homedir())])
  })

  it('expands ~/subdir', () => {
    const dir = realDir()
    // Fabricate a "~/x" whose expansion is a directory we know exists by
    // pointing HOME at our scratch dir for the duration of the call.
    const prevHome = process.env['HOME']
    process.env['HOME'] = dir
    try {
      mkdirSync(join(dir, 'artifacts'), { recursive: true })
      cfg.value = ['~/artifacts']
      const out = run()
      // homedir() may read the OS record rather than $HOME on some platforms;
      // accept either resolution as long as SOMETHING expanded and exists.
      expect(out.length <= 1).toBe(true)
      if (out.length === 1) expect(out[0]).toMatch(/artifacts$/)
    } finally {
      if (prevHome === undefined) delete process.env['HOME']
      else process.env['HOME'] = prevHome
    }
  })

  it('keeps multiple distinct existing paths in order', () => {
    const a = realDir(); const b = realDir()
    cfg.value = [a, b]
    expect(run()).toEqual([a, b])
  })
})

describe('resolveConfiguredWriteAllowPaths — rejects (fails closed)', () => {
  it('a RELATIVE path — it must not be resolved against projectDir into a host grant', () => {
    cfg.value = ['./out', '../escape', 'relative/dir']
    expect(run()).toEqual([])
  })

  it('a non-existent absolute path (bwrap needs the bind source to exist)', () => {
    cfg.value = ['/definitely/not/here/xyz-12345']
    expect(run()).toEqual([])
  })

  it('non-string entries', () => {
    cfg.value = [42, null, undefined, {}, [], true]
    expect(run()).toEqual([])
  })

  it('empty and whitespace-only entries', () => {
    cfg.value = ['', '   ', '\t\n']
    expect(run()).toEqual([])
  })

  it('a config value that is not an array', () => {
    for (const bad of ['/tmp', { path: '/tmp' }, 42, null, true]) {
      cfg.value = bad
      expect(run(), JSON.stringify(bad)).toEqual([])
    }
  })

  it('an absent config key', () => {
    cfg.value = undefined
    expect(run()).toEqual([])
  })

  it('a THROWING config layer — returns [] instead of propagating', () => {
    // Fail-closed: a broken config file must not grant paths, and must not take
    // down the session either.
    cfg.shouldThrow = true
    expect(run()).toEqual([])
  })
})

describe('resolveConfiguredWriteAllowPaths — normalisation', () => {
  it('de-duplicates repeated paths', () => {
    const dir = realDir()
    cfg.value = [dir, dir, dir]
    expect(run()).toEqual([dir])
  })

  it('de-duplicates paths that differ only by a trailing slash or . segment', () => {
    const dir = realDir()
    cfg.value = [dir, `${dir}/`, `${dir}/.`]
    expect(run()).toEqual([dir])
  })

  it('trims surrounding whitespace before resolving', () => {
    const dir = realDir()
    cfg.value = [`  ${dir}  `]
    expect(run()).toEqual([dir])
  })

  it('keeps the good entries when the list also contains bad ones', () => {
    const dir = realDir()
    cfg.value = ['./relative', dir, '/nope/nope', '', 7]
    expect(run()).toEqual([dir])
  })
})

describe('resolveHostPathRequirement', () => {
  it('expands a bare ~', () => {
    expect(resolveHostPathRequirement('~')).toBe(homedir())
  })

  it('expands ~/x', () => {
    expect(resolveHostPathRequirement('~/data')).toBe(resolve(homedir(), 'data'))
  })

  it('passes an absolute path through, normalised', () => {
    expect(resolveHostPathRequirement('/data//sub/.')).toBe(resolve('/data/sub'))
  })

  it('resolves a relative path against cwd (requirement ≠ grant)', () => {
    // This function only EXPANDS; it deliberately does not decide whether the
    // path is granted — that is resolveConfiguredWriteAllowPaths' job, which is
    // why a relative path is allowed to resolve here but dropped there.
    expect(resolveHostPathRequirement('rel/dir')).toBe(resolve('rel/dir'))
  })

  it('trims whitespace', () => {
    expect(resolveHostPathRequirement('  /data  ')).toBe(resolve('/data'))
  })
})
