import { describe, expect, it } from 'vitest'
import { buildBwrapArgs } from '../profiles/bwrap.js'
import { buildMacOSProfile } from '../profiles/macos.js'

describe('sandbox profiles', () => {
  it('does not grant workspace writes when readonlyWorkspace is true', () => {
    const workspaceRoot = '/repo'

    const macosProfile = buildMacOSProfile({ readonlyWorkspace: true }, workspaceRoot)
    expect(macosProfile).not.toContain(`(allow file-write* (subpath "${workspaceRoot}"))`)
    expect(macosProfile).toContain(`(deny file-write* (subpath "${workspaceRoot}"))`)

    const bwrapArgs = buildBwrapArgs({ readonlyWorkspace: true }, workspaceRoot)
    expect(bwrapArgs).not.toEqual(expect.arrayContaining(['--bind', workspaceRoot, workspaceRoot]))
    expect(bwrapArgs).toEqual(expect.arrayContaining(['--ro-bind', workspaceRoot, workspaceRoot]))
  })

  it('still grants explicit writeAllowPaths for readonly workspaces', () => {
    const workspaceRoot = '/repo'
    const artifactRoot = '/tmp/artifacts'

    const macosProfile = buildMacOSProfile({
      readonlyWorkspace: true,
      writeAllowPaths: [artifactRoot],
    }, workspaceRoot)
    expect(macosProfile).toContain(`(subpath "${artifactRoot}")`)

    const bwrapArgs = buildBwrapArgs({
      readonlyWorkspace: true,
      writeAllowPaths: [artifactRoot],
    }, workspaceRoot)
    expect(bwrapArgs).toEqual(expect.arrayContaining(['--bind', artifactRoot, artifactRoot]))
  })

  it('carves writeDenyPaths out of a writable workspace', () => {
    const workspaceRoot = '/repo'
    const denied = '/repo/.meta-agent'

    const macosProfile = buildMacOSProfile({ writeDenyPaths: [denied] }, workspaceRoot)
    expect(macosProfile).toContain(`(allow file-write* (subpath "${workspaceRoot}"))`)
    expect(macosProfile).toContain(`(subpath "${denied}")`)
    // Seatbelt takes the LAST matching rule — the deny must appear AFTER the allow.
    expect(macosProfile.indexOf(`(deny file-write*\n  (subpath "${denied}")`))
      .toBeGreaterThan(macosProfile.indexOf(`(allow file-write* (subpath "${workspaceRoot}"))`))

    const bwrapArgs = buildBwrapArgs({ writeDenyPaths: [denied] }, workspaceRoot)
    expect(bwrapArgs).toEqual(expect.arrayContaining(['--ro-bind-try', denied, denied]))
    // The ro-bind must come after the workspace bind so it shadows it.
    expect(bwrapArgs.indexOf('--ro-bind-try')).toBeGreaterThan(bwrapArgs.indexOf('--bind'))
  })
})
