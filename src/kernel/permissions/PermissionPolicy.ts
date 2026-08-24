import { existsSync, readFileSync } from 'fs'
import { join, resolve } from 'path'
import { metaAgentPath } from '../../infra/metaAgentHome.js'
import { RuntimeEnv } from '../../infra/env/RuntimeEnv.js'
import type { KernelTool } from '../types/KernelTool.js'
import type {
  CanUseToolFn,
  CanUseToolResult,
  PermissionDecisionSource,
} from '../types/KernelConfig.js'
import type { AutonomyProfile, ToolPermissionDeclaration } from '../types/Permissions.js'
import { detectSensitiveShellCommand } from './SensitiveCommandPatterns.js'
import {
  compileCommandRules,
  loadCommandRules,
  type CompiledCommandRules,
} from './CommandRules.js'
import { isInsideWorkspace } from '../../tools/fs/workspaceGuard.js'

type BeforeToolCallResult =
  | { action: 'allow'; decidedBy?: PermissionDecisionSource }
  | { action: 'deny'; reason?: string; decidedBy?: PermissionDecisionSource }
  | { action: 'redirect'; instructions: string; decidedBy?: PermissionDecisionSource }

export interface PermissionPolicyOptions {
  workspaceRoot?: string
  beforeToolCall?: (toolName: string, input: Record<string, unknown>) => Promise<BeforeToolCallResult>
  planModeRef?: { active: boolean }
  askUser?: (question: string, choices?: string[]) => Promise<string>
  permissionConfig?: PermissionConfig
  /**
   * Autonomy profile (auto mode). When set, tightens the policy:
   *   - lockWorkspace          → ignore permissions.json allowOutsideWorkspace
   *   - autoApproveInWorkspace → sensitive in-workspace ops skip the confirm
   *                              guard; out-of-workspace ops are still denied.
   * The policy acts ONLY on these booleans — it never sees a SessionMode, so the
   * mode→profile mapping stays in the routing layer.
   */
  autonomy?: AutonomyProfile
  /**
   * Hermeticity escape hatch. When true, the on-disk permission configs
   * (`~/.meta-agent/permissions.json` and `<workspace>/.meta-agent/permissions.json`)
   * are NOT read — only `permissionConfig` passed here applies. This keeps tests
   * and CI deterministic regardless of the developer's global config. Also
   * forced on by the `META_AGENT_IGNORE_USER_PERMISSIONS` env var so a test
   * runner can enable it process-wide without threading the flag everywhere.
   */
  ignoreUserConfig?: boolean
  /**
   * External lifecycle hooks, when configured.
   *
   * Consulted at the very END of the policy, after every built-in check has
   * already said "allow". A hook may turn that into a deny; it can never turn a
   * deny into an allow, because it is never asked about one. See
   * kernel/hooks/types.ts for why the veto direction is the only safe one.
   */
  hookRunner?: import('../hooks/HookRunner.js').HookRunner | null
  /**
   * Declarative sensitive-command rules.
   *
   * When supplied, replaces the on-disk lookup entirely (tests, embedders).
   * When absent, rules are layered global → project from `command-rules.json`,
   * falling back to the built-in list. See CommandRules.ts for why making this
   * configurable does not weaken any containment guarantee.
   */
  commandRules?: import('./CommandRules.js').CommandRulesConfig
  /**
   * Absolute host paths OUTSIDE the workspace that the operator granted via
   * config.json `sandbox.writeAllowPaths` / `sandbox.readAllowPaths`.
   *
   * The jail widens by exactly these roots, so a granted directory is usable as
   * a bash `cwd`, may appear as an absolute path in a command, and may be passed
   * in a tool's path fields. Without this the OS sandbox would allow the access
   * while the jail denied it first — the config setting would appear to do
   * nothing.
   *
   * Resolved by the routing layer (`resolveSandboxPolicy().allowedRoots`) rather
   * than read here, so the kernel keeps no dependency on the config service and
   * tests can inject grants directly. When omitted, only the workspace is legal.
   */
  externalAllowedRoots?: readonly string[]
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

/** Tool names already warned about, so the notice is printed once per process. */
const _inertJailWarned = new Set<string>()

/** @internal test hook */
export function _resetInertJailWarnings(): void {
  _inertJailWarned.clear()
}

/**
 * C1: make a silently-inert workspace jail loud.
 *
 * `findWorkspaceViolation` checks exactly three things, and each is subscribed
 * to by an explicit field name: `cwdField`, `commandField`, and the
 * `pathFields` list. A tool that declares a mutating category but names NONE of
 * them reaches the scan and the scan finds nothing to look at — `jailActive` is
 * true, zero paths are examined, and `sensitive` defaults to false so no
 * approval prompt fires either. From the outside that is indistinguishable from
 * "checked and allowed".
 *
 * This is the same shape as the v0.8.16 P0-2 bug (guards keyed on
 * `tool.name === 'bash'`, so anything not called bash was exempt): the control
 * is subscribed by enumeration, and forgetting to enumerate is silent. That one
 * was found by reading the code. This warning means the next one announces
 * itself instead.
 *
 * A warning rather than a denial, deliberately: several legitimate tools are
 * write-category but take no path at all (they write to a fixed store
 * directory under a sanitised id). Denying them would break working setups to
 * fix a latent risk. The paired test in
 * `kernel/__tests__/PermissionDeclarations.test.ts` is the enforcing half.
 */
function warnIfJailIsInert(toolName: string, permission: ToolPermissionOverride): void {
  const mutating = permission.category === 'write' || permission.category === 'execute'
  if (!mutating) return
  if (permission.cwdField || permission.commandField || permission.pathFields?.length) return
  if (_inertJailWarned.has(toolName)) return
  _inertJailWarned.add(toolName)
  process.stderr.write(
    `[meta-agent] ⚠ tool "${toolName}" declares category='${permission.category}' but names no ` +
    'cwdField / commandField / pathFields, so the workspace jail scans nothing for it. ' +
    'If it takes a path or a command, declare the field; if it genuinely takes neither, ' +
    'add it to the allowlist in PermissionDeclarations.test.ts to record that as intentional.\n',
  )
}

/**
 * Fallback declarations for tools that ship without their own `permission`
 * block. A tool's own declaration and then permissions.json override these.
 *
 * `commandField` is what subscribes a tool to the command-level guards (see
 * ToolPermissionDeclaration.commandField) — it must be present on EVERY tool
 * that hands model-supplied text to a shell. `cron_create` is listed here as a
 * belt-and-braces backstop: the tool declares its own permission block now, but
 * this entry means that even if a future refactor drops the declaration, the
 * command scan still fires.
 */
const DEFAULT_TOOL_PERMISSIONS: Record<string, ToolPermissionDeclaration> = {
  read_file: { category: 'read', pathFields: ['file_path'], requiresWorkspace: true, planMode: 'allow' },
  // write_file / edit_file: NOT sensitive — writes inside the workspace
  // auto-allow without user approval in every mode (agentic/robotics/campaign).
  // The workspace boundary is still hard-enforced: paths outside the workspace
  // are denied (requiresWorkspace), and plan mode still gates writes (planMode:
  // 'ask') so a planning turn does not silently modify files.
  write_file: { category: 'write', pathFields: ['file_path'], requiresWorkspace: true, sensitive: false, planMode: 'ask' },
  append_file: { category: 'write', pathFields: ['file_path'], requiresWorkspace: true, sensitive: false, planMode: 'ask' },
  edit_file: { category: 'write', pathFields: ['file_path'], requiresWorkspace: true, sensitive: false, planMode: 'ask' },
  notebook_edit: { category: 'write', pathFields: ['notebook_path'], requiresWorkspace: true, sensitive: true, planMode: 'ask' },
  glob: { category: 'read', pathFields: ['path'], requiresWorkspace: true, planMode: 'allow' },
  grep: { category: 'read', pathFields: ['path'], requiresWorkspace: true, planMode: 'allow' },
  bash: { category: 'execute', cwdField: 'cwd', commandField: 'command', requiresWorkspace: true, sensitive: true, planMode: 'ask' },
  powershell: { category: 'execute', cwdField: 'cwd', commandField: 'command', requiresWorkspace: true, sensitive: true, planMode: 'ask' },
  cron_create: { category: 'execute', commandField: 'command', requiresWorkspace: true, sensitive: true, planMode: 'ask' },
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

/** True when on-disk permission configs must be ignored (hermetic mode). */
function shouldIgnoreUserConfig(ignoreUserConfig?: boolean): boolean {
  return ignoreUserConfig === true || RuntimeEnv.ignoreUserPermissions()
}

function loadPermissionConfig(
  workspaceRoot?: string,
  explicit: PermissionConfig = {},
  ignoreUserConfig?: boolean,
): PermissionConfig {
  // Hermetic mode: skip both global and project configs so only the explicit
  // config decides — deterministic across machines / CI.
  if (shouldIgnoreUserConfig(ignoreUserConfig)) {
    return mergePermissionConfig({}, explicit)
  }
  // Route through metaAgentPath so the global config honours $META_AGENT_HOME —
  // identical to ~/.meta-agent for real users, but redirected to an isolated
  // temp dir under the test runner, so unit tests never inherit the developer's
  // local permissions.json (the root cause of non-hermetic permission tests).
  const globalConfig = readPermissionConfig(metaAgentPath('permissions.json'))
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
  // 'dev' was MISSING here, which made the scan skip every /dev/ path before it
  // reached any check — so `dd of=/dev/sda`, `mkfs /dev/nvme0n1` and
  // `cat img > /dev/sdb` were never examined at all. (The explicit `/dev/`
  // exemption further down was therefore dead code that merely made the hole
  // look intentional.) With 'dev' recognised as a real root, benign character
  // devices are carved out by ALLOWED_DEV_PATHS and block devices are denied.
  'dev',
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

/**
 * Device files a shell command may legitimately reference.
 *
 * The previous rule exempted the WHOLE `/dev/` prefix, which let block-device
 * writes (`dd of=/dev/sda`, `mkfs /dev/nvme0n1`, `> /dev/sdb`) sail through the
 * workspace scan — and `dd`/`mkfs` are not in SENSITIVE_SHELL_PATTERNS either,
 * so under auto mode's autoApproveInWorkspace nothing else stopped them. On a
 * host with bwrap the fresh `--dev /dev` namespace hides real block devices,
 * but on the noop-sandbox path (see sandbox/index.ts) the command reached the
 * host unfiltered.
 *
 * So the exemption is an explicit allowlist now: the standard character devices
 * and FD aliases that ordinary pipelines need, nothing else. Anything else under
 * /dev/ falls through to the normal out-of-workspace denial.
 */
const ALLOWED_DEV_PATHS = new Set([
  '/dev/null', '/dev/zero', '/dev/full', '/dev/random', '/dev/urandom',
  '/dev/tty', '/dev/stdin', '/dev/stdout', '/dev/stderr',
])
/** `/dev/fd/3`, `/dev/fd/12` — process FD aliases used by `<(…)` and `>(…)`. */
const ALLOWED_DEV_PATTERN = /^\/dev\/fd\/\d+$/

function isAllowedDevicePath(candidate: string): boolean {
  // Tolerate a trailing slash from the scanner's `\/?` group.
  const path = candidate.length > 1 && candidate.endsWith('/')
    ? candidate.slice(0, -1)
    : candidate
  return ALLOWED_DEV_PATHS.has(path) || ALLOWED_DEV_PATTERN.test(path)
}

/**
 * Is `candidate` inside the workspace, or inside one of the external roots the
 * OPERATOR granted via config.json `sandbox.writeAllowPaths` /
 * `sandbox.readAllowPaths`?
 *
 * The two lists have to agree. The OS sandbox may happily allow a command to
 * touch `/data/shared`, but if this jail still says "outside workspace" the
 * call is denied long before the sandbox is consulted — so an operator who
 * granted the path would see it silently not work. Threading the grants through
 * here is what makes the config setting actually take effect.
 *
 * Grants use the same segment-wise containment as the workspace itself, so
 * granting `/data/shared` does not also grant `/data/shared-backup`.
 */
function isInsideGrantedScope(
  candidate: string,
  workspaceRoot: string,
  allowedRoots: readonly string[],
): boolean {
  if (isInsideWorkspace(candidate, workspaceRoot)) return true
  return allowedRoots.some(root => isInsideWorkspace(candidate, root))
}

function findWorkspaceViolation(
  tool: KernelTool,
  input: Record<string, unknown>,
  workspaceRoot: string,
  permission: ToolPermissionOverride,
  allowTmp: boolean,
  allowedRoots: readonly string[],
): string | null {
  const toolName = tool.name
  if (permission.cwdField) {
    const cwd = input[permission.cwdField]
    if (typeof cwd === 'string' && cwd && !isInsideGrantedScope(cwd, workspaceRoot, allowedRoots)) {
      return `${toolName}.${permission.cwdField} is outside workspace: ${cwd}`
    }
  }

  // Command-level scanning is subscribed to by DECLARATION, not by tool name.
  // See ToolPermissionDeclaration.commandField for why.
  if (permission.commandField) {
    const command = String(input[permission.commandField] ?? '')
    // The path may be glued to an option with `=` or `:` (e.g. `--output=/etc/x`,
    // `dd of=/dev/sda`, `rsync src:/etc`). Treat those as boundaries too, otherwise
    // such absolute paths slip past the scan entirely.
    const absPathPattern = /(?:^|[\s'"=:])(\/(?:[^\s'"`$;&|()<>]+\/?)+)/g
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
        !isAllowedDevicePath(candidate) &&
        !isInsideGrantedScope(candidate, workspaceRoot, allowedRoots)
      ) {
        return `${toolName} command references path outside workspace: ${candidate.slice(0, 120)}` +
          (allowedRoots.length
            ? ` (granted external roots: ${allowedRoots.join(', ')})`
            : ' — grant external directories via config.json sandbox.writeAllowPaths / sandbox.readAllowPaths')
      }
    }
  }

  const fields = permission.pathFields ?? []
  for (const field of fields) {
    const value = input[field]
    if (typeof value === 'string' && value && !isInsideGrantedScope(value, workspaceRoot, allowedRoots)) {
      return `${toolName}.${field} is outside workspace: ${value}`
    }
  }

  return null
}

/**
 * Flag a command worth asking about.
 *
 * Routed through the compiled rule set when one is available (the normal path)
 * and through the legacy hard-coded list otherwise, so an embedder that
 * constructs a policy without rules keeps the exact previous behaviour.
 */
function detectSensitiveCommand(
  input: Record<string, unknown>,
  commandField: string,
  rules: CompiledCommandRules | null,
): string | null {
  const command = String(input[commandField] ?? '')
  if (rules) return rules.evaluate(command)?.label ?? null
  return detectSensitiveShellCommand(command)
}

/**
 * Workspace-jail hardening: catch the RELATIVE workspace escapes that the
 * absolute-path scan in findWorkspaceViolation cannot see — `~`, `$HOME`, and a
 * leading `../` (or bare `..`) that climbs above the workspace root.
 *
 * This runs for ANY jail-active bash/powershell call (see caller), not only auto
 * mode: the absolute-path scan already hard-denies out-of-workspace absolute
 * paths in every mode, so leaving the relative/home variants unchecked was a hole
 * in that same jail (e.g. `cat ~/.ssh/id_rsa`, `cat ../../etc/passwd` slipped
 * through in agentic/robotics). The jail is only active when the workspace is set
 * and `allowOutsideWorkspace` is false — an operator who genuinely needs
 * out-of-workspace access opts out via permissions.json
 * (`workspace.allowOutsideWorkspace: true`), which disables jailActive and skips
 * this check entirely.
 *
 * Deliberately conservative: it flags the clear home/parent escapes the design
 * calls out (`rm -rf ~`, `rm -rf $HOME`, `rm -rf ..`) without tripping on
 * internal `a/../b` (which stays inside). When in doubt the caller denies, which
 * is the safe direction for a workspace jail.
 *
 * It also catches the two filesystem-ROOT targets that the absolute-path scan in
 * findWorkspaceViolation cannot see, because they have no named first component:
 *   - a bare `/`   (e.g. `rm -rf /`, `cd /`)
 *   - a root glob  (e.g. `rm -rf /*`, `chmod -R 777 /*`)
 * Both clearly operate outside the workspace, so under the jail they are denied.
 */
function findBashRelativeEscape(
  input: Record<string, unknown>,
  commandField: string,
): string | null {
  const command = String(input[commandField] ?? '')
  // `~` / `..` are only treated as PATHS when what follows them looks like a
  // path or ends the argument: a `/`, a quote, end-of-command, or optional
  // whitespace followed by a shell separator (`&&`, `||`, `;`, `|`, `)`, `>`).
  //
  // The trailing alternative used to be a bare `\s`, i.e. "anything followed by
  // a space". That made `~` and `..` un-typable in their far more common
  // NON-path roles and denied ordinary commands with a message pointing at the
  // wrong thing entirely:
  //   awk '$1 ~ /x/'   → "references home (~) — outside workspace"
  //   echo "a .. b"    → "references parent path (..)"
  // `~` is awk's regex-match operator and appears in nearly every awk one-liner,
  // so the jail was rejecting a staple of shell work.
  //
  // Real escapes are still caught, because a path-shaped `~`/`..` always ends
  // the argument or is followed by `/`:
  //   cat ~/.ssh/id_rsa · rm -rf ~ · cd ~ && ls · rm -rf "~"
  //   cat ../../etc/passwd · cd .. · cd .. ; ls
  const PATH_TAIL = String.raw`(?:\/|['"]|$|\s*(?:$|[;&|)]|>{1,2}))`
  const homeRe   = new RegExp(String.raw`(?:^|[\s'"=:(])~${PATH_TAIL}`)
  const parentRe = new RegExp(String.raw`(?:^|[\s'"=:(])\.\.${PATH_TAIL}`)
  if (homeRe.test(command)) {
    return 'bash command references home (~) — outside workspace'
  }
  if (/\$\{?HOME\b/.test(command)) {
    return 'bash command references $HOME — outside workspace'
  }
  if (parentRe.test(command)) {
    return 'bash command references parent path (..) — may escape workspace'
  }
  // Filesystem root as a target: `/` or `/*` (optionally quoted). The leading
  // boundary excludes in-workspace absolute paths like `/repo/src` (the char
  // after `/` would be a letter, not `*`/space/end/quote).
  if (/(?:^|[\s'"=:(])\/(?:\*|\s|$|['"])/.test(command)) {
    return 'bash command targets filesystem root (/ or /*) — outside workspace'
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
      return {
        behavior: 'deny',
        reason: guard.reason ?? 'User denied this operation.',
        ...(guard.decidedBy ? { decidedBy: guard.decidedBy } : {}),
      }
    }
    if (guard.action === 'redirect') {
      return {
        behavior: 'redirect',
        message: `[用户提供替代指导]\n${guard.instructions}\n\n请完全按照上述指导重新规划并执行。`,
        ...(guard.decidedBy ? { decidedBy: guard.decidedBy } : {}),
      }
    }
    return { behavior: 'allow', ...(guard.decidedBy ? { decidedBy: guard.decidedBy } : {}) }
  }

  const askUser = options.askUser ?? context.askUser
  if (askUser) {
    const inputStr = JSON.stringify(input, null, 2).slice(0, 400)
    const answer = await askUser(`${fallbackReason}\n${inputStr}`, ['yes', 'no'])
    return answer.toLowerCase().startsWith('y')
      ? { behavior: 'allow', decidedBy: 'human' }
      : { behavior: 'deny', reason: `${toolName} was not approved by user.`, decidedBy: 'human' }
  }

  return { behavior: 'deny', reason: `${fallbackReason} No approval channel is available.` }
}

export function createPermissionPolicy(options: PermissionPolicyOptions = {}): CanUseToolFn {
  const initialWorkspaceRoot = options.workspaceRoot ? resolve(options.workspaceRoot) : undefined
  const permissionConfig = loadPermissionConfig(
    initialWorkspaceRoot,
    options.permissionConfig,
    options.ignoreUserConfig,
  )
  const configuredRoot = permissionConfig.workspace?.root
  const workspaceRoot = configuredRoot
    ? resolve(initialWorkspaceRoot ?? process.cwd(), configuredRoot)
    : initialWorkspaceRoot
  const autonomy = options.autonomy
  // Auto-mode jail is absolute: lockWorkspace forces allowOutsideWorkspace off,
  // overriding any permissions.json that tries to unlock the boundary.
  const allowOutsideWorkspace =
    !autonomy?.lockWorkspace && permissionConfig.workspace?.allowOutsideWorkspace === true
  const allowTmp = permissionConfig.workspace?.allowTmp !== false
  // Canonicalised once: the containment test runs per path per command, and
  // realpath()ing the grant list on every call would be pure waste.
  const allowedRoots = (options.externalAllowedRoots ?? []).map(root => resolve(root))
  // Compiled once per policy: a shell-heavy turn evaluates this list on every
  // call, and rebuilding thirty regexes per command is pure waste.
  const compiledRules = compileCommandRules(
    loadCommandRules(workspaceRoot, options.commandRules, options.ignoreUserConfig),
  )

  return async (
    tool: KernelTool,
    input: unknown,
    _assistantMessageUuid: string,
    _toolUseId: string,
    context,
  ): Promise<CanUseToolResult> => {
    const record = asRecord(input)
    let approvalDecidedBy: PermissionDecisionSource | undefined
    // Precedence (low → high): DEFAULT_TOOL_PERMISSIONS < tool's own declaration
    // < user permissions.json. The user config file is the highest authority so
    // an operator can flip any tool's gates (e.g. sensitive) without code changes.
    const permission = mergePermissionDeclaration(
      mergePermissionDeclaration(DEFAULT_TOOL_PERMISSIONS[tool.name], tool.permission),
      permissionConfig.tools?.[tool.name],
    )
    warnIfJailIsInert(tool.name, permission)

    if (permission.enabled === false) {
      return { behavior: 'deny', reason: `Tool "${tool.name}" is disabled by permissions config.` }
    }

    // Autonomy capability boundary: some tools can mutate global/remote state
    // that cannot be proven to stay inside the workspace jail. Deny them before
    // any path checks or approval logic. This also covers tools manually
    // registered by embedders, so filtering the standard toolset is not the
    // only line of defence.
    if (autonomy?.deniedTools?.includes(tool.name)) {
      return {
        behavior: 'deny',
        reason: `Tool "${tool.name}" is unavailable in autonomous mode because its effects cannot be confined to the workspace.`,
      }
    }

    // jailActive: the workspace boundary is enforced for this tool, so any
    // path/cwd/absolute-bash-path escape has already been denied below this
    // point. Auto-approve (§autonomy) keys off this so it can only skip the
    // confirm guard for operations we've proven stay inside the workspace.
    const jailActive = !!workspaceRoot && !allowOutsideWorkspace && permission.requiresWorkspace !== false

    if (jailActive) {
      const violation = findWorkspaceViolation(
        tool, record, workspaceRoot!, permission, allowTmp, allowedRoots,
      )
      if (violation) return { behavior: 'deny', reason: violation }
      // Workspace-jail hardening (ALL modes, not just auto): the absolute-path
      // scan misses relative escapes (~, $HOME, leading ../) and bare
      // filesystem-root targets (/, /*). Catch them here so the jail is
      // consistent with the absolute-path denial above, and before any
      // auto-approve can fire. Opt out via workspace.allowOutsideWorkspace
      // (which turns jailActive off and skips this block).
      //
      // Subscribed by declaration (permission.commandField), not by tool name —
      // the name-keyed version of this check is exactly what let cron_create
      // through with a raw `bash -c` payload.
      if (permission.commandField) {
        const escape = findBashRelativeEscape(record, permission.commandField)
        if (escape) return { behavior: 'deny', reason: escape }
      }
    }

    const commandField = permission.commandField
    const sensitiveLabel = commandField
      ? detectSensitiveCommand(record, commandField, compiledRules)
      : null

    // Resolve whether this call needs an approval gate.
    //
    // Shell tools are special-cased because their BUILT-IN `sensitive: true`
    // declaration (DEFAULT_TOOL_PERMISSIONS + the tool's own permission block)
    // means "ask when a SENSITIVE_SHELL_PATTERNS rule matches", NOT "ask on
    // every command" — prompting for every `ls` would make the tool unusable.
    //
    // That special case used to be written as `tool.name !== 'bash'` inside the
    // gate condition, which silently swallowed an operator's explicit
    // `permissions.json` override too: `{"tools":{"bash":{"sensitive":true}}}`
    // did nothing at all, with no warning — on the single most dangerous tool.
    // So the user config is now read separately from the merged declaration and
    // is authoritative in BOTH directions:
    //   true      → every shell command needs approval
    //   false     → no shell command needs approval (not even pattern matches)
    //   undefined → built-in behaviour: approve-on-pattern-match
    // Non-shell tools keep using the merged declaration, where the user config
    // already wins by merge precedence.
    const userSensitiveOverride = permissionConfig.tools?.[tool.name]?.sensitive
    const needsApproval = commandField
      ? (userSensitiveOverride ?? sensitiveLabel !== null)
      : permission.sensitive === true

    if (needsApproval) {
      // Auto mode: a sensitive op that passed the jail's path checks is
      // auto-approved without a prompt. jailActive means the absolute-path
      // violation scan + relative/root-escape checks already ran, so the
      // obvious escapes are denied before reaching here. This is best-effort
      // defense-in-depth, NOT a proof of containment (a determined command can
      // still obfuscate a path) — the real boundary is the fail-closed OS
      // sandbox below. Out-of-workspace ops never reach here (denied above), and
      // tools exempt from the jail (requiresWorkspace: false, e.g. config) are
      // NOT auto-approved.
      const autoApproveInWorkspace = autonomy?.autoApproveInWorkspace === true && jailActive
      if (!autoApproveInWorkspace) {
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
        approvalDecidedBy = guard.decidedBy
      }
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
      if (planMode === 'allow') {
        return { behavior: 'allow', ...(approvalDecidedBy ? { decidedBy: approvalDecidedBy } : {}) }
      }
      if (planMode === 'deny') {
        return { behavior: 'deny', reason: `[Plan Mode] Tool "${tool.name}" is denied by permissions config.` }
      }
      const askUser = options.askUser ?? context.askUser
      if (askUser) {
        const inputStr = JSON.stringify(input, null, 2).slice(0, 400)
        const answer = await askUser(`[Plan Mode] Allow tool "${tool.name}"?\n${inputStr}`, ['yes', 'no'])
        if (!answer.toLowerCase().startsWith('y')) {
          return {
            behavior: 'deny',
            reason: `[Plan Mode] Tool "${tool.name}" was not approved by user.`,
            decidedBy: 'human',
          }
        }
        approvalDecidedBy = 'human'
      } else {
        return { behavior: 'deny', reason: `[Plan Mode] Tool "${tool.name}" requires approval.` }
      }
    }

    // ── External hook veto ───────────────────────────────────────────────────
    // Last, and only on the allow path. Everything above has already decided
    // this call is permitted; a `pre_tool_use` hook gets the final say on
    // whether it actually happens.
    //
    // Placing it here — rather than earlier, where it could also see denials —
    // is what makes the "veto only, never grant" rule structural instead of a
    // convention: a hook is never consulted about an operation the policy
    // rejected, so there is no code path in which its answer could revive one.
    if (options.hookRunner?.has('pre_tool_use', tool.name)) {
      const outcome = await options.hookRunner.run(
        'pre_tool_use',
        {
          sessionId: context.sessionId ?? '',
          ...(workspaceRoot ? { workspaceRoot } : {}),
          toolName: tool.name,
          toolInput: record,
        },
        context.abortSignal ?? new AbortController().signal,
      )
      if (outcome.denied) {
        return {
          behavior: 'deny',
          reason: outcome.reason ?? `Tool "${tool.name}" was denied by a pre_tool_use hook.`,
          decidedBy: 'hook',
        }
      }
    }

    return { behavior: 'allow', ...(approvalDecidedBy ? { decidedBy: approvalDecidedBy } : {}) }
  }
}
