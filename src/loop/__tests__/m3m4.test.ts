/**
 * M3/M4 acceptance: distiller retry loop, charter migration semantics,
 * lifetime budget escalation (rounds/usd/deadline), worker sandbox denial,
 * kernel observer events.
 */
import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import type { ISubAgentDispatcher } from '../../subagent/ISubAgentDispatcher.js'
import type { SubAgentConfig, SubAgentRecord } from '../../subagent/types.js'
import { makeSubAgentTaskId } from '../../subagent/types.js'
import { DISTILLER_SYSTEM, buildDistillerSystem, distillCharter } from '../distill/Distiller.js'
import { migrateInstance } from '../instance/Migrate.js'
import { createInstance, loadInstance, setInstanceStatus } from '../instance/InstanceStore.js'
import { CharterStore } from '../charter/CharterStore.js'
import { WakeStore } from '../wake/WakeStore.js'
import { runUntilQuiescent } from '../runner.js'
import { runRound, type LoopEvent } from '../kernel/LoopKernel.js'
import { validateCharter } from '../charter/CharterValidate.js'
import { instancePaths } from '../types.js'
import { runLoopCli } from '../cli.js'
import { walkResearchCharter } from './testCharter.js'

function scriptedDispatcher(
  script: (task: string, config: Partial<SubAgentConfig>) => Promise<Record<string, unknown>>,
): ISubAgentDispatcher & { configs: Array<Partial<SubAgentConfig>> } {
  const configs: Array<Partial<SubAgentConfig>> = []
  return {
    configs,
    async spawnSubAgent({ config }) {
      configs.push(config)
      const output = await script(config.taskDescription, config)
      return {
        schemaVersion: '1.0', taskId: makeSubAgentTaskId(), parentSessionId: 't',
        status: 'completed', config: config as SubAgentRecord['config'],
        createdAt: Date.now(), completedAt: Date.now(), pendingHumanApproval: false,
        result: {
          success: true, summary: 'scripted', output,
          turnsUsed: 1, inputTokens: 0, outputTokens: 0, costUsd: 0.1, durationMs: 1,
        },
      } satisfies SubAgentRecord
    },
    async getStatus() { return null },
    async cancelTask() { return true },
  }
}

const passingSeats = (paths: ReturnType<typeof instancePaths>) =>
  async (task: string): Promise<Record<string, unknown>> => {
    if (task.includes('产出契约')) {
      await mkdir(paths.draftsDir, { recursive: true })
      await writeFile(join(paths.draftsDir, 'findings_draft.json'),
        JSON.stringify([{ claim: 'c', evidence: 'e' }]), 'utf-8')
      return { label: 'ok' }
    }
    if (task.includes('隔离评审座位')) {
      return { verdict: 'pass', new_findings_count: 1, metric_delta: 0.1, metric: 0.5, messages: [] }
    }
    throw new Error('unexpected seat')
  }

// ── T3.1 distiller ────────────────────────────────────────────────────────────

describe('distillCharter', () => {
  it('teaches explicit tri-state policies and forbids implicit fallback', () => {
    expect(DISTILLER_SYSTEM).toContain('"onAbsent":"skip"|"false"|"fail_stop"')
    expect(DISTILLER_SYSTEM).toContain('"onNull":"skip_update"|"fail_stop"')
    expect(DISTILLER_SYSTEM).toContain('禁止隐式回退')
    expect(DISTILLER_SYSTEM).not.toContain('混用在运行时按"缺值"回退处理')
    expect(DISTILLER_SYSTEM).toContain('"artifacts"')
    expect(DISTILLER_SYSTEM).toContain('"gateBindings"')
    expect(DISTILLER_SYSTEM).toContain('"projections"')
    expect(DISTILLER_SYSTEM).toContain('builtin/generic@1')
    expect(DISTILLER_SYSTEM).toContain('skill、timer、return_result 是内核基础工具')
    expect(DISTILLER_SYSTEM).toContain('vcs_publish')
    expect(DISTILLER_SYSTEM).toContain('accepted_finding_indexes')
    expect(DISTILLER_SYSTEM).toContain('waitPolicy.selfTimer')
    expect(DISTILLER_SYSTEM).toContain('workspace:<项目相对路径>')
    expect(DISTILLER_SYSTEM).toContain('不预设任何目录名')
    expect(DISTILLER_SYSTEM).toContain('既有进展/失败尝试/决策记录')
    expect(DISTILLER_SYSTEM).toContain('不得假设固定目录名')
    expect(DISTILLER_SYSTEM).toContain('paths 必须逐项列出')
    expect(DISTILLER_SYSTEM).toContain('完整可运行 Research 示例')
    expect(DISTILLER_SYSTEM).toContain('taskSpec 是人工审阅/部署清单')
  })

  it('keeps the default mechanism free of project-specific conventions', () => {
    const defaultPrompt = DISTILLER_SYSTEM.toLowerCase()
    for (const projectToken of ['.oma', 'agibot', 'gradmotion', 'account-pool', 'humanoid/envs/x1']) {
      expect(defaultPrompt).not.toContain(projectToken)
    }
    expect(DISTILLER_SYSTEM).toContain('绝不能把示例值提升为 Loop 的通用约定')
  })

  it('feeds validation errors back and succeeds on the corrected attempt', async () => {
    const good = walkResearchCharter()
    const bad = walkResearchCharter({
      tripwires: [{ when: 'stale_count >= 2', then: { act: 'pivot' } }],
      budgets: { perRound: { usd: 6 } },  // no lifetime cap → no guaranteed terminator
    })
    const tasks: string[] = []
    let call = 0
    const dispatcher = scriptedDispatcher(async task => {
      tasks.push(task)
      call++
      return { charter: call === 1 ? bad : good, taskSpec: '# task spec' }
    })
    const result = await distillCharter('目标：行走研究 loop……', { dispatcher })
    expect(result.attempts).toBe(2)
    expect(result.charter.id).toBe('walk-research')
    // The retry prompt carried the exact validation failure.
    expect(tasks[1]).toContain('未通过校验')
    expect(tasks[1]).toMatch(/stop|finalize/)
  })

  it('contains a parseable and structurally valid complete Research example', () => {
    const section = DISTILLER_SYSTEM.split('## 8. 完整可运行 Research 示例')[1] ?? ''
    const json = section.match(/```json\n([\s\S]*?)\n```/)?.[1]
    expect(json).toBeTruthy()
    const parsed = JSON.parse(json!) as { charter: Parameters<typeof validateCharter>[0] }
    expect(validateCharter(parsed.charter)).toEqual([])
  })

  it('injects only explicitly supplied project evidence without a ledger import', () => {
    const prompt = buildDistillerSystem({ workspaceEvidencePaths: ['docs/research-history.md'] })
    expect(prompt).toContain('workspace:docs/research-history.md')
    expect(prompt).toContain('不导入/改写 Ledger baseline')
  })

  it('gives up with the accumulated errors after max attempts', async () => {
    const bad = walkResearchCharter({ tripwires: [] })
    const dispatcher = scriptedDispatcher(async () => ({ charter: bad, taskSpec: '' }))
    await expect(distillCharter('doc', { dispatcher, maxAttempts: 2 }))
      .rejects.toThrow(/failed after 2 attempts[\s\S]*tripwire/)
  })
})

// ── T3.2 migrate ──────────────────────────────────────────────────────────────

describe('migrateInstance', () => {
  async function idleInstanceWithMeters() {
    const dir = await mkdtemp(join(tmpdir(), 'loop-mig-'))
    const inst = await createInstance({
      projectDir: dir, charter: walkResearchCharter(), wakeStore: new WakeStore(dir),
    })
    const progress = await inst.ledger.readProgress()
    await inst.ledger.writeProgress({
      ...progress, iteration: 3,
      meters: { iteration: 3, stale_count: 2 }, updatedAt: Date.now(),
    })
    return { dir, inst }
  }

  it('carries meters by name, inits new, archives dropped; bumps version+hash', async () => {
    const { dir, inst } = await idleInstanceWithMeters()
    const v2 = walkResearchCharter({
      version: 2,
      meters: [
        { name: 'iteration', inc: 'every_round' },
        { name: 'plateau_streak', incWhen: 'metric_delta < 0' }, // stale_count dropped
      ],
      tripwires: [{ when: 'iteration >= 10', then: { act: 'finalize' } }],
    })
    const oldHash = inst.record.charterHash
    const entry = await migrateInstance(inst, v2, { projectDir: dir })
    expect(entry.carriedMeters).toContain('iteration')
    expect(entry.newMeters).toEqual(['plateau_streak'])
    expect(entry.droppedMeters).toEqual({ stale_count: 2 })
    expect(inst.record.charterVersion).toBe(2)
    expect(inst.record.charterHash).not.toBe(oldHash)
    const progress = await inst.ledger.readProgress()
    expect(progress.meters).toEqual({ iteration: 3, plateau_streak: 0 })
    // Audit trail exists.
    const audit = await readFile(join(inst.paths.ledgerDir, 'migrations.jsonl'), 'utf-8')
    expect(JSON.parse(audit.trim())).toMatchObject({ fromVersion: 1, toVersion: 2 })
    // Reloaded instance sees the new frozen charter (persisted, not in-memory only).
    const reloaded = (await loadInstance(dir, inst.record.instanceId))!
    expect(reloaded.charter.version).toBe(2)
  })

  it('refuses same/older versions, different ids, and busy instances', async () => {
    const { dir, inst } = await idleInstanceWithMeters()
    await expect(migrateInstance(inst, walkResearchCharter(), { projectDir: dir }))
      .rejects.toThrow(/NEWER version/)
    await expect(migrateInstance(inst, walkResearchCharter({ id: 'other-loop', version: 2 }), { projectDir: dir }))
      .rejects.toThrow(/different charter id/)
    await setInstanceStatus(inst, 'waiting')
    await expect(migrateInstance(inst, walkResearchCharter({ version: 2 }), { projectDir: dir }))
      .rejects.toThrow(/cannot migrate while 'waiting'/)
  })

  it('re-arms a paused_attention instance (migration = human ack) and resets the escalating meters', async () => {
    const { dir, inst } = await idleInstanceWithMeters()
    await setInstanceStatus(inst, 'paused_attention', 'attention at round 3')
    const wakeStore = new WakeStore(dir)
    const entry = await migrateInstance(inst, walkResearchCharter({ version: 2 }), { wakeStore, projectDir: dir })
    expect(entry.reArmed).toBe(true)
    expect(inst.record.status).toBe('idle')
    expect((await wakeStore.list()).some(w => w.kind === 'timer' && w.status === 'pending')).toBe(true)
    // v3: re-arm resets the meters behind the escalation (stale_count>=4 tripwire
    // references stale_count) so the same tripwire can't re-fire instantly.
    expect(entry.resetMeters).toEqual(['stale_count'])
    const progress = await inst.ledger.readProgress()
    expect(progress.meters['stale_count']).toBe(0)
    expect(progress.meters['iteration']).toBe(3) // untouched
  })

  it('is reachable end-to-end via the CLI (save v2 → loop migrate)', async () => {
    const { dir, inst } = await idleInstanceWithMeters()
    const store = new CharterStore(dir)
    await store.save(walkResearchCharter())                      // v1 in library
    await store.save(walkResearchCharter({ goal: '修订目标' })) // v2 in library
    const out = await runLoopCli(['migrate', inst.record.instanceId], { projectDir: dir })
    expect(out).toContain('v1 → v2')
  })
})

// ── T4.1 lifetime budget escalation ───────────────────────────────────────────

describe('lifetime budgets (T4.1)', () => {
  const budgetCharter = (lifetime: Record<string, number>) => walkResearchCharter({
    budgets: { perRound: { usd: 4 }, lifetime },
    tripwires: [
      { when: 'budget.lifetime.exhausted', then: { act: 'escalate', reason: 'budget' } },
      { when: 'iteration >= 100', then: { act: 'finalize' } },
    ],
  })

  async function runWithBudget(lifetime: Record<string, number>) {
    const dir = await mkdtemp(join(tmpdir(), 'loop-budget-'))
    const paths = instancePaths(dir, 'walk-research-v1')
    const dispatcher = scriptedDispatcher(async t => passingSeats(paths)(t))
    await createInstance({ projectDir: dir, charter: budgetCharter(lifetime), wakeStore: new WakeStore(dir) })
    await runUntilQuiescent({ dispatcher, projectDir: dir })
    return { dir, paths, record: JSON.parse(await readFile(paths.instanceJson, 'utf-8')) }
  }

  it('rounds cap escalates via the budget tripwire', async () => {
    const { paths, record } = await runWithBudget({ rounds: 2 })
    expect(record.status).toBe('paused_attention')
    expect(record.statusReason).toContain('budget')
    const rounds = (await readFile(paths.roundsJsonl, 'utf-8')).trim().split('\n')
    // v3: exhaustion is recomputed at ROUTE with the round accounted, so the
    // escalation happens ON round 2 — no wasted empty third round.
    expect(rounds.length).toBe(2)
    await expect(readFile(join(paths.reportsDir, 'attention_report.md'), 'utf-8'))
      .resolves.toContain('budget')
  })

  it('usd cap escalates once accumulated cost crosses it', async () => {
    // Each round costs 0.2 (worker+judge at 0.1 each) → cap 0.3 stops round 3.
    const { record } = await runWithBudget({ usd: 0.3 })
    expect(record.status).toBe('paused_attention')
  })

  it('deadline escalates immediately when in the past', async () => {
    const { record } = await runWithBudget({ deadlineMs: Date.now() - 1_000 })
    expect(record.status).toBe('paused_attention')
  })
})

describe('per-round USD budget', () => {
  it('caps the worker and fails closed when no budget remains for the judge', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'loop-round-budget-'))
    const paths = instancePaths(dir, 'walk-research-v1')
    const dispatcher = scriptedDispatcher(async t => passingSeats(paths)(t))
    await createInstance({
      projectDir: dir,
      charter: walkResearchCharter({
        budgets: { perRound: { usd: 0.1 }, lifetime: { rounds: 1 } },
        tripwires: [{ when: 'iteration >= 1', then: { act: 'finalize' } }],
      }),
      wakeStore: new WakeStore(dir),
    })
    await runUntilQuiescent({ dispatcher, projectDir: dir })
    expect(dispatcher.configs).toHaveLength(1)
    expect(dispatcher.configs[0]!.maxBudgetUsd).toBe(0.1)
    const instance = (await loadInstance(dir, 'walk-research-v1'))!
    expect(await instance.ledger.readView()).toMatchObject({
      findingsCount: 0,
    })
  })
})

describe('shape schema gates', () => {
  it('retries once then fails closed when structured output remains invalid', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'loop-shape-gate-'))
    const paths = instancePaths(dir, 'walk-research-v1')
    const dispatcher = scriptedDispatcher(async task => {
      if (task.includes('产出契约')) {
        await mkdir(paths.draftsDir, { recursive: true })
        await writeFile(join(paths.draftsDir, 'findings_draft.json'), JSON.stringify([{ claim: 'missing evidence' }]))
        return { label: 'ok' }
      }
      throw new Error('judge must not run after a failed shape gate')
    })
    const charter = walkResearchCharter({
      tripwires: [{ when: 'iteration >= 1', then: { act: 'finalize' } }],
    })
    charter.gates.draft_shape = {
      kind: 'schema', files: ['drafts/findings_draft.json'],
      spec: {
        type: 'array', minItems: 1,
        items: {
          type: 'object', required: ['claim', 'evidence'],
          properties: { claim: { type: 'string' }, evidence: { type: 'string', minLength: 1 } },
        },
      },
    }
    await createInstance({ projectDir: dir, charter, wakeStore: new WakeStore(dir) })
    await runUntilQuiescent({ dispatcher, projectDir: dir })
    expect(dispatcher.configs).toHaveLength(2) // worker + one corrective retry; no judge
    const instance = (await loadInstance(dir, 'walk-research-v1'))!
    expect((await instance.ledger.readView()).findingsCount).toBe(0)
  })
})

// ── T4.2 sandbox denial + T4.4 observer ───────────────────────────────────────

describe('worker sandbox + kernel observer (T4.2/T4.4)', () => {
  it('worker spawns use a readonly workspace with drafts allowlisted; judge carries none', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'loop-sbx-'))
    const paths = instancePaths(dir, 'walk-research-v1')
    const dispatcher = scriptedDispatcher(async t => passingSeats(paths)(t))
    await mkdir(join(dir, 'docs'), { recursive: true })
    await writeFile(join(dir, 'docs', 'research-history.md'), 'DEAD-END-MARKER: do-not-repeat', 'utf-8')
    const charter = walkResearchCharter({
      tripwires: [{ when: 'iteration >= 1', then: { act: 'finalize' } }],
    })
    const judgeGate = charter.gates.findings_gate
    if (judgeGate?.kind === 'judge') judgeGate.evidence.push('workspace:docs/research-history.md')
    await createInstance({
      projectDir: dir,
      charter,
      wakeStore: new WakeStore(dir),
    })
    await runUntilQuiescent({ dispatcher, projectDir: dir })

    const worker = dispatcher.configs.find(c => c.taskDescription!.includes('产出契约'))!
    const denied = (worker.sandbox as { writeDenyPaths?: string[] } | undefined)?.writeDenyPaths ?? []
    const workerSandbox = worker.sandbox as {
      readonlyWorkspace?: boolean
      writeAllowPaths?: string[]
    }
    expect(workerSandbox.readonlyWorkspace).toBe(true)
    expect(workerSandbox.writeAllowPaths).toEqual([paths.draftsDir, paths.scratchDir])
    expect(worker.extraTools?.map(tool => tool.name)).toEqual(expect.arrayContaining(['timer', 'skill']))
    expect(denied).toContain(paths.ledgerDir)
    expect(denied).toContain(paths.instanceJson)
    const judge = dispatcher.configs.find(c => c.taskDescription!.includes('隔离评审座位'))!
    expect(judge.sandbox).toBeUndefined()
    expect(judge.allowedTools).toEqual([])
    expect(judge.taskDescription).toContain('每条 finding 必须有训练数据支撑')
    expect(judge.taskDescription).toContain('accepted_finding_indexes')
    expect(judge.taskDescription).toContain('DEAD-END-MARKER: do-not-repeat')
  })

  it('emits the full observer event sequence for a round', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'loop-obs-'))
    const paths = instancePaths(dir, 'walk-research-v1')
    const dispatcher = scriptedDispatcher(async t => passingSeats(paths)(t))
    await createInstance({
      projectDir: dir,
      charter: walkResearchCharter({
        tripwires: [{ when: 'iteration >= 1', then: { act: 'finalize' } }],
      }),
      wakeStore: new WakeStore(dir),
    })
    const wakeStore = new WakeStore(dir)
    const [wake] = await wakeStore.claimDue(Date.now())
    const instance = (await loadInstance(dir, 'walk-research-v1'))!
    const events: LoopEvent[] = []
    await runRound(instance, wake!, {
      dispatcher, projectDir: dir, signal: new AbortController().signal,
      wakeStore, observer: e => events.push(e),
    })
    expect(events.map(e => e.type)).toEqual([
      'round_started', 'seat_completed', 'seat_completed', 'terminated',
    ])
    expect(events.filter(e => e.type === 'seat_completed').map(e => (e as { seat: string }).seat))
      .toEqual(['worker', 'judge'])
  })
})
