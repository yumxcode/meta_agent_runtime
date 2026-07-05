/**
 * core/roles — the review-role skeleton (spec §7 迁移清单): RoleCatalog +
 * reviewer spawn helpers + the unified verdict. Relocated out of the retired
 * core/auto_orch on v1 deletion; it powers auto-mode verify/drift gates today
 * and is the spawn skeleton v2 loop seats reuse. Decoupled from the graph IR.
 */
export {
  RoleCatalog,
  defaultRoleCatalog,
  goalWithCriteria,
  type RoleContext,
  type RoleHandler,
  type RoleHandlerInput,
  type RoleDefinition,
} from './RoleRegistry.js'
export {
  ROLE_TOOLS_READONLY,
  roleSystemPrompt,
  parseRoleVerdict,
  runReviewer,
  type ReviewerInput,
} from './reviewer.js'
export {
  type VerdictAction,
  type OrchVerdict,
  continueVerdict,
  skippedVerdict,
  fromDrift,
  fromVerify,
  type DriftVerdictLike,
  type VerifyVerdictLike,
} from './Verdict.js'
