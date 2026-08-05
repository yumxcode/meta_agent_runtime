/**
 * ToolRuntimeGuards — the per-session injection point for the OS sandbox.
 *
 * This is where auto/simple_auto's "fail closed" actually happens: lockWorkspace
 * forces allowUnsandboxedFallback:false, and a host with no backend must error
 * rather than quietly run the agent unjailed.
 *
 * It is also where a handle-creation race lived: the cache stored the RESOLVED
 * handle, so two concurrent tool calls both missed, both created a handle, and
 * the second overwrote the first — leaving the first unreachable from dispose()
 * and therefore never destroyed. Handles are stateless today, so nothing leaked
 * in practice, but it was a trap primed for the first stateful backend.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { SandboxConfig, SandboxExecSpec, SandboxHandle } from '../../sandbox/types.js'
import type { MetaAgentTool, ToolCallContext } from '../../core/types.js'

const state = vi.hoisted(() => ({
  created: 0,
  destroyed: 0,
  platform: 'linux' as 'linux' | 'macos' | 'noop',
  createDelayMs: 0,
  failNextCreate: false,
  lastConfig: null as SandboxConfig | null,
}))

vi.mock('../../sandbox/index.js', () => ({
  createSandboxExecutor: () => ({
    platform: state.platform,
    isAvailable: () => state.platform !== 'noop',
    async create(config: SandboxConfig): Promise<SandboxHandle> {
      state.lastConfig = config
      if (state.createDelayMs) await new Promise(r => setTimeout(r, state.createDelayMs))
      if (state.failNextCreate) {
        state.failNextCreate = false
        throw new Error('backend unavailable right now')
      }
      state.created++
      const id = state.created
      return {
        description: `mock-handle-${id}`,
        wrapExec: (command: string): SandboxExecSpec => ({ file: 'mock', args: [command] }),
        async destroy(): Promise<void> { state.destroyed++ },
      }
    },
  }),
}))

import { ToolRuntimeGuards } from '../toolRuntimeGuards.js'

function sandboxedTool(name = 'bash'): MetaAgentTool {
  return {
    name,
    description: name,
    inputSchema: { type: 'object', properties: {} },
    permission: { category: 'execute', sandbox: true },
    call: async (_input, ctx: ToolCallContext) => ({
      content: ctx.sandboxHandle?.description ?? 'NO-HANDLE',
    }),
  } as unknown as MetaAgentTool
}

function plainTool(): MetaAgentTool {
  return {
    name: 'read_file',
    description: 'read',
    inputSchema: { type: 'object', properties: {} },
    permission: { category: 'read' },
    call: async () => ({ content: 'ok' }),
  } as unknown as MetaAgentTool
}

const ctx = {} as ToolCallContext

beforeEach(() => {
  state.created = 0
  state.destroyed = 0
  state.platform = 'linux'
  state.createDelayMs = 0
  state.failNextCreate = false
  state.lastConfig = null
})

afterEach(() => vi.clearAllMocks())

describe('sandbox handle lifecycle', () => {
  it('injects a handle into a sandbox-declaring tool', async () => {
    const guards = new ToolRuntimeGuards({ projectDir: '/ws' })
    const wrapped = guards.wrapTool(sandboxedTool())
    expect((await wrapped.call({}, ctx)).content).toBe('mock-handle-1')
    await guards.dispose()
  })

  it('leaves a tool with no sandbox declaration untouched', async () => {
    const guards = new ToolRuntimeGuards({ projectDir: '/ws' })
    const tool = plainTool()
    // No autonomy → no write mutex either, so wrapTool should return the SAME object.
    expect(guards.wrapTool(tool)).toBe(tool)
    expect(state.created).toBe(0)
  })

  it('reuses one handle across repeated sequential calls', async () => {
    const guards = new ToolRuntimeGuards({ projectDir: '/ws' })
    const wrapped = guards.wrapTool(sandboxedTool())
    await wrapped.call({}, ctx)
    await wrapped.call({}, ctx)
    await wrapped.call({}, ctx)
    expect(state.created).toBe(1)
    await guards.dispose()
  })

  it('REGRESSION: concurrent first calls create exactly ONE handle', async () => {
    // The race: with a resolved-handle cache, both callers miss during the
    // `await create()` window and the loser's handle becomes unreachable from
    // dispose(). Caching the in-flight promise makes the second caller join.
    state.createDelayMs = 25
    const guards = new ToolRuntimeGuards({ projectDir: '/ws' })
    const wrapped = guards.wrapTool(sandboxedTool())

    const results = await Promise.all([
      wrapped.call({}, ctx), wrapped.call({}, ctx),
      wrapped.call({}, ctx), wrapped.call({}, ctx),
    ])

    expect(state.created).toBe(1)
    expect(results.map(r => r.content)).toEqual(Array(4).fill('mock-handle-1'))
    await guards.dispose()
    // And the single handle is actually torn down — nothing orphaned.
    expect(state.destroyed).toBe(1)
  })

  it('REGRESSION: every created handle is destroyed by dispose()', async () => {
    state.createDelayMs = 15
    const guards = new ToolRuntimeGuards({ projectDir: '/ws' })
    const wrapped = guards.wrapTool(sandboxedTool())
    await Promise.all([wrapped.call({}, ctx), wrapped.call({}, ctx)])
    await guards.dispose()
    expect(state.destroyed).toBe(state.created)
  })

  it('dispose() awaits a creation that is still in flight', async () => {
    state.createDelayMs = 40
    const guards = new ToolRuntimeGuards({ projectDir: '/ws' })
    const wrapped = guards.wrapTool(sandboxedTool())
    const inFlight = wrapped.call({}, ctx)
    await guards.dispose()          // races the creation
    await inFlight
    // Whatever got created must have been destroyed, not left dangling.
    expect(state.destroyed).toBe(state.created)
  })

  it('a failed creation is not cached — the next call retries', async () => {
    state.failNextCreate = true
    const guards = new ToolRuntimeGuards({ projectDir: '/ws' })
    const wrapped = guards.wrapTool(sandboxedTool())

    await expect(wrapped.call({}, ctx)).rejects.toThrow(/backend unavailable/)
    // A cached rejection would poison the session for good.
    expect((await wrapped.call({}, ctx)).content).toBe('mock-handle-1')
    await guards.dispose()
  })
})

describe('autonomy jail wiring', () => {
  it('lockWorkspace forces allowUnsandboxedFallback:false', async () => {
    const guards = new ToolRuntimeGuards({
      projectDir: '/ws',
      autonomy: { lockWorkspace: true, autoApproveInWorkspace: true },
    })
    await guards.wrapTool(sandboxedTool()).call({}, ctx)
    expect(state.lastConfig?.allowUnsandboxedFallback).toBe(false)
    await guards.dispose()
  })

  it('FAILS CLOSED: lockWorkspace + no backend → the tool call errors', async () => {
    state.platform = 'noop'
    const guards = new ToolRuntimeGuards({
      projectDir: '/ws',
      autonomy: { lockWorkspace: true, autoApproveInWorkspace: true },
    })
    await expect(guards.wrapTool(sandboxedTool()).call({}, ctx))
      .rejects.toThrow(/no supported sandbox backend/)
  })

  it('without lockWorkspace, a missing backend degrades instead of failing', async () => {
    state.platform = 'noop'
    const guards = new ToolRuntimeGuards({ projectDir: '/ws' })
    // bash's DEFAULT_MAIN_SANDBOX sets allowUnsandboxedFallback:true; emulate it.
    const tool = {
      ...sandboxedTool(),
      permission: { category: 'execute', sandbox: { allowUnsandboxedFallback: true } },
    } as unknown as MetaAgentTool
    expect((await guards.wrapTool(tool).call({}, ctx)).content).toBe('mock-handle-1')
    await guards.dispose()
  })

  it('injects the write mutex only for autonomous sessions', async () => {
    let sawMutex: unknown
    const probe = {
      name: 'write_file',
      description: 'w',
      inputSchema: { type: 'object', properties: {} },
      permission: { category: 'write' },
      call: async (_i: unknown, c: ToolCallContext) => { sawMutex = c.writeMutex; return { content: 'ok' } },
    } as unknown as MetaAgentTool

    const plain = new ToolRuntimeGuards({ projectDir: '/ws' })
    expect(plain.wrapTool(probe)).toBe(probe)            // untouched entirely

    const auto = new ToolRuntimeGuards({
      projectDir: '/ws',
      autonomy: { lockWorkspace: true, autoApproveInWorkspace: true },
    })
    await auto.wrapTool(probe).call({}, ctx)
    expect(sawMutex).toBeDefined()
    await auto.dispose()
  })
})

describe('extraWriteAllowPaths merging', () => {
  it('merges operator-configured paths into the policy', async () => {
    const guards = new ToolRuntimeGuards({
      projectDir: '/ws',
      extraWriteAllowPaths: ['/data/shared'],
    })
    await guards.wrapTool(sandboxedTool()).call({}, ctx)
    expect(state.lastConfig?.writeAllowPaths).toContain('/data/shared')
    await guards.dispose()
  })

  it('policies differing only by merged paths get SEPARATE handles', async () => {
    // The cache key is the fully-resolved config, so a different writable set
    // must not silently reuse a handle built for a narrower one.
    const guards = new ToolRuntimeGuards({ projectDir: '/ws', extraWriteAllowPaths: ['/data/a'] })
    const toolA = sandboxedTool('bash')
    const toolB = {
      ...sandboxedTool('bash2'),
      permission: { category: 'execute', sandbox: { writeAllowPaths: ['/data/b'] } },
    } as unknown as MetaAgentTool

    await guards.wrapTool(toolA).call({}, ctx)
    await guards.wrapTool(toolB).call({}, ctx)
    expect(state.created).toBe(2)
    await guards.dispose()
    expect(state.destroyed).toBe(2)
  })
})
