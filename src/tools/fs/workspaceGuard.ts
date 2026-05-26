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

export function assertInsideWorkspace(path: string, workspaceRoot = process.cwd()): string | null {
  const workspace = existsSync(workspaceRoot) ? realpathSync(workspaceRoot) : resolve(workspaceRoot)
  const target = resolvePathForGuard(path, workspace)
  const inside = target === workspace || target.startsWith(workspace.endsWith(sep) ? workspace : workspace + sep)
  return inside ? null : `Error: path is outside workspace: ${path}`
}
