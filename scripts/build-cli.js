#!/usr/bin/env node
/**
 * Build the meta-agent CLI into a single self-contained bundle.
 *
 * Output: dist/cli.mjs  (ESM, Node target, executable shebang)
 *
 * Why ESM + .mjs:
 *  - The package is "type":"module"; .mjs forces ESM regardless
 *  - @meta-agent/cc-kernel uses import.meta.url — must stay external
 *    (bundling it as CJS would make import.meta.url === undefined)
 *  - All other deps are bundled in; esbuild wraps CJS deps via
 *    createRequire automatically
 *
 * Run:  node scripts/build-cli.js
 *   or  npm run build:cli
 */

import { build } from 'esbuild'
import { chmod, readFile } from 'fs/promises'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')

// ── inline-prompts plugin ──────────────────────────────────────────────────
//
// Problem: tools read their description from a sibling `prompt.md` file at
// runtime via `loadToolPrompt(import.meta.url)` or `readFile(...prompt.md)`.
// When esbuild bundles everything into a single dist/cli.mjs, import.meta.url
// always resolves to dist/cli.mjs — so every tool looks for dist/prompt.md,
// which doesn't exist.
//
// Solution: intercept each tool file during the bundle pass, read the sibling
// prompt.md from SOURCE on disk, and replace the runtime read expression with
// the inlined string literal.  Zero changes to individual tool files needed.
//
// Two call patterns are handled:
//   1. await loadToolPrompt(import.meta.url)
//      → replaced with JSON-escaped string literal
//
//   2. async function loadPrompt() { ... readFile(join(dir,'prompt.md'),'utf-8') ... }
//      (used by provenance tools)
//      → the whole function body is replaced with `return <literal>`
//
const inlinePromptsPlugin = {
  name: 'inline-prompts',
  setup(build) {
    // Match any .ts/.js file anywhere under src/tools/
    build.onLoad({ filter: /\/tools\/[^/]+(?:\/[^/]+)*\.(ts|js)$/ }, async (args) => {
      const dir = dirname(args.path)
      const promptPath = join(dir, 'prompt.md')

      let contents = await readFile(args.path, 'utf-8')

      try {
        const promptContent = (await readFile(promptPath, 'utf-8')).trim()
        const escaped = JSON.stringify(promptContent)

        // Pattern 1 — most tools: await loadToolPrompt(import.meta.url)
        contents = contents.replace(
          /await\s+loadToolPrompt\s*\(\s*import\.meta\.url\s*\)/g,
          escaped,
        )

        // Pattern 2 — provenance tools: inline loadPrompt() function body
        // Matches the whole async helper that does readFile(join(dir,'prompt.md'))
        contents = contents.replace(
          /async function loadPrompt\(\)[^{]*\{[^}]*readFile\([^)]*prompt\.md[^)]*\)[^}]*\}/gs,
          `async function loadPrompt() { return ${escaped} }`,
        )

        // Pattern 3 — dynamicDescription(import.meta.url, enhanceFn)
        // Replace the URL arg with the pre-loaded content string.
        // dynamicDescription() in util.ts detects non-URL first args and skips
        // the file system read — fully backward-compatible with unbundled usage.
        contents = contents.replace(
          /dynamicDescription\s*\(\s*import\.meta\.url\s*,/g,
          `dynamicDescription(${escaped},`,
        )
      } catch {
        // No prompt.md next to this file — leave contents unchanged
      }

      return { contents, loader: 'ts' }
    })
  },
}

console.log('Building meta-agent CLI…')

await build({
  entryPoints: [join(root, 'src/cli/index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  outfile: join(root, 'dist/cli.mjs'),
  plugins: [inlinePromptsPlugin],
  external: [
    // cc-kernel uses import.meta.url extensively — must not be bundled
    '@meta-agent/cc-kernel',
    // optional native addon
    'fsevents',
  ],
  banner: {
    js: '#!/usr/bin/env node',
  },
  minify: false,
  sourcemap: false,
  logLevel: 'info',
  treeShaking: true,
})

await chmod(join(root, 'dist/cli.mjs'), 0o755)

// ── Mirror prompt.md files into dist ─────────────────────────────────────────
// The library build (plain tsc) emits only .js/.d.ts; tools load their
// description from a sibling prompt.md at RUNTIME via loadToolPrompt().
// Without this copy, library consumers of dist/index.js crash with ENOENT on
// createWebSearchTool() etc. (the CLI bundle is unaffected — esbuild inlines
// the prompts above). Keep dist a faithful mirror of src for every prompt.md.
{
  const { readdir, mkdir, copyFile } = await import('node:fs/promises')
  const { dirname, relative } = await import('node:path')
  async function* walkPrompts(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) yield* walkPrompts(full)
      else if (entry.name === 'prompt.md') yield full
    }
  }
  let copied = 0
  for await (const src of walkPrompts(join(root, 'src'))) {
    const dest = join(root, 'dist', relative(join(root, 'src'), src))
    await mkdir(dirname(dest), { recursive: true })
    await copyFile(src, dest)
    copied++
  }
  console.log(`✅  ${copied} prompt.md file(s) mirrored into dist/.`)
}

console.log('✅  dist/cli.mjs built and marked executable.')
console.log('   Install globally:  npm link')
console.log('   Or run directly:   node dist/cli.mjs --help')
