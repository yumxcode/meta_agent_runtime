#!/usr/bin/env node
/**
 * Remove the self-dependency npm adds when a tarball is installed from inside
 * this repo. See scripts/check-publishable-manifest.js for why it is fatal.
 *
 * Idempotent; prints what it removed so the fix is visible in a build log.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const removed = []

const pkgPath = join(root, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
  for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
    if (name === pkg.name || (typeof spec === 'string' && /^(file|link):/.test(spec))) {
      delete pkg[field][name]
      removed.push(`package.json ${field}["${name}"] = ${spec}`)
    }
  }
}
if (removed.length) writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')

const lockPath = join(root, 'package-lock.json')
try {
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
  let touched = false
  for (const deps of [lock.packages?.['']?.dependencies, lock.packages?.['']?.devDependencies, lock.dependencies]) {
    for (const name of Object.keys(deps ?? {})) {
      if (name === pkg.name) { delete deps[name]; removed.push(`package-lock.json ${name}`); touched = true }
    }
  }
  for (const key of Object.keys(lock.packages ?? {})) {
    const entry = lock.packages[key]
    if (key.includes(pkg.name) || (typeof entry?.resolved === 'string' && /^(file|link):/.test(entry.resolved))) {
      delete lock.packages[key]; removed.push(`package-lock.json packages["${key}"]`); touched = true
    }
  }
  if (touched) writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n')
} catch { /* no lockfile is fine */ }

console.log(removed.length
  ? `[clean-self-dependency] removed:\n${removed.map(r => `  - ${r}`).join('\n')}`
  : '[clean-self-dependency] nothing to clean.')
