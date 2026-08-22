import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionStore } from '../../core/SessionStore.js'
import type { ConversationMessage } from '../../core/types.js'
import { clearTrajectoryHubForTests } from '../hub.js'
import {
  listTrajectoryIndex,
  rebuildTrajectoryIndex,
  reserveTrajectoryIndex,
  searchTrajectoryIndex,
} from '../indexStore.js'
import {
  trajectoryDir,
  trajectoryFile,
  trajectoryIndexFile,
  trajectoryLeaseFile,
} from '../paths.js'
import {
  projectModelContext,
  readModelContextFromTrajectory,
  readTrajectoryPage,
  readTrajectoryPreservingUnknown,
  readTrajectory,
  repairAndVerifyTrajectory,
} from '../reader.js'
import {
  TrajectoryItemTooLargeError,
  TrajectoryRecorder,
  TrajectoryWriterLeaseError,
} from '../recorder.js'
import { TRAJECTORY_LINE_SCHEMA_VERSION } from '../types.js'
import { TrajectoryTelemetryProjector } from '../projector.js'
import { projectHistoricalTrajectoryTelemetry } from '../telemetryStore.js'
import { projectTrajectoryResumeParity } from '../parityStore.js'
import { readTrajectoryHealth } from '../health.js'

const descriptor = (sessionId = 'session-1') => ({
  subject: { kind: 'session' as const, sessionId },
  mode: 'agentic',
  workspace: '/workspace',
})

afterEach(() => clearTrajectoryHubForTests())

describe('TrajectoryRecorder', () => {
  it('writes a strictly ordered, schema-valid append-only trajectory', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'trajectory-recorder-'))
    const recorder = await TrajectoryRecorder.open(descriptor(), { rootDir })
    const runId = crypto.randomUUID()
    await Promise.all([
      recorder.record({ type: 'run_started', reason: 'submit' }, { runId }),
      recorder.record({
        type: 'message',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'hello' },
            { type: 'thinking', thinking: 'private' },
          ],
        },
      }, { runId }),
      recorder.record({
        type: 'run_result',
        outcome: 'success',
        isError: false,
        costUsd: 0.01,
      }, { runId }),
    ])
    await recorder.barrier('run_result')
    await recorder.close()

    const lines = await readTrajectory(recorder.path)
    expect(lines.map(line => line.ordinal)).toEqual([1, 2, 3, 4])
    expect(lines[0]?.item.type).toBe('trajectory_meta')
    expect(JSON.stringify(lines)).not.toContain('private')
    expect((await repairAndVerifyTrajectory(recorder.path)).valid).toBe(true)
  })

  it('removes thinking blocks from compaction replacement history without null holes', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'trajectory-privacy-'))
    const recorder = await TrajectoryRecorder.open(descriptor('privacy-session'), { rootDir })
    await recorder.record({
      type: 'compaction',
      previousTokens: 100,
      summaryTokens: 10,
      replacementHistory: [{
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'secret' },
          { type: 'text', text: 'visible' },
        ],
      }],
    })
    await recorder.close()
    const lines = await readTrajectory(recorder.path)
    const item = lines.find(line => line.item.type === 'compaction')?.item
    expect(item?.type).toBe('compaction')
    if (item?.type !== 'compaction') throw new Error('missing compaction')
    expect(item.replacementHistory[0]?.['content']).toEqual([{ type: 'text', text: 'visible' }])
    expect(JSON.stringify(item)).not.toContain('null')
    expect(JSON.stringify(item)).not.toContain('secret')
  })

  it('rejects a single item larger than the bounded queue instead of waiting forever', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'trajectory-oversize-'))
    const recorder = await TrajectoryRecorder.open(descriptor('oversize-session'), {
      rootDir,
      maxPendingBytes: 1024,
    })
    await expect(recorder.record({
      type: 'message',
      message: { role: 'user', content: Array.from({ length: 100 }, (_, i) => ({ text: `block-${i}` })) },
    })).rejects.toBeInstanceOf(TrajectoryItemTooLargeError)
    await recorder.close()
    expect(await readTrajectoryHealth(recorder.trajectoryId, { rootDir })).toMatchObject({
      canonicalDegraded: true,
      projectionDegraded: false,
    })
    const reopened = await TrajectoryRecorder.open(descriptor('oversize-session'), {
      rootDir,
      trajectoryId: recorder.trajectoryId,
      maxPendingBytes: 1024,
    })
    await reopened.close()
    expect((await readTrajectoryHealth(recorder.trajectoryId, { rootDir })).canonicalDegraded)
      .toBe(true)
  })

  it('rejects a second live writer for the same trajectory', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'trajectory-lease-'))
    const trajectoryId = crypto.randomUUID()
    const first = await TrajectoryRecorder.open(descriptor(), { rootDir, trajectoryId })
    await expect(TrajectoryRecorder.open(descriptor(), { rootDir, trajectoryId }))
      .rejects.toBeInstanceOf(TrajectoryWriterLeaseError)
    await first.close()
  })

  it('reclaims a stale heartbeat even when its pid has been reused by a live process', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'trajectory-stale-lease-'))
    const trajectoryId = crypto.randomUUID()
    await mkdir(trajectoryDir(trajectoryId, { rootDir }), { recursive: true })
    await writeFile(trajectoryLeaseFile(trajectoryId, { rootDir }), JSON.stringify({
      token: crypto.randomUUID(), pid: process.pid, acquiredAt: Date.now() - 60 * 60_000,
    }))
    const recorder = await TrajectoryRecorder.open(descriptor('stale-lease-session'), {
      rootDir,
      trajectoryId,
      now: () => Date.now() + 31 * 60_000,
    })
    await recorder.close()
    expect((await repairAndVerifyTrajectory(recorder.path)).valid).toBe(true)
  })

  it('repairs only a torn final line and fails closed on middle corruption', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'trajectory-repair-'))
    const recorder = await TrajectoryRecorder.open(descriptor(), { rootDir })
    await recorder.record({ type: 'run_started', reason: 'submit' })
    await recorder.close()

    await writeFile(recorder.path, `${await readFile(recorder.path, 'utf8')}{"broken":`, 'utf8')
    const repaired = await repairAndVerifyTrajectory(recorder.path)
    expect(repaired.valid).toBe(true)
    expect(repaired.repairedTailBytes).toBeGreaterThan(0)

    const intact = await readFile(recorder.path, 'utf8')
    const lines = intact.trimEnd().split('\n')
    await writeFile(recorder.path, `${lines[0]}\nnot-json\n${lines[1]}\n`, 'utf8')
    const corrupt = await repairAndVerifyTrajectory(recorder.path)
    expect(corrupt.valid).toBe(false)
    expect(corrupt.errors.join(' ')).toContain('invalid JSON')
  })

  it('repairs a complete final line missing only its newline without adding NUL bytes', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'trajectory-newline-'))
    const recorder = await TrajectoryRecorder.open(descriptor(), { rootDir })
    await recorder.record({ type: 'message', message: { role: 'user', content: 'hello' } })
    await recorder.close()
    const withoutNewline = (await readFile(recorder.path, 'utf8')).trimEnd()
    await writeFile(recorder.path, withoutNewline, 'utf8')

    expect((await repairAndVerifyTrajectory(recorder.path)).valid).toBe(true)
    const repaired = await readFile(recorder.path, 'utf8')
    expect(repaired.endsWith('\n')).toBe(true)
    expect(repaired).not.toContain('\0')
    await expect(readTrajectory(recorder.path)).resolves.toHaveLength(2)
  })

  it('rebuilds the disposable metadata index from canonical JSONL', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'trajectory-index-'))
    const recorder = await TrajectoryRecorder.open(descriptor('index-session'), { rootDir })
    await recorder.record({
      type: 'message',
      message: { role: 'user', content: [{ type: 'text', text: 'fix the controller' }] },
    })
    await recorder.record({
      type: 'tool_outcome',
      toolUseId: 'tool-1',
      toolName: 'bash',
      durationMs: 5,
      isError: false,
      outputSummary: 'ok',
      outputHash: 'hash',
    })
    await recorder.close()

    const result = await rebuildTrajectoryIndex({ rootDir })
    expect(result).toEqual({ indexed: 1, failed: [] })
    expect(await readFile(trajectoryFile(recorder.trajectoryId, { rootDir }), 'utf8')).toContain('fix the controller')
  })

  it('reconstructs the same model context from a safe reverse compaction boundary', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'trajectory-context-'))
    const recorder = await TrajectoryRecorder.open(descriptor('context-session'), { rootDir })
    const runId = crypto.randomUUID()
    await recorder.record({ type: 'run_started', reason: 'submit' }, { runId })
    await recorder.record({
      type: 'turn_context',
      model: 'test-model',
      provider: 'test',
      tools: [],
    }, { runId })
    await recorder.record({
      type: 'message',
      message: { role: 'user', content: [{ type: 'text', text: 'old prompt' }] },
    }, { runId })
    await recorder.record({
      type: 'compaction',
      previousTokens: 10_000,
      summaryTokens: 200,
      replacementHistory: [{ role: 'user', content: [{ type: 'text', text: 'summary' }] }],
    }, { runId })
    await recorder.record({
      type: 'message',
      message: { role: 'assistant', content: [{ type: 'text', text: 'continued' }] },
    }, { runId })
    await recorder.record({ type: 'run_result', outcome: 'success', isError: false }, { runId })
    await recorder.close()

    const lines = await readTrajectory(recorder.path)
    const full = projectModelContext(lines)
    const reverse = await readModelContextFromTrajectory(recorder.path)
    expect(reverse.usedCompaction).toBe(true)
    expect(reverse.scannedFromOrdinal).toBe(5)
    expect(reverse.messages).toEqual(full.messages)
    expect(reverse.lastTurnContext).toEqual(full.lastTurnContext)
  })

  it('falls back to a full verified replay when the newest run is incomplete', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'trajectory-context-inflight-'))
    const recorder = await TrajectoryRecorder.open(descriptor('context-inflight-session'), { rootDir })
    const completedRun = crypto.randomUUID()
    await recorder.record({ type: 'run_started', reason: 'submit' }, { runId: completedRun })
    await recorder.record({
      type: 'turn_context', model: 'test-model', provider: 'test', tools: [],
    }, { runId: completedRun })
    await recorder.record({
      type: 'compaction', previousTokens: 100, summaryTokens: 10,
      replacementHistory: [{ role: 'user', content: 'summary' }],
    }, { runId: completedRun })
    await recorder.record({ type: 'run_result', outcome: 'success', isError: false }, { runId: completedRun })
    const incompleteRun = crypto.randomUUID()
    await recorder.record({ type: 'run_started', reason: 'submit' }, { runId: incompleteRun })
    await recorder.record({ type: 'message', message: { role: 'user', content: 'in flight' } }, { runId: incompleteRun })
    await recorder.close()

    const projected = await readModelContextFromTrajectory(recorder.path)
    expect(projected.usedCompaction).toBe(false)
    expect(projected.scannedFromOrdinal).toBe(1)
    expect(projected.messages.at(-1)).toMatchObject({ content: 'in flight' })
  })

  it('pages forward immediately after an ordinal without silently skipping the middle', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'trajectory-page-'))
    const recorder = await TrajectoryRecorder.open(descriptor('page-session'), { rootDir })
    for (let i = 1; i <= 50; i++) {
      await recorder.record({ type: 'message', message: { role: 'user', content: `message-${i}` } })
    }
    await recorder.close()
    const page = await readTrajectoryPage(recorder.path, { afterOrdinal: 1, limit: 10 })
    expect(page.lines.map(line => line.ordinal)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
    expect(page.nextOrdinal).toBe(11)
    expect(page.hasMore).toBe(true)
  })

  it('preserves unknown future items for audit while excluding them from strict recovery', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'trajectory-unknown-'))
    const recorder = await TrajectoryRecorder.open(descriptor('unknown-session'), { rootDir })
    const trajectoryId = recorder.trajectoryId
    await recorder.close()
    const future = JSON.stringify({
      schemaVersion: TRAJECTORY_LINE_SCHEMA_VERSION,
      ts: Date.now(),
      ordinal: 2,
      trajectoryId,
      item: { type: 'future_major_item', payload: { preserved: true } },
    })
    await writeFile(recorder.path, `${await readFile(recorder.path, 'utf8')}${future}\n`, 'utf8')
    const audit = await readTrajectoryPreservingUnknown(recorder.path)
    expect(audit[1]).toMatchObject({ ordinal: 2, knownItem: false, item: { type: 'future_major_item' } })
    expect(audit[1]?.rawLine).toBe(future)
    await expect(readTrajectory(recorder.path)).rejects.toThrow('unknown trajectory item')
    const page = await readTrajectoryPage(recorder.path, { afterOrdinal: 1, limit: 10 })
    expect(page.lines[0]).toMatchObject({ ordinal: 2, knownItem: false })
    expect((await repairAndVerifyTrajectory(recorder.path)).valid).toBe(true)
  })

  it('atomically reserves one trajectory id per subject and searches metadata', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'trajectory-reserve-'))
    const makeCandidate = (trajectoryId: string) => ({
      trajectoryId,
      subject: { kind: 'session' as const, sessionId: 'reserved-session' },
      mode: 'agentic',
      createdAt: Date.now(),
      lastActivity: Date.now(),
      lastOrdinal: 0,
      toolCalls: 0,
      toolErrors: 0,
      runs: 0,
      totalCostUsd: 0,
      title: 'Controller verification',
    })
    const [first, second] = await Promise.all([
      reserveTrajectoryIndex(makeCandidate(crypto.randomUUID()), { rootDir }),
      reserveTrajectoryIndex(makeCandidate(crypto.randomUUID()), { rootDir }),
    ])
    expect(second.trajectoryId).toBe(first.trajectoryId)
    expect(await searchTrajectoryIndex('controller', { rootDir })).toHaveLength(1)
  })

  it('keeps historical trajectories for the same subject stable across reindex', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'trajectory-subject-history-'))
    const first = await TrajectoryRecorder.open(descriptor('reused-subject'), {
      rootDir,
      trajectoryId: crypto.randomUUID(),
    })
    await first.close()
    const second = await TrajectoryRecorder.open(descriptor('reused-subject'), {
      rootDir,
      trajectoryId: crypto.randomUUID(),
    })
    await second.close()
    expect(await listTrajectoryIndex({ rootDir })).toHaveLength(2)
    await rebuildTrajectoryIndex({ rootDir })
    expect(await listTrajectoryIndex({ rootDir })).toHaveLength(2)
  })

  it('projects cross-mode historical telemetry from durable items', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'trajectory-telemetry-'))
    const recorder = await TrajectoryRecorder.open(descriptor('telemetry-session'), { rootDir })
    const runId = crypto.randomUUID()
    await recorder.record({ type: 'run_started', reason: 'submit' }, { runId })
    await recorder.record({
      type: 'tool_outcome', toolUseId: 't1', toolName: 'bash', durationMs: 2,
      isError: true, outputSummary: 'failed', outputHash: 'hash', exitCode: 1,
    }, { runId })
    await recorder.record({ type: 'subagent', action: 'spawned', taskId: 'task-1' }, { runId })
    await recorder.record({ type: 'run_result', outcome: 'failed', isError: true, costUsd: 0.25 }, { runId })
    await recorder.close()
    const projector = new TrajectoryTelemetryProjector()
    for (const line of await readTrajectory(recorder.path)) projector.observe(line)
    expect(projector.snapshot()).toMatchObject({
      trajectories: 1,
      runs: 1,
      failedRuns: 1,
      toolCalls: 1,
      toolErrors: 1,
      subagents: 1,
      totalCostUsd: 0.25,
    })
  })

  it('operationally projects historical telemetry with an atomic ordinal cursor', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'trajectory-telemetry-store-'))
    const recorder = await TrajectoryRecorder.open(descriptor('telemetry-store-session'), { rootDir })
    const runId = crypto.randomUUID()
    await recorder.record({ type: 'run_started', reason: 'submit' }, { runId })
    await recorder.barrier('first-telemetry-page')

    const first = await projectHistoricalTrajectoryTelemetry({ rootDir })
    expect(first.summary).toMatchObject({ trajectories: 1, runs: 1 })
    expect(first.processedLines).toBe(2)
    const unchanged = await projectHistoricalTrajectoryTelemetry({ rootDir })
    expect(unchanged.processedLines).toBe(0)

    await recorder.record({ type: 'run_result', outcome: 'success', isError: false }, { runId })
    await recorder.barrier('second-telemetry-page')
    const second = await projectHistoricalTrajectoryTelemetry({ rootDir })
    expect(second.processedLines).toBe(1)
    expect(second.summary.successfulRuns).toBe(1)
    await recorder.close()
  })

  it('persists dual-read resume parity evidence without exposing message content', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'trajectory-parity-'))
    const sessionId = 'parity-session'
    const messages: ConversationMessage[] = [
      { role: 'user' as const, content: 'inspect the controller' },
      { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'inspection complete' }] },
      {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'private reasoning', signature: 'test-signature' }],
      },
    ]
    await SessionStore.replace(sessionId, {
      mode: 'agentic', startTime: 1, lastActivity: 2,
      messageCount: 2, firstPrompt: 'inspect the controller',
    }, messages, { rootDir: join(rootDir, 'sessions') })
    const recorder = await TrajectoryRecorder.open(descriptor(sessionId), { rootDir })
    for (const message of messages) {
      await recorder.record({ type: 'message', message })
    }
    await recorder.close()

    const matching = await projectTrajectoryResumeParity({ rootDir })
    expect(matching).toMatchObject({ comparable: 1, matches: 1, technicallyReady: true })
    expect(matching.observations[0]).toMatchObject({
      status: 'match', trajectoryMessageCount: 2, legacyMessageCount: 2,
    })
    expect(JSON.stringify(matching)).not.toContain('inspect the controller')

    await SessionStore.replace(sessionId, {
      mode: 'agentic', startTime: 1, lastActivity: 3,
      messageCount: 1, firstPrompt: 'diverged',
    }, [{ role: 'user', content: 'diverged' }], { rootDir: join(rootDir, 'sessions') })
    const mismatching = await projectTrajectoryResumeParity({ rootDir })
    expect(mismatching).toMatchObject({
      comparable: 1, matches: 0, mismatches: 1, technicallyReady: false,
    })
    expect(mismatching.evidence[sessionId]).toMatchObject({
      lastStatus: 'mismatch', matchingCheckpoints: 0,
    })
  })

  it('keeps 1000-entry metadata search P95 below 100ms without SQLite', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'trajectory-search-perf-'))
    const file = trajectoryIndexFile({ rootDir })
    await mkdir(join(rootDir, 'index'), { recursive: true })
    const entries = Array.from({ length: 1_000 }, (_, index) => ({
      trajectoryId: crypto.randomUUID(),
      subject: { kind: 'session' as const, sessionId: `session-${index}` },
      mode: index % 2 ? 'agentic' : 'robotics',
      createdAt: index,
      lastActivity: index,
      lastOrdinal: 1,
      workspace: `/workspace/${index % 10}`,
      title: index === 777 ? 'needle controller' : `session ${index}`,
      toolCalls: 0,
      toolErrors: 0,
      runs: 1,
      totalCostUsd: 0,
    }))
    await writeFile(file, JSON.stringify({ schemaVersion: 'trajectory-index-1.0', entries }))
    await searchTrajectoryIndex('needle', { rootDir })
    const samples: number[] = []
    for (let i = 0; i < 20; i++) {
      const started = performance.now()
      expect(await searchTrajectoryIndex('needle', { rootDir })).toHaveLength(1)
      samples.push(performance.now() - started)
    }
    samples.sort((a, b) => a - b)
    expect(samples[Math.ceil(samples.length * 0.95) - 1]).toBeLessThan(100)
  })
})
