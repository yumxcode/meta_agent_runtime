import { existsSync, realpathSync } from 'fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'path'

function findExistingAncestor(path: string): string {
  let current = path
  while (!existsSync(current)) {
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return current
}

/**
 * Canonicalise `path` for boundary checking: resolve the real path of the
 * nearest EXISTING ancestor (defeating symlink escapes) and re-attach the
 * not-yet-created tail (so a check works for files about to be written).
 *
 * Exported because every guard in the codebase needs exactly this, and the ones
 * that reimplemented it drifted — see the note on isInsideWorkspace.
 */
export function canonicalizeForGuard(path: string, base: string): string {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(base, path)
  if (existsSync(absolute)) return realpathSync(absolute)
  const ancestor = findExistingAncestor(absolute)
  const realAncestor = existsSync(ancestor) ? realpathSync(ancestor) : resolve(ancestor)
  return resolve(realAncestor, relative(ancestor, absolute))
}

/** Internal alias kept for readability at the original call sites. */
const resolvePathForGuard = canonicalizeForGuard

/**
 * Containment test on ALREADY-CANONICAL absolute paths.
 *
 * Uses path segments, not string prefixes: `startsWith` says
 * `/home/u/proj-backup` is inside `/home/u/proj`, which is how a prefix check
 * silently waves through a sibling directory.
 */
export function pathIsUnder(absolutePath: string, root: string): boolean {
  const rel = relative(root, absolutePath)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/**
 * Single source of truth for "is this path inside the workspace?".
 *
 * The kernel PermissionPolicy, the bash tool, the CLI's sensitive-op guard and
 * the sub-agent seat write guard all import from THIS module so the symlink
 * handling above cannot drift between them.
 *
 * That drift was not hypothetical. Two call sites had grown private copies:
 * `SubAgentRunner.canonicalGuardPath` (a line-for-line duplicate) and the CLI's
 * `detectSensitiveOp`, which used bare `filePath.startsWith(workspace)` — so
 * with workspace `/home/u/proj` it treated `/home/u/proj-backup/secret` as
 * inside and skipped the confirmation prompt entirely.
 */
export function isInsideWorkspace(path: string, workspaceRoot = process.cwd()): boolean {
  const workspace = existsSync(workspaceRoot) ? realpathSync(workspaceRoot) : resolve(workspaceRoot)
  // M4-fix: was a `startsWith(workspace + sep)` string prefix. Equivalent on
  // POSIX once the separator is appended, but this file's own history is about
  // guards that drifted apart, and pathIsUnder — the segment-wise test written
  // 20 lines above for exactly this question — also normalises separators, so
  // there is no reason for two containment semantics to coexist here.
  return pathIsUnder(resolvePathForGuard(path, workspace), workspace)
}

export function assertInsideWorkspace(path: string, workspaceRoot = process.cwd()): string | null {
  return isInsideWorkspace(path, workspaceRoot) ? null : `Error: path is outside workspace: ${path}`
}

/**
 * Validate AND canonicalise in one step — the single entry point FS/shell tools
 * should use so the path they check is byte-for-byte the path they execute on.
 *
 * The historical split (validate `filePath` against `workspaceRoot`, then run
 * `writeFile(filePath)`) diverges whenever `process.cwd() !== workspaceRoot`,
 * because Node resolves a relative `filePath` against cwd while the guard
 * resolved it against the workspace root. Returning the resolved absolute path
 * here closes that gap: callers execute on `result.path`, never on the raw
 * input.
 *
 * Returns `{ path }` (the workspace-relative-resolved real absolute path) when
 * inside the workspace, or `{ error }` with a ready-to-surface message.
 */
export function resolveInsideWorkspace(
  path: string,
  workspaceRoot = process.cwd(),
): { ok: true; path: string } | { ok: false; error: string } {
  const workspace = existsSync(workspaceRoot) ? realpathSync(workspaceRoot) : resolve(workspaceRoot)
  const target = resolvePathForGuard(path, workspace)
  return pathIsUnder(target, workspace)
    ? { ok: true, path: target }
    : { ok: false, error: `Error: path is outside workspace: ${path}` }
}
