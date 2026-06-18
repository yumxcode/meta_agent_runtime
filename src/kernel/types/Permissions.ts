/**
 * Permissions.ts — permission/autonomy type contracts owned by the kernel.
 *
 * These types are consumed by the kernel permission policy (`canUseTool`) and
 * the tool contract, so they live in the bottom layer (kernel) rather than in
 * `core`. `core/types.ts` re-exports them for backward compatibility, so every
 * existing `import { ToolPermissionDeclaration } from '../core/types.js'` keeps
 * working while the kernel no longer has to reach UP into core (which inverted
 * the layering — see architecture-review-2026-06-18.md §1.3).
 */

/** Broad capability class used by the kernel permission policy. */
export type ToolPermissionCategory =
  | 'read'
  | 'write'
  | 'execute'
  | 'network'
  | 'config'
  | 'state'

/**
 * Autonomy profile — the "auto mode" capability switches.
 *
 * Deliberately generic: the kernel PermissionPolicy and MetaAgentSession act on
 * these booleans, NOT on a SessionMode string, so the routing layer is the only
 * place that knows `mode === 'auto'`. This keeps the permission/sandbox layers
 * decoupled from the mode enum (no `if (mode === 'auto')` below routing).
 */
export interface AutonomyProfile {
  /**
   * When true, sensitive operations whose paths are ALL inside the workspace are
   * auto-approved without the interactive confirmation guard. Paths outside the
   * workspace are still hard-denied (never prompted). This is the source of
   * auto mode's "don't stop to ask" behaviour.
   */
  autoApproveInWorkspace?: boolean
  /**
   * When true, the workspace jail cannot be unlocked by configuration:
   * `permissions.json`'s `allowOutsideWorkspace` is forced to false, and the OS
   * sandbox is fail-closed (no silent unsandboxed fallback when bwrap /
   * sandbox-exec is unavailable).
   */
  lockWorkspace?: boolean
  /**
   * Tool names that are categorically unavailable to an unattended session.
   *
   * This is a capability boundary, not a prompt hint: PermissionPolicy denies
   * these tools even when a caller manually registers them or permissions.json
   * attempts to relax their declaration. Use it for capabilities whose effects
   * cannot be proven to stay inside the workspace (remote MCP mutation, global
   * memory writes, unsandboxed process schedulers, etc.).
   */
  deniedTools?: readonly string[]
}

export interface ToolPermissionDeclaration {
  /** Broad capability class used by the kernel permission policy. */
  category?: ToolPermissionCategory
  /** Input fields that contain filesystem paths and must stay in workspace. */
  pathFields?: string[]
  /** Input field that contains a working directory, usually bash.cwd. */
  cwdField?: string
  /** Whether path/cwd fields are constrained to the workspace. Default: true for path-aware tools. */
  requiresWorkspace?: boolean
  /** Whether calls should go through interactive confirmation when available. */
  sensitive?: boolean
  /**
   * Request a durable checkpoint immediately before and/or after this tool.
   * Intended for long-running or non-idempotent external operations.
   */
  checkpointBoundary?: 'before' | 'after' | 'both'
  /** Plan-mode behavior for this tool. Default: ask for non-concurrency-safe tools. */
  planMode?: 'allow' | 'ask' | 'deny'
  /**
   * OS-level sandbox policy for this tool's execution.
   *
   * When set, MetaAgentSession._wrapTool() injects a SandboxHandle into the
   * ToolCallContext before each call, and the tool reads ctx.sandboxHandle to
   * wrap its subprocess execution.
   *
   * - true            → default policy: workspace root writable, network unrestricted
   * - SandboxConfig   → custom policy (e.g. deny network, extra write paths)
   * - undefined       → no OS-level sandbox (default)
   *
   * Tools that execute arbitrary shell commands (e.g. BashTool) should declare
   * sandbox: true so they are automatically sandboxed even in the main agent
   * session, not just inside isolated sub-agents.
   */
  sandbox?: true | import('../../sandbox/types.js').SandboxConfig
}
