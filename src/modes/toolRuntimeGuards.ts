import type { AutonomyProfile, MetaAgentTool, ToolCallContext } from '../core/types.js'
import { getGlobalWriteMutex } from '../core/fs/WriteMutex.js'
import { createSandboxExecutor } from '../sandbox/index.js'
import type { SandboxConfig, SandboxHandle } from '../sandbox/types.js'

export interface ToolRuntimeGuardsOptions {
  projectDir?: string
  autonomy?: AutonomyProfile
}

/**
 * Per-session runtime guards applied immediately before a MetaAgentTool runs.
 *
 * The expensive part (creating the OS sandbox handle) is lazy and cached by
 * policy, so tools with no sandbox declaration pay no cost and repeated bash
 * calls pay only a Map lookup.
 */
export class ToolRuntimeGuards {
  private readonly sandboxHandles = new Map<string, SandboxHandle>()
  private readonly options: ToolRuntimeGuardsOptions
  private readonly writeMutex: ReturnType<typeof getGlobalWriteMutex> | undefined

  constructor(options: ToolRuntimeGuardsOptions = {}) {
    this.options = options
    this.writeMutex = options.autonomy ? getGlobalWriteMutex() : undefined
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
    const handles = [...this.sandboxHandles.values()]
    this.sandboxHandles.clear()
    await Promise.allSettled(handles.map(handle => handle.destroy()))
  }

  private async getOrCreateSandboxHandle(policy: true | SandboxConfig): Promise<SandboxHandle> {
    const cacheKey = policy === true ? '__default__' : JSON.stringify(policy)
    const cached = this.sandboxHandles.get(cacheKey)
    if (cached) return cached

    const baseConfig: SandboxConfig = policy === true ? {} : policy
    const config: SandboxConfig = this.options.autonomy?.lockWorkspace
      ? { ...baseConfig, allowUnsandboxedFallback: false }
      : baseConfig
    const workspaceRoot = this.options.projectDir ?? process.cwd()
    const executor = createSandboxExecutor()
    if (executor.platform === 'noop' && !config.allowUnsandboxedFallback) {
      throw new Error(
        'Sandbox requested, but no supported sandbox backend is available. ' +
        'Install sandbox-exec/bwrap or set sandbox.allowUnsandboxedFallback=true.',
      )
    }

    const handle = await executor.create(config, workspaceRoot)
    this.sandboxHandles.set(cacheKey, handle)
    return handle
  }
}
