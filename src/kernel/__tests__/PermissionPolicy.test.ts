import { describe, it, expect } from 'vitest'
import { createPermissionPolicy } from '../permissions/PermissionPolicy.js'
import { detectSensitiveShellCommand } from '../permissions/SensitiveCommandPatterns.js'
import type { KernelTool, KernelToolContext } from '../types/KernelTool.js'
import { FileStateCache } from '../session/FileStateCache.js'

function bashTool(): KernelTool {
  return {
    name: 'bash',
    description: 'bash',
    inputSchema: { safeParse: (v) => ({ success: true, data: v }) },
    inputJSONSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    permission: { category: 'execute', cwdField: 'cwd', requiresWorkspace: true, sensitive: true },
    isConcurrencySafe: () => false,
    call: async () => ({ data: 'ok' }),
  }
}

function writeTool(): KernelTool {
  return {
    name: 'write_file',
    description: 'write',
    inputSchema: { safeParse: (v) => ({ success: true, data: v }) },
    inputJSONSchema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] },
    permission: { category: 'write', pathFields: ['file_path'], requiresWorkspace: true, sensitive: true },
    isConcurrencySafe: () => false,
    call: async () => ({ data: 'ok' }),
  }
}

function powershellTool(): KernelTool {
  return {
    name: 'powershell',
    description: 'powershell',
    inputSchema: { safeParse: (v) => ({ success: true, data: v }) },
    inputJSONSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    permission: { category: 'execute', cwdField: 'cwd', requiresWorkspace: true, sensitive: true },
    isConcurrencySafe: () => false,
    call: async () => ({ data: 'ok' }),
  }
}

function context(): KernelToolContext {
  return {
    sessionId: 's',
    abortSignal: new AbortController().signal,
    readFileState: new FileStateCache(),
    messages: [],
    workspaceRoot: process.cwd(),
  }
}

describe('createPermissionPolicy', () => {
  it('uses shared shell sensitive command detection', () => {
    expect(detectSensitiveShellCommand('git push origin main')).toBe('git push')
    expect(detectSensitiveShellCommand('echo ok > local.txt')).toBeNull()
  })

  it('allows non-sensitive bash when no approval channel is configured', async () => {
    // Non-sensitive commands (no dangerous patterns, no outside-workspace paths)
    // pass straight through — the policy no longer requires an explicit channel for
    // safe bash invocations.
    const canUseTool = createPermissionPolicy({ workspaceRoot: process.cwd() })
    const result = await canUseTool(bashTool(), { command: 'echo ok' }, 'a', 't', context())
    expect(result.behavior).toBe('allow')
  })

  it('denies sensitive bash when no approval channel is available', async () => {
    // Commands that match SENSITIVE_BASH_PATTERNS still require an approval hook.
    const canUseTool = createPermissionPolicy({ workspaceRoot: process.cwd() })
    // 'rm -rf /' matches the dangerous-delete pattern
    const result = await canUseTool(bashTool(), { command: 'rm -rf /tmp/foo' }, 'a', 't', context())
    // With no beforeToolCall or askUser, the guard must deny.
    expect(result.behavior).toBe('deny')
  })

  it('allows bash when the approval hook allows it', async () => {
    const canUseTool = createPermissionPolicy({
      workspaceRoot: process.cwd(),
      beforeToolCall: async () => ({ action: 'allow' }),
    })
    const result = await canUseTool(bashTool(), { command: 'echo ok' }, 'a', 't', context())
    expect(result.behavior).toBe('allow')
  })

  it('denies sensitive write tools when no approval channel is available', async () => {
    const canUseTool = createPermissionPolicy({ workspaceRoot: process.cwd() })
    const result = await canUseTool(writeTool(), { file_path: 'tmp.txt' }, 'a', 't', context())
    expect(result.behavior).toBe('deny')
  })

  it('allows sensitive write tools when the approval hook allows them', async () => {
    const canUseTool = createPermissionPolicy({
      workspaceRoot: process.cwd(),
      beforeToolCall: async () => ({ action: 'allow' }),
    })
    const result = await canUseTool(writeTool(), { file_path: 'tmp.txt' }, 'a', 't', context())
    expect(result.behavior).toBe('allow')
  })

  it('denies sensitive PowerShell commands when no approval channel is available', async () => {
    const canUseTool = createPermissionPolicy({ workspaceRoot: process.cwd() })
    const result = await canUseTool(powershellTool(), { command: 'Remove-Item foo; git push' }, 'a', 't', context())
    expect(result.behavior).toBe('deny')
  })

  it('allows non-sensitive PowerShell commands inside workspace', async () => {
    const canUseTool = createPermissionPolicy({ workspaceRoot: process.cwd() })
    const result = await canUseTool(powershellTool(), { command: 'Write-Output ok' }, 'a', 't', context())
    expect(result.behavior).toBe('allow')
  })
})
