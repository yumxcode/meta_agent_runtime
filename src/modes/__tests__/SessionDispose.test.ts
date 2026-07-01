import { describe, expect, it } from 'vitest'
import { AgenticSession } from '../AgenticSession.js'
import { CampaignSession } from '../CampaignSession.js'
import type { KernelSession } from '../../kernel/KernelSession.js'

describe('AgenticSession + CampaignSession dispose (S1)', () => {
  it('AgenticSession.dispose forwards to KernelSession.dispose and clears tools', async () => {
    const session = new AgenticSession({ apiKey: 'test', tools: [] })
    const internal = session as unknown as {
      _engine: KernelSession
      _registeredTools: unknown[]
      _disposed: boolean
    }
    internal._registeredTools.push({ name: 'mock' })
    expect(internal._disposed).toBe(false)
    expect(internal._registeredTools.length).toBeGreaterThan(0)
    // dispose() is async (it awaits sandbox/runtime-guard teardown); the engine
    // dispose and tool-clear happen AFTER that await, so the caller must await.
    await session.dispose()
    expect(internal._disposed).toBe(true)
    expect(internal._registeredTools.length).toBe(0)
    // KernelSession.dispose() sets its own _disposed flag too
    const innerDisposed = (internal._engine as unknown as { _disposed: boolean })._disposed
    expect(innerDisposed).toBe(true)
  })

  it('AgenticSession.dispose is idempotent', async () => {
    const session = new AgenticSession({ apiKey: 'test', tools: [] })
    await session.dispose()
    await expect(session.dispose()).resolves.toBeUndefined()
  })

  it('CampaignSession.dispose is async and tears down kernel state', async () => {
    const session = new CampaignSession({ apiKey: 'test', tools: [] })
    const internal = session as unknown as {
      _engine: KernelSession
      _registeredTools: unknown[]
      _disposed: boolean
    }
    internal._registeredTools.push({ name: 'mock' })
    expect(internal._disposed).toBe(false)
    await session.dispose()
    expect(internal._disposed).toBe(true)
    expect(internal._registeredTools.length).toBe(0)
    const innerDisposed = (internal._engine as unknown as { _disposed: boolean })._disposed
    expect(innerDisposed).toBe(true)
  })
})
