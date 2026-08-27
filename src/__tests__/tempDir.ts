/**
 * Test helper: temp directories whose paths match what the runtime will see.
 *
 * Why this exists (§8.1, review 2026-08-27)
 * -----------------------------------------
 * On macOS `os.tmpdir()` returns `/var/folders/…`, and `/var` is a symlink to
 * `/private/var`. Path-guard code in this repo canonicalises with
 * `realpathSync()` before comparing — deliberately, because two different
 * spellings of one directory must not be able to sit on opposite sides of a
 * containment check.
 *
 * Tests that built expectations from the *lexical* `mkdtempSync()` result were
 * therefore comparing `/var/folders/…` against the runtime's
 * `/private/var/folders/…` and failing on macOS only, while passing in CI on
 * Linux where `/tmp` is a real directory. The production behaviour was right;
 * the test fixtures were the thing that had drifted.
 *
 * Use these instead of `mkdtempSync(join(tmpdir(), …))` in any test that
 * compares a path against one the runtime produced, or that feeds a path to a
 * workspace guard.
 */

import { mkdtempSync, realpathSync } from 'node:fs'
import { mkdtemp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Create a temp directory and return its fully-resolved path.
 *
 * @param prefix directory-name prefix, as for `mkdtempSync`
 */
export function makeTempDirSync(prefix: string): string {
  return realpathSync(mkdtempSync(join(realpathSync(tmpdir()), prefix)))
}

/** Async twin of {@link makeTempDirSync}. */
export async function makeTempDir(prefix: string): Promise<string> {
  return realpath(await mkdtemp(join(await realpath(tmpdir()), prefix)))
}

/**
 * Canonicalise a path the same way the runtime's guards do.
 *
 * For assertions about a path that may not exist yet — `realpathSync` throws on
 * a missing path, so resolve the existing prefix and re-append the rest.
 */
export function canonicalise(path: string): string {
  return realpathSync(path)
}
