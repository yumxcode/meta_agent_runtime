import { describe, expect, it } from 'vitest'
import { mkdtemp } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  HostSchedulerCoordinator,
  WorkspaceIdentityConflictError,
} from '../HostSchedulerCoordinator.js'
import { ensureWorkspaceIdentity } from '../../workspace/WorkspaceIdentity.js'
import {
  acquireRegisteredModelCall,
  registerModelCallScope,
} from '../../../infra/modelCallAdmission.js'
import { loopTaskScopeFromSessionId } from '../../../subagent/loopScope.js'

const scope = (workspaceId: string, instanceId = 'loop-v1') => ({ workspaceId, instanceId })
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

describe('HostSchedulerCoordinator', () => {
  it('rejects a duplicate live workspace identity at a second realpath', async () => {
    const state = await mkdtemp(join(tmpdir(), 'loop-host-state-'))
    const a = await mkdtemp(join(tmpdir(), 'loop-host-a-'))
    const b = await mkdtemp(join(tmpdir(), 'loop-host-b-'))
    const identity = await ensureWorkspaceIdentity(a)
    const coordinator = new HostSchedulerCoordinator({ rootDir: state })
    const first = await coordinator.acquireWorkspaceLease(identity, a)
    await expect(coordinator.acquireWorkspaceLease(identity, b))
      .rejects.toBeInstanceOf(WorkspaceIdentityConflictError)
    await first.release()
  })

  it('enforces one host graph-tick slot across coordinator instances', async () => {
    const state = await mkdtemp(join(tmpdir(), 'loop-host-capacity-'))
    const a = new HostSchedulerCoordinator({ rootDir: state, maxConcurrentGraphTicks: 1, pollMs: 10 })
    const b = new HostSchedulerCoordinator({ rootDir: state, maxConcurrentGraphTicks: 1, pollMs: 10 })
    const first = await a.acquireGraphTick(scope('ws-00000000-0000-4000-8000-000000000001'), new AbortController().signal)
    let secondGranted = false
    const secondPromise = b.acquireGraphTick(
      scope('ws-00000000-0000-4000-8000-000000000002'), new AbortController().signal,
    ).then(handle => { secondGranted = true; return handle })
    await delay(40)
    expect(secondGranted).toBe(false)
    await first.release()
    const second = await secondPromise
    expect(secondGranted).toBe(true)
    await second.release()
  })

  it('gives a waiting workspace the next slot instead of letting a busy workspace reacquire', async () => {
    const state = await mkdtemp(join(tmpdir(), 'loop-host-fair-'))
    const coordinator = new HostSchedulerCoordinator({ rootDir: state, maxConcurrentGraphTicks: 1, pollMs: 10 })
    const wsA = 'ws-00000000-0000-4000-8000-00000000000a'
    const wsB = 'ws-00000000-0000-4000-8000-00000000000b'
    const first = await coordinator.acquireGraphTick(scope(wsA, 'a1'), new AbortController().signal)
    let aGranted = false
    const nextA = coordinator.acquireGraphTick(scope(wsA, 'a2'), new AbortController().signal)
      .then(handle => { aGranted = true; return handle })
    await delay(15)
    const nextB = coordinator.acquireGraphTick(scope(wsB, 'b1'), new AbortController().signal)
    await delay(25)
    await first.release()
    const b = await nextB
    expect(aGranted).toBe(false)
    await b.release()
    const a = await nextA
    await a.release()
  })

  it('serializes exclusive resources and allows bounded shared holders', async () => {
    const state = await mkdtemp(join(tmpdir(), 'loop-host-resource-'))
    const coordinator = new HostSchedulerCoordinator({ rootDir: state, pollMs: 10 })
    const signal = new AbortController().signal
    const exclusive = await coordinator.acquireResources(scope('ws-a'), [
      { id: 'account-pool:default', mode: 'exclusive' },
    ], signal)
    let sharedGranted = false
    const sharedPromise = coordinator.acquireResources(scope('ws-b'), [
      { id: 'account-pool:default', mode: 'shared', maxConcurrent: 2 },
    ], signal).then(handle => { sharedGranted = true; return handle })
    await delay(30)
    expect(sharedGranted).toBe(false)
    await exclusive!.release()
    const shared1 = await sharedPromise
    const shared2 = await coordinator.acquireResources(scope('ws-c'), [
      { id: 'account-pool:default', mode: 'shared', maxConcurrent: 2 },
    ], signal)
    expect(shared2).not.toBeNull()
    await shared2!.release()
    await shared1!.release()
  })

  it('does not starve an older exclusive waiter with later shared requests', async () => {
    const state = await mkdtemp(join(tmpdir(), 'loop-host-writer-fair-'))
    const coordinator = new HostSchedulerCoordinator({ rootDir: state, pollMs: 10 })
    const signal = new AbortController().signal
    const firstShared = await coordinator.acquireResources(scope('ws-a'), [
      { id: 'dataset:one', mode: 'shared', maxConcurrent: 2 },
    ], signal)
    let exclusiveGranted = false
    const exclusivePromise = coordinator.acquireResources(scope('ws-b'), [
      { id: 'dataset:one', mode: 'exclusive' },
    ], signal).then(handle => { exclusiveGranted = true; return handle })
    await delay(20)
    let laterSharedGranted = false
    const laterSharedPromise = coordinator.acquireResources(scope('ws-c'), [
      { id: 'dataset:one', mode: 'shared', maxConcurrent: 2 },
    ], signal).then(handle => { laterSharedGranted = true; return handle })
    await delay(30)
    expect(laterSharedGranted).toBe(false)
    await firstShared!.release()
    const exclusive = await exclusivePromise
    expect(exclusiveGranted).toBe(true)
    expect(laterSharedGranted).toBe(false)
    await exclusive!.release()
    const laterShared = await laterSharedPromise
    await laterShared!.release()
  })

  it('admits actual scoped model calls and propagates the scope to descendants', async () => {
    const state = await mkdtemp(join(tmpdir(), 'loop-host-model-'))
    const sessionA = 'loop:ws-00000000-0000-4000-8000-00000000000a:loop-v1:seat:a'
    const sessionB = 'loop:ws-00000000-0000-4000-8000-00000000000b:loop-v1:seat:b'
    const common = { coordinatorRoot: state, maxConcurrentModelCalls: 1 }
    const unregA = registerModelCallScope(sessionA, {
      workspaceId: 'ws-00000000-0000-4000-8000-00000000000a', instanceId: 'loop-v1', ...common,
    })
    const unregB = registerModelCallScope(sessionB, {
      workspaceId: 'ws-00000000-0000-4000-8000-00000000000b', instanceId: 'loop-v1', ...common,
    })
    const signal = new AbortController().signal
    const first = await acquireRegisteredModelCall(sessionA, signal)
    let secondGranted = false
    const secondPromise = acquireRegisteredModelCall(sessionB, signal)
      .then(handle => { secondGranted = true; return handle })
    await delay(30)
    expect(secondGranted).toBe(false)
    expect(loopTaskScopeFromSessionId(sessionA)).toMatchObject({
      workspaceId: 'ws-00000000-0000-4000-8000-00000000000a',
      loopInstanceId: 'loop-v1', hostCoordinatorRoot: state,
    })
    await first!.release()
    const second = await secondPromise
    expect(secondGranted).toBe(true)
    await second!.release()
    unregA()
    unregB()
  })

  it('recovers a crashed holder by TTL without letting its stale token delete the new lease', async () => {
    const state = await mkdtemp(join(tmpdir(), 'loop-host-stale-'))
    const coordinator = new HostSchedulerCoordinator({
      rootDir: state, maxConcurrentGraphTicks: 1, leaseTtlMs: 1_000, pollMs: 10,
    })
    const first = await coordinator.acquireGraphTick(scope('ws-stale-a'), new AbortController().signal)
    const second = await coordinator.acquireGraphTick(scope('ws-stale-b'), new AbortController().signal)
    expect(second.lease.token).not.toBe(first.lease.token)
    await first.release() // stale release must be a no-op
    expect((await coordinator.snapshot()).leases.some(lease => lease.token === second.lease.token)).toBe(true)
    await second.release()
  }, 5_000)

  it('bounds 200 graph-tick grants across 50 workspaces without starvation', async () => {
    const state = await mkdtemp(join(tmpdir(), 'loop-host-stress-'))
    const coordinator = new HostSchedulerCoordinator({ rootDir: state, maxConcurrentGraphTicks: 8, pollMs: 10 })
    let active = 0
    let maxActive = 0
    const seen = new Set<string>()
    await Promise.all(Array.from({ length: 200 }, async (_, index) => {
      const workspaceId = `ws-${String(index % 50).padStart(8, '0')}-0000-4000-8000-000000000000`
      const handle = await coordinator.acquireGraphTick(scope(workspaceId, `loop-${index}`), new AbortController().signal)
      active++
      maxActive = Math.max(maxActive, active)
      seen.add(workspaceId)
      await delay(1)
      active--
      await handle.release()
    }))
    expect(maxActive).toBeLessThanOrEqual(8)
    expect(seen.size).toBe(50)
    const snapshot = await coordinator.snapshot()
    expect(snapshot.tickets).toHaveLength(0)
    expect(snapshot.leases).toHaveLength(0)
  }, 30_000)
})
