/**
 * The package entry point must actually export what the docs promise.
 *
 * `package.json` maps `exports: "."` to `dist/index.js`, so `src/index.ts` is
 * the ONLY surface a consumer can reach. Everything else — `tools/index.ts`,
 * `infra/...` — is internal wiring no `import` from the published package can
 * see.
 *
 * That distinction is easy to lose while working inside the repo, where every
 * module is reachable by relative path and the tests import them directly. The
 * v0.9.0 tool additions were exported from `tools/index.ts`, used correctly by
 * every in-repo test, and were still absent from the package: the gap only
 * surfaced when a tarball was installed into a scratch project and a consumer
 * `import` threw "does not provide an export named 'createApplyPatchTool'".
 *
 * Type-only exports are deliberately NOT asserted here — they are erased at
 * runtime, so `tsc --noEmit` already proves them and this test could not.
 */
import { describe, it, expect } from 'vitest'
import * as pkg from '../index.js'

/**
 * Runtime values a consumer is documented to be able to import.
 *
 * Add to this list when a feature gains public surface; the README section that
 * documents it is the trigger. Nothing here is load-bearing at runtime — the
 * list exists so that "I forgot the barrel export" fails in CI instead of on a
 * user's first install.
 */
const PUBLIC_VALUES: Record<string, readonly string[]> = {
  'persistent shell sessions': [
    'createShellTools',
    'createExecSessionTool',
    'createWriteStdinTool',
    'createCloseSessionTool',
    'ShellSessionStore',
    'shellSessionStore',
    'resetShellSessionStore',
    'ShellSessionNotFound',
    'ShellSessionExited',
    'SHELL_SESSION_DEFAULTS',
  ],
  'atomic patches and turn diffs': [
    'createApplyPatchTool',
    'createTurnDiffTool',
    'parsePatch',
    'applyHunks',
    'describeOperations',
    'PatchParseError',
    'PatchApplyError',
    'unifiedDiff',
    'diffLines',
    'diffStat',
    'splitLines',
    'TurnDiffTracker',
    'TURN_DIFF_LIMITS',
  ],
  'deferred tool schemas': [
    'createToolSearchTool',
    'ToolVisibilityRegistry',
    'toolVisibility',
    'resetToolVisibility',
    'visibleToolsForApi',
    'searchTools',
    'namespaceOf',
    'isDeferred',
    'eagerToolsForced',
    'DEFAULT_NAMESPACE',
  ],
  'pre-existing core surface': [
    'SessionRouter',
    'MetaAgentSession',
    'createStandardTools',
    'createFsTools',
    'createRuntimeContext',
    'instrumentTool',
  ],
}

describe('public entry surface', () => {
  for (const [feature, names] of Object.entries(PUBLIC_VALUES)) {
    it(`exports the ${feature} surface`, () => {
      const missing = names.filter(n => (pkg as Record<string, unknown>)[n] === undefined)
      expect(
        missing,
        `missing from src/index.ts — these are reachable in-repo by relative ` +
        `path but NOT from the published package`,
      ).toEqual([])
    })
  }

  it('exports every name as the kind it is declared as', () => {
    // A barrel that re-exports a class as undefined (a common outcome of a
    // circular import) type-checks fine and fails only when called.
    const factories = Object.values(PUBLIC_VALUES).flat()
      .filter(n => n.startsWith('create'))
    for (const name of factories) {
      expect(typeof (pkg as Record<string, unknown>)[name], name).toBe('function')
    }
  })
})
