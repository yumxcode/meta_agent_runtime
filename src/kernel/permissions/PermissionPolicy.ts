import { existsSync, readFileSync, realpathSync } from 'fs'
import { homedir } from 'os'
import { dirname, isAbsolute, join, resolve, sep } from 'path'
import type { KernelTool } from '../types/KernelTool.js'
import type { CanUseToolFn, CanUseToolResult } from '../types/KernelConfig.js'
import type { ToolPermissionDeclaration } from '../../core/types.js'

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

const SENSITIVE_BASH_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  // ── File deletion ──────────────────────────────────────────────────────────
  { pattern: /\brm\b/, label: 'rm (file deletion)' },
  { pattern: /\brmdir\b/, label: 'rmdir' },
  { pattern: /\bunlink\b/, label: 'unlink' },
  { pattern: /\btrash\b/, label: 'trash' },
  { pattern: /\bshred\b/, label: 'shred' },
  // ── Git destructive operations ─────────────────────────────────────────────
  { pattern: /\bgit\s+push\b/, label: 'git push' },
  { pattern: /\bgit\s+clean\b/, label: 'git clean' },
  { pattern: /\bgit\s+branch\b.*-[dD]\b/, label: 'git branch delete' },
  { pattern: /\bgit\s+tag\b.*-[dD]\b/, label: 'git tag delete' },
  { pattern: /\bgit\s+reset\s+--hard\b/, label: 'git reset --hard' },
  // ── Package installs ───────────────────────────────────────────────────────
  { pattern: /\bpip3?\s+install\b/, label: 'pip install' },
  { pattern: /\bconda\s+install\b/, label: 'conda install' },
  { pattern: /\bapt(?:-get)?\s+install\b/, label: 'apt install' },
  { pattern: /\bbrew\s+install\b/, label: 'brew install' },
  { pattern: /\bnpm\b.*\b(?:install|i)\b.*\b(?:-g|--global)\b/, label: 'npm install -g' },
  // ── Downloads ─────────────────────────────────────────────────────────────
  { pattern: /\bcurl\b.*\s-[a-zA-Z]*[oO][a-zA-Z]*\s/, label: 'curl download' },
  { pattern: /\bwget\b/, label: 'wget' },
  // ── High-risk system operations ────────────────────────────────────────────
  { pattern: /\bsudo\b/, label: 'sudo' },
  { pattern: /\bcurl\b.*\|\s*(ba)?sh\b/, label: 'curl pipe to shell' },
  { pattern: /\bwget\b.*\|\s*(ba)?sh\b/, label: 'wget pipe to shell' },
  { pattern: /\bchmod\s+(-R\s+)?777\b/, label: 'chmod 777' },
  { pattern: /\bchown\s+(-R\s+)?/, label: 'chown' },
  // ── In-place file edits (modifies existing files without explicit path in tool input) ──
  // NOTE: plain `>` / `>>` / `tee` redirections are intentionally NOT flagged here.
  // Writing to relative paths inside the workspace is safe; writing to absolute paths
  // outside the workspace is already blocked by findWorkspaceViolation() above.
  // Keeping broad redirection patterns causes constant false positives for legitimate
  // operations like `2>/dev/null`, `cat > file <<'EOF'`, and `echo x > log.txt`.
  { pattern: /\bsed\s+.*\s-i(?:\s|$)/, label: 'sed in-place edit' },
  { pattern: /\bperl\s+.*\s-i(?:\s|$)/, label: 'perl in-place edit' },
]

const DEFAULT_TOOL_PERMISSIONS: Record<string, ToolPermissionDeclaration> = {
  read_file: { category: 'read', pathFields: ['file_path'], requiresWorkspace: true, planMode: 'allow' },
  write_file: { category: 'write', pathFields: ['file_path'], requiresWorkspace: true, sensitive: true, planMode: 'ask' },
  edit_file: { category: 'write', pathFields: ['file_path'], requiresWorkspace: true, sensitive: true, planMode: 'ask' },
  notebook_edit: { category: 'write', pathFields: ['notebook_path'], requiresWorkspace: true, sensitive: true, planMode: 'ask' },
  glob: { category: 'read', pathFields: ['path'], requiresWorkspace: true, planMode: 'allow' },
  grep: { category: 'read', pathFields: ['path'], requiresWorkspace: true, planMode: 'allow' },
  bash: { category: 'execute', cwdField: 'cwd', requiresWorkspace: true, sensitive: true, planMode: 'ask' },
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

function findExistingAncestor(path: string): string {
  let current = path
  while (!existsSync(current)) {
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return current
}

function resolveForPolicy(path: string, workspaceRoot: string): string {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(workspaceRoot, path)
  if (existsSync(absolute)) return realpathSync(absolute)
  const ancestor = findExistingAncestor(absolute)
  const realAncestor = existsSync(ancestor) ? realpathSync(ancestor) : resolve(ancestor)
  return resolve(realAncestor, absolute.slice(ancestor.length))
}

function isInsideWorkspace(path: string, workspaceRoot: string): boolean {
  const workspace = existsSync(workspaceRoot) ? realpathSync(workspaceRoot) : resolve(workspaceRoot)
  const target = resolveForPolicy(path, workspace)
  return target === workspace || target.startsWith(workspace.endsWith(sep) ? workspace : workspace + sep)
}

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

  if (toolName === 'bash') {
    const command = String(input['command'] ?? '')
    const absPathPattern = /(?:^|\s|['"])(\/(?:[^\s'"`$;&|()<>]+\/?)+)/g
    let match: RegExpExecArray | null
    while ((match = absPathPattern.exec(command)) !== null) {
      const candidate = match[1]!
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
  for (const { pattern, label } of SENSITIVE_BASH_PATTERNS) {
    if (pattern.test(command)) return label
  }
  return null
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
    const permission = mergePermissionDeclaration(
      mergePermissionDeclaration(DEFAULT_TOOL_PERMISSIONS[tool.name], tool.permission),
      permissionConfig.tools?.[tool.name],
    )

    if (permission.enabled === false) {
      return { behavior: 'deny', reason: `Tool "${tool.name}" is disabled by permissions config.` }
    }

    if (workspaceRoot && !allowOutsideWorkspace && permission.requiresWorkspace !== false) {
      const violation = findWorkspaceViolation(tool, record, workspaceRoot, permission, allowTmp)
      if (violation) return { behavior: 'deny', reason: violation }
    }

    const sensitiveLabel = detectSensitiveBash(record)
    if (sensitiveLabel || (options.beforeToolCall && permission.sensitive === true && tool.name !== 'bash')) {
      const guard = await applyBeforeToolGuard(
        tool.name,
        record,
        options,
        context,
        `Tool "${tool.name}" requires approval.`,
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
