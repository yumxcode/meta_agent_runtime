import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  resolveExistingInside,
  resolveInside,
  writeScopeRoot,
} from '../PathSafety.js'

describe('Loop path safety', () => {
  it('accepts contained paths and rejects traversal/absolute paths', () => {
    expect(resolveInside('/workspace/root', 'ledger/progress.json')).toBe('/workspace/root/ledger/progress.json')
    expect(() => resolveInside('/workspace/root', '../root-other/secret')).toThrow(/unsafe|escapes/)
    expect(() => resolveInside('/workspace/root', '/etc/passwd')).toThrow(/unsafe/)
    expect(() => resolveInside('/workspace/root', 'a/../../secret')).toThrow(/unsafe/)
  })

  it('rejects symlinks that escape the read root', async () => {
    const base = await mkdtemp(join(tmpdir(), 'loop-path-'))
    const root = join(base, 'root')
    const outside = join(base, 'outside.txt')
    await mkdir(root)
    await writeFile(outside, 'secret')
    await symlink(outside, join(root, 'link.txt'))
    await expect(resolveExistingInside(root, 'link.txt')).rejects.toThrow(/symlink/)
  })

  it('only accepts enforceable literal or trailing directory-tree scopes', () => {
    expect(writeScopeRoot('src/**')).toBe('src')
    expect(writeScopeRoot('src/file.ts')).toBe('src/file.ts')
    expect(() => writeScopeRoot('src/**/*.ts')).toThrow(/only a literal/)
    expect(() => writeScopeRoot('*.md')).toThrow(/only a literal/)
    expect(() => writeScopeRoot('./**')).toThrow(/workspace root/)
  })
})
