import { describe, expect, it } from 'vitest'
import {
  describeJsonDefect,
  normalizeIntakePreconditions,
  normalizeIntakeProbes,
  parseIntakeEnvelope,
  repairUnescapedQuotes,
  structuredJsonCandidates,
  validateLoopIntakeRecord,
  LOOP_INTAKE_SCHEMA,
} from '../index.js'

/**
 * Verbatim excerpts from a real failed `loop intake` run on the AMP training
 * project. The model wrote Chinese prose that quoted the requirement document
 * with unescaped ASCII quotes, which invalidated a ~33k-token envelope holding
 * an entire human Q&A session. The run died with "no parseable envelope" — a
 * message that reads like a missing field.
 */
const brokenEnvelope = `\`\`\`json
{
  "constraints": {
    "schemaVersion": "loop-constraints-2.0",
    "goal": "把 X1 的 PPO 基线改造为 AMP 闭环并通过三道 Gate。",
    "constraints": [
      {"id":"GATE-C-FROZEN-THRESHOLDS","kind":"success_criteria","statement":"60s/95%/5%/5seeds 直接冻结","strength":"hard","sources":[{"path":"amp_loop.md","locator":"L126"}]}
    ]
  },
  "approvedConstraintIds": ["GATE-C-FROZEN-THRESHOLDS"],
  "preconditions": {
    "paths": [
      {"path":"humanoid/","mustExist":true,"createdBy":"human","note":"AgiBot X1 PPO 训练代码目录。"},
      {"path":"data/0008_normal_walk4_stageii.npz","mustExist":true,"createdBy":"human","note":"重定向参考动作。"},
      {"path":"gmr_f1/GMR/assets/body_models/smplx/","mustExist":false,"createdBy":"human","note":"当前不存在。"}
    ],
    "commands": [
      {"name":"isaacgym","mustBeInstalled":true,"note":"训练依赖。"},
      {"name":"mujoco","mustBeInstalled":true,"note":"回放与 Sim2Sim 验证。"}
    ],
    "credentials": [
      {"name":"gradmotion-account-pool","mustBeConfigured":true,"note":"远端训练换号。"}
    ],
    "deferredDecisions": [
      {"id":"DEF-GATE-C-SPECIFIC-THRESHOLDS","description":"速度/步态/足滑阈值待冻结。","blockingPhase":"amp_training"}
    ]
  },
  "probes": [
    {
      "ruleClass": "constraint-weakened",
      "question": "Gate C 的部分阈值已明确，其余是否 defer？",
      "precheck": "文档 L126-L134 给出了部分数字但 L131 明确说"具体阈值必须在首次正式训练前依据 F1 尺寸写入 task_spec.md"；当前无 F1 关节参数",
      "status": "resolved",
      "answer": "对。60s/95%/5%/5seeds 直接冻结。",
      "affects": ["GATE-C-FROZEN-THRESHOLDS"]
    },
    {
      "ruleClass": "constraint-weakened",
      "question": "文档 L134 说"F1关节限位可稍微放宽"。"稍微放宽"和"频繁、过量"缺乏可执行判定标准。如何处理？",
      "precheck": "文档 L134 给出定性描述但无定量阈值",
      "status": "resolved",
      "answer": "直接按"不作为严格要求"处理，仅作为评测报告观察项。",
      "affects": ["JOINT-LIMIT-RELAXED"]
    }
  ],
  "deferred": [
    {"id":"DEF-GATE-C-SPECIFIC-THRESHOLDS","question":"具体数值阈值应设为多少？","assumedDefault":"无默认值，训练前冻结","affects":["GATE-C-FROZEN-THRESHOLDS"]}
  ]
}
\`\`\``

describe('unescaped-quote repair', () => {
  it('reproduces the original failure: raw JSON.parse and brace scanning both fail', () => {
    expect(() => JSON.parse(brokenEnvelope.replace(/```json|```/g, '').trim())).toThrow()
  })

  it('escapes inner quotes while leaving structural ones alone', () => {
    const repaired = repairUnescapedQuotes('{"a": "他说"这样"，然后走了", "b": 1}')
    expect(JSON.parse(repaired)).toEqual({ a: '他说"这样"，然后走了', b: 1 })
  })

  it('leaves already-valid JSON byte-identical', () => {
    const valid = '{"a":"plain","b":["x","y"],"c":{"d":1}}'
    expect(repairUnescapedQuotes(valid)).toBe(valid)
  })

  it('does not merge two adjacent string values into one', () => {
    // A quote followed by a legal value terminator must still close its string,
    // otherwise the repair would silently rewrite well-formed data.
    const repaired = repairUnescapedQuotes('{"a":"one","b":"two"}')
    expect(JSON.parse(repaired)).toEqual({ a: 'one', b: 'two' })
  })

  it('recovers the top-level object a desynchronised scan would miss', () => {
    const candidates = structuredJsonCandidates(brokenEnvelope)
    const withConstraints = candidates.filter(item => item && typeof item === 'object' && 'constraints' in item)
    expect(withConstraints.length).toBeGreaterThan(0)
  })
})

describe('intake envelope recovery', () => {
  it('parses the real broken envelope end to end', () => {
    const { record, diagnosis } = parseIntakeEnvelope(brokenEnvelope)
    expect(diagnosis).toBe('')
    expect(record?.constraints.constraints[0]?.id).toBe('GATE-C-FROZEN-THRESHOLDS')
    // The host stamps origin; it is what makes the immutability check real.
    expect(record?.constraints.constraints[0]?.origin).toBe('intake')
    expect(record?.approvedConstraintIds).toEqual(['GATE-C-FROZEN-THRESHOLDS'])
    // The prose answers — the expensive part — survive intact.
    expect(record?.probes[1]?.answer).toContain('不作为严格要求')
  })

  it('maps the domain-shaped preconditions models keep inventing', () => {
    const { record } = parseIntakeEnvelope(brokenEnvelope)
    const items = record?.preconditions.items ?? []
    expect(record?.preconditions.schemaVersion).toBe('loop-preconditions-1.0')
    expect(items.find(item => item.target === 'humanoid/')?.kind).toBe('directory')
    expect(items.find(item => item.target === 'data/0008_normal_walk4_stageii.npz')?.kind).toBe('file')
    expect(items.find(item => item.target === 'isaacgym')?.kind).toBe('command')
    expect(items.find(item => item.target === 'gradmotion-account-pool')?.kind).toBe('credential')
    expect(items.find(item => item.target === 'DEF-GATE-C-SPECIFIC-THRESHOLDS')?.kind).toBe('decision')
    // `mustExist: false` must not become a blocking launch gate.
    expect(items.find(item => item.target.endsWith('smplx/'))?.blocking).toBe(false)
  })

  it('normalizes probe status and prose precheck instead of failing', () => {
    // Probes are diagnostic metadata; nothing executes them. Losing a human
    // conversation over a vocabulary mismatch here would be a bad trade.
    const probes = normalizeIntakeProbes([
      { ruleClass: 'missing-precondition', question: 'q', precheck: 'glob 未找到 humanoid/', status: 'resolved', answer: 'a', affects: ['C1'] },
    ])
    expect(probes[0]?.status).toBe('answered')
    expect(probes[0]?.precheck).toEqual({ kind: 'source-scan', target: 'glob 未找到 humanoid/', found: true })
  })

  it('passes the flat items shape straight through', () => {
    const items = [{ kind: 'file' as const, target: 'a.md', reason: 'r', blocking: true }]
    expect(normalizeIntakePreconditions({ schemaVersion: 'loop-preconditions-1.0', items }).items).toEqual(items)
  })

  it('produces a record that validates', () => {
    const { record } = parseIntakeEnvelope(brokenEnvelope)
    expect(validateLoopIntakeRecord({
      schemaVersion: LOOP_INTAKE_SCHEMA,
      source: { requirement: 'amp_loop.md', projectDir: '/p', sha256: 'abc' },
      completedAt: 1,
      ...record!,
    })).toEqual([])
  })
})

describe('envelope diagnostics', () => {
  it('names the quoting slip rather than reporting a missing field', () => {
    // The old message was "no parseable envelope", which sent people looking
    // for a schema problem thousands of characters away from the real cause.
    const defect = describeJsonDefect('{"a": "他说"这样"，然后走了"}')
    expect(defect).toContain('未转义的半角双引号')
  })

  it('points at the failing line when the engine locates the defect', () => {
    const defect = describeJsonDefect('{\n  "a": "x"\n  "b": "y"\n}')
    expect(defect).toContain('JSON 解析失败')
    expect(defect).toMatch(/第 \d+ 行/)
    expect(defect).toContain('附近文本')
  })

  it('stays honest when the engine offers no location', () => {
    // Fabricating a line number would be worse than admitting there is none.
    const defect = describeJsonDefect('{\n  "a": 1,\n  "b": ,\n}')
    expect(defect).toContain('JSON 解析失败')
    expect(defect).not.toMatch(/第 \d+ 行/)
  })

  it('explains a structurally fine object that simply lacks the ledger', () => {
    const { record, diagnosis } = parseIntakeEnvelope({ approvedConstraintIds: [], probes: [] })
    expect(record).toBeUndefined()
    expect(diagnosis).toContain('constraints')
  })
})
