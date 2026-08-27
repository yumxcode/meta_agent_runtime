/**
 * Regression tests for P0-1 (review 2026-08-27): store identifiers used as path
 * segments must fail closed rather than escape their root.
 *
 * The original defect: `new JobStore('..').save({ jobId: 'config', ... })`
 * resolved to `$META_AGENT_HOME/config.json` and overwrote the runtime config.
 */

import { describe, it, expect } from 'vitest'
import { join, resolve, sep } from 'node:path'
import { validateStoreId, isValidStoreId, resolveWithinRoot, StoreIdError } from '../storeId.js'

describe('validateStoreId', () => {
  describe('rejects traversal and separator forms', () => {
    const traversal = [
      '..',
      '.',
      '../..',
      '../config',
      'a/../../b',
      'foo/bar',
      'foo\\bar',
      '/etc/passwd',
      './relative',
      '..\\..\\windows',
    ]
    for (const id of traversal) {
      it(`rejects ${JSON.stringify(id)}`, () => {
        expect(() => validateStoreId(id)).toThrow(StoreIdError)
      })
    }
  })

  describe('rejects Windows-specific aliasing forms', () => {
    // These are legal POSIX filenames, so a POSIX-only check lets a store be
    // written on Linux that cannot be read back on Windows — or worse, that
    // aliases two ids onto one file there.
    const win32 = [
      'C:',            // drive letter
      'C:config',      // drive-relative path
      'name:stream',   // NTFS alternate data stream
      'trailing.',     // Win32 strips the trailing dot
      'trailing ',     // Win32 strips the trailing space
    ]
    for (const id of win32) {
      it(`rejects ${JSON.stringify(id)}`, () => {
        expect(() => validateStoreId(id)).toThrow(StoreIdError)
      })
    }
  })

  it('rejects empty, whitespace-only and NUL-bearing ids', () => {
    expect(() => validateStoreId('')).toThrow(StoreIdError)
    expect(() => validateStoreId('   ')).toThrow(StoreIdError)
    expect(() => validateStoreId('foo\0bar')).toThrow(StoreIdError)
    expect(() => validateStoreId('foo\0')).toThrow(StoreIdError)
  })

  it('rejects ids past the per-component length budget', () => {
    expect(() => validateStoreId('a'.repeat(201))).toThrow(StoreIdError)
    expect(validateStoreId('a'.repeat(200))).toHaveLength(200)
  })

  it('rejects double-encoded traversal rather than decoding it', () => {
    // %2e%2e%2f must not be treated as `../` — but it must also not be silently
    // accepted as a literal name, because a later layer might decode it.
    expect(() => validateStoreId('%2e%2e%2f')).toThrow(StoreIdError)
    expect(() => validateStoreId('..%2fetc')).toThrow(StoreIdError)
  })

  it('accepts the id shapes the runtime actually mints', () => {
    // SessionStore: UUID v4. JobStore: makeJobId() → <domain>-<tool>-<uuid8>.
    // CampaignStateStore: c_<hash>_<slug>.
    expect(validateStoreId('3f2504e0-4f89-11d3-9a0c-0305e82c3301')).toBeTruthy()
    expect(validateStoreId('generic-bash_tool-a1b2c3d4')).toBeTruthy()
    expect(validateStoreId('c_ab12cd_my_project')).toBeTruthy()
    expect(validateStoreId('history.jsonl')).toBeTruthy()
    expect(validateStoreId('v1.2.3')).toBeTruthy()
  })

  it('returns the id unchanged rather than sanitising it', () => {
    // Sanitising would let two distinct ids collide on one file.
    expect(validateStoreId('Abc-123_x.y')).toBe('Abc-123_x.y')
  })

  it('names the offending field in the error message', () => {
    expect(() => validateStoreId('..', 'sessionId')).toThrow(/sessionId/)
    expect(() => validateStoreId('..', 'jobId')).toThrow(/jobId/)
  })
})

describe('isValidStoreId', () => {
  it('mirrors validateStoreId without throwing', () => {
    expect(isValidStoreId('ok-id')).toBe(true)
    expect(isValidStoreId('..')).toBe(false)
    expect(isValidStoreId('')).toBe(false)
    expect(isValidStoreId('a/b')).toBe(false)
  })
})

describe('resolveWithinRoot', () => {
  const root = resolve('/tmp/meta-agent-test-root')

  it('resolves ordinary segments under the root', () => {
    expect(resolveWithinRoot(root, 'session-1')).toBe(join(root, 'session-1'))
    expect(resolveWithinRoot(root, 'session-1', 'history.jsonl'))
      .toBe(join(root, 'session-1', 'history.jsonl'))
  })

  it('rejects a segment that climbs above the root', () => {
    expect(() => resolveWithinRoot(root, '..')).toThrow(StoreIdError)
    expect(() => resolveWithinRoot(root, '..', 'config.json')).toThrow(StoreIdError)
    expect(() => resolveWithinRoot(root, 'a', '..', '..', 'config.json')).toThrow(StoreIdError)
  })

  it('rejects the root itself as a target', () => {
    // Writing "the root" is always a bug: the caller meant a record inside it.
    expect(() => resolveWithinRoot(root, '.')).toThrow(StoreIdError)
  })

  it('rejects an absolute segment that would discard the root', () => {
    // resolve() lets a later absolute segment win outright — the exact reason
    // the containment check runs on the OUTPUT, not just the input.
    expect(() => resolveWithinRoot(root, `${sep}etc${sep}passwd`)).toThrow(StoreIdError)
  })

  it('does not treat a sibling with the root as a name prefix as contained', () => {
    // String-prefix containment checks say `/tmp/root-evil` is inside `/tmp/root`.
    const sibling = `${root}-evil`
    expect(() => resolveWithinRoot(root, '..', `${sibling.split(sep).pop()}`)).toThrow(StoreIdError)
  })
})
