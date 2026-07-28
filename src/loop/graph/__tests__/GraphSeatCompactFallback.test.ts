import { describe, it, expect } from 'vitest'
import { MetaAgentGraphAgentExecutor } from '../agent/MetaAgentGraphAgentExecutor.js'
import { GRAPH_AGENT_PROFILE } from '../agent/GraphAgentExecutor.js'
import type { ISubAgentDispatcher } from '../../../subagent/ISubAgentDispatcher.js'
import type { SubAgentConfig, SubAgentRecord } from '../../../subagent/types.js'

/**
 * G5 — docs/reviews/graph-loop-token-cost-audit-2026-07-27.md.
 *
 * Graph Agent seats are unattended and long-lived: if the model-based
 * compactor's circuit breaker opens, the no-model structural-truncate fallback
 * is the only thing standing between the seat and the blocking limit, and there
 * is no human to recover the run.
 *
 * That fallback used to be acquired implicitly — AgenticSession derives it from
 * `autonomy !== undefined`, and the seat only satisfied that because the loop
 * CLI happens to build its backend with mode:'auto'. This test pins the seat's
 * own declaration so re-wiring the CLI cannot silently remove the guarantee.
 */

function terminalRecord(config: Partial<SubAgentConfig>): SubAgentRecord {
  return {
    taskId: 'task-g5',
    parentSessionId: 'parent',
    status: 'completed',
    createdAt: Date.now(),
    completedAt: Date.now(),
    config: config as SubAgentConfig,
    result: {
      success: true,
      summary: 'ok',
      output: { done: true },
      turnsUsed: 1,
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.001,
      durationMs: 5,
    },
  } as unknown as SubAgentRecord
}

/** Records the spawn config and reports the task terminal immediately. */
function capturingDispatcher(): { dispatcher: ISubAgentDispatcher; seen: Partial<SubAgentConfig>[] } {
  const seen: Partial<SubAgentConfig>[] = []
  let record: SubAgentRecord | null = null
  const dispatcher: ISubAgentDispatcher = {
    async spawnSubAgent(opts) {
      seen.push(opts.config as Partial<SubAgentConfig>)
      record = terminalRecord(opts.config as Partial<SubAgentConfig>)
      return record
    },
    async getStatus() { return record },
    async cancelTask() { return true },
  }
  return { dispatcher, seen }
}

describe('Graph Agent seat compaction fallback (G5)', () => {
  it('declares compactStructuralFallback on every spawn', async () => {
    const { dispatcher, seen } = capturingDispatcher()
    const executor = new MetaAgentGraphAgentExecutor(dispatcher)

    const result = await executor.execute({
      profile: GRAPH_AGENT_PROFILE,
      prompt: { system: 'sys', user: 'usr' },
      allowedTools: ['read_file'],
      workspace: {
        projectDir: '/tmp/project',
        mode: 'shared_write',
        writeAllowPaths: [],
        writeDenyPaths: [],
      },
      continuity: {
        lineageSessionId: 'lane-research',
        workspaceId: 'ws-test',
        loopInstanceId: 'inst-test',
      },
      limits: { turns: 5, usd: 1, wallTimeMs: 10_000 },
      signal: new AbortController().signal,
    })

    expect(result.kind).toBe('completed')
    expect(seen).toHaveLength(1)
    // The load-bearing assertion: the seat asks for the fallback itself rather
    // than inheriting it from however the parent backend happened to be built.
    expect(seen[0]!.compactStructuralFallback).toBe(true)
    // It must not have quietly started depending on an autonomy profile instead
    // — the Graph Kernel owns orchestration, the seat is not an auto session.
    expect(seen[0]!.autonomy).toBeUndefined()
  })
})
