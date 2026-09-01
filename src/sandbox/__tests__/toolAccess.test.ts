/**
 * `sandbox.toolAccess` — capability presets, per-mode overrides, and the two
 * boundaries they may never cross.
 *
 * The acceptance table these mirror lives in
 * docs/architecture/p1-sandbox-tool-access-config-plan-2026-09-01.md §8.
 *
 * Cases 1, 3, 6 and 8 are the regression floor: they assert that the feature
 * did NOT widen anything it was not supposed to. They are the reason this file
 * exists — a preset table is easy to extend and easy to accidentally turn into
 * a credential-forwarding bypass.
 *
 * HOME is redirected to a temp dir throughout, because presets resolve `~/…`
 * and a test that depended on the developer's real `~/.config/gh` would pass or
 * fail based on whose laptop ran it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { resolveSandboxPolicy, applySandboxPolicy } from '../sandboxPolicyConfig.js'
import {
  expandToolAccess,
  TOOL_ACCESS_PRESETS,
  AUTONOMOUS_RESTRICTED,
} from '../toolAccessPresets.js'
import {
  buildChildEnv,
  setEnvAllowlist,
  isBlockedEnvName,
} from '../../infra/env/childProcessEnv.js'
import { createPermissionPolicy } from '../../kernel/permissions/PermissionPolicy.js'
import { FileStateCache } from '../../kernel/session/FileStateCache.js'
import type { KernelTool, KernelToolContext } from '../../kernel/types/KernelTool.js'

/**
 * Drive the real PermissionPolicy over a bash-shaped tool.
 *
 * Modelled on kernel/__tests__/CommandFieldGuards.test.ts. `/data/shared` is a
 * literal rather than a mkdtemp path on purpose: the guard's first-component
 * heuristic only inspects paths rooted in a real OS directory, and tmpdir() is
 * remapped under some CI sandboxes — a fixture built from it would skip the
 * check under test.
 */
async function decideBash(
  command: string,
  extra: Parameters<typeof createPermissionPolicy>[0] = {},
): Promise<{ behavior: string }> {
  const tool = {
    name: 'bash',
    description: 'bash',
    inputSchema: { safeParse: (v: unknown) => ({ success: true, data: v }) },
    inputJSONSchema: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
    permission: {
      category: 'execute',
      commandField: 'command',
      requiresWorkspace: true,
    },
    isConcurrencySafe: () => false,
    call: async () => ({ data: 'ok' }),
  } as unknown as KernelTool

  const policy = createPermissionPolicy({
    workspaceRoot: projectDir,
    ignoreUserConfig: true,
    ...extra,
  })
  return policy(tool, { command }, 'msg', 'use', {
    abortSignal: new AbortController().signal,
    fileStateCache: new FileStateCache(),
  } as unknown as KernelToolContext)
}

let projectDir: string
let fakeHome: string
let realHome: string | undefined

function writeProjectConfig(sandbox: Record<string, unknown>): void {
  const dir = join(projectDir, '.meta-agent')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ sandbox }, null, 2))
}

/** Materialise a `~/…` preset path so it survives the existence filter. */
function makeHomePath(relative: string): string {
  const full = join(fakeHome, relative)
  mkdirSync(full, { recursive: true })
  return full
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'toolaccess-'))
  fakeHome = mkdtempSync(join(tmpdir(), 'toolaccess-home-'))
  realHome = process.env['HOME']
  // os.homedir() honours $HOME on POSIX, which is what expandHostPath uses.
  process.env['HOME'] = fakeHome
  setEnvAllowlist([])
})

afterEach(() => {
  if (realHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = realHome
  setEnvAllowlist([])
  rmSync(projectDir, { recursive: true, force: true })
  rmSync(fakeHome, { recursive: true, force: true })
})

// ── §8 case 1 — no config means no behaviour change ───────────────────────────

describe('case 1: absent toolAccess changes nothing', () => {
  it('yields empty grants, empty allowlist and no diagnostics', () => {
    writeProjectConfig({})
    const policy = resolveSandboxPolicy(projectDir, 'agentic')
    expect(policy.toolAccess).toEqual([])
    expect(policy.envAllowlist).toEqual([])
    expect(policy.allowedRoots).toEqual([])
    expect(policy.diagnostics).toEqual([])
  })

  it('leaves the child env filter exactly as it was', () => {
    writeProjectConfig({})
    const policy = resolveSandboxPolicy(projectDir, 'agentic')
    setEnvAllowlist(policy.envAllowlist)
    const before = process.env['GH_ENTERPRISE_TOKEN']
    process.env['GH_ENTERPRISE_TOKEN'] = 'x'
    try {
      // Still stripped: it matches TOKEN$ and nothing granted it.
      expect(buildChildEnv('filtered')['GH_ENTERPRISE_TOKEN']).toBeUndefined()
    } finally {
      if (before === undefined) delete process.env['GH_ENTERPRISE_TOKEN']
      else process.env['GH_ENTERPRISE_TOKEN'] = before
    }
  })
})

// ── §8 case 2 — the actual feature ────────────────────────────────────────────

describe('case 2: toolAccess gh under robotics', () => {
  it('grants ~/.config/gh read+write and puts it in allowedRoots', () => {
    const ghDir = makeHomePath('.config/gh')
    writeProjectConfig({ toolAccess: ['gh'] })
    const policy = resolveSandboxPolicy(projectDir, 'robotics')

    expect(policy.toolAccess).toEqual(['gh'])
    expect(policy.allowedRoots).toContain(ghDir)
    expect(policy.writeAllowPaths).toContain(ghDir)
  })

  it('lifts the default credential deny on ~/.config/gh and says so', () => {
    const ghDir = makeHomePath('.config/gh')
    writeProjectConfig({ toolAccess: ['gh'] })
    const policy = resolveSandboxPolicy(projectDir, 'robotics')

    // ~/.config/gh is in DEFAULT_CREDENTIAL_DENY_PATHS. Without the lift, the
    // sandbox would read-deny the very directory the preset just granted — the
    // failure this whole feature was built to fix.
    expect(policy.readDenyPaths).not.toContain(ghDir)
    const lifted = policy.diagnostics.filter(d => d.kind === 'credential-deny-lifted')
    expect(lifted.map(d => d.subject)).toContain(ghDir)
  })

  it('forwards GH_ENTERPRISE_TOKEN, which no config could reach before', () => {
    makeHomePath('.config/gh')
    writeProjectConfig({ toolAccess: ['gh'] })
    const policy = resolveSandboxPolicy(projectDir, 'robotics')
    expect(policy.envAllowlist).toContain('GH_ENTERPRISE_TOKEN')

    setEnvAllowlist(policy.envAllowlist)
    const before = process.env['GH_ENTERPRISE_TOKEN']
    process.env['GH_ENTERPRISE_TOKEN'] = 'secret-value'
    try {
      expect(buildChildEnv('filtered')['GH_ENTERPRISE_TOKEN']).toBe('secret-value')
    } finally {
      if (before === undefined) delete process.env['GH_ENTERPRISE_TOKEN']
      else process.env['GH_ENTERPRISE_TOKEN'] = before
    }
  })

  it('requests network without overriding an explicit none', () => {
    makeHomePath('.config/gh')
    writeProjectConfig({ toolAccess: ['gh'] })
    expect(resolveSandboxPolicy(projectDir, 'robotics').network).toBe('unrestricted')
  })
})

// ── §8 case 3 — the boundary that must never move ─────────────────────────────

describe('case 3: envAllowlist cannot unlock the credential blocklist', () => {
  it('refuses ANTHROPIC_API_KEY and records why', () => {
    writeProjectConfig({ envAllowlist: ['ANTHROPIC_API_KEY'] })
    const policy = resolveSandboxPolicy(projectDir, 'agentic')

    expect(policy.envAllowlist).not.toContain('ANTHROPIC_API_KEY')
    const blocked = policy.diagnostics.filter(d => d.kind === 'blocked-env')
    expect(blocked.map(d => d.subject)).toContain('ANTHROPIC_API_KEY')
  })

  it('still strips it even if the allowlist is forced past the resolver', () => {
    // Defence in depth: buildChildEnv re-checks rather than trusting its input.
    setEnvAllowlist(['ANTHROPIC_API_KEY', 'AWS_SECRET_ACCESS_KEY'])
    const before = process.env['ANTHROPIC_API_KEY']
    process.env['ANTHROPIC_API_KEY'] = 'sk-should-not-leak'
    try {
      expect(buildChildEnv('filtered')['ANTHROPIC_API_KEY']).toBeUndefined()
    } finally {
      if (before === undefined) delete process.env['ANTHROPIC_API_KEY']
      else process.env['ANTHROPIC_API_KEY'] = before
    }
  })
})

// ── §8 case 4 — a preset colliding with the blocklist ─────────────────────────

describe('case 4: the npm preset drops NPM_TOKEN and reports it', () => {
  it('grants the rest of npm but not the blocklisted name', () => {
    makeHomePath('.npm/_cacache')
    writeFileSync(join(fakeHome, '.npmrc'), '')
    writeProjectConfig({ toolAccess: ['npm'] })
    const policy = resolveSandboxPolicy(projectDir, 'agentic')

    expect(policy.toolAccess).toEqual(['npm'])
    expect(policy.envAllowlist).toContain('NPM_CONFIG_REGISTRY')
    expect(policy.envAllowlist).not.toContain('NPM_TOKEN')

    const blocked = policy.diagnostics.filter(d => d.kind === 'blocked-env')
    expect(blocked.map(d => d.subject)).toContain('NPM_TOKEN')
  })

  it('keeps NPM_TOKEN on the blocklist (guards the preset table itself)', () => {
    // If someone "fixes" the npm preset by removing NPM_TOKEN from the
    // blocklist, this fails before the bypass ships.
    expect(isBlockedEnvName('NPM_TOKEN')).toBe(true)
    expect(TOOL_ACCESS_PRESETS.npm.env).toContain('NPM_TOKEN')
  })
})

// ── §8 case 5 — autonomous narrowing ──────────────────────────────────────────

describe('case 5: restricted presets need an explicit per-mode grant', () => {
  it('drops aws under auto when only the top-level list names it', () => {
    makeHomePath('.aws')
    writeProjectConfig({ toolAccess: ['aws'] })
    const policy = resolveSandboxPolicy(projectDir, 'auto')

    expect(policy.toolAccess).toEqual([])
    const dropped = policy.diagnostics.filter(d => d.kind === 'dropped-preset')
    expect(dropped.map(d => d.subject)).toContain('aws')
  })

  it('honours it when repeated under sandbox.modes.auto', () => {
    makeHomePath('.aws')
    writeProjectConfig({ toolAccess: ['aws'], modes: { auto: { toolAccess: ['aws'] } } })
    expect(resolveSandboxPolicy(projectDir, 'auto').toolAccess).toEqual(['aws'])
  })

  it('does not restrict the same preset under a non-autonomous mode', () => {
    makeHomePath('.aws')
    writeProjectConfig({ toolAccess: ['aws'] })
    expect(resolveSandboxPolicy(projectDir, 'robotics').toolAccess).toEqual(['aws'])
  })

  it('lets a per-mode list narrow, not merely widen', () => {
    makeHomePath('.config/gh')
    makeHomePath('.aws')
    // modes.auto REPLACES the top-level list. Unioning would grant gh here,
    // which is exactly what the operator wrote the override to prevent.
    writeProjectConfig({ toolAccess: ['gh'], modes: { auto: { toolAccess: ['git'] } } })
    expect(resolveSandboxPolicy(projectDir, 'auto').toolAccess).toEqual(['git'])
  })

  it('keeps docker and kubectl restricted alongside aws', () => {
    expect([...AUTONOMOUS_RESTRICTED].sort()).toEqual(['aws', 'docker', 'kubectl'])
  })
})

// ── §8 case 6 — the jail floor is not config-reachable ────────────────────────

describe('case 6: per-mode config cannot unlock the workspace jail', () => {
  it('exposes no field that could reach allowOutsideWorkspace', () => {
    writeProjectConfig({
      modes: { auto: { allowOutsideWorkspace: true, lockWorkspace: false } },
    })
    const policy = resolveSandboxPolicy(projectDir, 'auto')
    // ResolvedSandboxPolicy is the ONLY thing AgenticSession forwards to
    // createPermissionPolicy (as externalAllowedRoots). If neither key can
    // appear on it, no config value can reach the lockWorkspace decision.
    expect(policy).not.toHaveProperty('allowOutsideWorkspace')
    expect(policy).not.toHaveProperty('lockWorkspace')
    expect(policy.allowedRoots).toEqual([])
  })

  it('still denies an ungranted external path under lockWorkspace', async () => {
    const res = await decideBash('cat /data/elsewhere/secret', {
      autonomy: { lockWorkspace: true, autoApproveInWorkspace: true },
      // An operator trying to unlock the boundary the documented way. Under
      // autonomy this must lose.
      permissionConfig: { workspace: { allowTmp: false, allowOutsideWorkspace: true } },
    })
    expect(res.behavior).toBe('deny')
  })
})

// ── end-to-end: preset → allowedRoots → the jail actually widens ──────────────

describe('a toolAccess grant reaches the permission jail', () => {
  it('denies the granted root when no grant is wired', async () => {
    const res = await decideBash('ls /data/shared/input.csv', {
      permissionConfig: { workspace: { allowTmp: false } },
    })
    expect(res.behavior).toBe('deny')
  })

  it('allows it once resolved allowedRoots are forwarded', async () => {
    // This is the join AgenticSession makes: resolveSandboxPolicy().allowedRoots
    // becomes createPermissionPolicy({ externalAllowedRoots }). Without it the
    // jail denies a path the OS sandbox would have permitted — the two-layer
    // trap called out in sandboxPolicyConfig's header.
    writeProjectConfig({ writeAllowPaths: ['/data/shared'] })
    const res = await decideBash('ls /data/shared/input.csv', {
      permissionConfig: { workspace: { allowTmp: false } },
      externalAllowedRoots: ['/data/shared'],
    })
    expect(res.behavior).toBe('allow')
  })
})

// ── §8 cases 7-8 — malformed input degrades, never throws ─────────────────────

describe('cases 7-8: malformed toolAccess degrades safely', () => {
  it('ignores an unknown preset name and explains it', () => {
    writeProjectConfig({ toolAccess: ['gh', 'definitely-not-a-tool'] })
    const policy = resolveSandboxPolicy(projectDir, 'agentic')
    expect(policy.toolAccess).toEqual(['gh'])
    const dropped = policy.diagnostics.filter(d => d.kind === 'dropped-preset')
    expect(dropped.map(d => d.subject)).toContain('definitely-not-a-tool')
  })

  it('treats a non-array toolAccess as empty rather than throwing', () => {
    writeProjectConfig({ toolAccess: 'gh' })
    expect(() => resolveSandboxPolicy(projectDir, 'agentic')).not.toThrow()
    expect(resolveSandboxPolicy(projectDir, 'agentic').toolAccess).toEqual([])
  })

  it('skips non-string entries', () => {
    writeProjectConfig({ toolAccess: ['gh', 42, null] })
    expect(resolveSandboxPolicy(projectDir, 'agentic').toolAccess).toEqual(['gh'])
  })

  it('does not throw on a malformed modes section', () => {
    writeProjectConfig({ toolAccess: ['gh'], modes: 'nope' })
    expect(() => resolveSandboxPolicy(projectDir, 'auto')).not.toThrow()
  })
})

// ── §8 case 9 — dropped paths are visible ─────────────────────────────────────

describe('case 9: a non-existent grant is dropped AND reported', () => {
  it('records the path and the config key that named it', () => {
    writeProjectConfig({ writeAllowPaths: ['/definitely/not/here/12345'] })
    const policy = resolveSandboxPolicy(projectDir, 'agentic')

    expect(policy.writeAllowPaths).toHaveLength(0)
    const dropped = policy.diagnostics.filter(d => d.kind === 'dropped-path')
    expect(dropped).toHaveLength(1)
    expect(dropped[0]?.subject).toBe('/definitely/not/here/12345')
    expect(dropped[0]?.detail).toContain('writeAllowPaths')
  })

  it('reports a preset path that does not exist on this host', () => {
    // No ~/.config/gh created — the gh preset silently evaporating here is the
    // exact confusion that motivated the diagnostics channel.
    writeProjectConfig({ toolAccess: ['gh'] })
    const policy = resolveSandboxPolicy(projectDir, 'agentic')
    expect(policy.allowedRoots).toEqual([])
    expect(policy.diagnostics.some(d => d.kind === 'dropped-path')).toBe(true)
  })
})

// ── §8 case 10 — network stays sticky ─────────────────────────────────────────

describe("case 10: a preset cannot override network 'none'", () => {
  it("keeps 'none' and records the conflict", () => {
    makeHomePath('.config/gh')
    writeProjectConfig({ toolAccess: ['gh'], network: 'none' })
    const policy = resolveSandboxPolicy(projectDir, 'agentic')

    expect(policy.network).toBe('none')
    const conflict = policy.diagnostics.filter(d => d.kind === 'malformed-config')
    expect(conflict).toHaveLength(1)
    expect(conflict[0]?.detail).toContain('none')
  })

  it("stays 'none' when the TOOL side asked for none", () => {
    makeHomePath('.config/gh')
    writeProjectConfig({ toolAccess: ['gh'] })
    const policy = resolveSandboxPolicy(projectDir, 'agentic')
    expect(applySandboxPolicy({ network: 'none' }, policy).network).toBe('none')
  })
})

// ── expandToolAccess unit-level ───────────────────────────────────────────────

describe('expandToolAccess', () => {
  it('folds write paths into read (write implies read)', () => {
    const out = expandToolAccess(['gh'])
    expect(out.write).toContain('~/.config/gh')
    expect(out.read).toContain('~/.config/gh')
  })

  it('deduplicates across overlapping presets', () => {
    const out = expandToolAccess(['git', 'gh'])
    expect(new Set(out.env).size).toBe(out.env.length)
    expect(new Set(out.read).size).toBe(out.read.length)
  })

  it('never throws on junk input', () => {
    expect(() => expandToolAccess(['', '  ', 'nope'])).not.toThrow()
    expect(expandToolAccess(['', '  ']).granted).toEqual([])
  })

  it('omits AWS long-lived keys from the aws preset', () => {
    // The preset must not even ASK for them — expansion would drop them, but a
    // preset that names them invites someone to "fix" the blocklist instead.
    expect(TOOL_ACCESS_PRESETS.aws.env).not.toContain('AWS_ACCESS_KEY_ID')
    expect(TOOL_ACCESS_PRESETS.aws.env).not.toContain('AWS_SECRET_ACCESS_KEY')
  })

  it('gives every preset a rationale for sandbox_probe to print', () => {
    for (const [name, preset] of Object.entries(TOOL_ACCESS_PRESETS)) {
      expect(preset.rationale, name).toBeTruthy()
    }
  })
})
