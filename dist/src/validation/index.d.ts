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
export type { VVPhase, VVSeverity, VVSuggestedAction, VVResult, VVContext, VVHook, } from './types.js';
export { defaultAction, requiresAbort, requiresPause, failures, maxSeverity, } from './types.js';
export { VVHookChain } from './VVHookChain.js';
export { OOMChecker, BUILT_IN_OOM_DB } from './built-in/OOMChecker.js';
export type { OOMRange, OOMReferenceDB } from './built-in/OOMChecker.js';
export { PhysicsConstraintChecker } from './built-in/PhysicsConstraintChecker.js';
export { DimensionChecker } from './built-in/DimensionChecker.js';
import { VVHookChain } from './VVHookChain.js';
export declare function createDefaultVVChain(): VVHookChain;
//# sourceMappingURL=index.d.ts.map