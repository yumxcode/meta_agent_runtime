/**
 * VVHookChain — registers VVHooks and runs them in order for a given phase.
 *
 * Design decisions:
 *
 * 1. Hooks are run sequentially (not in parallel) so that a critical failure
 *    in an early hook can short-circuit the rest.  This avoids wasting compute
 *    on checks downstream of a known abort condition.
 *
 * 2. A hook is "applicable" if:
 *    - Its `phase` matches (or includes) the requested phase, AND
 *    - Its `appliesTo` is '*' or includes the tool name.
 *
 * 3. Each hook is wrapped in try/catch — a buggy hook must never crash the
 *    tool call it's protecting.  Hook errors are returned as VVResult with
 *    passed=true so they don't block execution (but they log a warning).
 *
 * 4. Short-circuit on 'abort': once any hook returns a critical failure, the
 *    remaining hooks for that phase are skipped.
 *
 * Usage:
 *
 *   const chain = new VVHookChain()
 *   chain.register(new OOMChecker(myReferenceDB))
 *   chain.register(new PhysicsConstraintChecker())
 *
 *   const results = await chain.run({
 *     phase: 'post_call',
 *     toolName: 'fem_stress',
 *     input:  { force: 1000, area: 0.01 },
 *     output: { stress: 1e8 },
 *     sessionId: '...',
 *     agentId: '...',
 *   })
 *
 *   if (requiresAbort(results)) { ... }
 */

import type { VVHook, VVResult, VVContext, VVPhase } from './types.js'
import { requiresAbort } from './types.js'

export class VVHookChain {
  private readonly hooks: VVHook[] = []

  // ── Registration ──────────────────────────────────────────────────────────

  register(hook: VVHook): void {
    if (this.hooks.some(h => h.name === hook.name)) {
      throw new Error(`VVHookChain: hook "${hook.name}" is already registered`)
    }
    this.hooks.push(hook)
  }

  unregister(hookName: string): void {
    const idx = this.hooks.findIndex(h => h.name === hookName)
    if (idx !== -1) this.hooks.splice(idx, 1)
  }

  /** Replace an existing hook (same name) with a new implementation */
  replace(hook: VVHook): void {
    const idx = this.hooks.findIndex(h => h.name === hook.name)
    if (idx === -1) {
      this.hooks.push(hook)
    } else {
      this.hooks[idx] = hook
    }
  }

  /** All registered hook names */
  get names(): string[] {
    return this.hooks.map(h => h.name)
  }

  // ── Execution ─────────────────────────────────────────────────────────────

  /**
   * Run all applicable hooks for the given context.
   *
   * Hooks are executed in registration order.
   * Short-circuits on 'abort' severity.
   *
   * Never throws — errors inside hooks become passing VVResults with a note.
   */
  async run(context: VVContext): Promise<VVResult[]> {
    const applicable = this._applicable(context.phase, context.toolName)
    const results: VVResult[] = []

    for (const hook of applicable) {
      let result: VVResult
      try {
        result = await hook.run(context)
      } catch (err) {
        // Hook crashed — don't block execution, but log it
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(`[VVHookChain] Hook "${hook.name}" threw unexpectedly: ${msg}`)
        result = {
          hookName: hook.name,
          passed: true,   // don't block — the hook itself is broken, not the tool
          severity: 'warning',
          message: `Hook "${hook.name}" encountered an internal error: ${msg}`,
          suggestedAction: 'warn_user',
        }
      }
      results.push(result)

      // Short-circuit on abort
      if (requiresAbort([result])) break
    }

    return results
  }

  // ── Convenience: run for a specific phase ─────────────────────────────────

  /** Run all pre_call hooks for a tool */
  async runPreCall(toolName: string, input: unknown, sessionId: string, agentId: string): Promise<VVResult[]> {
    return this.run({
      phase: 'pre_call',
      toolName,
      input: input as any,
      sessionId,
      agentId,
    })
  }

  /** Run all post_call hooks for a tool */
  async runPostCall(
    toolName: string,
    input: unknown,
    output: unknown,
    sessionId: string,
    agentId: string,
    jobId?: string,
    fidelityLevel?: number,
  ): Promise<VVResult[]> {
    return this.run({
      phase: 'post_call',
      toolName,
      input: input as any,
      output: output as any,
      sessionId,
      agentId,
      jobId,
      fidelityLevel,
    })
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private _applicable(phase: VVPhase, toolName: string): VVHook[] {
    return this.hooks.filter(hook => {
      const phases = Array.isArray(hook.phase) ? hook.phase : [hook.phase]
      if (!phases.includes(phase)) return false
      if (hook.appliesTo === '*') return true
      return hook.appliesTo.includes(toolName)
    })
  }
}
