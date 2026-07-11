/**
 * loop/reduce — the deterministic code-node backend kept from v1 (spec §7, D3):
 * content-addressed freeze store, security review, and a sandboxed child-process
 * runner. Decoupled from the retired graph IR; wired into v2 custom reduction
 * when that lands.
 *
 * TRACKING (2026-07-10 review, L9): currently has NO callers outside its own
 * tests — kept deliberately for the v2 custom-reduction milestone. If that
 * milestone is dropped, delete this module rather than letting it rot.
 */
export * from './types.js'
export {
  CodeNodeArtifact,
  hashCodeSource,
  codeRefForHash,
  resolveCodeRef,
  writeCodeNodeArtifact,
  readCodeNodeSource,
} from './CodeNodeStore.js'
export { CodeNodeRunner, type CodeNodeRunnerOptions } from './CodeNodeRunner.js'
export {
  reviewCodeNodeSource,
  materializeCodeNodes,
  type CodeNodeMaterializeDeps,
  type CodeNodeMaterializeResult,
} from './CodeNodeAuthor.js'
