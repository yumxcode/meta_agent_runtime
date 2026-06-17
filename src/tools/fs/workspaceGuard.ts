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

function resolvePathForGuard(path: string, workspaceRoot: string): string {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(workspaceRoot, path)
  if (existsSync(absolute)) return realpathSync(absolute)
  const ancestor = findExistingAncestor(absolute)
  const realAncestor = existsSync(ancestor) ? realpathSync(ancestor) : resolve(ancestor)
  return resolve(realAncestor, relative(ancestor, absolute))
}

/**
 * Single source of truth for "is this path inside the workspace?".
 *
 * Both the kernel PermissionPolicy and the bash tool import THIS function so
 * the symlink-escape handling (resolve real path of the nearest existing
 * ancestor, then re-attach the non-existent tail) cannot drift between the
 * three call sites that historically each had their own copy.
 */
export function isInsideWorkspace(path: string, workspaceRoot = process.cwd()): boolean {
  const workspace = existsSync(workspaceRoot) ? realpathSync(workspaceRoot) : resolve(workspaceRoot)
  const target = resolvePathForGuard(path, workspace)
  return target === workspace || target.startsWith(workspace.endsWith(sep) ? workspace : workspace + sep)
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
  const inside =
    target === workspace || target.startsWith(workspace.endsWith(sep) ? workspace : workspace + sep)
  return inside
    ? { ok: true, path: target }
    : { ok: false, error: `Error: path is outside workspace: ${path}` }
}
