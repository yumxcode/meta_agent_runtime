import { readdir, stat } from 'fs/promises'
import { join, relative, basename, sep } from 'path'
import type { MetaAgentTool, ToolCallContext, ToolResult } from '../../../core/types.js'
import { dynamicDescription } from '../../util.js'
import { assertInsideWorkspace } from '../workspaceGuard.js'

function matchGlob(pattern: string, filePath: string): boolean {
  let out = ''
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!
    const next = pattern[i + 1]
    const afterNext = pattern[i + 2]
    if (ch === '*' && next === '*' && afterNext === '/') {
      out += '(?:.*\\/)?'
      i += 2
    } else if (ch === '*' && next === '*') {
      out += '.*'
      i += 1
    } else if (ch === '*') {
      out += '[^/]*'
    } else if (ch === '?') {
      out += '[^/]'
    } else if (ch === '{') {
      const end = pattern.indexOf('}', i + 1)
      if (end > i) {
        out += `(${pattern.slice(i + 1, end).split(',').map(s => s.trim().replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('|')})`
        i = end
      } else {
        out += '\\{'
      }
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  try { return new RegExp(`^${out}$`).test(filePath) } catch { return false }
}

/**
 * Dependency and cache directories, skipped by default.
 *
 * Only names that are an ecosystem-wide convention belong here. The temptation
 * is to add whatever directory happened to swamp the last project you debugged,
 * but this tool serves every domain: a name that is vendored dependencies in
 * one repository is first-class source in another. `env/`, `build/` and
 * `target/` were considered and rejected on exactly that ground.
 *
 * The list is a performance default, not a correctness mechanism — matching now
 * happens during the walk and truncation is reported honestly, so a large
 * unlisted directory costs time rather than answers. And naming a directory in
 * the pattern searches it regardless (see `WalkState.requested`).
 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', '.next', 'coverage',
  '__pycache__', 'site-packages', 'venv', '.venv', '.tox', '.mypy_cache', '.pytest_cache',
  '.gradle', 'vendor', '.terraform',
])

const MAX_MATCHES = 100
/** Directory entries visited before giving up, independent of how many matched.
 * Only a safety valve against pathological trees now that matching happens
 * during the walk and irrelevant subtrees are pruned. */
const MAX_SCANNED = 200_000

/** The literal directory prefix a pattern is rooted at, e.g. `src/**​/*.ts`
 * → ['src']. Descending only into that subtree is what turns a walk over tens of
 * thousands of vendored files into one over a handful, and it is why an answer
 * now arrives at all. */
function literalPrefixSegments(pattern: string): string[] {
  const segments: string[] = []
  for (const segment of pattern.split('/')) {
    if (/[*?{[]/.test(segment)) break
    if (!segment || segment === '.') break
    segments.push(segment)
  }
  // The last literal segment may be the filename itself (`src/main.ts`); it is
  // only a directory hint when something follows it.
  return segments.length && segments.length < pattern.split('/').length ? segments : []
}

interface WalkState {
  matches: Array<{ path: string; mtime: number }>
  scanned: number
  truncated: boolean
  /** Directory names the pattern mentions literally; these override SKIP_DIRS. */
  requested: Set<string>
}

/** Literal path segments anywhere in the pattern, so `**​/vendor/*.go` also
 * opts back into a skipped directory. */
function literalSegments(pattern: string): Set<string> {
  return new Set(pattern.split('/').filter(segment => segment && !/[*?{[]/.test(segment)))
}

async function walkDir(
  dir: string, root: string, pattern: string, state: WalkState, signal?: AbortSignal,
): Promise<void> {
  if (state.truncated) return
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    if (signal?.aborted) { state.truncated = true; return }
    if (state.matches.length >= MAX_MATCHES || state.scanned >= MAX_SCANNED) { state.truncated = true; return }
    state.scanned++
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      // Skipping is a default, not a prohibition: a caller who names the
      // directory in the pattern ("build/**/*.js") is asking for it on purpose,
      // and silently returning nothing would repeat the very failure this
      // rewrite exists to remove.
      if (!SKIP_DIRS.has(entry.name) || state.requested.has(entry.name)) await walkDir(full, root, pattern, state, signal)
      if (state.truncated) return
      continue
    }
    // Match DURING the walk. The old implementation collected up to 5000 files
    // first and filtered afterwards, so a large irrelevant subtree could consume
    // the entire budget and the caller was told "No files found" — absence
    // reported for what was really an early exit.
    const rel = relative(root, full)
    if (!matchGlob(pattern, rel) && !matchGlob(pattern, basename(full))) continue
    try { state.matches.push({ path: full, mtime: (await stat(full)).mtimeMs }) } catch { /* vanished */ }
  }
}

export async function createGlobTool(): Promise<MetaAgentTool> {
  const description = dynamicDescription(import.meta.url, (base, ctx) => {
    const note = ctx.toolNames.has('bash')
      ? '\n\nIMPORTANT: Use this `glob` tool to find files by name pattern. Do NOT use `find` or `ls` via bash.'
      : ''
    return base + note
  })
  return {
    name: 'glob',
    description,
    isConcurrencySafe: true,
    permission: { category: 'read', pathFields: ['path'], requiresWorkspace: true, planMode: 'allow' },
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern (e.g. "**/*.ts")' },
        path: { type: 'string', description: 'Directory to search in. Defaults to workspace root.' },
      },
      required: ['pattern'],
    },
    async call(input: Record<string, unknown>, _ctx: ToolCallContext): Promise<ToolResult> {
      const pattern = input['pattern'] as string
      const workspaceRoot = _ctx.workspaceRoot ?? process.cwd()
      const searchPath = (input['path'] as string | undefined) ?? workspaceRoot
      if (!pattern) return { content: 'Error: pattern is required', isError: true }
      const workspaceError = assertInsideWorkspace(searchPath, workspaceRoot)
      if (workspaceError) return { content: workspaceError, isError: true }
      try {
        const prefix = literalPrefixSegments(pattern)
        const start = prefix.length ? join(searchPath, ...prefix) : searchPath
        const rooted = prefix.length && await stat(start).then(s => s.isDirectory()).catch(() => false)
        const state: WalkState = { matches: [], scanned: 0, truncated: false, requested: literalSegments(pattern) }
        await walkDir(rooted ? start : searchPath, searchPath, pattern, state, _ctx.abortSignal)
        state.matches.sort((a, b) => b.mtime - a.mtime)
        const results = state.matches.map(f => f.path)
        if (results.length === 0) {
          // Never let a truncated scan masquerade as an empty directory: acting
          // on "this does not exist" when the real answer is "I stopped early"
          // is the most expensive mistake this tool can cause.
          return {
            content: state.truncated
              ? `Search was TRUNCATED after scanning ${state.scanned} entries and found no match for "${pattern}" so far — this does NOT mean the files are absent. Narrow the search (pass a more specific \`path\`, or a pattern rooted at a directory such as "subdir/**/*.py") and try again.`
              : `No files found matching "${pattern}" in ${searchPath}`,
            isError: false,
          }
        }
        const truncated = state.truncated
          ? `\n[results TRUNCATED at ${MAX_MATCHES} matches after scanning ${state.scanned} entries; more may exist — narrow the pattern or \`path\` to see the rest]`
          : ''
        return { content: results.join('\n') + truncated, isError: false }
      } catch (err) {
        return { content: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  }
}

export const GLOB_INTERNALS_FOR_TEST = { literalPrefixSegments, SKIP_DIRS, MAX_MATCHES, sep }
