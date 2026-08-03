import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  describeJsonDefect,
  normalizeIntakePreconditions,
  normalizePreconditionKind,
  validateLoopPreconditions,
  normalizeIntakeProbes,
  createFileLoopIntakeStore,
  deferredConstraintIds,
  formatIntakeFactsForReviewer,
  parseLayeredSemanticReview,
  SEMANTIC_REVIEW_LAYERS,
  mergeIntakePreconditions,
  parseIntakeEnvelope,
  resolveIntakePickup,
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

describe('intake pickup notice', () => {
  it('says which path a run is on, and why', async () => {
    // The decision changes what the Architect may do, so it has to be legible
    // before the compile rather than in the summary afterwards.
    const root = await mkdtemp(join(tmpdir(), 'intake-pickup-'))
    try {
      await writeFile(join(root, 'req.md'), 'Converge.', 'utf8')

      const missing = await resolveIntakePickup(root, 'req.md', false)
      expect(missing.record).toBeUndefined()
      expect(missing.notice).toContain('无 loop.intake.json')

      const store = createFileLoopIntakeStore(root)
      const { record } = parseIntakeEnvelope(brokenEnvelope)
      await store.save({ requirement: 'req.md', projectDir: root }, record!)

      const used = await resolveIntakePickup(root, 'req.md', false)
      expect(used.record).toBeDefined()
      expect(used.notice).toContain('采用 loop.intake.json')
      expect(used.notice).toContain('1 条经人确认')

      const disabled = await resolveIntakePickup(root, 'req.md', true)
      expect(disabled.record).toBeUndefined()
      expect(disabled.notice).toContain('--no-intake')

      // A requirement edit must never let an artifact claim a sign-off the
      // human gave to a different document — and must say so out loud.
      await writeFile(join(root, 'req.md'), 'Converge, but differently.', 'utf8')
      const stale = await resolveIntakePickup(root, 'req.md', false)
      expect(stale.record).toBeUndefined()
      expect(stale.notice).toContain('被修改过')
      expect(stale.notice).toContain('loop intake req.md')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('explains an unusable record instead of falling back in silence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'intake-invalid-'))
    try {
      await writeFile(join(root, 'req.md'), 'Converge.', 'utf8')
      await writeFile(join(root, 'loop.intake.json'), '{ not json', 'utf8')
      expect((await resolveIntakePickup(root, 'req.md', false)).notice).toContain('不是合法 JSON')

      await writeFile(join(root, 'loop.intake.json'), JSON.stringify({ schemaVersion: 'loop-intake-1.0' }), 'utf8')
      expect((await resolveIntakePickup(root, 'req.md', false)).notice).toContain('记录不合法')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('intake launch contract reaches loop create', () => {
  const intake = {
    preconditions: {
      schemaVersion: 'loop-preconditions-1.0' as const,
      items: [
        { kind: 'directory' as const, target: 'humanoid/', reason: 'PPO 基线代码', blocking: true },
        { kind: 'command' as const, target: 'isaacgym', reason: '训练依赖', blocking: true },
        { kind: 'file' as const, target: 'optional.md', reason: '可选输入', blocking: false },
      ],
    },
    deferred: [{ id: 'DEF-THRESHOLDS', question: '阈值设为多少？', assumedDefault: '训练前冻结', affects: ['C1'] }],
  }

  it('carries confirmed preconditions and deferrals into the final artifact', () => {
    // Without this the chain "human confirms → loop create refuses to start"
    // is broken at its last link, and the confirmation buys nothing.
    const merged = mergeIntakePreconditions(
      { schemaVersion: 'loop-preconditions-1.0', items: [{ kind: 'file', target: 'compiler.md', reason: 'r', blocking: true }] },
      intake,
    )
    const targets = merged.items.map(item => item.target)
    expect(targets).toContain('compiler.md')
    expect(targets).toContain('humanoid/')
    expect(targets).toContain('isaacgym')
    expect(targets).toContain('DEF-THRESHOLDS')
    expect(merged.items.find(item => item.target === 'DEF-THRESHOLDS')?.kind).toBe('decision')
    expect(merged.items.find(item => item.target === 'humanoid/')?.reason).toContain('Intake 已确认')
  })

  it('does not let the Compiler soften a human-declared blocking precondition', () => {
    const merged = mergeIntakePreconditions(
      { schemaVersion: 'loop-preconditions-1.0', items: [{ kind: 'directory', target: 'humanoid/', reason: '推导所得', blocking: false }] },
      intake,
    )
    expect(merged.items).toHaveLength(4)
    expect(merged.items.find(item => item.target === 'humanoid/')?.blocking).toBe(true)
  })

  it('preserves a non-blocking item the human marked optional', () => {
    const merged = mergeIntakePreconditions({ schemaVersion: 'loop-preconditions-1.0', items: [] }, intake)
    expect(merged.items.find(item => item.target === 'optional.md')?.blocking).toBe(false)
  })

  it('is a no-op without an intake record', () => {
    const base = { schemaVersion: 'loop-preconditions-1.0' as const, items: [] }
    expect(mergeIntakePreconditions(base, undefined)).toBe(base)
  })
})

describe('what the reviewer is told a human already settled', () => {
  const intake = {
    schemaVersion: LOOP_INTAKE_SCHEMA,
    source: { requirement: 'amp_loop.md', projectDir: '/p', sha256: 'abc' },
    completedAt: 1,
    constraints: {
      schemaVersion: 'loop-constraints-2.0' as const,
      goal: 'g',
      constraints: [
        { id: 'GATE-C', kind: 'success_criteria' as const, statement: 'Gate C 验收', strength: 'hard' as const, origin: 'intake' as const, sources: [{ path: 'amp_loop.md', locator: 'L126' }] },
        { id: 'ROUTE-C', kind: 'deterministic_rule' as const, statement: '先判 error 再判 attention', strength: 'hard' as const, origin: 'intake' as const, sources: [{ path: 'amp_loop.md', locator: 'L182' }] },
      ],
    },
    approvedConstraintIds: ['GATE-C', 'ROUTE-C'],
    preconditions: { schemaVersion: 'loop-preconditions-1.0' as const, items: [] },
    probes: [{
      ruleClass: 'unbounded-or-unreachable-control' as const,
      question: 'stale_countC >= 6 是否可达？',
      status: 'answered' as const,
      answer: '确认不可达，用户同意反转顺序并拆成双计数器。',
      affects: ['ROUTE-C'],
    }],
    deferred: [{ id: 'DEF-THRESHOLDS', question: '阈值设为多少？', assumedDefault: '训练前冻结', affects: ['GATE-C'] }],
  }

  it('states the confirmed set, the deferrals and the answered probes', () => {
    const text = formatIntakeFactsForReviewer(intake)
    expect(text).toContain('GATE-C、ROUTE-C')
    expect(text).toContain('DEF-THRESHOLDS')
    expect(text).toContain('确认不可达，用户同意反转顺序')
  })

  it('keeps intent and implementation apart', () => {
    // Blanket deference would be worse than the problem it solves: a human
    // agreeing to a remedy says nothing about whether the Compiler applied it.
    const text = formatIntakeFactsForReviewer(intake)
    expect(text).toContain('意图已定，不要重新裁决')
    expect(text).toContain('照查不误')
    expect(text).toContain('overreach-obligation')
  })

  it('collects the constraints a deferral covers', () => {
    expect([...deferredConstraintIds(intake)]).toEqual(['GATE-C'])
    expect(deferredConstraintIds(undefined).size).toBe(0)
  })
})

describe('a deliberately deferred value is not an unimplemented constraint', () => {
  const envelope = (ruleClass: string, statement: string, witness?: unknown): Record<string, unknown> => {
    const layers = Object.fromEntries(SEMANTIC_REVIEW_LAYERS.map(name => [name, {
      status: 'pass', findings: [],
      evidence: [{ sourceRefs: ['amp_loop.md:L1'], designRefs: ['intent'], graphRefs: ['/goal'], statement: 'Aligned.' }],
    }]))
    layers.control_flow = {
      status: 'fail',
      findings: [{
        ruleClass, statement, sourceRefs: ['amp_loop.md:L131'], designRefs: ['control'], graphRefs: ['/limits'],
        ...(witness ? { witness } : {}),
      }],
      evidence: [{ sourceRefs: ['amp_loop.md:L131'], designRefs: ['control'], graphRefs: ['/limits'], statement: 'Checked.' }],
    }
    return { schemaVersion: 'loop-semantic-review-2.2', accepted: false, layers, verdicts: [], issues: [] }
  }
  const deferred = { deferredConstraintIds: new Set(['GATE-C']) }

  it('demotes a missing-value finding against a deferred constraint', () => {
    const parsed = parseLayeredSemanticReview(
      envelope('unimplemented-hard-constraint', 'GATE-C 的速度阈值在图中没有任何实现'), undefined, deferred)
    expect(parsed?.accepted).toBe(true)
    expect(parsed?.advisories[0]).toContain('已由人在 Intake 阶段明确暂缓')
    expect(parsed?.layers.control_flow.status).toBe('pass')
  })

  it('leaves the same class blocking for a constraint nobody deferred', () => {
    const parsed = parseLayeredSemanticReview(
      envelope('unimplemented-hard-constraint', 'OTHER-C 的轮次上限在图中没有任何实现'), undefined, deferred)
    expect(parsed?.accepted).toBe(false)
  })

  it('prefers the deferral reason over the missing-witness reason', () => {
    // Both rules demote, but only one of them is the truth. Telling the next
    // round "you gave no counterexample" would send it hunting for evidence
    // about a value nobody has chosen yet.
    const parsed = parseLayeredSemanticReview(
      envelope('missing-source-bound', 'GATE-C 的阈值没有确定性路由'), undefined, deferred)
    expect(parsed?.accepted).toBe(true)
    expect(parsed?.advisories[0]).toContain('已由人在 Intake 阶段明确暂缓')
    expect(parsed?.advisories[0]).not.toContain('未提供反例')
  })

  it('only demotes the "value is missing" reading, not every finding', () => {
    // Whether Gate C has an independent reviewer is unrelated to whether its
    // threshold has been chosen, and must still block.
    const parsed = parseLayeredSemanticReview(
      envelope('single-agent-terminal-authority', 'GATE-C 由产出工作的 Agent 自行签发'), undefined, deferred)
    expect(parsed?.accepted).toBe(false)
  })
})

describe('precondition kinds the Distill vocabulary invites', () => {
  it('repairs kind="capability", which our own prompts teach the model to write', () => {
    // Every Distill prompt says a kind=capability CONSTRAINT resolves to the
    // human and lands in preconditions. The model then writes "capability" on
    // the precondition too — and two such items failed a whole Intake after the
    // person had already answered everything.
    const items = [
      { kind: 'capability', target: 'isaacgym', reason: '训练依赖' },
      { kind: 'capability', target: 'gradmotion', reason: '远端训练' },
    ]
    const normalized = normalizeIntakePreconditions({ schemaVersion: 'loop-preconditions-1.0', items })
    expect(normalized.items.map(item => item.kind)).toEqual(['command', 'command'])
    expect(validateLoopPreconditions(normalized)).toEqual([])
  })

  it('maps the other synonyms models reach for', () => {
    const items = [
      { kind: 'skill', target: 'gradmotion', reason: 'r' },
      { kind: 'secret', target: 'ANTHROPIC_API_KEY', reason: 'r' },
      { kind: 'folder', target: 'humanoid/', reason: 'r' },
      { kind: 'question', target: 'DEF-X', reason: 'r' },
    ]
    expect(normalizeIntakePreconditions({ schemaVersion: 'loop-preconditions-1.0', items }).items.map(i => i.kind))
      .toEqual(['command', 'credential', 'directory', 'decision'])
  })

  it('infers from the target when the kind is unrecognisable', () => {
    expect(normalizePreconditionKind('nonsense', 'data/motion.npz')).toBe('file')
    expect(normalizePreconditionKind('nonsense', 'humanoid/')).toBe('directory')
    // Not path-like and not classifiable: make it a blocking question rather
    // than dropping it silently.
    expect(normalizePreconditionKind('nonsense', 'something')).toBe('decision')
  })

  it('leaves already-valid kinds untouched', () => {
    const items = [
      { kind: 'file' as const, target: 'a.md', reason: 'r', blocking: true },
      { kind: 'decision' as const, target: 'DEF-1', reason: 'r', blocking: true },
    ]
    expect(normalizeIntakePreconditions({ schemaVersion: 'loop-preconditions-1.0', items }).items).toEqual(items)
  })

  it('keeps a non-blocking item non-blocking', () => {
    const items = [{ kind: 'capability', target: 'optional-cli', reason: 'r', blocking: false }]
    const [item] = normalizeIntakePreconditions({ schemaVersion: 'loop-preconditions-1.0', items }).items
    expect(item).toMatchObject({ kind: 'command', blocking: false })
  })
})
