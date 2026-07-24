import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ProviderCircuitBreaker,
  ProviderCircuitOpenError,
} from '../ProviderCircuitBreaker.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

describe('ProviderCircuitBreaker', () => {
  it('opens host-wide, admits exactly one half-open probe, and closes on probe success', async () => {
    const root = await mkdtemp(join(tmpdir(), 'provider-circuit-')); roots.push(root)
    let now = 1_000
    const breakerA = new ProviderCircuitBreaker({
      rootDir: root,
      now: () => now,
      transientCooldownMs: 1_000,
      blockedCooldownMs: 5_000,
    })
    const breakerB = new ProviderCircuitBreaker({
      rootDir: root,
      now: () => now,
      transientCooldownMs: 1_000,
      blockedCooldownMs: 5_000,
    })
    const first = await breakerA.beforeCall('zhipu')
    await breakerA.recordFailure(first, {
      category: 'provider_blocked',
      message: 'subscription expired',
      retryable: false,
      providerId: 'zhipu',
    })
    await expect(breakerB.beforeCall('zhipu')).rejects.toBeInstanceOf(ProviderCircuitOpenError)
    now = 6_000
    const probe = await breakerB.beforeCall('zhipu')
    expect(probe.probe).toBe(true)
    await expect(breakerA.beforeCall('zhipu')).rejects.toBeInstanceOf(ProviderCircuitOpenError)
    await breakerB.recordSuccess(probe)
    expect((await breakerA.beforeCall('zhipu')).probe).toBe(false)
  })

  it('does not let an older in-flight success erase a newer open circuit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'provider-circuit-race-')); roots.push(root)
    const breaker = new ProviderCircuitBreaker({ rootDir: root })
    const older = await breaker.beforeCall('anthropic')
    const failed = await breaker.beforeCall('anthropic')
    await breaker.recordFailure(failed, {
      category: 'provider_transient',
      message: 'status=529 overloaded',
      retryable: true,
      providerId: 'anthropic',
    })
    await breaker.recordSuccess(older)
    await expect(breaker.beforeCall('anthropic')).rejects.toBeInstanceOf(ProviderCircuitOpenError)
  })

  it('does not open the provider circuit for a local runtime failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'provider-circuit-runtime-')); roots.push(root)
    const breaker = new ProviderCircuitBreaker({ rootDir: root })
    const permit = await breaker.beforeCall('deepseek')
    await breaker.recordFailure(permit, {
      category: 'runtime_transient',
      message: 'local tool process crashed',
      retryable: true,
      providerId: 'deepseek',
    })
    expect(await breaker.snapshot()).toEqual([])
    expect((await breaker.beforeCall('deepseek')).probe).toBe(false)
  })
})
