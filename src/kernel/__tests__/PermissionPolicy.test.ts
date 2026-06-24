import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
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

  it('auto-allows write_file by default (non-sensitive) with no approval channel', async () => {
    const canUseTool = createPermissionPolicy({ workspaceRoot: process.cwd() })
    // No tool.permission → DEFAULT_TOOL_PERMISSIONS.write_file applies (sensitive:false).
    const tool = { ...writeTool(), permission: undefined }
    const result = await canUseTool(tool, { file_path: 'tmp.txt' }, 'a', 't', context())
    expect(result.behavior).toBe('allow')
  })

  it('still denies write_file outside the workspace (boundary enforced)', async () => {
    const canUseTool = createPermissionPolicy({ workspaceRoot: process.cwd() })
    const tool = { ...writeTool(), permission: undefined }
    const result = await canUseTool(tool, { file_path: '/etc/passwd' }, 'a', 't', context())
    expect(result.behavior).toBe('deny')
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

  // ── Workspace-jail hardening in NON-auto modes (no autonomy profile) ───────
  // The relative/home/root escape scan used to run only under autonomy.
  // lockWorkspace; these assert it now applies to any jail-active bash so the
  // jail is consistent with the absolute-path denial that always ran.
  describe('bash relative/home escapes are denied without an autonomy profile', () => {
    const cases: Array<[string, string]> = [
      ['home (~)',     'cat ~/.ssh/id_rsa'],
      ['$HOME',        'cat $HOME/.netrc'],
      ['parent climb', 'cat ../../etc/passwd'],
      ['filesystem root', 'rm -rf /*'],
    ]
    for (const [label, command] of cases) {
      it(`denies: ${label}`, async () => {
        const canUseTool = createPermissionPolicy({ workspaceRoot: process.cwd() })
        const result = await canUseTool(bashTool(), { command }, 'a', 't', context())
        expect(result.behavior).toBe('deny')
      })
    }

    it('does NOT flag an internal ../ that stays inside (a/../b)', async () => {
      const canUseTool = createPermissionPolicy({
        workspaceRoot: process.cwd(),
        beforeToolCall: async () => ({ action: 'allow' }),
      })
      const result = await canUseTool(bashTool(), { command: 'cat a/../b.txt' }, 'a', 't', context())
      expect(result.behavior).toBe('allow')
    })

    it('permits the escape when the workspace jail is unlocked via config', async () => {
      // allowOutsideWorkspace:true turns jailActive off, so the escape scan is
      // skipped — the documented opt-out for callers that need outside access.
      const canUseTool = createPermissionPolicy({
        workspaceRoot: process.cwd(),
        beforeToolCall: async () => ({ action: 'allow' }),
        permissionConfig: { workspace: { allowOutsideWorkspace: true } },
      })
      const result = await canUseTool(bashTool(), { command: 'cat ../sibling/notes.txt' }, 'a', 't', context())
      expect(result.behavior).toBe('allow')
    })
  })

  // ── Hermeticity: ignoreUserConfig opt-out (#5) ─────────────────────────────
  // On-disk permission configs (global ~/.meta-agent + project <ws>/.meta-agent)
  // can override a tool's sensitivity. ignoreUserConfig skips them so tests/CI
  // are deterministic regardless of the developer's local config. We drive this
  // through the project-config path (a temp workspace we fully control), which
  // shares the exact load+skip code path as the global config.
  describe('ignoreUserConfig hermeticity opt-out', () => {
    function tempWorkspaceWithConfig(toolConfig: Record<string, unknown>): string {
      const ws = mkdtempSync(join(tmpdir(), 'perm-hermetic-'))
      mkdirSync(join(ws, '.meta-agent'), { recursive: true })
      writeFileSync(
        join(ws, '.meta-agent', 'permissions.json'),
        JSON.stringify({ tools: { write_file: toolConfig } }),
        'utf-8',
      )
      return ws
    }

    function ctxIn(ws: string): KernelToolContext {
      return { ...context(), workspaceRoot: ws }
    }

    // A permission-less write tool → falls back to DEFAULT write_file (sensitive:false).
    const plainWrite = (): KernelTool => ({ ...writeTool(), permission: undefined })

    it('reads project config by default (config flips write_file to sensitive → deny)', async () => {
      const ws = tempWorkspaceWithConfig({ sensitive: true })
      const canUseTool = createPermissionPolicy({ workspaceRoot: ws })
      const result = await canUseTool(plainWrite(), { file_path: join(ws, 'x.txt') }, 'a', 't', ctxIn(ws))
      expect(result.behavior).toBe('deny')
    })

    it('ignoreUserConfig skips the on-disk config (default sensitive:false → allow)', async () => {
      const ws = tempWorkspaceWithConfig({ sensitive: true })
      const canUseTool = createPermissionPolicy({ workspaceRoot: ws, ignoreUserConfig: true })
      const result = await canUseTool(plainWrite(), { file_path: join(ws, 'x.txt') }, 'a', 't', ctxIn(ws))
      expect(result.behavior).toBe('allow')
    })

    it('META_AGENT_IGNORE_USER_PERMISSIONS env var also forces hermetic mode', async () => {
      const ws = tempWorkspaceWithConfig({ sensitive: true })
      const prev = process.env['META_AGENT_IGNORE_USER_PERMISSIONS']
      process.env['META_AGENT_IGNORE_USER_PERMISSIONS'] = '1'
      try {
        const canUseTool = createPermissionPolicy({ workspaceRoot: ws })
        const result = await canUseTool(plainWrite(), { file_path: join(ws, 'x.txt') }, 'a', 't', ctxIn(ws))
        expect(result.behavior).toBe('allow')
      } finally {
        if (prev === undefined) delete process.env['META_AGENT_IGNORE_USER_PERMISSIONS']
        else process.env['META_AGENT_IGNORE_USER_PERMISSIONS'] = prev
      }
    })
  })
})
