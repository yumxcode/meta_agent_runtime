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
