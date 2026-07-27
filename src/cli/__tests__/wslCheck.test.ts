import { describe, expect, it } from 'vitest'
import { getWslFilesystemWarning } from '../wslCheck.js'

const WORKSPACE = { label: 'workspace', path: '/mnt/c/Users/yumx/proj' }
const HOME = { label: 'META_AGENT_HOME', path: '/home/yumx/.meta-agent' }

describe('getWslFilesystemWarning', () => {
  it('does not warn when not running under WSL', () => {
    const warning = getWslFilesystemWarning({
      paths: [WORKSPACE],
      detect: () => null,
      isWindowsBacked: () => true,
    })
    expect(warning).toBeNull()
  })

  it('does not warn when every path is on the distro filesystem', () => {
    const warning = getWslFilesystemWarning({
      paths: [HOME],
      detect: () => 'wsl2',
      isWindowsBacked: () => false,
    })
    expect(warning).toBeNull()
  })

  it('does not warn when no paths were supplied', () => {
    const warning = getWslFilesystemWarning({
      detect: () => 'wsl2',
      isWindowsBacked: () => true,
    })
    expect(warning).toBeNull()
  })

  it('warns and names only the affected paths', () => {
    const warning = getWslFilesystemWarning({
      paths: [WORKSPACE, HOME],
      detect: () => 'wsl2',
      isWindowsBacked: path => path.startsWith('/mnt/'),
    })
    expect(warning).toContain('WSL2')
    expect(warning).toContain('/mnt/c/Users/yumx/proj')
    expect(warning).not.toContain('/home/yumx/.meta-agent')
    // The three primitives the Loop runtime depends on must be named, or the
    // warning reads as a performance nag and gets ignored.
    expect(warning).toContain('link()')
    expect(warning).toContain('rename()')
    expect(warning).toContain('mtime')
    expect(warning).toContain('daemon.lock')
  })

  it('labels WSL1 distinctly', () => {
    const warning = getWslFilesystemWarning({
      paths: [WORKSPACE],
      detect: () => 'wsl1',
      isWindowsBacked: () => true,
    })
    expect(warning).toContain('WSL1')
  })

  it('can be suppressed by environment variable', () => {
    const warning = getWslFilesystemWarning({
      paths: [WORKSPACE],
      env: { META_AGENT_SUPPRESS_WSL_WARNING: '1' },
      detect: () => 'wsl2',
      isWindowsBacked: () => true,
    })
    expect(warning).toBeNull()
  })

  it('ignores empty paths rather than resolving them to cwd', () => {
    const warning = getWslFilesystemWarning({
      paths: [{ label: 'workspace', path: '' }],
      detect: () => 'wsl2',
      isWindowsBacked: () => true,
    })
    expect(warning).toBeNull()
  })
})
