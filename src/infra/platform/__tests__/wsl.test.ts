import { describe, expect, it } from 'vitest'
import {
  detectWsl,
  filesystemTypeOf,
  isWindowsBackedPath,
  isWsl,
  readMounts,
  type WslProbe,
} from '../wsl.js'

const MOUNTS_WSL2 = [
  '/dev/sdc / ext4 rw,relatime,discard,errors=remount-ro,data=ordered 0 0',
  'none /mnt/wsl tmpfs rw,relatime 0 0',
  'drivers /usr/lib/wsl/drivers 9p ro,dirsync,noatime 0 0',
  'C:\\134 /mnt/c 9p rw,dirsync,noatime,aname=drvfs 0 0',
  'D:\\134 /mnt/d 9p rw,dirsync,noatime,aname=drvfs 0 0',
  '',
].join('\n')

const MOUNTS_PLAIN_LINUX = [
  '/dev/nvme0n1p2 / ext4 rw,relatime 0 0',
  '/dev/nvme0n1p1 /boot/efi vfat rw,relatime 0 0',
  '',
].join('\n')

function probe(overrides: Partial<WslProbe> & { files?: Record<string, string> } = {}): WslProbe {
  const files = overrides.files ?? {}
  return {
    platform: overrides.platform ?? 'linux',
    env: overrides.env ?? {},
    release: overrides.release ?? (() => '5.15.167.4-microsoft-standard-WSL2'),
    readFile: overrides.readFile ?? ((path: string) => {
      const value = files[path]
      if (value === undefined) throw new Error(`ENOENT: ${path}`)
      return value
    }),
  }
}

describe('detectWsl', () => {
  it('returns null on non-Linux platforms', () => {
    expect(detectWsl(probe({ platform: 'darwin' }))).toBeNull()
    expect(detectWsl(probe({ platform: 'win32' }))).toBeNull()
  })

  it('returns null on a plain Linux kernel', () => {
    expect(detectWsl(probe({
      release: () => '6.8.0-45-generic',
      files: { '/proc/version': 'Linux version 6.8.0-45-generic (buildd@lcy02) …' },
    }))).toBeNull()
  })

  it('detects WSL2 from the kernel suffix', () => {
    expect(detectWsl(probe({
      files: { '/proc/version': 'Linux version 5.15.167.4-microsoft-standard-WSL2 …' },
    }))).toBe('wsl2')
  })

  it('detects WSL2 from WSL_INTEROP even when the kernel string is unhelpful', () => {
    expect(detectWsl(probe({
      release: () => '5.15.0-microsoft',
      env: { WSL_INTEROP: '/run/WSL/8_interop', WSL_DISTRO_NAME: 'Ubuntu' },
      files: { '/proc/version': 'Linux version 5.15.0-microsoft …' },
    }))).toBe('wsl2')
  })

  it('falls back to wsl1 for a Microsoft kernel with no WSL2 marker', () => {
    expect(detectWsl(probe({
      release: () => '4.4.0-19041-Microsoft',
      files: { '/proc/version': 'Linux version 4.4.0-19041-Microsoft (Microsoft@Microsoft.com) …' },
    }))).toBe('wsl1')
  })

  it('isWsl mirrors detectWsl', () => {
    expect(isWsl(probe({ platform: 'darwin' }))).toBe(false)
    expect(isWsl(probe({ files: { '/proc/version': 'microsoft-standard-WSL2' } }))).toBe(true)
  })
})

describe('readMounts', () => {
  it('returns an empty table when /proc/mounts is unreadable', () => {
    expect(readMounts(probe())).toEqual([])
  })

  it('parses mount points and lowercases fs types', () => {
    const mounts = readMounts(probe({ files: { '/proc/mounts': MOUNTS_WSL2 } }))
    expect(mounts).toContainEqual({ mountPoint: '/', fsType: 'ext4' })
    expect(mounts).toContainEqual({ mountPoint: '/mnt/c', fsType: '9p' })
  })

  it('unescapes octal-escaped mount paths', () => {
    const mounts = readMounts(probe({
      files: { '/proc/mounts': 'none /mnt/My\\040Drive 9p rw 0 0\n' },
    }))
    expect(mounts[0]?.mountPoint).toBe('/mnt/My Drive')
  })
})

describe('filesystemTypeOf', () => {
  const wsl2 = probe({ files: { '/proc/mounts': MOUNTS_WSL2 } })

  it('longest-prefix matches, not first match', () => {
    expect(filesystemTypeOf('/home/yumx/code/proj', wsl2)).toBe('ext4')
    expect(filesystemTypeOf('/mnt/c/Users/yumx/proj', wsl2)).toBe('9p')
    expect(filesystemTypeOf('/usr/lib/wsl/drivers/x', wsl2)).toBe('9p')
    expect(filesystemTypeOf('/usr/lib/other', wsl2)).toBe('ext4')
  })

  it('matches the mount point itself, not just children', () => {
    expect(filesystemTypeOf('/mnt/c', wsl2)).toBe('9p')
  })

  it('does not treat a sibling with a shared prefix as a child', () => {
    const mounts = probe({ files: { '/proc/mounts': '/dev/a / ext4 rw 0 0\nnone /mnt/c 9p rw 0 0\n' } })
    expect(filesystemTypeOf('/mnt/config', mounts)).toBe('ext4')
  })

  it('returns null when the mount table is unavailable', () => {
    expect(filesystemTypeOf('/anything', probe())).toBeNull()
  })
})

describe('isWindowsBackedPath', () => {
  const wsl2 = probe({ files: { '/proc/mounts': MOUNTS_WSL2 } })

  it('flags Windows drives and clears the distro filesystem', () => {
    expect(isWindowsBackedPath('/mnt/c/Users/yumx/proj', wsl2)).toBe(true)
    expect(isWindowsBackedPath('/mnt/d/data', wsl2)).toBe(true)
    expect(isWindowsBackedPath('/home/yumx/code/proj', wsl2)).toBe(false)
  })

  it('clears every path on a plain Linux host', () => {
    const linux = probe({ files: { '/proc/mounts': MOUNTS_PLAIN_LINUX } })
    expect(isWindowsBackedPath('/home/yumx/code/proj', linux)).toBe(false)
    expect(isWindowsBackedPath('/boot/efi/x', linux)).toBe(false)
  })

  it('flags network shares, which have the same rename/hardlink caveats', () => {
    const share = probe({ files: { '/proc/mounts': '/dev/a / ext4 rw 0 0\n//srv/x /mnt/share cifs rw 0 0\n' } })
    expect(isWindowsBackedPath('/mnt/share/proj', share)).toBe(true)
  })

  it('falls back to the /mnt/<drive> shape when the mount table is unreadable', () => {
    const blind = probe()
    expect(isWindowsBackedPath('/mnt/c/Users/yumx/proj', blind)).toBe(true)
    expect(isWindowsBackedPath('/mnt/c', blind)).toBe(true)
    expect(isWindowsBackedPath('/home/yumx/code/proj', blind)).toBe(false)
    // Multi-character segment is a normal mount, not a drive letter.
    expect(isWindowsBackedPath('/mnt/data/proj', blind)).toBe(false)
  })
})
