/**
 * inner_orch_worker seat wiring — asserts the lineage vs isolated branch flows
 * all the way into the spawned sub-agent config: lineage seats resume a stable
 * session id and carry the lineage prompt; isolated seats start fresh.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ISubAgentDispatcher } from '../../../subagent/ISubAgentDispatcher.js'
import type { SubAgentConfig, SubAgentRecord } from '../../../subagent/types.js'
import { makeSubAgentTaskId } from '../../../subagent/types.js'
import { freezeCharter } from '../../charter/CharterValidate.js'
import { instancePaths } from '../../types.js'
import { runWorkerSeat } from '../Seats.js'
import { walkResearchCharter } from '../../__tests__/testCharter.js'
import type { Capsule } from '../../capsule/CapsuleBuilder.js'
import type { SeatContext } from '../../charter/CharterTypes.js'

function capturing(): ISubAgentDispatcher & { configs: SubAgentConfig[] } {
  const configs: SubAgentConfig[] = []
  return {
    configs,
    async spawnSubAgent({ config }) {
      configs.push(config as SubAgentConfig)
      return {
        schemaVersion: '1.0', taskId: makeSubAgentTaskId(), parentSessionId: 't',
        status: 'completed', config: config as SubAgentRecord['config'],
        createdAt: Date.now(), completedAt: Date.now(), pendingHumanApproval: false,
        result: {
          success: true, summary: 'ok', output: { label: 'ok' },
          turnsUsed: 1, inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 1,
        },
      } satisfies SubAgentRecord
    },
    async getStatus() { return null },
    async cancelTask() { return true },
  }
}

const capsule: Capsule = {
  builtAt: Date.now(), round: 1, mode: 'normal', goal: 'g',
  meters: { iteration: 1 }, bestMetric: null, totalFindings: 0,
  directionsTried: [], recentFindings: [], recentRounds: [], inboxMessages: [],
}

async function runWith(context: SeatContext): Promise<SubAgentConfig> {
  const dir = mkdtempSync(join(tmpdir(), 'seat-wire-'))
  const paths = instancePaths(dir, 'walk-research-v1')
  const charter = freezeCharter(walkResearchCharter({
    seats: {
      worker: { context, prompt: 'WORKER_ROLE' },
      judge: { context: 'isolated', prompt: 'J', inputs: ['drafts/findings_draft.json'] },
    },
  }))
  const d = capturing()
  await runWorkerSeat({ dispatcher: d, projectDir: dir, signal: new AbortController().signal }, charter, paths, capsule)
  return d.configs[0]!
}

describe('inner_orch_worker seat wiring', () => {
  it('lineage_loop → resumes a stable session id + lineage prompt + externalPromptAssembly', async () => {
    const cfg = await runWith('lineage_loop')
    expect(cfg.externalPromptAssembly).toBe(true)
    expect(cfg.lineageSessionId).toBe('loop-walk-research-v1-worker')
    expect(cfg.systemPrompt).toContain('WORKER_ROLE')
    expect(cfg.systemPrompt).toContain('自动压缩')        // lineage continuity clause
    expect(cfg.taskDescription.startsWith('<context>')).toBe(true)
  })

  it('isolated → fresh session (no lineageSessionId) + isolated prompt', async () => {
    const cfg = await runWith('isolated')
    expect(cfg.externalPromptAssembly).toBe(true)
    expect(cfg.lineageSessionId).toBeUndefined()
    expect(cfg.systemPrompt).toContain('没有历史对话')     // isolated clause
  })
})
