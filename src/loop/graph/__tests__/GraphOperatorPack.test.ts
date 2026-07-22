import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { runLoopCli } from '../../cli.js'
import type { LoopGraphSpec } from '../index.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

describe('graph Operator Pack', () => {
  it('adds versioned JSON views and pending event inspection without changing default output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'graph-operator-pack-')); roots.push(root)
    const graph: LoopGraphSpec = {
      schemaVersion: 'graph-2.0', id: 'operator_pack', version: 1, goal: 'Wait for one operator event.',
      state: {}, lanes: {},
      nodes: {
        wait: { type: 'wait', wait: { kind: 'event', event: 'operator.ready', timeoutMs: 60_000 } },
        done: { type: 'terminal', status: 'done' },
        failed: { type: 'terminal', status: 'failed' },
      },
      transitions: [
        { id: 'event_done', from: 'wait', on: 'event', to: 'done' },
        { id: 'timeout_failed', from: 'wait', on: 'timeout', to: 'failed' },
        { id: 'wait_failed', from: 'wait', on: 'failure', to: 'failed' },
      ],
      entrypoints: [{ id: 'start', node: 'wait' }],
      limits: { maxTotalActivations: 3, maxLiveActivations: 2, maxWallTimeMs: 120_000 },
      concurrency: { maxActivations: 1, maxPerNode: 1, stateConsistency: 'commit_latest' },
    }
    await writeFile(join(root, 'loop.json'), JSON.stringify(graph), 'utf8')
    await runLoopCli(['create', 'loop.json', '--id', 'operator-pack'], { projectDir: root })

    const humanList = await runLoopCli(['list'], { projectDir: root })
    expect(humanList).toContain('engine=durable-graph-v2')
    const list = JSON.parse(await runLoopCli(['list', '--json'], { projectDir: root }))
    expect(list.schemaVersion).toBe('loop-list-1.0')
    expect(list.instances[0].instanceId).toBe('operator-pack')

    const inspect = JSON.parse(await runLoopCli(['inspect', 'operator-pack', '--json'], { projectDir: root }))
    expect(inspect.schemaVersion).toBe('loop-inspect-1.0')
    expect(inspect.reliability.schemaVersion).toBe('loop-reliability-profile-1.0')
    expect(inspect.reliability.ingress.status).toBe('unknown')
    expect(Array.isArray(inspect.diagnostics)).toBe(true)

    await runLoopCli([
      'event', 'operator-pack', 'unmatched.event', '--source', 'test', '--delivery-id', 'delivery-1',
      '--payload', '{"ready":true}',
    ], { projectDir: root })
    const events = JSON.parse(await runLoopCli(['events', 'operator-pack', '--status', 'pending', '--json'], { projectDir: root }))
    expect(events.schemaVersion).toBe('loop-events-1.0')
    expect(events.events).toHaveLength(1)
    expect(events.events[0]).toMatchObject({ status: 'pending', source: 'test', deliveryId: 'delivery-1' })

    const timeline = JSON.parse(await runLoopCli(['timeline', 'operator-pack', '--json'], { projectDir: root }))
    expect(timeline.schemaVersion).toBe('loop-timeline-1.0')
    expect(timeline.events.some((item: { event: { type: string } }) => item.event.type === 'external_event_recorded')).toBe(true)

    const disk = JSON.parse(await runLoopCli(['disk', 'operator-pack', '--json'], { projectDir: root }))
    expect(disk.schemaVersion).toBe('loop-disk-1.0')
    expect(disk.metrics.looseJournalFiles).toBeGreaterThan(0)
    expect(disk.metrics.eventFiles).toBe(1)
  })
})
