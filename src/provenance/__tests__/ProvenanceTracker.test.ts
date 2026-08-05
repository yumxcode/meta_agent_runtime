/**
 * ProvenanceTracker — the store behind "provenance 数据溯源与血缘追踪".
 *
 * Live in robotics mode (via createRoboticsRuntimeContext) and exposed as four
 * agent-facing tools, yet it had zero tests. Its failure modes are all SILENT:
 * a broken lineage chain just returns fewer records, a de-dup miss just reruns
 * an expensive job, a cache/disk divergence just returns stale data. Nothing
 * throws, so nothing gets noticed.
 *
 * Every test here runs against a real temp $META_AGENT_HOME so the on-disk
 * layout is exercised rather than mocked away.
 */
import { describe, expect, it } from 'vitest'
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { META_AGENT_HOME } from '../../core/metaAgentHome.js'
import { ProvenanceTracker } from '../ProvenanceTracker.js'

// vitest.config.ts injects an isolated META_AGENT_HOME per run (see test.env),
// captured by metaAgentHome.ts at import time — so nothing here touches the
// developer's real ~/.meta-agent. Each test uses a fresh random sessionId, which
// gives it a private directory under that home without any env juggling.
const newSession = (): string => `prov-test-${randomUUID()}`

/** A tracker over the same session — models a process restart with a cold cache. */
const trackerFor = (sessionId: string): ProvenanceTracker => new ProvenanceTracker(sessionId)

/** Minimal valid ProvenanceInput; override anything a test cares about. */
function input(over: Record<string, unknown> = {}): never {
  return {
    sessionId: 'sess-1',
    agentId: 'agent-1',
    toolName: 'solve',
    toolVersion: '1.0.0',
    fidelityLevel: 0,
    input: { x: 1 },
    modelName: 'test-model',
    output: { y: 2 },
    validationResults: [],
    artifacts: [],
    ...over,
  } as never
}

const provDir = (sessionId: string): string => join(META_AGENT_HOME, 'sessions', sessionId, 'provenance')

describe('record / get round-trip', () => {
  it('stores a record and reads it back', async () => {
    const s1 = newSession()
    const t = trackerFor(s1)
    const id = await t.record(input({ toolName: 'fem' }))
    const rec = await t.get(id)
    expect(rec?.id).toBe(id)
    expect(rec?.toolName).toBe('fem')
  })

  it('fills in the auto-generated fields', async () => {
    const s1 = newSession()
    const t = trackerFor(s1)
    const id = await t.record(input({ systemPrompt: 'you are a solver' }))
    const rec = (await t.get(id))!
    expect(rec.timestamp).toBeGreaterThan(0)
    expect(rec.inputHash).toMatch(/^[0-9a-f]{64}$/)
    expect(rec.systemPromptHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('leaves systemPromptHash empty when no prompt was supplied', async () => {
    const s1 = newSession()
    const t = trackerFor(s1)
    expect((await t.get(await t.record(input())))!.systemPromptHash).toBe('')
  })

  it('does not persist the raw system prompt, only its hash', async () => {
    // The prompt can contain user content; only the hash belongs on disk.
    const s1 = newSession()
    const t = trackerFor(s1)
    const id = await t.record(input({ systemPrompt: 'SECRET-PROMPT-TEXT' }))
    const raw = await readFile(join(provDir(s1), `${id}.json`), 'utf-8')
    expect(raw).not.toContain('SECRET-PROMPT-TEXT')
  })

  it('returns null for an unknown id instead of throwing', async () => {
    const s1 = newSession()
    const t = trackerFor(s1)
    expect(await t.get('prov-does-not-exist' as never)).toBeNull()
  })

  it('generates distinct ids for identical inputs', async () => {
    const s1 = newSession()
    const t = trackerFor(s1)
    const a = await t.record(input())
    const b = await t.record(input())
    expect(a).not.toBe(b)
  })

  it('a SECOND tracker instance reads records from disk (survives restart)', async () => {
    const s1 = newSession()
    const first = trackerFor(s1)
    const id = await first.record(input({ toolName: 'persisted' }))

    const second = trackerFor(s1)      // cold cache
    expect((await second.get(id))?.toolName).toBe('persisted')
  })

  it('sessions are isolated from each other', async () => {
    const a = trackerFor(newSession())
    const b = trackerFor(newSession())
    const id = await a.record(input())
    expect(await b.get(id)).toBeNull()
    expect(await b.list()).toEqual([])
  })
})

describe('list + filters', () => {
  it('returns records oldest-first', async () => {
    const s1 = newSession()
    const t = trackerFor(s1)
    const a = await t.record(input({ toolName: 'a' }))
    await new Promise(r => setTimeout(r, 2))
    const b = await t.record(input({ toolName: 'b' }))
    const ids = (await t.list()).map(r => r.id)
    expect(ids.indexOf(a)).toBeLessThan(ids.indexOf(b))
  })

  it('lists records written by a previous instance', async () => {
    const s1 = newSession()
    const first = trackerFor(s1)
    await first.record(input())
    await first.record(input())
    expect(await trackerFor(s1).list()).toHaveLength(2)
  })

  it('filters by toolName, agentId and fidelity', async () => {
    const s1 = newSession()
    const t = trackerFor(s1)
    await t.record(input({ toolName: 'fem', agentId: 'a1', fidelityLevel: 2 }))
    await t.record(input({ toolName: 'cfd', agentId: 'a2', fidelityLevel: 0 }))

    expect(await t.list({ toolName: 'fem' })).toHaveLength(1)
    expect(await t.list({ agentId: 'a2' })).toHaveLength(1)
    expect(await t.list({ fidelityLevels: [0] })).toHaveLength(1)
    expect(await t.list({ fidelityLevels: [0, 2] })).toHaveLength(2)
  })

  it('filters by tags (ALL listed tags must be present)', async () => {
    const s1 = newSession()
    const t = trackerFor(s1)
    await t.record(input({ tags: ['baseline', 'v1'] }))
    await t.record(input({ tags: ['baseline'] }))
    expect(await t.list({ tags: ['baseline'] })).toHaveLength(2)
    expect(await t.list({ tags: ['baseline', 'v1'] })).toHaveLength(1)
    expect(await t.list({ tags: ['missing'] })).toHaveLength(0)
  })

  it('filters by V&V failure presence', async () => {
    const s1 = newSession()
    const t = trackerFor(s1)
    await t.record(input({ validationResults: [] }))
    await t.record(input({
      validationResults: [{ hookName: 'oom', passed: false, severity: 'error', message: 'too big' }],
    }))
    expect(await t.list({ hasVVFailure: true })).toHaveLength(1)
    expect(await t.list({ hasVVFailure: false })).toHaveLength(1)
  })

  it('filters by time range', async () => {
    const s1 = newSession()
    const t = trackerFor(s1)
    await t.record(input())
    const mid = Date.now() + 1
    await new Promise(r => setTimeout(r, 5))
    await t.record(input())
    expect((await t.list({ since: mid })).length).toBe(1)
    expect((await t.list({ until: mid })).length).toBe(1)
  })

  it('an empty session lists nothing rather than throwing', async () => {
    expect(await trackerFor(newSession()).list()).toEqual([])
  })

  it('skips corrupt record files instead of failing the whole listing', async () => {
    const s1 = newSession()
    const t = trackerFor(s1)
    await t.record(input({ toolName: 'good' }))
    await mkdir(provDir(s1), { recursive: true })
    await writeFile(join(provDir(s1), 'prov-corrupt.json'), '{ not json', 'utf-8')

    const fresh = trackerFor(s1)
    const all = await fresh.list()
    expect(all).toHaveLength(1)
    expect(all[0]?.toolName).toBe('good')
  })
})

describe('chain (lineage)', () => {
  it('returns root → leaf in order', async () => {
    const s1 = newSession()
    const t = trackerFor(s1)
    const a = await t.record(input({ toolName: 'raw' }))
    const b = await t.record(input({ toolName: 'L0', parentProvenanceId: a }))
    const c = await t.record(input({ toolName: 'L2', parentProvenanceId: b }))

    expect((await t.chain(c)).map(r => r.toolName)).toEqual(['raw', 'L0', 'L2'])
  })

  it('a record with no parent chains to just itself', async () => {
    const s1 = newSession()
    const t = trackerFor(s1)
    const a = await t.record(input())
    expect((await t.chain(a)).map(r => r.id)).toEqual([a])
  })

  it('an unknown id yields an empty chain', async () => {
    const s1 = newSession()
    const t = trackerFor(s1)
    expect(await t.chain('prov-nope' as never)).toEqual([])
  })

  it('stops cleanly at a DANGLING parent instead of throwing', async () => {
    const s1 = newSession()
    const t = trackerFor(s1)
    const b = await t.record(input({ toolName: 'orphan', parentProvenanceId: 'prov-missing' as never }))
    expect((await t.chain(b)).map(r => r.toolName)).toEqual(['orphan'])
  })

  it('TERMINATES on a cyclic parent link', async () => {
    // A cycle is the classic way a lineage walker hangs forever. The tracker has
    // a visited-set guard; this pins it, since the cycle can only arise from
    // hand-edited or corrupted records and would otherwise never be exercised.
    const s1 = newSession()
    const t = trackerFor(s1)
    const a = await t.record(input({ toolName: 'a' }))
    const b = await t.record(input({ toolName: 'b', parentProvenanceId: a }))

    // Rewrite A on disk so it points back at B.
    const recA = (await t.get(a))!
    await writeFile(
      join(provDir(s1), `${a}.json`),
      JSON.stringify({ ...recA, parentProvenanceId: b }),
      'utf-8',
    )

    const fresh = trackerFor(s1)      // cold cache reads the cycle
    const chain = await fresh.chain(b)
    expect(chain.length).toBeLessThanOrEqual(2)
    expect(new Set(chain.map(r => r.id)).size).toBe(chain.length)   // no repeats
  })
})

describe('de-duplication', () => {
  it('findDuplicate matches an identical input payload', async () => {
    const s1 = newSession()
    const t = trackerFor(s1)
    const id = await t.record(input({ input: { mesh: 'fine', load: 10 } }))
    const dup = await t.findDuplicate({ mesh: 'fine', load: 10 })
    expect(dup?.id).toBe(id)
  })

  it('findDuplicate returns null for a different input', async () => {
    const s1 = newSession()
    const t = trackerFor(s1)
    await t.record(input({ input: { load: 10 } }))
    expect(await t.findDuplicate({ load: 11 })).toBeNull()
  })

  it('returns the MOST RECENT match when several exist', async () => {
    const s1 = newSession()
    const t = trackerFor(s1)
    await t.record(input({ input: { k: 1 }, toolName: 'older' }))
    await new Promise(r => setTimeout(r, 2))
    await t.record(input({ input: { k: 1 }, toolName: 'newer' }))
    expect((await t.findDuplicate({ k: 1 }))?.toolName).toBe('newer')
  })

  it('DOCUMENTED LIMITATION: hashing is key-order sensitive', async () => {
    // hashRecord uses JSON.stringify, so {a,b} and {b,a} hash differently and a
    // semantically identical rerun is NOT detected as a duplicate. Pinned so the
    // behaviour is a known trade-off rather than a surprise; switching to a
    // canonical stringify would make this test the thing that flags the change.
    const s1 = newSession()
    const t = trackerFor(s1)
    await t.record(input({ input: { a: 1, b: 2 } }))
    expect(await t.findDuplicate({ a: 1, b: 2 })).not.toBeNull()
    expect(await t.findDuplicate({ b: 2, a: 1 })).toBeNull()
  })

  it('findByInputHash returns every match oldest-first', async () => {
    const s1 = newSession()
    const t = trackerFor(s1)
    await t.record(input({ input: { k: 1 } }))
    await new Promise(r => setTimeout(r, 2))
    await t.record(input({ input: { k: 1 } }))
    const hash = (await t.list())[0]!.inputHash
    const matches = await t.findByInputHash(hash)
    expect(matches).toHaveLength(2)
    expect(matches[0]!.timestamp).toBeLessThanOrEqual(matches[1]!.timestamp)
  })
})

describe('summary', () => {
  it('describes a clean record', async () => {
    const s1 = newSession()
    const t = trackerFor(s1)
    const id = await t.record(input({ toolName: 'fem', fidelityLevel: 2 }))
    const text = await t.summary(id)
    expect(text).toContain('fem')
    expect(text).toMatch(/V&V/)
  })

  it('surfaces V&V failures in the summary', async () => {
    const s1 = newSession()
    const t = trackerFor(s1)
    const id = await t.record(input({
      validationResults: [{ hookName: 'oom', passed: false, severity: 'error', message: 'mesh too large' }],
    }))
    expect(await t.summary(id)).toContain('mesh too large')
  })

  it('reports a readable message for an unknown id', async () => {
    const s1 = newSession()
    const t = trackerFor(s1)
    expect(await t.summary('prov-nope' as never)).toMatch(/not found/)
  })
})

describe('storage layout', () => {
  it('writes one json file per record under the session directory', async () => {
    const s1 = newSession()
    const t = trackerFor(s1)
    const id = await t.record(input())
    expect(await readdir(provDir(s1))).toContain(`${id}.json`)
  })

  it('concurrent records do not collide on a shared temp file', async () => {
    const s1 = newSession()
    const t = trackerFor(s1)
    const ids = await Promise.all(Array.from({ length: 15 }, () => t.record(input())))
    const files = (await readdir(provDir(s1))).filter(f => f.endsWith('.json'))
    expect(new Set(ids).size).toBe(15)
    expect(files).toHaveLength(15)
    expect((await readdir(provDir(s1))).filter(f => f.endsWith('.tmp'))).toEqual([])
  })
})
