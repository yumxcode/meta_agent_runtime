/**
 * V&V (Validation & Verification) — public exports
 *
 * Quick-start:
 *
 *   import { VVHookChain, OOMChecker, PhysicsConstraintChecker } from '@meta-agent/runtime'
 *
 *   const vv = new VVHookChain()
 *   vv.register(new OOMChecker())
 *   vv.register(new PhysicsConstraintChecker())
 *
 *   const results = await vv.runPostCall('my_tool', input, output, sessionId, agentId)
 *   if (requiresAbort(results)) { ... }
 */
export { defaultAction, requiresAbort, requiresPause, failures, maxSeverity, } from './types.js';
// Chain
export { VVHookChain } from './VVHookChain.js';
// Built-in hooks
export { OOMChecker, BUILT_IN_OOM_DB } from './built-in/OOMChecker.js';
export { PhysicsConstraintChecker } from './built-in/PhysicsConstraintChecker.js';
export { DimensionChecker } from './built-in/DimensionChecker.js';
// Convenience: create a fully-loaded default chain
import { VVHookChain } from './VVHookChain.js';
import { OOMChecker } from './built-in/OOMChecker.js';
import { PhysicsConstraintChecker } from './built-in/PhysicsConstraintChecker.js';
import { DimensionChecker } from './built-in/DimensionChecker.js';
export function createDefaultVVChain() {
    const chain = new VVHookChain();
    chain.register(new OOMChecker());
    chain.register(new PhysicsConstraintChecker());
    chain.register(new DimensionChecker());
    return chain;
}
//# sourceMappingURL=index.js.map