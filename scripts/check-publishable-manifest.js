#!/usr/bin/env node
/**
 * Refuse to publish a manifest that cannot be installed.
 *
 * A single `npm install ./release/<tarball>` run from inside this repo is enough
 * to make npm record the package as a dependency OF ITSELF:
 *
 *     "@meta-agent/runtime": "file:release/meta-agent-runtime-0.8.5.tgz"
 *
 * `npm pack` then faithfully ships that line, and every consumer's install dies
 * with ENOENT on `node_modules/@meta-agent/runtime/release/…` after four
 * confusing "tarball data seems to be corrupted" retries. Two releases went out
 * that way, and the usual pre-flight checks all passed: gzip was valid, the tar
 * listing was complete, the shasum matched. Integrity was never the problem —
 * the manifest was. This checks the manifest.
 *
 * Runs on `prepack`, so it fires for both `npm pack` and `npm publish`.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const problems = []

const DEP_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies']
for (const field of DEP_FIELDS) {
  for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
    if (name === pkg.name) {
      problems.push(`${field}["${name}"] makes the package depend on itself (${spec}).`)
      continue
    }
    // A `file:` or `link:` spec resolves relative to wherever the package ends
    // up installed, which is never where the author meant.
    if (typeof spec === 'string' && /^(file|link):/.test(spec)) {
      problems.push(`${field}["${name}"] = "${spec}" is a local path spec; it cannot resolve on a consumer's machine.`)
    }
  }
}

if (problems.length) {
  console.error('[check-publishable-manifest] package.json is not publishable:\n')
  for (const problem of problems) console.error(`  - ${problem}`)
  console.error('\nThis usually happens after running `npm install ./release/<tarball>` inside this repo,')
  console.error('which makes npm save the tarball as a dependency. Remove the entry from package.json')
  console.error('AND package-lock.json, then pack again.\n')
  process.exit(1)
}
