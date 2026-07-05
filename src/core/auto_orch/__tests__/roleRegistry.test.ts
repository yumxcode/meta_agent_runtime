/**
 * RoleCatalog — unit coverage for the role registry that unifies drift/verify
 * with the auto_orch graph roles.
 *
 * The heavy verify/drift gates (git snapshot + judge) are exercised by the kernel
 * suites; here we assert the WIRING: the catalogue exposes the built-in roles,
 * produces kernel gates for verify/drift, resolves node handlers (falling back to
 * a generic reviewer for unknown names), and is overridable.
 */
import { describe, it, expect } from 'vitest'
import type { ISubAgentDispatcher } from '../../../subagent/ISubAgentDispatcher.js'
import { RoleCatalog, defaultRoleCatalog, goalWithCriteria, type RoleContext } from '../RoleRegistry.js'
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

// ── M1 regression: role nodes must feed their taskDescription to the gates ─────
describe('goalWithCriteria (M1)', () => {
  it('composes goal + criteria, keeping the goal as the anchor', () => {
    const get = goalWithCriteria(() => 'the goal', '必须包含单元测试')
    const composed = get()!
    expect(composed.startsWith('the goal')).toBe(true)
    expect(composed).toContain('必须包含单元测试')
    expect(composed).toContain('审查标准')
  })

  it('empty criteria → goal unchanged; missing goal → criteria alone', () => {
    expect(goalWithCriteria(() => 'g', '   ')()).toBe('g')
    expect(goalWithCriteria(() => null, 'c')()).toBe('c')
  })

  it('does not duplicate when the criteria echo the goal', () => {
    expect(goalWithCriteria(() => 'do X carefully', 'X')()).toBe('do X carefully')
  })

  it('the verify node handler hands the node criteria to the spawned judge', async () => {
    const seen: string[] = []
    const captureDispatcher: ISubAgentDispatcher = {
      async spawnSubAgent(opts) {
        seen.push(String((opts.config as Record<string, unknown>)['taskDescription'] ?? ''))
        return {
          taskId: 't1',
          status: 'completed',
          config: opts.config,
          result: { success: true, summary: 'not a verdict', costUsd: 0 },
        } as never
      },
      async getStatus() { return null },
      async cancelTask() { return true },
    }
    const handler = defaultRoleCatalog().buildHandler('verify', {
      dispatcher: captureDispatcher,
      projectDir: '/tmp/definitely-not-a-git-repo',
      getGoal: () => 'GLOBAL-GOAL',
    })
    await handler({ criteria: 'NODE-CRITERIA-XYZ', signal: new AbortController().signal })
    expect(seen.length).toBeGreaterThan(0)
    expect(seen[0]).toContain('GLOBAL-GOAL')
    expect(seen[0]).toContain('NODE-CRITERIA-XYZ')
  })
})
