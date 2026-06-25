#!/usr/bin/env node
/**
 * Sync the version strings embedded in README.md with package.json.
 *
 * The CLI's runtime version (`meta-agent --version`) already reads package.json
 * directly and can't drift, but README.md is static markdown and historically
 * lagged behind the published version (e.g. README said 0.3.3 while the package
 * was 0.3.4). This script is the single place that rewrites the documented
 * version so a release can never ship a stale README.
 *
 * Wired into the npm lifecycle:
 *   - `version`  (runs on `npm version <bump>`, then git-adds README)
 *   - `prepack`  (runs before `npm pack` / publish)
 * and exposed manually as `npm run version:sync`.
 *
 * Idempotent: writes only when something actually changed, and exits non-zero
 * (in --check mode) if the README is out of sync — handy for CI.
 *
 * It updates every occurrence of a version wrapped in backticks on a line that
 * mentions a version label, matching both README forms:
 *     > 当前版本:`0.3.4` · Node.js `>= 18`
 *     当前包版本:`0.3.4`。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const checkOnly = process.argv.includes('--check')

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const version = pkg.version
if (!version) {
  console.error('[sync-readme-version] package.json has no "version" field.')
  process.exit(1)
}

const readmePath = join(root, 'README.md')
const original = readFileSync(readmePath, 'utf8')

// Match a backticked semver that sits on a line carrying a version label
// (版本 / version), so we never touch unrelated backticked code spans.
const LINE_RE = /(版本[^\n`]*`)(\d+\.\d+\.\d+(?:-[\w.]+)?)(`)/g
const updated = original.replace(LINE_RE, (_m, pre, _old, post) => `${pre}${version}${post}`)

if (updated === original) {
  console.log(`[sync-readme-version] README.md already at v${version}.`)
  process.exit(0)
}

if (checkOnly) {
  console.error(
    `[sync-readme-version] README.md is out of sync with package.json (v${version}). ` +
    `Run "npm run version:sync".`,
  )
  process.exit(1)
}

writeFileSync(readmePath, updated, 'utf8')
console.log(`[sync-readme-version] README.md updated to v${version}.`)
