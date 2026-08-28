import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { makeAutoVerifyGate, parseVerdict, buildJudgeRubric, resolveJudgeLimits, VERIFY_JUDGE_DEFAULTS } from '../VerifyJudge.js'
import { buildVerifyRejectionPrompt } from '../../../../kernel/loop/VerifyGate.js'
import { DEFAULT_VERIFY_BUDGET_USD, DEFAULT_JUDGE_MAX_TURNS } from '../../../../infra/budgets.js'
import type { ISubAgentDispatcher } from '../../../../subagent/ISubAgentDispatcher.js'
import type { SubAgentRecord } from '../../../../subagent/types.js'

describe('parseVerdict', () => {
  it('parses a fenced json verdict', () => {
    const text = 'Here is my review.\n```json\n{"done": false, "unfinished": ["add tests"], "evidence": ["src/a.ts:10 missing return"]}\n```'
    const v = parseVerdict(text)
    expect(v).not.toBeNull()
    expect(v!.done).toBe(false)
    expect(v!.unfinished).toEqual(['add tests'])
    expect(v!.evidence).toEqual(['src/a.ts:10 missing return'])
  })

  it('parses a done verdict with empty arrays', () => {
    const v = parseVerdict('```json\n{"done": true, "unfinished": [], "evidence": ["npm run test exit 0"]}\n```')
    expect(v!.done).toBe(true)
    expect(v!.unfinished).toEqual([])
  })

  it('falls back to a trailing bare object', () => {
    const v = parseVerdict('blah blah {"done": false, "unfinished": ["x"], "evidence": []}')
    expect(v!.done).toBe(false)
    expect(v!.unfinished).toEqual(['x'])
  })

  it('coerces missing/wrong-typed fields to safe defaults', () => {
    const v = parseVerdict('```json\n{"done": true}\n```')
    expect(v!.done).toBe(true)
    expect(v!.unfinished).toEqual([])
    expect(v!.evidence).toEqual([])
  })

  it('returns null when there is no parseable verdict', () => {
    expect(parseVerdict('I think it is fine, looks good to me.')).toBeNull()
    expect(parseVerdict('')).toBeNull()
  })

  it('returns null when done is not a boolean', () => {
    expect(parseVerdict('```json\n{"done": "yes", "unfinished": []}\n```')).toBeNull()
  })

  it('prefers the last verdict block when several are present', () => {
    const text = '```json\n{"done": true, "unfinished": []}\n```\nwait, revised:\n```json\n{"done": false, "unfinished": ["redo"]}\n```'
    const v = parseVerdict(text)
    expect(v!.done).toBe(false)
    expect(v!.unfinished).toEqual(['redo'])
  })
})

describe('buildVerifyRejectionPrompt', () => {
  it('lists unfinished items and evidence', () => {
    const p = buildVerifyRejectionPrompt(
      { done: false, unfinished: ['fix typecheck', 'add README'], evidence: ['tsc exit 2'] },
      2,
    )
    expect(p).toContain('第 2 轮')
    expect(p).toContain('1. fix typecheck')
    expect(p).toContain('2. add README')
    expect(p).toContain('tsc exit 2')
  })

  it('handles an empty unfinished list gracefully', () => {
    const p = buildVerifyRejectionPrompt({ done: false, unfinished: [], evidence: [] }, 1)
    expect(p).toContain('第 1 轮')
    expect(p).toContain('未给出具体项')
  })
})

describe('makeAutoVerifyGate judge toolset', () => {
  it('drops bash (read-only tools) when no git snapshot can be made', async () => {
    // A non-git tmpdir: withReadonlySnapshot yields null, so the judge inspects
    // the LIVE tree — where bash must NOT be available (the auto jail
    // auto-approves in-workspace writes, so a bash-capable judge could mutate
    // real source despite the read-only rubric).
    const dir = mkdtempSync(join(tmpdir(), 'ma-verify-tools-'))
    try {
      const doneSummary = '```json\n{"done": true, "unfinished": [], "evidence": []}\n```'
      let capturedAllowedTools: string[] | undefined
      let capturedTask = ''
      const completed = {
        taskId: 't1',
        status: 'completed',
        result: { summary: doneSummary },
      } as unknown as SubAgentRecord
      let capturedSystemPrompt = ''
      let capturedMaxTurns: number | undefined
      let capturedMaxBudget: number | undefined
      const dispatcher: ISubAgentDispatcher = {
        spawnSubAgent: async opts => {
          capturedAllowedTools = opts.config.allowedTools
          capturedTask = opts.config.taskDescription
          capturedSystemPrompt = opts.config.systemPrompt ?? ''
          capturedMaxTurns = opts.config.maxTurns
          capturedMaxBudget = opts.config.maxBudgetUsd
          return completed
        },
        getStatus: async () => completed,
        cancelTask: async () => true,
      }

      const gate = makeAutoVerifyGate({ dispatcher, projectDir: dir, getGoal: () => 'do the thing' })
      const verdict = await gate({
        workspaceRoot: dir,
        turnCount: 1,
        round: 1,
        signal: new AbortController().signal,
      })

      expect(capturedAllowedTools).toEqual(['read_file', 'grep', 'glob'])
      expect(capturedAllowedTools).not.toContain('bash')
      expect(capturedTask).not.toContain('确定性检查结果')
      expect(capturedTask).not.toContain('typecheck')
      // Rubric must be aligned with the actual (bash-less) toolset on the live tree.
      expect(capturedSystemPrompt).toContain('没有 bash/shell')
      expect(capturedSystemPrompt).not.toContain('bash 仅用于查看')
      // Default budget (env-overridable) is sized for multi-file deliverables.
      expect(capturedMaxTurns).toBe(VERIFY_JUDGE_DEFAULTS.maxTurns)
      expect(capturedMaxBudget).toBe(VERIFY_JUDGE_DEFAULTS.maxBudgetUsd)
      expect(verdict.done).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('buildJudgeRubric — tool alignment', () => {
  it('promises bash only when bash is granted (snapshot path)', () => {
    const r = buildJudgeRubric(['read_file', 'grep', 'glob', 'bash'])
    expect(r).toContain('read_file / grep / glob / bash')
    expect(r).toContain('bash 仅用于查看')
    expect(r).not.toContain('没有 bash/shell')
  })

  it('omits bash and adds grep guidance when bash is absent (live-tree path)', () => {
    const r = buildJudgeRubric(['read_file', 'grep', 'glob'])
    expect(r).toContain('read_file / grep / glob')
    expect(r).toContain('没有 bash/shell')
    expect(r).toContain('content 模式')
    expect(r).not.toContain('git log')
  })

  it('always asks for a best-effort JSON verdict before exhausting budget', () => {
    expect(buildJudgeRubric(['read_file'])).toContain('接近轮次上限')
  })

  // 2026-08-27: the judge finished its investigation genuinely undecided — some
  // acceptance metrics met, others still converging — and wrote prose instead of
  // committing to a boolean. `parseVerdict` requires `typeof done === 'boolean'`,
  // so both channels missed, the gate reported "unavailable", and the run halted.
  // The rubric never told it where "partially done" lands.
  it('gives a partially-done judgement a determinate landing spot', () => {
    const r = buildJudgeRubric(['read_file', 'grep', 'glob'])
    expect(r).toContain('二值判断')
    expect(r).toContain('部分指标达成')
    expect(r).toContain('done: false')
  })

  it('says explicitly that prose is not an acceptable verdict', () => {
    const r = buildJudgeRubric(['read_file'])
    // Naming the CONSEQUENCE matters more than the instruction: a model that
    // knows prose costs a full re-run has a reason to commit to the boolean.
    expect(r).toMatch(/散文/)
    expect(r).toMatch(/无法裁决|作废|重跑/)
  })

  it('still requires unfinished to be empty when done', () => {
    expect(buildJudgeRubric(['read_file'])).toContain('done=true 时 unfinished 必须为空数组')
  })
})

describe('resolveJudgeLimits — env-overridable budget', () => {
  const KEYS = [
    'META_AGENT_VERIFY_MAX_TURNS',
    'META_AGENT_VERIFY_MAX_BUDGET_USD',
    'META_AGENT_VERIFY_MAX_DURATION_MS',
  ]
  const saved: Record<string, string | undefined> = {}
  beforeEach(() => { for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k] } })
  afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] } })

  it('falls back to the documented defaults (ladder turns / ladder budget / 30min)', () => {
    const expected = { maxTurns: DEFAULT_JUDGE_MAX_TURNS, maxBudgetUsd: DEFAULT_VERIFY_BUDGET_USD, maxDurationMs: 1_800_000 }
    expect(resolveJudgeLimits()).toEqual(expected)
    expect(VERIFY_JUDGE_DEFAULTS).toEqual(expected)
  })

  it('applies env overrides', () => {
    process.env['META_AGENT_VERIFY_MAX_TURNS'] = '12'
    process.env['META_AGENT_VERIFY_MAX_BUDGET_USD'] = '0.4'
    process.env['META_AGENT_VERIFY_MAX_DURATION_MS'] = '300000'
    expect(resolveJudgeLimits()).toEqual({ maxTurns: 12, maxBudgetUsd: 0.4, maxDurationMs: 300_000 })
  })

  it('ignores garbage and clamps out-of-range overrides', () => {
    process.env['META_AGENT_VERIFY_MAX_TURNS'] = 'abc'      // → default 30
    process.env['META_AGENT_VERIFY_MAX_BUDGET_USD'] = '-5'  // → clamped to min 0.01
    const r = resolveJudgeLimits()
    expect(r.maxTurns).toBe(DEFAULT_JUDGE_MAX_TURNS)
    expect(r.maxBudgetUsd).toBe(0.01)
  })

  it('rejects a valid prefix followed by garbage rather than reading the prefix', () => {
    // P2-3 class. `parseInt('1oops')` is 1 — a one-turn judge cannot gather
    // evidence, so it produces no verdict, which surfaces as the very same
    // "verify unavailable" halt this file's gate reports. A typo in a budget
    // knob must not disarm the judge.
    process.env['META_AGENT_VERIFY_MAX_TURNS'] = '1oops'
    process.env['META_AGENT_VERIFY_MAX_BUDGET_USD'] = '0.5junk'
    const r = resolveJudgeLimits()
    expect(r.maxTurns).toBe(DEFAULT_JUDGE_MAX_TURNS)
    expect(r.maxBudgetUsd).toBe(DEFAULT_VERIFY_BUDGET_USD)
  })
})
