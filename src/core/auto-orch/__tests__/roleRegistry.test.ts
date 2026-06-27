/**
 * RoleCatalog — unit coverage for the role registry that unifies drift/verify
 * with the auto-orch graph roles.
 *
 * The heavy verify/drift gates (git snapshot + judge) are exercised by the kernel
 * suites; here we assert the WIRING: the catalogue exposes the built-in roles,
 * produces kernel gates for verify/drift, resolves node handlers (falling back to
 * a generic reviewer for unknown names), and is overridable.
 */
import { describe, it, expect } from 'vitest'
import type { ISubAgentDispatcher } from '../../../subagent/ISubAgentDispatcher.js'
import { RoleCatalog, defaultRoleCatalog, type RoleContext } from '../RoleRegistry.js'
import type { OrchVerdict } from '../Verdict.js'

const noopDispatcher: ISubAgentDispatcher = {
  async spawnSubAgent() { throw new Error('not used') },
  async getStatus() { return null },
  async cancelTask() { return true },
}

const ctx = (): RoleContext => ({ dispatcher: noopDispatcher, projectDir: '/tmp', getGoal: () => 'goal' })

describe('defaultRoleCatalog', () => {
  it('registers the three built-in roles', () => {
    const cat = defaultRoleCatalog()
    expect(cat.names().sort()).toEqual(['drift', 'reviewer', 'verify'])
    expect(cat.has('verify')).toBe(true)
    expect(cat.has('nope')).toBe(false)
  })

  it('produces a kernel verify gate and drift gate from the catalogue', () => {
    const cat = defaultRoleCatalog()
    expect(typeof cat.buildVerifyGate(ctx())).toBe('function')
    expect(typeof cat.buildDriftGate(ctx())).toBe('function')
  })

  it('resolves a node handler for each role and falls back to reviewer for unknown', () => {
    const cat = defaultRoleCatalog()
    expect(typeof cat.buildHandler('verify', ctx())).toBe('function')
    expect(typeof cat.buildHandler('drift', ctx())).toBe('function')
    // an unknown Planner-invented role still resolves (generic reviewer)
    expect(typeof cat.buildHandler('security_auditor', ctx())).toBe('function')
  })
})

describe('RoleCatalog (custom)', () => {
  it('lets a caller register/override a role', async () => {
    const cat = new RoleCatalog().register({
      name: 'verify',
      buildHandler: () => async (): Promise<OrchVerdict> => ({ action: 'done', label: 'pass', note: 'stub' }),
    })
    const handler = cat.buildHandler('verify', ctx())
    const verdict = await handler({ criteria: 'x', signal: new AbortController().signal })
    expect(verdict).toMatchObject({ action: 'done', label: 'pass', note: 'stub' })
  })

  it('an empty catalogue has no verify/drift gates', () => {
    const cat = new RoleCatalog()
    expect(cat.buildVerifyGate(ctx())).toBeUndefined()
    expect(cat.buildDriftGate(ctx())).toBeUndefined()
  })

  it('rejects a role without a name', () => {
    expect(() => new RoleCatalog().register({ name: '', buildHandler: () => async () => ({ action: 'continue' }) })).toThrow()
  })
})
