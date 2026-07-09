/**
 * Shared test fixture: the RL walk-research charter (spec §3.1 example),
 * exercised by charter/kernel/acceptance suites. Not a test file itself.
 */
import type { Charter } from '../charter/CharterTypes.js'

export function walkResearchCharter(overrides?: Partial<Charter>): Charter {
  const charter: Charter = {
    id: 'walk-research',
    version: 1,
    goal: '人形机器人行走控制长周期自主研究：每轮推进研究并产出可验证 findings。',
    observables: [
      { name: 'new_findings', source: { from: 'judge', key: 'new_findings_count' } },
      { name: 'metric_delta', source: { from: 'judge', key: 'metric_delta' } },
    ],
    meters: [
      { name: 'iteration', inc: 'every_round' },
      {
        name: 'stale_count',
        incWhen: 'new_findings == 0 || metric_delta < 0',
        resetWhen: 'new_findings > 0 && metric_delta >= 0',
      },
    ],
    tripwires: [
      { when: 'stale_count >= 4', then: { act: 'escalate', reason: 'attention' } },
      { when: 'stale_count >= 2', then: { act: 'pivot' } },
      { when: 'iteration >= 3', then: { act: 'finalize' } },
    ],
    gates: {
      state_gate: { kind: 'schema', files: ['ledger/progress.json'] },
      findings_gate: {
        kind: 'judge',
        evidence: ['drafts/findings_draft.json', 'ledger/findings.jsonl'],
        rubric: '每条 finding 必须有训练数据支撑；与历史 findings 无语义重复。',
      },
    },
    seats: {
      worker: {
        context: 'lineage_round',
        prompt: '读取胶囊，选择一个与历史不同的研究方向，实现并训练，将 findings 草稿写入 drafts/findings_draft.json。',
        tools: ['read_file', 'edit_file', 'bash'],
        budgetPerRound: { usd: 2, turns: 40 },
      },
      judge: {
        context: 'isolated',
        prompt: '仅依据证据文件评审 findings 草稿。',
        inputs: ['drafts/findings_draft.json', 'ledger/findings.jsonl'],
        budgetPerRound: { usd: 0.5, turns: 10 },
      },
      pivoter: {
        context: 'isolated',
        prompt: '基于死路清单提出结构性新方向，不做参数微调。',
        inputs: ['ledger/directions.json', 'ledger/findings.jsonl'],
      },
    },
    budgets: {
      perRound: { usd: 4 },
      lifetime: { rounds: 12, usd: 60 },
    },
    roundIntervalMs: 0,
    ...overrides,
  }
  // Keep the pivot ⇔ pivoter invariant (validator enforces BOTH directions)
  // when a test overrides only ONE side: drop the dead pivoter seat, or drop
  // the unhonorable pivot tripwire. (Tests overriding both sides are on their
  // own — presumably exercising the validator.)
  const hasPivotTripwire = charter.tripwires.some(tw => {
    const t = tw.then as { act?: string; mode?: string }
    return t.act === 'pivot' || t.mode === 'pivot' // v3 + legacy-migration fixtures
  })
  if (overrides?.tripwires && !overrides.seats && !hasPivotTripwire && charter.seats.pivoter) {
    charter.seats = { ...charter.seats }
    delete charter.seats.pivoter
  }
  if (overrides?.seats && !overrides.tripwires && hasPivotTripwire && !charter.seats.pivoter) {
    charter.tripwires = charter.tripwires.filter(tw => {
      const t = tw.then as { act?: string; mode?: string }
      return t.act !== 'pivot' && t.mode !== 'pivot'
    })
  }
  return charter
}
