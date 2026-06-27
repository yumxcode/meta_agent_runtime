/**
 * RoleRegistry — the single source of truth for "what review roles exist".
 *
 * Before this, drift and verify were two hard-coded gate slots wired directly in
 * AgenticBackendFactory, while auto-orch graph nodes resolved roles ad hoc. The
 * catalogue unifies both: a role is defined ONCE here (by name) and exposes
 *   • buildHandler  — a node-level handler the orchestration graph (KernelNodeRunner)
 *                     uses for a `role` node, and
 *   • buildVerifyGate / buildDriftGate — the kernel-facing gate the loop consumes
 *                     at its structural boundaries (verify on "done", drift on the
 *                     turn interval).
 *
 * Crucially this does NOT touch the kernel: the loop still consumes the proven
 * `VerifyGateFn` / `DriftGateFn` contracts unchanged. The catalogue is the
 * AUTHORING layer that PRODUCES them (verify/drift delegate to the existing
 * makers), so adding a role — reviewer, cost_guard, security — is one entry and
 * both the graph and (where applicable) the loop can use it. Zero regression.
 */
import type { VerifyGateFn } from '../../kernel/loop/VerifyGate.js'
import type { DriftGateFn } from '../../kernel/loop/DriftGate.js'
import type { ISubAgentDispatcher } from '../../subagent/ISubAgentDispatcher.js'
import { makeAutoVerifyGate } from '../auto/verify/VerifyJudge.js'
import { makeAutoDriftGate } from '../auto/learn/DriftAgent.js'
import { fromVerify, fromDrift, type OrchVerdict } from './Verdict.js'
import { runReviewer } from './reviewer.js'

/** Shared deps every role builder receives. */
export interface RoleContext {
  dispatcher: ISubAgentDispatcher
  projectDir: string
  getGoal: () => string | null
}

/** Input to a node-level role handler (the node's criteria + abort signal). */
export interface RoleHandlerInput {
  criteria: string
  signal: AbortSignal
}

/** A node-level role handler: review the work, return a unified verdict. */
export type RoleHandler = (input: RoleHandlerInput) => Promise<OrchVerdict>

/** A role definition. verify/drift additionally expose a kernel gate builder. */
export interface RoleDefinition {
  name: string
  description?: string
  /** Node-level handler used by the orchestration graph. */
  buildHandler: (ctx: RoleContext) => RoleHandler
  /** Kernel completion-gate builder (only the 'verify' role provides this). */
  buildVerifyGate?: (ctx: RoleContext) => VerifyGateFn
  /** Kernel drift-gate builder (only the 'drift' role provides this). */
  buildDriftGate?: (ctx: RoleContext) => DriftGateFn
}

export class RoleCatalog {
  private readonly roles = new Map<string, RoleDefinition>()

  register(def: RoleDefinition): this {
    if (!def.name) throw new Error('role definition needs a name')
    this.roles.set(def.name, def)
    return this
  }

  has(name: string): boolean {
    return this.roles.has(name)
  }

  get(name: string): RoleDefinition | undefined {
    return this.roles.get(name)
  }

  names(): string[] {
    return [...this.roles.keys()]
  }

  /**
   * Resolve a node-level handler for `role`. Falls back to the generic reviewer
   * when the name is unknown, so a Planner-invented role label still works.
   */
  buildHandler(role: string, ctx: RoleContext): RoleHandler {
    const def = this.roles.get(role)
    if (def) return def.buildHandler(ctx)
    return ({ criteria, signal }) => runReviewer(ctx.dispatcher, { role, criteria, signal })
  }

  /** The kernel completion gate from the registered 'verify' role, if any. */
  buildVerifyGate(ctx: RoleContext): VerifyGateFn | undefined {
    return this.roles.get('verify')?.buildVerifyGate?.(ctx)
  }

  /** The kernel drift gate from the registered 'drift' role, if any. */
  buildDriftGate(ctx: RoleContext): DriftGateFn | undefined {
    return this.roles.get('drift')?.buildDriftGate?.(ctx)
  }
}

// ── Built-in roles ──────────────────────────────────────────────────────────────

/** verify: the completion judge. Kernel gate + node handler both delegate to it. */
const VERIFY_ROLE: RoleDefinition = {
  name: 'verify',
  description: '完成度审查：对照原始目标核对是否真正达成。',
  buildVerifyGate: ctx => makeAutoVerifyGate(ctx),
  buildHandler: ctx => {
    const gate = makeAutoVerifyGate(ctx)
    return async ({ signal }) =>
      fromVerify(await gate({ workspaceRoot: ctx.projectDir, turnCount: 0, round: 1, signal }))
  },
}

/** drift: the mid-flight course reviewer. Kernel gate + node handler delegate to it. */
const DRIFT_ROLE: RoleDefinition = {
  name: 'drift',
  description: '航向审查：对照原始目标判断是否偏离。',
  buildDriftGate: ctx => makeAutoDriftGate(ctx),
  buildHandler: ctx => {
    const gate = makeAutoDriftGate(ctx)
    return async ({ signal }) =>
      fromDrift(await gate({ workspaceRoot: ctx.projectDir, turnCount: 0, reason: 'turn_interval', signal }))
  },
}

/** reviewer: the generic read-only pass/fail reviewer (graph nodes only). */
const REVIEWER_ROLE: RoleDefinition = {
  name: 'reviewer',
  description: '通用只读复核：对照标准给出 pass/fail。',
  buildHandler: ctx => ({ criteria, signal }) =>
    runReviewer(ctx.dispatcher, { role: 'reviewer', criteria, signal }),
}

/** A catalogue pre-loaded with the three built-in roles. */
export function defaultRoleCatalog(): RoleCatalog {
  return new RoleCatalog()
    .register(VERIFY_ROLE)
    .register(DRIFT_ROLE)
    .register(REVIEWER_ROLE)
}
