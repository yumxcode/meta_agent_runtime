import { createHash } from 'crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ToolCallContext } from '../../core/types.js'
import { createRunAgentTool } from '../../tools/agent/run_agent/index.js'
import type { ISubAgentDispatcher } from '../ISubAgentDispatcher.js'
import type { SubAgentBridge } from '../SubAgentBridge.js'
import { makeGetSubAgentResultTool } from '../tools/get_sub_agent_result.js'
import { makeGetSubAgentStatusTool } from '../tools/get_sub_agent_status.js'
import { makeRecoverSubAgentResultTool } from '../tools/recover_sub_agent_result.js'
import type { SubAgentRecord } from '../types.js'

const dirs: string[] = []

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'subagent-result-'))
  dirs.push(dir)
  return dir
}

function record(output: unknown): SubAgentRecord {
  return {
    schemaVersion: '1.0',
    taskId: 'subtask-result1',
    parentSessionId: 'parent',
    status: 'completed',
    config: {
      taskDescription: 'write code',
      apiKey: 'must-not-leak',
      maxTurns: 10,
      maxBudgetUsd: 1,
      useEventDriven: true,
      pollIntervalMs: 1_000,
      requireHumanApproval: false,
      checkpointEveryNTurns: 3,
      workspaceMode: 'isolated_write',
    },
    createdAt: 1,
    completedAt: 2,
    pendingHumanApproval: false,
    result: {
      success: true,
      summary: 'implemented',
      output,
      integration: {
        mergeRequired: false,
        status: 'no_changes',
        changedFiles: [],
      },
      turnsUsed: 2,
      inputTokens: 3,
      outputTokens: 4,
      costUsd: 0.1,
      durationMs: 5,
    },
  }
}

function ctx(root: string): ToolCallContext {
  return {
    sessionId: 'parent',
    agentId: 'parent',
    abortSignal: new AbortController().signal,
    workspaceRoot: root,
  }
}

function bridgeFor(task: SubAgentRecord): SubAgentBridge {
  return {
    lookupStatus: async () => ({ kind: 'owned', record: task }),
    getStatus: async () => task,
  } as unknown as SubAgentBridge
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('sub-agent result delivery', () => {
  it('status exports a sanitized output-only artifact inside the caller workspace', async () => {
    const root = workspace()
    const output = { files: [{ path: 'src/a.ts', sha256: 'abc' }] }
    const task = record(output)
    const bridge = bridgeFor(task)
    const result = await makeGetSubAgentStatusTool(bridge).call({ task_id: task.taskId }, ctx(root))
    expect(result.isError).toBe(false)
    const body = JSON.parse(result.content)
    expect(body.result.merge_required).toBe(false)
    expect(body.result.output_path).toContain(join(root, '.meta-agent', 'auto', 'subagent-results'))
    const serialized = JSON.stringify(output, null, 2)
    expect(readFileSync(body.result.output_path, 'utf8')).toBe(serialized)
    expect(body.result.output_length).toBe(serialized.length)
    expect(body.result.output_sha256).toBe(
      createHash('sha256').update(serialized, 'utf8').digest('hex'),
    )
    expect(readFileSync(body.result.output_path, 'utf8')).not.toContain('must-not-leak')
    expect(body.result.output_path_scope).toBe('caller_workspace')
    expect(body.result.output_path_lifetime).toBe('workspace_lifetime')

    const inode = statSync(body.result.output_path).ino
    const repeated = await makeGetSubAgentStatusTool(bridge).call({ task_id: task.taskId }, ctx(root))
    expect(repeated.isError).toBe(false)
    expect(statSync(body.result.output_path).ino).toBe(inode)
  })

  it('pages authoritative output with stable offsets and digest', async () => {
    const output = { code: 'x'.repeat(40_000) }
    const task = record(output)
    const bridge = bridgeFor(task)
    const tool = makeGetSubAgentResultTool(bridge)
    const chunks: string[] = []
    let offset = 0
    let digest = ''
    while (true) {
      const result = await tool.call({ task_id: task.taskId, offset, limit: 10_000 }, ctx(workspace()))
      expect(result.isError).toBe(false)
      const page = JSON.parse(result.content)
      chunks.push(page.data)
      digest = page.sha256
      if (page.done) break
      offset = page.next_offset
    }
    const serialized = JSON.stringify(output, null, 2)
    expect(chunks.join('')).toBe(serialized)
    expect(digest).toBe(createHash('sha256').update(serialized, 'utf8').digest('hex'))
  })

  it('does not follow a workspace metadata symlink outside the caller workspace', async () => {
    const root = workspace()
    const outside = workspace()
    symlinkSync(outside, join(root, '.meta-agent'))
    const task = record({ secret: 'deliverable' })
    const bridge = bridgeFor(task)
    const result = await makeGetSubAgentStatusTool(bridge).call({ task_id: task.taskId }, ctx(root))
    expect(result.isError).toBe(false)
    const body = JSON.parse(result.content)
    expect(body.result.output_path).toBeUndefined()
    expect(body.result.output_export_error).toContain('outside the caller workspace')
    expect(existsSync(join(outside, 'auto', 'subagent-results'))).toBe(false)
  })

  it('distinguishes an inaccessible task without leaking its owner or raw record path', async () => {
    const bridge = {
      lookupStatus: async () => ({ kind: 'foreign' }),
    } as unknown as SubAgentBridge
    for (const tool of [makeGetSubAgentStatusTool(bridge), makeGetSubAgentResultTool(bridge)]) {
      const result = await tool.call({ task_id: 'subtask-foreign' }, ctx(workspace()))
      expect(result.isError).toBe(true)
      expect(result.content).toContain('exists but belongs to a different parent session')
      expect(result.content).not.toContain('~/.meta-agent')
      expect(result.content).not.toContain('secret-owner-session-id')
    }
  })

  it('recovers only sanitized terminal output through an explicitly sensitive tool', async () => {
    const task = record({ code: 'x'.repeat(30_000) })
    const tool = makeRecoverSubAgentResultTool(async () => task)
    expect(tool.permission).toMatchObject({
      category: 'state',
      sensitive: true,
      requiresWorkspace: false,
    })
    const result = await tool.call({ task_id: task.taskId, limit: 8_000 }, ctx(workspace()))
    expect(result.isError).toBe(false)
    const page = JSON.parse(result.content)
    expect(page.cross_session_recovery).toBe(true)
    expect(page.data.length).toBe(8_000)
    expect(result.content).not.toContain(task.parentSessionId)
    expect(result.content).not.toContain('must-not-leak')
  })

  it('refuses cross-session recovery while the historical task is still live', async () => {
    const task = { ...record({ value: 1 }), status: 'running', result: undefined } as SubAgentRecord
    const result = await makeRecoverSubAgentResultTool(async () => task)
      .call({ task_id: task.taskId }, ctx(workspace()))
    expect(result.isError).toBe(true)
    expect(result.content).toContain('terminal-only')
  })

  it('rejects path traversal before the recovery reader is invoked', async () => {
    let read = false
    const tool = makeRecoverSubAgentResultTool(async () => {
      read = true
      return record({ secret: true })
    })
    const result = await tool.call({ task_id: '../../config' }, ctx(workspace()))
    expect(result.isError).toBe(true)
    expect(result.content).toContain('invalid format')
    expect(read).toBe(false)
  })

  it('run_agent returns the same artifact metadata for synchronous tasks', async () => {
    const root = workspace()
    const output = { manifest: [{ path: 'src/a.ts' }] }
    const terminal = record(output)
    const dispatcher: ISubAgentDispatcher = {
      spawnSubAgent: async () => terminal,
      getStatus: async () => terminal,
      waitForTerminal: async () => terminal,
      cancelTask: async () => false,
    }
    const tool = await createRunAgentTool(dispatcher)
    const result = await tool.call({ task_description: 'inspect' }, ctx(root))
    expect(result.isError).toBe(false)
    const body = JSON.parse(result.content)
    expect(body.output_path).toContain(join(root, '.meta-agent', 'auto', 'subagent-results'))
    expect(JSON.parse(readFileSync(body.output_path, 'utf8'))).toEqual(output)
    expect(body.output_sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(body.output_path_lifetime).toBe('workspace_lifetime')
  })
})
