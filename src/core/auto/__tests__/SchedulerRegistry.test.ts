/**
 * SchedulerRegistry — workspace discovery and scheduler liveness.
 *
 * Two properties matter more than the rest:
 *
 *  - A stopped scheduler is MARKED, not deleted. Deleting would make a
 *    workspace vanish from the global view precisely when its scheduler went
 *    away, which is the moment you most need to see it.
 *  - Liveness is not a timestamp comparison alone. A `kill -9`ed scheduler must
 *    read as dead immediately, not after the staleness window elapses.
 */
import { describe, expect, it, afterEach } from 'vitest'
import { hostname } from 'node:os'
import {
  SchedulerRegistration,
  isSchedulerAlive,
  listKnownWorkspaces,
  listSchedulers,
  pruneAncient,
  registerKnownWorkspace,
  type SchedulerHeartbeat,
} from '../SchedulerRegistry.js'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { META_AGENT_HOME } from '../../../infra/metaAgentHome.js'

afterEach(async () => {
  await rm(join(META_AGENT_HOME, 'schedulers'), { recursive: true, force: true })
  await rm(join(META_AGENT_HOME, 'auto-workspaces'), { recursive: true, force: true })
})

const base = (over: Partial<SchedulerHeartbeat> = {}): SchedulerHeartbeat => ({
  schemaVersion: '1.0',
  workspace: '/w/proj',
  pid: process.pid,
  host: hostname(),
  startedAt: 1_000,
  lastSeen: 1_000,
  pollIntervalMs: 1_000,
  maxConcurrent: 1,
  ...over,
})

describe('liveness', () => {
  it('treats a fresh heartbeat from a live pid as alive', () => {
    expect(isSchedulerAlive(base({ lastSeen: 5_000 }), 5_500)).toBe(true)
  })

  it('treats a gracefully stopped scheduler as dead however fresh', () => {
    expect(isSchedulerAlive(base({ lastSeen: 5_000, stoppedAt: 5_000 }), 5_100)).toBe(false)
  })

  it('detects a killed process on this host immediately', () => {
    // pid 2^22 is above the default pid_max on Linux and macOS: nothing can own
    // it, so this stands in for a scheduler that was SIGKILLed a moment ago —
    // its heartbeat is still fresh, but the process is gone.
    const record = base({ pid: 4_194_303, lastSeen: 5_000 })
    expect(isSchedulerAlive(record, 5_100)).toBe(false)
  })

  it('falls back to the staleness window for another host', () => {
    const record = base({ host: 'some-other-box', pid: 4_194_303, lastSeen: 5_000 })
    expect(isSchedulerAlive(record, 5_100)).toBe(true)
    expect(isSchedulerAlive(record, 5_000 + 60_000)).toBe(false)
  })

  it('scales the window with the scheduler poll interval', () => {
    const slow = base({ host: 'other', pollIntervalMs: 60_000, lastSeen: 0 })
    expect(isSchedulerAlive(slow, 100_000)).toBe(true)
    expect(isSchedulerAlive(slow, 200_000)).toBe(false)
  })
})

describe('registration lifecycle', () => {
  it('discovers parked work before any scheduler has ever started', async () => {
    await registerKnownWorkspace('/w/parked-only', 5_000)
    expect(await listSchedulers()).toEqual([])
    expect(await listKnownWorkspaces()).toContain('/w/parked-only')
  })

  it('registers, beats, and survives a graceful stop as a workspace record', async () => {
    const registration = await SchedulerRegistration.register({
      workspace: '/w/alpha', pollIntervalMs: 1_000, maxConcurrent: 1,
    })
    expect(await listKnownWorkspaces()).toContain('/w/alpha')

    await registration.beat(Date.now())
    expect((await listSchedulers())[0]?.stoppedAt).toBeUndefined()

    await registration.markStopped()
    const after = await listSchedulers()
    expect(after[0]?.stoppedAt).toBeGreaterThan(0)
    // Still discoverable — this is the whole point.
    expect(await listKnownWorkspaces()).toContain('/w/alpha')
    expect(isSchedulerAlive(after[0]!)).toBe(false)
  })

  it('deduplicates workspaces across restarts', async () => {
    await SchedulerRegistration.register({
      workspace: '/w/beta', pollIntervalMs: 1_000, maxConcurrent: 1,
    })
    await SchedulerRegistration.register({
      workspace: '/w/beta', pollIntervalMs: 500, maxConcurrent: 2,
    })
    expect((await listKnownWorkspaces()).filter(w => w === '/w/beta')).toHaveLength(1)
  })

  it('prunes only records nobody has touched in a very long time', async () => {
    await SchedulerRegistration.register({
      workspace: '/w/gamma', pollIntervalMs: 1_000, maxConcurrent: 1,
    })
    expect(await pruneAncient(Date.now())).toBe(0)
    expect(await pruneAncient(Date.now() + 31 * 24 * 60 * 60_000)).toBe(1)
    expect(await listSchedulers()).toEqual([])
  })
})
