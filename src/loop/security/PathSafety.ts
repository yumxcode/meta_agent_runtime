import { isAbsolute, relative, resolve, sep } from 'path'
import { realpath, stat } from 'fs/promises'

const GLOB_META_RE = /[*?[\]{}]/
const WINDOWS_ABSOLUTE_RE = /^[a-zA-Z]:[\\/]/

/** Validate a charter path before it is frozen. Both POSIX and Windows
 * separators are treated as separators so a charter cannot become unsafe when
 * moved between hosts. */
export function relativePathError(value: string): string | null {
  if (typeof value !== 'string' || !value.trim()) return 'must be a non-empty relative path'
  if (isAbsolute(value) || WINDOWS_ABSOLUTE_RE.test(value) || value.startsWith('\\')) {
    return 'must be relative'
  }
  const segments = value.split(/[\\/]+/)
  if (segments.includes('..')) return "must not contain '..'"
  return null
}

function isOutside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)
}

/** Lexical containment for paths that may not exist yet. */
export function resolveInside(root: string, rel: string): string {
  const err = relativePathError(rel)
  if (err) throw new Error(`unsafe relative path '${rel}': ${err}`)
  const absoluteRoot = resolve(root)
  const target = resolve(absoluteRoot, rel)
  if (isOutside(absoluteRoot, target)) throw new Error(`path escapes root: ${rel}`)
  return target
}

/** Read-side containment. realpath closes symlink escapes after the lexical
 * check. The target must exist; callers should treat failures as gate errors,
 * never as an absent optional file when the path itself is unsafe. */
export async function resolveExistingInside(root: string, rel: string): Promise<string> {
  const target = resolveInside(root, rel)
  const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(target)])
  if (isOutside(realRoot, realTarget)) throw new Error(`path escapes root through symlink: ${rel}`)
  return realTarget
}

/** Convert the intentionally small writeScope language into a path the OS
 * sandbox can enforce exactly. Supported forms are a literal existing file or
 * directory, or a trailing recursive directory-tree glob (for example,
 * `path/**`).
 * Arbitrary globs such as `src/**\/*.ts` cannot be represented by Seatbelt or
 * bwrap and are rejected instead of silently widening access. */
export function writeScopeRoot(scope: string): string {
  const err = relativePathError(scope)
  if (err) throw new Error(err)
  const normalized = scope.replace(/\\/g, '/')
  const root = normalized.replace(/\/\*\*(?:\/\*)?$/, '')
  if (!root || root === '.') throw new Error('must not grant the workspace root')
  if (GLOB_META_RE.test(root)) {
    throw new Error("only a literal path or trailing '/**' directory tree is supported")
  }
  return root
}

/** Runtime write-side validation. bwrap bind sources must exist, and resolving
 * the real path prevents a declared symlink from granting a path outside the
 * workspace. */
export async function resolveWriteScopeRoot(projectDir: string, scope: string): Promise<string> {
  const root = writeScopeRoot(scope)
  const target = await resolveExistingInside(projectDir, root)
  await stat(target) // make the existence requirement explicit in diagnostics
  return target
}
