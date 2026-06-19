import { describe, it, expect } from 'vitest'
import { makeSpawnSubAgentTool } from '../tools/spawn_sub_agent.js'
import type { SubAgentBridge } from '../SubAgentBridge.js'
import type { SpawnSubAgentOptions } from '../SubAgentBridge.js'
import type { SubAgentRecord } from '../types.js'

/**
 * Locks in the concurrency + write-isolation contract added to spawn_sub_agent:
 *   - the tool is concurrency-safe (multiple spawns in one turn batch in parallel)
 *   - workspace_mode defaults to shared_readonly (safe for concurrent reads)
 *   - a write task must opt into isolated_write (own git branch)
 */
function makeCapturingBridge(): { bridge: SubAgentBridge; calls: SpawnSubAgentOptions[] } {
  const calls: SpawnSubAgentOptions[] = []
  const bridge = {
    async spawnSubAgent(opts: SpawnSubAgentOptions): Promise<SubAgentRecord> {
      calls.push(opts)
      return {
        schemaVersion: '1.0',
        taskId: 'subtask-test1234',
        parentSessionId: 'sess-1',
        status: 'queued',
        config: opts.config,
        createdAt: Date.now(),
        pendingHumanApproval: false,
      } as unknown as SubAgentRecord
    },
  } as unknown as SubAgentBridge
  return { bridge, calls }
}

describe('spawn_sub_agent concurrency + isolation contract', () => {
  it('is concurrency-safe so a one-turn fan-out runs in parallel', () => {
    const { bridge } = makeCapturingBridge()
    const tool = makeSpawnSubAgentTool(bridge)
    expect(tool.isConcurrencySafe).toBe(true)
  })

  it('defaults workspace_mode to shared_readonly (no concurrent-write races)', async () => {
    const { bridge, calls } = makeCapturingBridge()
    const tool = makeSpawnSubAgentTool(bridge)
    const res = await tool.call({ task_description: 'analyse the logs' }, {} as never)
    expect(res.isError).toBeFalsy()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.config.workspaceMode).toBe('shared_readonly')
    expect(calls[0]!.config.isolateWorktree).toBe(false)
  })

  it('routes a write task through isolated_write (own branch)', async () => {
    const { bridge, calls } = makeCapturingBridge()
    const tool = makeSpawnSubAgentTool(bridge)
    await tool.call(
      { task_description: 'refactor module X', workspace_mode: 'isolated_write' },
      {} as never,
    )
    expect(calls[0]!.config.workspaceMode).toBe('isolated_write')
    expect(calls[0]!.config.isolateWorktree).toBe(true)
  })

  it('does not expose shared_write on the async tool (forces isolation for writes)', () => {
    const { bridge } = makeCapturingBridge()
    const tool = makeSpawnSubAgentTool(bridge)
    const enum_ = (tool.inputSchema as { properties: { workspace_mode: { enum: string[] } } })
      .properties.workspace_mode.enum
    expect(enum_).toEqual(['shared_readonly', 'isolated_write'])
  })
})
