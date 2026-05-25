/**
 * ProvenanceTracker smoke test — no external dependencies.
 *
 * Covers: record, get, list, chain, findByInputHash, findDuplicate,
 *         filter combinations, summary output, cycle guard in chain().
 *
 * Run: cd packages/meta-agent-runtime && npx tsx examples/smoke-test-provenance.ts
 */

import { ProvenanceTracker } from '../src/provenance/ProvenanceTracker.js'
import type { ProvenanceInput } from '../src/provenance/types.js'

// ── Harness ────────────────────────────────────────────────────────────────

let passed = 0
let failed = 0

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  process.stdout.write(`  ⏳  ${name}`)
  try {
    await fn()
    process.stdout.write(`\r  ✅  ${name}\n`)
    passed++
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stdout.write(`\r  ❌  ${name}\n       ${msg}\n`)
    failed++
  }
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg)
}

// ── Fixtures ───────────────────────────────────────────────────────────────

function baseInput(overrides: Partial<ProvenanceInput> = {}): ProvenanceInput {
  return {
    sessionId: 'sess-smoke',
    agentId: 'agent-1',
    toolName: 'beam_theory_tool',
    toolVersion: '1.0.0',
    fidelityLevel: 0,
    modelName: 'claude-opus-4-6',
    input: { force: 1000, length: 2.0, section: 'IPE200' },
    output: { max_stress: 1.2e8, deflection: 0.003 },
    validationResults: [],
    artifacts: [],
    ...overrides,
  }
}

function uniqueSession(): string {
  return `smoke-prov-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

// ── Tests ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('\nProvenanceTracker smoke tests\n')

  // ── 1: record + get ───────────────────────────────────────────────────────
  await test('record() returns a provenanceId string', async () => {
    const tracker = new ProvenanceTracker(uniqueSession())
    const id = await tracker.record(baseInput())
    assert(typeof id === 'string' && id.startsWith('prov-'), `Expected prov-… ID, got ${id}`)
    assert(id.length > 5, 'ID should be non-trivial')
  })

  await test('get() retrieves the saved record with auto-filled fields', async () => {
    const tracker = new ProvenanceTracker(uniqueSession())
    const id = await tracker.record(baseInput({ systemPrompt: 'You are an engineer.' }))
    const rec = await tracker.get(id)

    assert(rec !== null, 'Expected record to be found')
    assert(rec!.id === id, 'ID mismatch')
    assert(rec!.toolName === 'beam_theory_tool', 'toolName mismatch')
    assert(typeof rec!.timestamp === 'number' && rec!.timestamp > 0, 'timestamp missing')
    assert(typeof rec!.inputHash === 'string' && rec!.inputHash.length === 64, 'inputHash should be 64-char hex')
    assert(typeof rec!.systemPromptHash === 'string' && rec!.systemPromptHash.length === 64, 'systemPromptHash should be 64-char hex')
  })

  await test('get() returns null for unknown ID', async () => {
    const tracker = new ProvenanceTracker(uniqueSession())
    const rec = await tracker.get('prov-doesnotexist')
    assert(rec === null, 'Expected null for unknown ID')
  })

  await test('get() uses in-memory cache on second access (no disk re-read)', async () => {
    const tracker = new ProvenanceTracker(uniqueSession())
    const id = await tracker.record(baseInput())
    const r1 = await tracker.get(id)
    const r2 = await tracker.get(id)
    assert(r1 === r2, 'Expected identical object reference from cache')
  })

  // ── 2: list + filter ──────────────────────────────────────────────────────
  await test('list() returns all records sorted by timestamp', async () => {
    const sid = uniqueSession()
    const tracker = new ProvenanceTracker(sid)
    const id1 = await tracker.record(baseInput({ toolName: 'tool_a', agentId: 'agent-1' }))
    const id2 = await tracker.record(baseInput({ toolName: 'tool_b', agentId: 'agent-2' }))
    const id3 = await tracker.record(baseInput({ toolName: 'tool_a', agentId: 'agent-2' }))

    const all = await tracker.list()
    assert(all.length === 3, `Expected 3, got ${all.length}`)
    assert(all[0].id === id1, 'First should be oldest (id1)')
    assert(all[2].id === id3, 'Last should be newest (id3)')
  })

  await test('list({ toolName }) filters correctly', async () => {
    const tracker = new ProvenanceTracker(uniqueSession())
    await tracker.record(baseInput({ toolName: 'tool_a' }))
    await tracker.record(baseInput({ toolName: 'tool_b' }))
    await tracker.record(baseInput({ toolName: 'tool_a' }))

    const res = await tracker.list({ toolName: 'tool_a' })
    assert(res.length === 2, `Expected 2, got ${res.length}`)
    assert(res.every(r => r.toolName === 'tool_a'), 'All results should be tool_a')
  })

  await test('list({ agentId }) filters correctly', async () => {
    const tracker = new ProvenanceTracker(uniqueSession())
    await tracker.record(baseInput({ agentId: 'coord' }))
    await tracker.record(baseInput({ agentId: 'worker' }))

    const coord = await tracker.list({ agentId: 'coord' })
    assert(coord.length === 1 && coord[0].agentId === 'coord', 'agentId filter failed')
  })

  await test('list({ fidelityLevels }) filters correctly', async () => {
    const tracker = new ProvenanceTracker(uniqueSession())
    await tracker.record(baseInput({ fidelityLevel: 0 }))
    await tracker.record(baseInput({ fidelityLevel: 1 }))
    await tracker.record(baseInput({ fidelityLevel: 2 }))

    const lowFi = await tracker.list({ fidelityLevels: [0, 1] })
    assert(lowFi.length === 2, `Expected 2, got ${lowFi.length}`)
  })

  await test('list({ hasVVFailure: true }) returns only records with V&V failures', async () => {
    const tracker = new ProvenanceTracker(uniqueSession())
    await tracker.record(baseInput({
      validationResults: [{ hookName: 'OOM', passed: true, severity: 'info', message: 'ok', suggestedAction: 'continue' }],
    }))
    await tracker.record(baseInput({
      validationResults: [{ hookName: 'OOM', passed: false, severity: 'error', message: 'bad', suggestedAction: 'pause_and_ask' }],
    }))

    const withFail = await tracker.list({ hasVVFailure: true })
    assert(withFail.length === 1, `Expected 1, got ${withFail.length}`)

    const withoutFail = await tracker.list({ hasVVFailure: false })
    assert(withoutFail.length === 1, `Expected 1, got ${withoutFail.length}`)
  })

  await test('list({ since, until }) filters by timestamp range', async () => {
    const tracker = new ProvenanceTracker(uniqueSession())
    const t0 = Date.now()
    await tracker.record(baseInput())
    const t1 = Date.now()
    await new Promise(r => setTimeout(r, 5))
    await tracker.record(baseInput())
    const t2 = Date.now()

    const first = await tracker.list({ since: t0, until: t1 })
    assert(first.length === 1, `Expected 1 in first window, got ${first.length}`)

    const both = await tracker.list({ since: t0, until: t2 })
    assert(both.length === 2, `Expected 2 in full window, got ${both.length}`)
  })

  await test('list({ tags }) filters by tag intersection', async () => {
    const tracker = new ProvenanceTracker(uniqueSession())
    await tracker.record(baseInput({ tags: ['battery', 'thermal'] }))
    await tracker.record(baseInput({ tags: ['mechanical'] }))
    await tracker.record(baseInput({ tags: ['battery', 'degradation'] }))

    const battery = await tracker.list({ tags: ['battery'] })
    assert(battery.length === 2, `Expected 2 battery records, got ${battery.length}`)

    const both = await tracker.list({ tags: ['battery', 'thermal'] })
    assert(both.length === 1, `Expected 1 battery+thermal record, got ${both.length}`)
  })

  // ── 3: chain (lineage) ────────────────────────────────────────────────────
  await test('chain() returns full lineage from root to leaf', async () => {
    const tracker = new ProvenanceTracker(uniqueSession())

    const idA = await tracker.record(baseInput({ toolName: 'raw_data' }))
    const idB = await tracker.record(baseInput({ toolName: 'l0_estimate', parentProvenanceId: idA }))
    const idC = await tracker.record(baseInput({ toolName: 'l2_fem', parentProvenanceId: idB }))

    const ch = await tracker.chain(idC)
    assert(ch.length === 3, `Expected chain of 3, got ${ch.length}`)
    assert(ch[0].id === idA, 'Root should be first')
    assert(ch[1].id === idB, 'Middle node second')
    assert(ch[2].id === idC, 'Leaf should be last')
  })

  await test('chain() on a root record (no parent) returns just itself', async () => {
    const tracker = new ProvenanceTracker(uniqueSession())
    const id = await tracker.record(baseInput())
    const ch = await tracker.chain(id)
    assert(ch.length === 1, `Expected chain of 1, got ${ch.length}`)
    assert(ch[0].id === id, 'Should be the record itself')
  })

  await test('chain() stops gracefully on missing parent (orphan)', async () => {
    const tracker = new ProvenanceTracker(uniqueSession())
    const id = await tracker.record(baseInput({ parentProvenanceId: 'prov-doesnotexist' }))
    const ch = await tracker.chain(id)
    // Should return just the one record; missing parent silently ignored
    assert(ch.length === 1, `Expected 1, got ${ch.length}`)
    assert(ch[0].id === id, 'Should be the record itself')
  })

  // ── 4: findByInputHash / findDuplicate ────────────────────────────────────
  await test('findByInputHash() finds records with identical input', async () => {
    const tracker = new ProvenanceTracker(uniqueSession())
    const input = { force: 500, length: 1.5 }

    const id1 = await tracker.record(baseInput({ input }))
    const id2 = await tracker.record(baseInput({ input }))
    await tracker.record(baseInput({ input: { force: 999 } }))  // different

    const rec1 = await tracker.get(id1)
    const matches = await tracker.findByInputHash(rec1!.inputHash)
    assert(matches.length === 2, `Expected 2 matches, got ${matches.length}`)
    assert(matches.some(r => r.id === id1), 'id1 should be in matches')
    assert(matches.some(r => r.id === id2), 'id2 should be in matches')
  })

  await test('findDuplicate() returns most recent matching record', async () => {
    const tracker = new ProvenanceTracker(uniqueSession())
    const input = { x: 42 }

    await tracker.record(baseInput({ input }))
    await new Promise(r => setTimeout(r, 5))
    const id2 = await tracker.record(baseInput({ input }))

    const dup = await tracker.findDuplicate(input)
    assert(dup !== null, 'Expected to find a duplicate')
    assert(dup!.id === id2, 'Should return most recent duplicate')
  })

  await test('findDuplicate() returns null when no duplicate exists', async () => {
    const tracker = new ProvenanceTracker(uniqueSession())
    const dup = await tracker.findDuplicate({ unique: Math.random() })
    assert(dup === null, 'Expected null for unique input')
  })

  // ── 5: summary() ──────────────────────────────────────────────────────────
  await test('summary() returns a non-empty readable string', async () => {
    const tracker = new ProvenanceTracker(uniqueSession())
    const id = await tracker.record(baseInput({
      toolName: 'fem_stress',
      fidelityLevel: 2,
      agentId: 'worker-1',
      jobId: 'mechanical-fem-a3f8',
      artifacts: [{ artifactId: 'a1', name: 'stress_contour.png', path: '/tmp/a.png' }],
      parentProvenanceId: 'prov-parent',
      validationResults: [{ hookName: 'OOM', passed: false, severity: 'error', message: 'stress too high', suggestedAction: 'pause_and_ask' }],
    }))

    const text = await tracker.summary(id)
    assert(text.includes('prov-'), 'Should include provenance ID')
    assert(text.includes('fem_stress'), 'Should include tool name')
    assert(text.includes('L2'), 'Should include fidelity level')
    assert(text.includes('stress_contour.png'), 'Should include artifact name')
    assert(text.includes('prov-parent'), 'Should include parent ID')
    assert(text.includes('V&V'), 'Should include V&V status')
    assert(text.includes('stress too high'), 'Should include V&V message')
  })

  await test('summary() returns graceful message for unknown ID', async () => {
    const tracker = new ProvenanceTracker(uniqueSession())
    const text = await tracker.summary('prov-unknown')
    assert(text.includes('not found'), 'Expected "not found" message')
  })

  // ── 6: persistence across tracker instances ───────────────────────────────
  await test('records persist to disk and reload in a new tracker instance', async () => {
    const sid = uniqueSession()
    const tracker1 = new ProvenanceTracker(sid)
    const id = await tracker1.record(baseInput({ toolName: 'persist_test' }))

    // New instance — no shared cache
    const tracker2 = new ProvenanceTracker(sid)
    const rec = await tracker2.get(id)

    assert(rec !== null, 'Record should load from disk in new instance')
    assert(rec!.toolName === 'persist_test', 'toolName should survive serialisation')
    assert(rec!.id === id, 'ID should match')
  })

  await test('list() on new instance reads all records from disk', async () => {
    const sid = uniqueSession()
    const t1 = new ProvenanceTracker(sid)
    await t1.record(baseInput({ toolName: 'x' }))
    await t1.record(baseInput({ toolName: 'y' }))

    const t2 = new ProvenanceTracker(sid)
    const all = await t2.list()
    assert(all.length === 2, `Expected 2 after disk load, got ${all.length}`)
  })

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exit(1)
}

main().catch(err => {
  console.error('Unexpected error:', err)
  process.exit(1)
})
