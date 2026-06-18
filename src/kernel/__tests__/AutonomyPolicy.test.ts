import { describe, it, expect } from 'vitest'
import { join } from 'path'
import { createPermissionPolicy } from '../permissions/PermissionPolicy.js'
import type { KernelTool, KernelToolContext } from '../types/KernelTool.js'
import { FileStateCache } from '../session/FileStateCache.js'

// Auto-mode permission jail: tests the `autonomy` profile on createPermissionPolicy.
//   autoApproveInWorkspace → in-workspace sensitive ops skip the confirm guard
//   lockWorkspace          → jail cannot be unlocked by config; + bash relative-escape hardening

const ROOT = process.cwd()
const AUTO = {
  autoApproveInWorkspace: true,
  lockWorkspace: true,
  deniedTools: ['memory_write', 'memory_delete', 'cron_create', 'cron_delete', 'powershell'],
} as const

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
    // sensitive:true so the op reaches the confirm-guard branch where auto-approve fires.
    permission: { category: 'write', pathFields: ['file_path'], requiresWorkspace: true, sensitive: true },
    isConcurrencySafe: () => false,
    call: async () => ({ data: 'ok' }),
  }
}

// A sensitive tool that is exempt from the workspace jail (requiresWorkspace:false),
// e.g. the config tool. Auto mode must NOT silently auto-approve these.
function configTool(): KernelTool {
  return {
    name: 'config',
    description: 'config',
    inputSchema: { safeParse: (v) => ({ success: true, data: v }) },
    inputJSONSchema: { type: 'object', properties: {}, required: [] },
    permission: { category: 'config', pathFields: [], requiresWorkspace: false, sensitive: true },
    isConcurrencySafe: () => false,
    call: async () => ({ data: 'ok' }),
  }
}

function namedTool(name: string): KernelTool {
  return {
    name,
    description: name,
    inputSchema: { safeParse: (v) => ({ success: true, data: v }) },
    inputJSONSchema: { type: 'object', properties: {}, required: [] },
    isConcurrencySafe: () => true,
    call: async () => ({ data: 'ok' }),
  }
}

function context(): KernelToolContext {
  return {
    sessionId: 's',
    abortSignal: new AbortController().signal,
    readFileState: new FileStateCache(),
    messages: [],
    workspaceRoot: ROOT,
  }
}

describe('autonomy profile — in-workspace auto-approve', () => {
  it('auto-approves a sensitive write inside the workspace WITHOUT any approval channel', async () => {
    const canUseTool = createPermissionPolicy({ workspaceRoot: ROOT, autonomy: AUTO })
    const result = await canUseTool(writeTool(), { file_path: join(ROOT, 'x.txt') }, 'a', 't', context())
    expect(result.behavior).toBe('allow')
  })

  it('WITHOUT autonomy, the same sensitive write is denied when no approval channel exists (baseline)', async () => {
    const canUseTool = createPermissionPolicy({ workspaceRoot: ROOT })
    const result = await canUseTool(writeTool(), { file_path: join(ROOT, 'x.txt') }, 'a', 't', context())
    expect(result.behavior).toBe('deny')
  })

  it('auto-approves rm -rf of an in-workspace subdirectory', async () => {
    const canUseTool = createPermissionPolicy({ workspaceRoot: ROOT, autonomy: AUTO })
    const result = await canUseTool(bashTool(), { command: 'rm -rf ./build', cwd: ROOT }, 'a', 't', context())
    expect(result.behavior).toBe('allow')
  })

  it('does NOT auto-approve a jail-exempt sensitive tool (requiresWorkspace:false)', async () => {
    const canUseTool = createPermissionPolicy({ workspaceRoot: ROOT, autonomy: AUTO })
    const result = await canUseTool(configTool(), {}, 'a', 't', context())
    expect(result.behavior).toBe('deny')
  })
})

describe('autonomy profile — out-of-workspace hard deny (no prompt)', () => {
  it('denies a write outside the workspace', async () => {
    const canUseTool = createPermissionPolicy({ workspaceRoot: ROOT, autonomy: AUTO })
    const result = await canUseTool(writeTool(), { file_path: '/etc/passwd' }, 'a', 't', context())
    expect(result.behavior).toBe('deny')
  })

  it('denies bash referencing an absolute path outside the workspace', async () => {
    const canUseTool = createPermissionPolicy({ workspaceRoot: ROOT, autonomy: AUTO })
    const result = await canUseTool(bashTool(), { command: 'rm -rf /etc/hosts', cwd: ROOT }, 'a', 't', context())
    expect(result.behavior).toBe('deny')
  })

  // Paths glued to an option via `=`/`:` previously slipped past the absolute-path
  // scan (it only recognised start/space/quote boundaries).
  it('denies an =-glued out-of-workspace path (dd of=/etc/x)', async () => {
    const canUseTool = createPermissionPolicy({ workspaceRoot: ROOT, autonomy: AUTO })
    const result = await canUseTool(bashTool(), { command: 'dd if=/dev/zero of=/etc/shadow', cwd: ROOT }, 'a', 't', context())
    expect(result.behavior).toBe('deny')
  })

  it('denies a --flag=/path out-of-workspace path', async () => {
    const canUseTool = createPermissionPolicy({ workspaceRoot: ROOT, autonomy: AUTO })
    const result = await canUseTool(bashTool(), { command: 'python --out=/etc/passwd run.py', cwd: ROOT }, 'a', 't', context())
    expect(result.behavior).toBe('deny')
  })
})

describe('autonomy profile — denied capability boundary', () => {
  for (const name of AUTO.deniedTools) {
    it(`denies ${name} even when manually registered`, async () => {
      const canUseTool = createPermissionPolicy({
        workspaceRoot: ROOT,
        autonomy: AUTO,
        permissionConfig: { tools: { [name]: { enabled: true, sensitive: false } } },
      })
      const result = await canUseTool(namedTool(name), {}, 'a', 't', context())
      expect(result.behavior).toBe('deny')
      expect(result.reason).toContain('cannot be confined to the workspace')
    })
  }

  it('does not apply the auto denylist outside autonomy mode', async () => {
    const canUseTool = createPermissionPolicy({ workspaceRoot: ROOT })
    const result = await canUseTool(namedTool('memory_write'), {}, 'a', 't', context())
    expect(result.behavior).toBe('allow')
  })

  it('keeps mcp_call available in autonomy mode', async () => {
    const canUseTool = createPermissionPolicy({ workspaceRoot: ROOT, autonomy: AUTO })
    const result = await canUseTool(namedTool('mcp_call'), {}, 'a', 't', context())
    expect(result.behavior).toBe('allow')
  })
})

describe('autonomy profile — filesystem-root target hardening', () => {
  const rootCases: Array<[string, string]> = [
    ['root glob', 'rm -rf /*'],
    ['bare root', 'rm -rf /'],
    ['cd root',   'cd / && rm -rf foo'],
    ['chmod root glob', 'chmod -R 777 /*'],
  ]
  for (const [label, command] of rootCases) {
    it(`denies root target: ${label}`, async () => {
      const canUseTool = createPermissionPolicy({ workspaceRoot: ROOT, autonomy: AUTO })
      const result = await canUseTool(bashTool(), { command, cwd: ROOT }, 'a', 't', context())
      expect(result.behavior).toBe('deny')
    })
  }

  it('does NOT flag an in-workspace absolute path', async () => {
    const canUseTool = createPermissionPolicy({ workspaceRoot: ROOT, autonomy: AUTO })
    const result = await canUseTool(bashTool(), { command: `cat ${join(ROOT, 'src/a.txt')}`, cwd: ROOT }, 'a', 't', context())
    expect(result.behavior).toBe('allow')
  })
})

describe('autonomy profile — bash relative-escape hardening', () => {
  const cases: Array<[string, string]> = [
    ['home tilde',   'rm -rf ~'],
    ['tilde path',   'cat ~/secrets'],
    ['$HOME',        'rm -rf $HOME/data'],
    ['${HOME}',      'rm -rf ${HOME}'],
    ['parent climb', 'rm -rf ..'],
    ['parent path',  'cat ../../etc/passwd'],
  ]
  for (const [label, command] of cases) {
    it(`denies relative escape: ${label}`, async () => {
      const canUseTool = createPermissionPolicy({ workspaceRoot: ROOT, autonomy: AUTO })
      const result = await canUseTool(bashTool(), { command, cwd: ROOT }, 'a', 't', context())
      expect(result.behavior).toBe('deny')
    })
  }

  it('does NOT flag an internal ../ that stays inside (a/../b)', async () => {
    const canUseTool = createPermissionPolicy({ workspaceRoot: ROOT, autonomy: AUTO })
    const result = await canUseTool(bashTool(), { command: 'cat a/../b.txt', cwd: ROOT }, 'a', 't', context())
    expect(result.behavior).toBe('allow')
  })
})

describe('autonomy profile — lockWorkspace overrides config', () => {
  it('allowOutsideWorkspace:true is IGNORED under lockWorkspace (jail wins)', async () => {
    const canUseTool = createPermissionPolicy({
      workspaceRoot: ROOT,
      autonomy: AUTO,
      permissionConfig: { workspace: { allowOutsideWorkspace: true } },
    })
    const result = await canUseTool(writeTool(), { file_path: '/etc/passwd' }, 'a', 't', context())
    expect(result.behavior).toBe('deny')
  })

  it('WITHOUT lockWorkspace, allowOutsideWorkspace:true permits the outside write (proves lock is the cause)', async () => {
    const canUseTool = createPermissionPolicy({
      workspaceRoot: ROOT,
      // no autonomy → allowOutsideWorkspace honoured; beforeToolCall allows the sensitive op
      beforeToolCall: async () => ({ action: 'allow' }),
      permissionConfig: { workspace: { allowOutsideWorkspace: true } },
    })
    const result = await canUseTool(writeTool(), { file_path: '/etc/passwd' }, 'a', 't', context())
    expect(result.behavior).toBe('allow')
  })
})
