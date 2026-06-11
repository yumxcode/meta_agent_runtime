import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join, resolve } from 'path'
import type { KernelTool } from '../types/KernelTool.js'
import type { CanUseToolFn, CanUseToolResult } from '../types/KernelConfig.js'
import type { ToolPermissionDeclaration } from '../../core/types.js'
import { detectSensitiveShellCommand } from './SensitiveCommandPatterns.js'
import { isInsideWorkspace } from '../../tools/fs/workspaceGuard.js'

type BeforeToolCallResult =
  | { action: 'allow' }
  | { action: 'deny'; reason?: string }
  | { action: 'redirect'; instructions: string }

export interface PermissionPolicyOptions {
  workspaceRoot?: string
  beforeToolCall?: (toolName: string, input: Record<string, unknown>) => Promise<BeforeToolCallResult>
  planModeRef?: { active: boolean }
  askUser?: (question: string, choices?: string[]) => Promise<string>
  permissionConfig?: PermissionConfig
}

export interface PermissionConfig {
  workspace?: {
    root?: string
    allowOutsideWorkspace?: boolean
    allowTmp?: boolean
  }
  tools?: Record<string, ToolPermissionOverride>
}

export interface ToolPermissionOverride extends ToolPermissionDeclaration {
  enabled?: boolean
}

const DEFAULT_TOOL_PERMISSIONS: Record<string, ToolPermissionDeclaration> = {
  read_file: { category: 'read', pathFields: ['file_path'], requiresWorkspace: true, planMode: 'allow' },
  write_file: { category: 'write', pathFields: ['file_path'], requiresWorkspace: true, sensitive: true, planMode: 'ask' },
  edit_file: { category: 'write', pathFields: ['file_path'], requiresWorkspace: true, sensitive: true, planMode: 'ask' },
  notebook_edit: { category: 'write', pathFields: ['notebook_path'], requiresWorkspace: true, sensitive: true, planMode: 'ask' },
  glob: { category: 'read', pathFields: ['path'], requiresWorkspace: true, planMode: 'allow' },
  grep: { category: 'read', pathFields: ['path'], requiresWorkspace: true, planMode: 'allow' },
  bash: { category: 'execute', cwdField: 'cwd', requiresWorkspace: true, sensitive: true, planMode: 'ask' },
  powershell: { category: 'execute', cwdField: 'cwd', requiresWorkspace: true, sensitive: true, planMode: 'ask' },
  web_fetch: { category: 'network', planMode: 'allow' },
}

function asRecord(input: unknown): Record<string, unknown> {
  return typeof input === 'object' && input !== null ? input as Record<string, unknown> : {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readPermissionConfig(path: string): PermissionConfig {
  if (!existsSync(path)) return {}
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown
    return isRecord(parsed) ? parsed as PermissionConfig : {}
  } catch {
    return {}
  }
}

function mergePermissionDeclaration(
  base: ToolPermissionDeclaration = {},
  override: ToolPermissionOverride = {},
): ToolPermissionOverride {
  return {
    ...base,
    ...override,
    pathFields: override.pathFields ?? base.pathFields,
  }
}

function mergePermissionConfig(base: PermissionConfig, override: PermissionConfig): PermissionConfig {
  const tools: Record<string, ToolPermissionOverride> = { ...(base.tools ?? {}) }
  for (const [name, value] of Object.entries(override.tools ?? {})) {
    tools[name] = mergePermissionDeclaration(tools[name], value)
  }
  return {
    workspace: { ...(base.workspace ?? {}), ...(override.workspace ?? {}) },
    tools,
  }
}

function loadPermissionConfig(workspaceRoot?: string, explicit: PermissionConfig = {}): PermissionConfig {
  const globalConfig = readPermissionConfig(join(homedir(), '.meta-agent', 'permissions.json'))
  const projectConfig = workspaceRoot
    ? readPermissionConfig(join(workspaceRoot, '.meta-agent', 'permissions.json'))
    : {}
  return mergePermissionConfig(mergePermissionConfig(globalConfig, projectConfig), explicit)
}

/**
 * Known real OS root directory names.
 * A path whose first component is NOT in this set (e.g. `/settings`, `/api`) is
 * almost certainly a URL segment, route path, or code literal — not a filesystem
 * path that could violate workspace boundaries.
 */
const KNOWN_OS_ROOT_DIRS = new Set([
  // Linux / macOS common roots
  'Users', 'home', 'root', 'etc', 'var', 'usr', 'opt', 'lib', 'lib64',
  'bin', 'sbin', 'boot', 'sys', 'proc', 'run', 'srv', 'mnt', 'media',
  // macOS-specific
  'private', 'Library', 'System', 'Applications', 'Volumes', 'cores', 'Network',
  // Other real roots
  'data', 'snap', 'app', 'tmp',
])

/**
 * Returns true only if `candidate` looks like a real filesystem path.
 *
 * Filters out false positives that appear inside heredocs or string literals:
 *   - `//`  (bash comment or protocol-relative URL)
 *   - `/^\d{12}/`  (regex pattern)
 *   - `/settings`  (React Router route)
 *   - `/api/v1`    (URL path)
 *
 * The heuristic: the first path component must be a known OS root directory
 * and must not contain regex/special characters.
 */
function looksLikeFilesystemPath(candidate: string): boolean {
  // Reject trivial: just slashes, empty
  if (!candidate || /^\/+$/.test(candidate)) return false
  // Extract first component (the word immediately after the leading /)
  const inner = candidate.slice(1)
  const slash2 = inner.indexOf('/')
  const firstComp = slash2 >= 0 ? inner.slice(0, slash2) : inner
  // First component must be a clean identifier (no regex meta-chars)
  if (!/^[A-Za-z0-9._\-~@]+$/.test(firstComp)) return false
  // Only flag paths whose first component is a real OS root directory
  return KNOWN_OS_ROOT_DIRS.has(firstComp)
}

/**
 * System executable/library roots that bash commands may legitimately
 * reference (interpreters, compilers, shared libs). These are enforceable as
 * read-only by the OS sandbox, so referencing them is not a workspace escape.
 * Deliberately narrow: /etc, /var (except tmp), /home, /Users etc. stay blocked.
 */
const READONLY_SYSTEM_PATH_PREFIXES = [
  '/usr/bin/', '/usr/local/bin/', '/usr/sbin/', '/usr/lib/', '/usr/local/lib/',
  '/usr/share/', '/usr/include/', '/usr/local/include/',
  '/bin/', '/sbin/', '/lib/', '/lib64/',
  '/opt/homebrew/bin/', '/opt/homebrew/lib/',
  '/System/Library/', '/Library/Developer/',
]

function findWorkspaceViolation(
  tool: KernelTool,
  input: Record<string, unknown>,
  workspaceRoot: string,
  permission: ToolPermissionOverride,
  allowTmp: boolean,
): string | null {
  const toolName = tool.name
  if (permission.cwdField) {
    const cwd = input[permission.cwdField]
    if (typeof cwd === 'string' && cwd && !isInsideWorkspace(cwd, workspaceRoot)) {
      return `${toolName}.${permission.cwdField} is outside workspace: ${cwd}`
    }
  }

  if (toolName === 'bash' || toolName === 'powershell') {
    const command = String(input['command'] ?? '')
    const absPathPattern = /(?:^|\s|['"])(\/(?:[^\s'"`$;&|()<>]+\/?)+)/g
    let match: RegExpExecArray | null
    while ((match = absPathPattern.exec(command)) !== null) {
      const candidate = match[1]!
      // Skip anything that doesn't look like a real filesystem path (URL segments,
      // route strings like /settings, regex patterns like /^\d+/, comments //).
      if (!looksLikeFilesystemPath(candidate)) continue
      // L7-fix: legitimate interpreter/toolchain references like
      // `/usr/bin/python3 x.py` were rejected by the heuristic. System
      // executable roots are effectively read-only for the agent (writes there
      // are blocked by the OS sandbox / file permissions anyway), so allow
      // them instead of failing useful commands. /etc and friends stay blocked.
      if (READONLY_SYSTEM_PATH_PREFIXES.some(p => candidate.startsWith(p))) continue
      if (
        !(allowTmp && (candidate.startsWith('/tmp/') || candidate.startsWith('/var/tmp/'))) &&
        !candidate.startsWith('/dev/') &&
        !isInsideWorkspace(candidate, workspaceRoot)
      ) {
        return `bash command references path outside workspace: ${candidate.slice(0, 120)}`
      }
    }
  }

  const fields = permission.pathFields ?? []
  for (const field of fields) {
    const value = input[field]
    if (typeof value === 'string' && value && !isInsideWorkspace(value, workspaceRoot)) {
      return `${toolName}.${field} is outside workspace: ${value}`
    }
  }

  return null
}

function detectSensitiveBash(input: Record<string, unknown>): string | null {
  const command = String(input['command'] ?? '')
  return detectSensitiveShellCommand(command)
}

async function applyBeforeToolGuard(
  toolName: string,
  input: Record<string, unknown>,
  options: PermissionPolicyOptions,
  context: Parameters<CanUseToolFn>[4],
  fallbackReason: string,
): Promise<CanUseToolResult> {
  if (options.beforeToolCall) {
    const guard = await options.beforeToolCall(toolName, input)
    if (guard.action === 'deny') {
      return { behavior: 'deny', reason: guard.reason ?? 'User denied this operation.' }
    }
    if (guard.action === 'redirect') {
      return {
        behavior: 'redirect',
        message: `[用户提供替代指导]\n${guard.instructions}\n\n请完全按照上述指导重新规划并执行。`,
      }
    }
    return { behavior: 'allow' }
  }

  const askUser = options.askUser ?? context.askUser
  if (askUser) {
    const inputStr = JSON.stringify(input, null, 2).slice(0, 400)
    const answer = await askUser(`${fallbackReason}\n${inputStr}`, ['yes', 'no'])
    return answer.toLowerCase().startsWith('y')
      ? { behavior: 'allow' }
      : { behavior: 'deny', reason: `${toolName} was not approved by user.` }
  }

  return { behavior: 'deny', reason: `${fallbackReason} No approval channel is available.` }
}

export function createPermissionPolicy(options: PermissionPolicyOptions = {}): CanUseToolFn {
  const initialWorkspaceRoot = options.workspaceRoot ? resolve(options.workspaceRoot) : undefined
  const permissionConfig = loadPermissionConfig(initialWorkspaceRoot, options.permissionConfig)
  const configuredRoot = permissionConfig.workspace?.root
  const workspaceRoot = configuredRoot
    ? resolve(initialWorkspaceRoot ?? process.cwd(), configuredRoot)
    : initialWorkspaceRoot
  const allowOutsideWorkspace = permissionConfig.workspace?.allowOutsideWorkspace === true
  const allowTmp = permissionConfig.workspace?.allowTmp !== false

  return async (
    tool: KernelTool,
    input: unknown,
    _assistantMessageUuid: string,
    _toolUseId: string,
    context,
  ): Promise<CanUseToolResult> => {
    const record = asRecord(input)
    const configuredPermission = mergePermissionDeclaration(
      DEFAULT_TOOL_PERMISSIONS[tool.name],
      permissionConfig.tools?.[tool.name],
    )
    const permission = mergePermissionDeclaration(configuredPermission, tool.permission)

    if (permission.enabled === false) {
      return { behavior: 'deny', reason: `Tool "${tool.name}" is disabled by permissions config.` }
    }

    if (workspaceRoot && !allowOutsideWorkspace && permission.requiresWorkspace !== false) {
      const violation = findWorkspaceViolation(tool, record, workspaceRoot, permission, allowTmp)
      if (violation) return { behavior: 'deny', reason: violation }
    }

    const sensitiveLabel = tool.name === 'bash' || tool.name === 'powershell'
      ? detectSensitiveBash(record)
      : null
    if (sensitiveLabel || (permission.sensitive === true && tool.name !== 'bash' && tool.name !== 'powershell')) {
      const guard = await applyBeforeToolGuard(
        tool.name,
        record,
        options,
        context,
        sensitiveLabel
          ? `Tool "${tool.name}" requires approval for ${sensitiveLabel}.`
          : `Tool "${tool.name}" requires approval.`,
      )
      if (guard.behavior !== 'allow') return guard
    }

    const isSafe = (() => {
      try {
        return tool.isConcurrencySafe(input)
      } catch {
        return false
      }
    })()
    if (options.planModeRef?.active ?? context.planMode ?? false) {
      const planMode = permission.planMode ?? (isSafe ? 'allow' : 'ask')
      if (planMode === 'allow') return { behavior: 'allow' }
      if (planMode === 'deny') {
        return { behavior: 'deny', reason: `[Plan Mode] Tool "${tool.name}" is denied by permissions config.` }
      }
      const askUser = options.askUser ?? context.askUser
      if (askUser) {
        const inputStr = JSON.stringify(input, null, 2).slice(0, 400)
        const answer = await askUser(`[Plan Mode] Allow tool "${tool.name}"?\n${inputStr}`, ['yes', 'no'])
        if (!answer.toLowerCase().startsWith('y')) {
          return { behavior: 'deny', reason: `[Plan Mode] Tool "${tool.name}" was not approved by user.` }
        }
      } else {
        return { behavior: 'deny', reason: `[Plan Mode] Tool "${tool.name}" requires approval.` }
      }
    }

    return { behavior: 'allow' }
  }
}
