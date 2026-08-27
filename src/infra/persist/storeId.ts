/**
 * persist/storeId — single source of truth for "is this string safe to use as
 * a path segment inside a store root?".
 *
 * Why this exists (P0-1, review 2026-08-27):
 *
 * Every file-backed store in this codebase derived its on-disk layout with a
 * bare `join(root, id)`. `join()` normalises `..` rather than rejecting it, so
 * `new JobStore('..').save({ jobId: 'config' })` resolved to
 * `$META_AGENT_HOME/config.json` and overwrote the runtime config. The same
 * shape in `SessionStore.deleteSession()` reached a recursive `rm()`.
 *
 * Two independent defences, because either one alone has a known bypass:
 *
 *   1. `validateStoreId()` — a strict allow-list on the *input*. Catches `..`,
 *      separators, absolute paths, NUL, and Windows oddities (drive letters,
 *      ADS `:` streams, trailing dots/spaces that Win32 silently strips)
 *      before they ever reach the filesystem layer.
 *   2. `resolveWithinRoot()` — a containment check on the *output*. Catches
 *      anything the allow-list did not anticipate, including symlinked roots
 *      and future callers that build multi-segment paths.
 *
 * Both fail closed: they throw `StoreIdError` rather than sanitising. Silently
 * rewriting an id would make two logically distinct records collide on one
 * file, which trades a loud failure for quiet data loss.
 */

import { isAbsolute, relative, resolve, sep } from 'path'

/** Thrown when an identifier is not safe to use as a path segment. */
export class StoreIdError extends Error {
  readonly code = 'ERR_INVALID_STORE_ID'
  constructor(message: string) {
    super(message)
    this.name = 'StoreIdError'
  }
}

/**
 * Allowed identifier shape: ASCII alphanumerics plus `_`, `-`, `.`.
 *
 * `.` is permitted because real ids embed it (timestamps, semver-ish suffixes),
 * but the dot-only forms `.` and `..` are rejected separately below — matching
 * on the character class alone would let `..` through.
 */
const STORE_ID_PATTERN = /^[A-Za-z0-9._-]+$/

/** Hard cap: keeps us clear of the 255-byte per-component limit on ext4/APFS. */
const MAX_STORE_ID_LENGTH = 200

/**
 * Validate an identifier destined to become exactly one path segment.
 *
 * @param id    the untrusted identifier
 * @param label what the id is, used in the error message (e.g. `'sessionId'`)
 * @returns the id unchanged, so call sites can inline it
 * @throws {StoreIdError} on anything that is not a plain, safe segment
 */
export function validateStoreId(id: string, label = 'id'): string {
  if (typeof id !== 'string') {
    throw new StoreIdError(`${label} must be a string, received ${typeof id}`)
  }
  if (id.length === 0) {
    throw new StoreIdError(`${label} must not be empty`)
  }
  if (id.length > MAX_STORE_ID_LENGTH) {
    throw new StoreIdError(
      `${label} must be at most ${MAX_STORE_ID_LENGTH} characters (received ${id.length})`,
    )
  }
  if (id.includes('\0')) {
    throw new StoreIdError(`${label} must not contain NUL bytes`)
  }
  if (id === '.' || id === '..') {
    throw new StoreIdError(`${label} must not be "${id}"`)
  }
  // Check separators before the pattern so the error names the actual problem.
  if (id.includes('/') || id.includes('\\')) {
    throw new StoreIdError(`${label} must not contain path separators (received ${JSON.stringify(id)})`)
  }
  if (isAbsolute(id)) {
    throw new StoreIdError(`${label} must not be an absolute path (received ${JSON.stringify(id)})`)
  }
  // Win32 drive-relative (`C:foo`) and NTFS alternate data streams (`x:stream`)
  // both hinge on a colon, which is legal in a POSIX filename. Reject on every
  // platform so a store written on Linux stays loadable on Windows.
  if (id.includes(':')) {
    throw new StoreIdError(`${label} must not contain ":" (received ${JSON.stringify(id)})`)
  }
  // Win32 strips trailing dots and spaces, so `foo.` and `foo` would alias.
  if (/[. ]$/.test(id)) {
    throw new StoreIdError(`${label} must not end with a dot or space (received ${JSON.stringify(id)})`)
  }
  if (!STORE_ID_PATTERN.test(id)) {
    throw new StoreIdError(
      `${label} may only contain letters, digits, "." , "_" and "-" (received ${JSON.stringify(id)})`,
    )
  }
  return id
}

/** Non-throwing probe, for callers that filter rather than fail (e.g. listings). */
export function isValidStoreId(id: string): boolean {
  try {
    validateStoreId(id)
    return true
  } catch {
    return false
  }
}

/**
 * Resolve `segments` under `root` and prove the result stayed inside it.
 *
 * This is the second line of defence and is deliberately independent of
 * `validateStoreId()`: it re-checks the *resolved* path, so it also covers
 * multi-segment joins and ids that were validated by an older/looser rule.
 *
 * @throws {StoreIdError} if the resolved path escapes `root`
 */
export function resolveWithinRoot(root: string, ...segments: string[]): string {
  const absoluteRoot = resolve(root)
  // Zero segments means "normalise the root", which is a legitimate ask.
  if (segments.length === 0) return absoluteRoot

  const target = resolve(absoluteRoot, ...segments)
  const rel = relative(absoluteRoot, target)
  // `relative()` yields '' when the segments resolved back to the root itself
  // (`resolveWithinRoot(root, '.')` — always a caller bug, since they asked for
  // a record *inside* the root), a `..`-prefixed path for anything above it,
  // and an absolute path when the two live on different Windows drives.
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new StoreIdError(
      `resolved path escapes its store root: ${JSON.stringify(target)} is outside ${JSON.stringify(absoluteRoot)}`,
    )
  }
  return target
}
