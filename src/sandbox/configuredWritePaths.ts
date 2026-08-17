/**
 * Legacy entry point — superseded by `sandboxPolicyConfig.ts`.
 *
 * `sandbox.writeAllowPaths` used to be the only operator-controlled sandbox
 * setting, so this module was named after it. The policy now also covers
 * read grants, deny lists, network and credential protection, so the
 * implementation moved to a module named for what it does. This file stays as a
 * re-export so existing imports keep working.
 */

export {
  resolveConfiguredWriteAllowPaths,
  resolveHostPathRequirement,
  resolveSandboxPolicy,
  applySandboxPolicy,
  expandHostPath,
  DEFAULT_CREDENTIAL_DENY_PATHS,
  type ResolvedSandboxPolicy,
} from './sandboxPolicyConfig.js'
