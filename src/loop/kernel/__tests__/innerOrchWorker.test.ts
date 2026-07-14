/**
 * inner_orch_worker prompt assembly — the lean seat base (L2-owned).
 * Asserts the kept sections, the lineage vs isolated difference, and that the
 * per-round capsule rides in the user message <context>, not the system prompt.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assembleInnerWorkerSystemPrompt,
  renderInnerWorkerUserMessage,
} from '../InnerOrchWorker.js'
import type { Capsule } from '../../capsule/CapsuleBuilder.js'

const projectDir = mkdtempSync(join(tmpdir(), 'inner-worker-'))

const capsule: Capsule = {
  schemaVersion: 2,
  builtAt: Date.now(), round: 3, mode: 'normal', goal: 'improve gait stability',
  progress: {
    meters: { iteration: 3, stale_count: 1 }, status: 'healthy', totalCostUsd: 1,
    objective: { bestValue: 0.62 },
  },
  scenario: {
    id: 'builtin/research@1',
    view: {
      schemaVersion: 1, data: { totalFindings: 4 },
      sections: [
        { title: 'directions', items: ['reward-shaping', 'curriculum'] },
        { title: 'findings', items: ['plateau at 0.62'] },
      ],
    },
  },
  recentRounds: ['#2 [normal] route=continue'], inboxMessages: [],
}

describe('inner_orch_worker system prompt', () => {
  it('keeps the lean section set and injects the charter seat prompt', async () => {
    const sys = await assembleInnerWorkerSystemPrompt({
      seatPrompt: 'CHARTER_SEAT_ROLE_XYZ', projectDir, variant: 'isolated',
      writeScope: ['src/module/**'],
      effectBindings: { training: { adapter: 'vendor/task@2' } },
    })
    expect(sys).toContain('inner_orch_worker')      // loop-seat identity
    expect(sys).toContain('CHARTER_SEAT_ROLE_XYZ')  // charter seat prompt (D-role)
    expect(sys).toContain('基本纪律')                // S3 discipline kept
    expect(sys).toContain('<context>')              // context-block convention kept
    expect(sys).toContain('src/module/**')          // write scope
    expect(sys).toContain('training→vendor/task@2') // frozen effect binding, no raw adapter selection
    // Dropped generic-agent scaffolding must NOT be composed here.
    expect(sys).not.toContain('自主执行账本')        // no autonomous ledger
    expect(sys).not.toContain('委派')                // no delegation guidance
  })

  it('lineage vs isolated differ only in the context-continuity clause', async () => {
    const base = { seatPrompt: 'r', projectDir }
    const lineage = await assembleInnerWorkerSystemPrompt({ ...base, variant: 'lineage' })
    const isolated = await assembleInnerWorkerSystemPrompt({ ...base, variant: 'isolated' })
    expect(lineage).toContain('自动压缩')            // relies on accumulated context
    expect(lineage).not.toContain('没有历史对话')
    expect(isolated).toContain('没有历史对话')       // fresh, no transcript
    expect(isolated).not.toContain('自动压缩')
  })
})

describe('inner_orch_worker user message', () => {
  it('rides the capsule in <context> and carries the output contract', () => {
    const msg = renderInnerWorkerUserMessage({
      capsule, draftsDir: '/tmp/x/drafts', preface: '【收割段】结果已就绪',
    })
    expect(msg.startsWith('<context>')).toBe(true)
    expect(msg).toContain('improve gait stability')  // capsule goal
    expect(msg).toContain('\n---\n')                 // context / instruction boundary
    expect(msg).toContain('【收割段】结果已就绪')      // harvest preface
    // Generic fallback names only the absolute draft root; production seats
    // inject their Scenario-owned Artifact contract explicitly.
    expect(msg).toContain('draft root: /tmp/x/drafts')
    expect(msg).not.toContain('findings_draft')
    expect(msg).toContain('产出契约')
  })
})
