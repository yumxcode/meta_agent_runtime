import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FlashClient } from '../../core/flash/FlashClient.js'
import { ExperiencePendingStore } from '../ExperiencePendingStore.js'
import { PhysicalAnchorPendingStore } from '../PhysicalAnchorPendingStore.js'
import {
  parseKnowledgeExtraction,
  extractKnowledgePostSession,
} from '../postSessionExtract.js'

const tempDirs: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'meta-agent-postextract-'))
  tempDirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

function flashReturning(payload: string | null): FlashClient {
  return { query: vi.fn().mockResolvedValue(payload) } as unknown as FlashClient
}

function transcript(nTurns: number): Array<{ role: string; content: string }> {
  return Array.from({ length: nTurns }, (_, i) => ({ role: 'assistant', content: `did work step ${i}` }))
}

async function stores() {
  return {
    experiencePending: new ExperiencePendingStore('/proj/x', await tempDir()),
    anchorPending: new PhysicalAnchorPendingStore('/proj/x', await tempDir()),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// parsing
// ─────────────────────────────────────────────────────────────────────────────

describe('parseKnowledgeExtraction', () => {
  it('parses both lists, tolerates code fences', () => {
    const raw = '```json\n{"experiences":[{"title":"a"}],"anchors":[{"title":"b"}]}\n```'
    const out = parseKnowledgeExtraction(raw)
    expect(out.experiences).toHaveLength(1)
    expect(out.anchors).toHaveLength(1)
  })

  it('defaults to empty on null / junk / non-object members', () => {
    expect(parseKnowledgeExtraction(null)).toEqual({ experiences: [], anchors: [] })
    expect(parseKnowledgeExtraction('not json')).toEqual({ experiences: [], anchors: [] })
    const out = parseKnowledgeExtraction('{"experiences":["bad",null,{"ok":1}],"anchors":[]}')
    expect(out.experiences).toHaveLength(1) // strings/null dropped
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// extraction (strict, merged)
// ─────────────────────────────────────────────────────────────────────────────

describe('extractKnowledgePostSession', () => {
  it('queues both experiences and anchors from one flash call', async () => {
    const s = await stores()
    const flash = flashReturning(JSON.stringify({
      experiences: [{ domain: 'locomotion', title: 't', problem: 'p', solution: 's', success: true, outcome_summary: 'o' }],
      anchors: [{ domain: 'locomotion', scope: 'robot', title: 'lag', fact: '8ms', implication: 'budget' }],
    }))
    const n = await extractKnowledgePostSession({ messages: transcript(8), flash, ...s })
    expect(n).toEqual({ experiences: 1, anchors: 1 })
    expect(s.experiencePending.count).toBe(1)
    expect(s.anchorPending.count).toBe(1)
    await s.experiencePending.flush(); await s.anchorPending.flush()
  })

  it('is strict: empty arrays yield nothing (rather none than flood)', async () => {
    const s = await stores()
    const flash = flashReturning(JSON.stringify({ experiences: [], anchors: [] }))
    const n = await extractKnowledgePostSession({ messages: transcript(8), flash, ...s })
    expect(n).toEqual({ experiences: 0, anchors: 0 })
  })

  it('caps each list at 3', async () => {
    const s = await stores()
    const mk = (t: string) => ({ domain: 'locomotion', scope: 'robot', title: t, fact: 'f', implication: 'i' })
    const flash = flashReturning(JSON.stringify({
      experiences: [mk('e1'), mk('e2'), mk('e3'), mk('e4')],
      anchors: [mk('a1'), mk('a2'), mk('a3'), mk('a4')],
    }))
    const n = await extractKnowledgePostSession({ messages: transcript(8), flash, ...s })
    expect(n).toEqual({ experiences: 3, anchors: 3 })
    await s.experiencePending.flush(); await s.anchorPending.flush()
  })

  it('no-ops without flash or with too few turns', async () => {
    const s = await stores()
    expect(await extractKnowledgePostSession({ messages: transcript(8), flash: null, ...s })).toEqual({ experiences: 0, anchors: 0 })
    const flash = flashReturning(JSON.stringify({ experiences: [{ title: 'x' }], anchors: [] }))
    expect(await extractKnowledgePostSession({ messages: transcript(3), flash, ...s })).toEqual({ experiences: 0, anchors: 0 })
  })

  it('no-ops gracefully when flash fails', async () => {
    const s = await stores()
    const flash = { query: vi.fn().mockRejectedValue(new Error('timeout')) } as unknown as FlashClient
    expect(await extractKnowledgePostSession({ messages: transcript(8), flash, ...s })).toEqual({ experiences: 0, anchors: 0 })
  })
})
