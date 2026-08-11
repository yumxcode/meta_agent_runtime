/**
 * EngineeringToolRegistry — capability × fidelity tool lookup.
 *
 * 5.55% coverage. The ordering bug that prompted this: `toString()` sorted with
 * a bare `[...map.entries()].sort()`, which stringifies each [key, value] PAIR
 * ("capability,[object Object]") — it happened to order capabilities correctly
 * and ordered numeric fidelity levels as 0, 1, 10, 2. `list()` and
 * `fidelitiesFor()` both had explicit comparators; only the diagnostic dump
 * did not, which is exactly the kind of thing nobody notices until they are
 * reading a dump to debug something else.
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { EngineeringToolRegistry } from '../EngineeringToolRegistry.js'
import type { MetaAgentTool } from '../../../core/types.js'

function tool(name: string): MetaAgentTool {
  return {
    name,
    description: `${name} tool`,
    inputSchema: { type: 'object', properties: {} },
    async call() { return { content: name, isError: false } },
  } as MetaAgentTool
}

let registry: EngineeringToolRegistry
beforeEach(() => { registry = new EngineeringToolRegistry() })

describe('register and get', () => {
  it('round-trips a tool at a given capability and fidelity', () => {
    registry.register('sim.cfd', 0, tool('cheap_cfd'))
    expect(registry.get('sim.cfd', 0)?.name).toBe('cheap_cfd')
  })

  it('returns null for an unknown capability or fidelity', () => {
    registry.register('sim.cfd', 0, tool('cheap_cfd'))
    expect(registry.get('sim.fea', 0)).toBeNull()
    expect(registry.get('sim.cfd', 2)).toBeNull()
  })

  it('the same tool can serve several capabilities', () => {
    const shared = tool('solver')
    registry.register('sim.cfd', 0, shared)
    registry.register('sim.fea', 0, shared)
    expect(registry.get('sim.cfd', 0)).toBe(shared)
    expect(registry.get('sim.fea', 0)).toBe(shared)
  })

  it('re-registering the same pair overwrites', () => {
    registry.register('c', 0, tool('old'))
    registry.register('c', 0, tool('new'))
    expect(registry.get('c', 0)?.name).toBe('new')
    expect(registry.fidelitiesFor('c')).toEqual([0])
  })

  it('unregister removes the entry and prunes an empty capability', () => {
    registry.register('c', 0, tool('t'))
    expect(registry.unregister('c', 0)).toBe(true)
    expect(registry.get('c', 0)).toBeNull()
    expect(registry.capabilities()).toEqual([])
    expect(registry.unregister('c', 0)).toBe(false)
  })
})

describe('bestAvailable', () => {
  it('picks the highest fidelity at or below the cap', () => {
    registry.register('c', 0, tool('L0'))
    registry.register('c', 2, tool('L2'))
    expect(registry.bestAvailable('c', 4)?.name).toBe('L2')
    // The docstring's own example: cap of 1 with only L0 and L2 → L0.
    expect(registry.bestAvailable('c', 1)?.name).toBe('L0')
  })

  it('defaults the cap to L4', () => {
    registry.register('c', 3, tool('L3'))
    expect(registry.bestAvailable('c')?.name).toBe('L3')
  })

  it('returns null when nothing qualifies', () => {
    registry.register('c', 3, tool('L3'))
    expect(registry.bestAvailable('c', 1)).toBeNull()
    expect(registry.bestAvailable('missing')).toBeNull()
  })
})

describe('list', () => {
  it('sorts by capability then by NUMERIC fidelity', () => {
    // Registration order is deliberately scrambled, and the fidelity levels
    // span single and double digits so a string sort would show 0, 1, 2 wrong.
    registry.register('b.cap', 2, tool('b2'))
    registry.register('a.cap', 2, tool('a2'))
    registry.register('a.cap', 0, tool('a0'))
    registry.register('b.cap', 0, tool('b0'))
    registry.register('a.cap', 1, tool('a1'))
    expect(registry.list().map(e => e.tool.name)).toEqual(['a0', 'a1', 'a2', 'b0', 'b2'])
  })

  it('filters by capability prefix', () => {
    registry.register('sim.cfd', 0, tool('cfd'))
    registry.register('sim.fea', 0, tool('fea'))
    registry.register('data.load', 0, tool('load'))
    expect(registry.list('sim.').map(e => e.tool.name)).toEqual(['cfd', 'fea'])
  })

  it('is empty for a registry with nothing in it', () => {
    expect(registry.list()).toEqual([])
  })
})

describe('capabilities and fidelitiesFor', () => {
  it('lists capabilities sorted', () => {
    registry.register('z.cap', 0, tool('z'))
    registry.register('a.cap', 0, tool('a'))
    expect(registry.capabilities()).toEqual(['a.cap', 'z.cap'])
  })

  it('lists fidelity levels in NUMERIC order', () => {
    registry.register('c', 2, tool('t2'))
    registry.register('c', 0, tool('t0'))
    registry.register('c', 1, tool('t1'))
    expect(registry.fidelitiesFor('c')).toEqual([0, 1, 2])
  })

  it('returns [] for an unknown capability', () => {
    expect(registry.fidelitiesFor('nope')).toEqual([])
  })
})

describe('allTools', () => {
  it('deduplicates by tool name across capability/fidelity pairs', () => {
    const shared = tool('solver')
    registry.register('sim.cfd', 0, shared)
    registry.register('sim.cfd', 1, shared)
    registry.register('sim.fea', 0, shared)
    registry.register('data.load', 0, tool('loader'))
    expect(registry.allTools().map(t => t.name).sort()).toEqual(['loader', 'solver'])
  })
})

describe('toString', () => {
  it('orders fidelity levels numerically, not as strings', () => {
    // The regression: a bare .sort() on [level, entry] pairs yields 0, 1, 10, 2.
    registry.register('c', 0, tool('t0'))
    registry.register('c', 1, tool('t1'))
    registry.register('c', 2, tool('t2'))
    const dump = registry.toString()
    const order = ['t0', 't1', 't2'].map(n => dump.indexOf(n))
    expect(order[0]).toBeLessThan(order[1]!)
    expect(order[1]).toBeLessThan(order[2]!)
  })

  it('orders capabilities alphabetically', () => {
    registry.register('z.cap', 0, tool('zt'))
    registry.register('a.cap', 0, tool('at'))
    const dump = registry.toString()
    expect(dump.indexOf('at')).toBeLessThan(dump.indexOf('zt'))
  })

  it('includes the notes when present', () => {
    registry.register('c', 0, tool('t'), 'low fidelity, 2s')
    expect(registry.toString()).toContain('low fidelity, 2s')
  })
})
