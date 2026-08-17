import type { AutonomyProfile, MetaAgentTool, ToolCallContext } from '../core/types.js'
import { getGlobalWriteMutex } from '../core/fs/WriteMutex.js'
import { createSandboxExecutor } from '../sandbox/index.js'
import { applySandboxPolicy, resolveSandboxPolicy, type ResolvedSandboxPolicy } from '../sandbox/sandboxPolicyConfig.js'
import type { SandboxConfig, SandboxHandle } from '../sandbox/types.js'

export interface ToolRuntimeGuardsOptions {
  projectDir?: string
  autonomy?: AutonomyProfile
  /**
   * Operator sandbox policy from config.json `sandbox.*` — external read/write
   * grants, deny lists, network and credential protection.
   *
   * Resolved once per session and merged into EVERY sandboxed tool's declared
   * policy (see applySandboxPolicy). When omitted it is resolved lazily from
   * `projectDir`, so an embedder that forgets to pass it still gets the
   * operator's configuration rather than silently losing their grants.
   */
  sandboxPolicy?: ResolvedSandboxPolicy
  /**
   * @deprecated Use `sandboxPolicy` / config.json `sandbox.writeAllowPaths`.
   * Retained so existing embedders keep compiling; unioned into the policy.
   */
  extraWriteAllowPaths?: string[]
}

/**
 * Per-session runtime guards applied immediately before a MetaAgentTool runs.
 *
 * The expensive part (creating the OS sandbox handle) is lazy and cached by
 * policy, so tools with no sandbox declaration pay no cost and repeated bash
 * calls pay only a Map lookup.
 */
export class ToolRuntimeGuards {
  /**
   * Cache of IN-FLIGHT-OR-SETTLED handle creations, keyed by resolved policy.
   *
   * The Promise — not the handle — is what is cached. Caching the resolved
   * handle left a window between the cache miss and the `await executor.create()`
   * resolving: two concurrent bash calls both missed, both created a handle, and
   * the second `set()` overwrote the first. The overwritten handle was then
   * unreachable from `dispose()`, so it never got `destroy()`ed. Today's handles
   * are stateless (bwrap is one-shot per command, `destroy()` is a no-op) so
   * nothing leaked in practice — but it was a live trap for the first stateful
   * backend (a persistent container, a VM, a mounted overlay).
   *
   * A rejected creation is evicted so the next call retries rather than
   * permanently caching the failure.
   */
  private readonly sandboxHandles = new Map<string, Promise<SandboxHandle>>()
  private readonly options: ToolRuntimeGuardsOptions
  private readonly writeMutex: ReturnType<typeof getGlobalWriteMutex> | undefined
  private readonly policy: ResolvedSandboxPolicy

  constructor(options: ToolRuntimeGuardsOptions = {}) {
    this.options = options
    this.writeMutex = options.autonomy ? getGlobalWriteMutex() : undefined
    const base = options.sandboxPolicy ?? resolveSandboxPolicy(options.projectDir)
    const legacy = options.extraWriteAllowPaths ?? []
    this.policy = legacy.length
      ? {
          ...base,
          writeAllowPaths: [...new Set([...base.writeAllowPaths, ...legacy])],
          allowedRoots: [...new Set([...base.allowedRoots, ...legacy])],
        }
      : base
  }

  /** The effective operator policy — the same grants the permission jail must widen by. */
  get sandboxPolicy(): ResolvedSandboxPolicy {
    return this.policy
  }

  wrapTool(tool: MetaAgentTool): MetaAgentTool {
    const sandboxPolicy = tool.permission?.sandbox
    const writeMutex = this.writeMutex
    if (sandboxPolicy === undefined && writeMutex === undefined) return tool

    return {
      ...tool,
      call: async (input, ctx) => {
        let enrichedCtx: ToolCallContext = ctx
        if (sandboxPolicy !== undefined) {
          const sandboxHandle = await this.getOrCreateSandboxHandle(sandboxPolicy)
          enrichedCtx = { ...enrichedCtx, sandboxHandle }
        }
        if (writeMutex !== undefined) {
          enrichedCtx = { ...enrichedCtx, writeMutex }
        }
        return tool.call(input, enrichedCtx)
      },
    }
  }

  async dispose(): Promise<void> {
    const pending = [...this.sandboxHandles.values()]
    this.sandboxHandles.clear()
    // Await each creation before destroying it: a handle whose creation is still
    // in flight when dispose() runs must not escape teardown. A creation that
    // rejected has nothing to destroy.
    await Promise.allSettled(
      pending.map(async promise => {
        const handle = await promise.catch(() => null)
        await handle?.destroy()
      }),
    )
  }

  private getOrCreateSandboxHandle(policy: true | SandboxConfig): Promise<SandboxHandle> {
    const baseConfig: SandboxConfig = policy === true ? {} : policy
    // Merge the operator's config.json `sandbox.*` policy into the tool's own
    // declaration: external read/write grants, deny lists, network, credential
    // protection. Allow lists union, deny lists union, `network: 'none'` is
    // sticky — see applySandboxPolicy.
    const withPolicy = applySandboxPolicy(baseConfig, this.policy)
    // lockWorkspace (auto modes) is the one setting the operator may NOT relax:
    // an unattended run must fail closed rather than silently degrade to plain
    // `bash -c` on a host with no sandbox backend.
    const config: SandboxConfig = this.options.autonomy?.lockWorkspace
      ? { ...withPolicy, allowUnsandboxedFallback: false }
      : withPolicy
    // Cache by the FULLY-resolved config so the merged paths participate in the key.
    const cacheKey = JSON.stringify(config)
    const cached = this.sandboxHandles.get(cacheKey)
    if (cached) return cached

    // Install the promise BEFORE the first await, so a concurrent caller that
    // arrives mid-creation joins this one instead of starting a second.
    const creation = (async (): Promise<SandboxHandle> => {
      const workspaceRoot = this.options.projectDir ?? process.cwd()
      const executor = createSandboxExecutor()
      if (executor.platform === 'noop' && !config.allowUnsandboxedFallback) {
        throw new Error(
          'Sandbox requested, but no supported sandbox backend is available. ' +
          'Install sandbox-exec/bwrap or set sandbox.allowUnsandboxedFallback=true.',
        )
      }
      return executor.create(config, workspaceRoot)
    })()

    this.sandboxHandles.set(cacheKey, creation)
    creation.catch(() => {
      // Don't cache a failure: a transient one (bwrap briefly missing, a bind
      // source not yet created) must not poison every later call for the
      // session's lifetime.
      if (this.sandboxHandles.get(cacheKey) === creation) {
        this.sandboxHandles.delete(cacheKey)
      }
    })
    return creation
  }
}
