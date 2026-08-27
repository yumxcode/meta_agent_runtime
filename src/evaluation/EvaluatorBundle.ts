/**
 * EvaluatorBundle — the checks that decide whether a case succeeded (G1-6,
 * minimum viable slice needed by the runner).
 *
 * ── Why the checks are not in the case ──────────────────────────────────────
 *
 * v1 put `setupCommands` and `check.command` directly in the EvalCase. That
 * makes every case an arbitrary command executed with the runner's authority,
 * and — worse — it puts the definition of success in the same document the
 * candidate generator is allowed to propose changes to. A candidate that can
 * influence its own passing condition is not being evaluated.
 *
 * So checks live in a separately versioned bundle, referenced by the case, and
 * the runner treats the bundle as a trust root:
 *
 *   - it must sit OUTSIDE the workspace the candidate runs in;
 *   - its content is hashed before the candidate runs and again before verify,
 *     and any change between the two aborts the verdict;
 *   - checks execute from the bundle directory with a minimal environment, so
 *     a file the candidate drops into the workspace cannot shadow them.
 *
 * The full G1-6 adds a separate OS identity, read-only mounts and independent
 * credentials. This slice deliberately stops short of that, and the runner
 * reports which protections were actually in force rather than implying all of
 * them (see `EvalRunReport.isolation`).
 */

import { createHash } from 'crypto'
import { join, resolve, sep } from 'path'
import { readdir, readFile, stat } from 'fs/promises'
import { z } from 'zod'

export const EvaluatorCheckSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  /** Shell command, run from the bundle directory. */
  command: z.string().min(1).max(4_000),
  /** Human-readable statement of what passing means. */
  statement: z.string().min(1).max(1_000),
  timeoutMs: z.number().int().positive().max(600_000).default(60_000),
}).strict()

export const EvaluatorBundleSchema = z.object({
  schemaVersion: z.literal('evaluator-bundle-1.0'),
  id: z.string().regex(/^evalbundle_[a-z0-9][a-z0-9_-]{2,63}$/),
  createdAt: z.number(),
  checks: z.array(EvaluatorCheckSchema).min(1).max(50),
}).strict()

export type EvaluatorBundle = z.infer<typeof EvaluatorBundleSchema>
export type EvaluatorCheck = z.infer<typeof EvaluatorCheckSchema>

export const EVALUATOR_BUNDLE_MANIFEST = 'bundle.json'

export class EvaluatorBundleError extends Error {}

/** Cap on hashed bundle size, so a huge tree cannot stall the integrity check. */
const MAX_BUNDLE_BYTES = 8 * 1024 * 1024

export async function loadEvaluatorBundle(bundleDir: string): Promise<EvaluatorBundle> {
  const manifestPath = join(bundleDir, EVALUATOR_BUNDLE_MANIFEST)
  let raw: string
  try {
    raw = await readFile(manifestPath, 'utf8')
  } catch {
    throw new EvaluatorBundleError(`no ${EVALUATOR_BUNDLE_MANIFEST} in ${bundleDir}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new EvaluatorBundleError(`${manifestPath} is not valid JSON`)
  }
  const result = EvaluatorBundleSchema.safeParse(parsed)
  if (!result.success) {
    throw new EvaluatorBundleError(`${manifestPath} is not a valid evaluator bundle: ${result.error.message}`)
  }
  const ids = new Set(result.data.checks.map(check => check.id))
  if (ids.size !== result.data.checks.length) {
    throw new EvaluatorBundleError(`${manifestPath} has duplicate check ids`)
  }
  return result.data
}

/**
 * Hash every file in the bundle directory.
 *
 * Covers the whole tree, not just the manifest: a check that shells out to
 * `./verify.sh` is only as trustworthy as `verify.sh`, and hashing the manifest
 * alone would leave the actual test script editable. Paths are included in the
 * digest so a rename is a change.
 */
export async function hashEvaluatorBundle(bundleDir: string): Promise<string> {
  const root = resolve(bundleDir)
  const files: Array<{ path: string; sha256: string }> = []
  let total = 0

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name)
      // Symlinks are not followed: a link pointing into the workspace would let
      // the candidate supply the bytes being hashed as "the bundle".
      if (entry.isSymbolicLink()) {
        files.push({ path: relPosix(root, full), sha256: 'symlink' })
        continue
      }
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      if (!entry.isFile()) continue
      const info = await stat(full)
      total += info.size
      if (total > MAX_BUNDLE_BYTES) {
        throw new EvaluatorBundleError(`evaluator bundle exceeds ${MAX_BUNDLE_BYTES} bytes`)
      }
      files.push({
        path: relPosix(root, full),
        sha256: createHash('sha256').update(await readFile(full)).digest('hex'),
      })
    }
  }

  await walk(root)
  return createHash('sha256').update(JSON.stringify(files)).digest('hex')
}

function relPosix(root: string, absolute: string): string {
  const rel = absolute.slice(root.length + 1)
  return sep === '/' ? rel : rel.split(sep).join('/')
}

/**
 * Refuse a bundle that lives inside the candidate's workspace.
 *
 * Containment is tested segment-wise so `/work-backup` is not accepted merely
 * because it shares a prefix with `/work`.
 */
export function assertBundleOutsideWorkspace(bundleDir: string, workspaceDir: string): void {
  const bundle = resolve(bundleDir)
  const workspace = resolve(workspaceDir)
  if (bundle === workspace || bundle.startsWith(workspace + sep)) {
    throw new EvaluatorBundleError(
      `evaluator bundle ${bundle} is inside the candidate workspace ${workspace}; ` +
      'the candidate could rewrite its own passing condition',
    )
  }
}
