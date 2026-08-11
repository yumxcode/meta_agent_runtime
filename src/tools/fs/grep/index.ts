import { execFile } from 'child_process'
import { readdir, readFile, stat } from 'fs/promises'
import { join } from 'path'
import { promisify } from 'util'
import type { MetaAgentTool, ToolCallContext, ToolResult } from '../../../core/types.js'
import { dynamicDescription } from '../../util.js'
import { assertInsideWorkspace } from '../workspaceGuard.js'
import { RuntimeEnv } from '../../../infra/env/RuntimeEnv.js'

const execFileAsync = promisify(execFile)
let _rgAvailable: boolean | null = null
const FALLBACK_MAX_FILES = 5_000
const FALLBACK_MAX_BYTES = 20 * 1024 * 1024
const FALLBACK_MAX_MS = 10_000
/** Largest single file the JS fallback will hand to `regex.test()`. */
const FALLBACK_MAX_FILE_BYTES = 2 * 1024 * 1024

/**
 * Reject the classic catastrophic-backtracking shapes before compiling.
 *
 * The rg path runs out of process with `timeout: 30000`. The JS fallback has no
 * equivalent, and cannot have one: `regex.test()` is SYNCHRONOUS, so a
 * backtracking blowup owns the event loop and the FALLBACK_MAX_MS check at the
 * top of the scan loop is never reached. Measured with `(a+)+$` against a
 * 41-character string: 86,909 ms of a completely unresponsive process. That is
 * not merely a slow search — `withFileLock` heartbeats every 10s against a 30s
 * staleness window, so a frozen event loop makes other processes declare this
 * one dead and take locks out from under it.
 *
 * The rule below is deliberately narrow: a group that is repeated an UNBOUNDED
 * number of times AND itself contains an unbounded quantifier. That is `(a+)+`,
 * `(\d*)*`, `([a-z]+)*`, `(.*)+ ` — and not `(foo|bar)+`, `(\d{3})+`, `(ab)*`,
 * which are all fine and common.
 *
 * A worker thread with `terminate()` would cover every shape rather than the
 * common ones, but it costs a process spawn per call on what is already the
 * degraded path. Installing ripgrep is the better answer, and the message says so.
 */
export function rejectRedosProne(pattern: string): string | null {
  // Walk the pattern tracking group spans so the check is on real structure and
  // not on a regex-parsing-regex.
  const openStack: number[] = []
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]
    if (ch === '\\') { i++; continue }               // escaped char — skip both
    if (ch === '[') {                                 // character class: skip to ]
      while (i < pattern.length && pattern[i] !== ']') {
        if (pattern[i] === '\\') i++
        i++
      }
      continue
    }
    if (ch === '(') { openStack.push(i); continue }
    if (ch !== ')') continue

    const start = openStack.pop()
    if (start === undefined) continue
    const outer = pattern.slice(i + 1)
    if (!/^(?:[*+]|\{\d+,\})/.test(outer)) continue   // group is not unbounded-repeated
    const body = pattern.slice(start + 1, i)
    if (hasUnboundedQuantifier(body)) {
      return (
        `Error: pattern "${pattern.slice(0, 80)}" nests an unbounded quantifier inside an ` +
        `unbounded group, which can backtrack catastrophically and freeze the process. ` +
        `The fast path (ripgrep) is not available here — install ripgrep, or rewrite the ` +
        `pattern (e.g. "(a+)+" → "a+").`
      )
    }
  }
  return null
}

/** True when `body` applies `*`, `+` or `{n,}` to something, ignoring escapes and classes. */
function hasUnboundedQuantifier(body: string): boolean {
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (ch === '\\') { i++; continue }
    if (ch === '[') {
      while (i < body.length && body[i] !== ']') {
        if (body[i] === '\\') i++
        i++
      }
      // A class is a single atom; a quantifier right after it counts.
      if (/^(?:[*+]|\{\d+,\})/.test(body.slice(i + 1))) return true
      continue
    }
    if (ch === '*' || ch === '+') return true
    if (ch === '{' && /^\{\d+,\}/.test(body.slice(i))) return true
  }
  return false
}
async function isRgAvailable(): Promise<boolean> {
  // Checked BEFORE the cache so the override works within a process that has
  // already probed for rg (i.e. inside a test run).
  if (RuntimeEnv.disableRipgrep()) return false
  if (_rgAvailable !== null) return _rgAvailable
  try { await execFileAsync('rg', ['--version'], { timeout: 2000 }); _rgAvailable = true } catch { _rgAvailable = false }
  return _rgAvailable
}

export async function createGrepTool(): Promise<MetaAgentTool> {
  // When bash is present, remind the model not to use grep/rg shell commands.
  const description = dynamicDescription(import.meta.url, (base, ctx) => {
    const note = ctx.toolNames.has('bash')
      ? '\n\nIMPORTANT: ALWAYS use this `grep` tool for search tasks. NEVER invoke `grep` or `rg` as a `bash` command — this tool has optimised output, permissions, and result formatting.'
      : ''
    return base + note
  })
  return {
    name: 'grep',
    description,
    isConcurrencySafe: true,
    permission: { category: 'read', pathFields: ['path'], requiresWorkspace: true, planMode: 'allow' },
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression pattern' },
        path: { type: 'string', description: 'File or directory to search. Default: workspace root' },
        glob: { type: 'string', description: 'Glob filter (e.g. "*.ts")' },
        output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'], description: 'Default: files_with_matches' },
        context: { type: 'number', description: 'Lines of context around matches' },
        case_insensitive: { type: 'boolean', description: 'Case-insensitive. Default: false' },
        multiline: { type: 'boolean', description: 'Multiline mode: the pattern may span lines and `.` matches newlines. Default: false' },
        head_limit: { type: 'number', description: 'Max lines to return. Default: 250' },
      },
      required: ['pattern'],
    },
    async call(input: Record<string, unknown>, _ctx: ToolCallContext): Promise<ToolResult> {
      const pattern = input['pattern'] as string
      const workspaceRoot = _ctx.workspaceRoot ?? process.cwd()
      const searchPath = (input['path'] as string | undefined) ?? workspaceRoot
      const outputMode = (input['output_mode'] as string | undefined) ?? 'files_with_matches'
      const headLimit = typeof input['head_limit'] === 'number' ? input['head_limit'] : 250
      if (!pattern) return { content: 'Error: pattern is required', isError: true }
      const workspaceError = assertInsideWorkspace(searchPath, workspaceRoot)
      if (workspaceError) return { content: workspaceError, isError: true }

      if (await isRgAvailable()) {
        try {
          const args: string[] = ['--no-heading']
          if (input['case_insensitive']) args.push('-i')
          if (input['multiline']) args.push('-U', '--multiline-dotall')
          if (input['glob']) args.push('--glob', input['glob'] as string)
          if (typeof input['context'] === 'number') args.push('-C', String(input['context']))
          if (outputMode === 'files_with_matches') args.push('-l')
          else if (outputMode === 'count') args.push('--count')
          else args.push('-n')
          args.push('--', pattern, searchPath)

          const { stdout } = await execFileAsync('rg', args, {
            timeout: 30000,
            maxBuffer: 10 * 1024 * 1024,
            signal: _ctx.abortSignal,
          })
          let out = stdout.trim()
          const lines = out.split('\n')
          if (lines.length > headLimit) out = lines.slice(0, headLimit).join('\n') + `\n[Truncated to ${headLimit} lines]`
          return { content: out || 'No matches found', isError: false }
        } catch (err: unknown) {
          const e = err as { status?: number; code?: number | string; stderr?: string }
          if (e.status === 1 || e.code === 1) return { content: 'No matches found', isError: false }
          // rg exits 2 for a bad pattern / unreadable path. Rethrowing made the
          // whole tool CALL throw, so a malformed regex from the model
          // surfaced as an unhandled tool crash instead of a result the model
          // could read and correct. Return it as a normal tool error.
          const stderr = (e.stderr ?? '').toString().trim()
          if (e.status === 2 || e.code === 2) {
            return {
              content: `Error: ripgrep rejected the search — ${stderr || 'invalid pattern or unreadable path'}`,
              isError: true,
            }
          }
          if (_ctx.abortSignal.aborted) return { content: 'Error: search aborted', isError: true }
          return {
            content: `Error running search: ${stderr || (err instanceof Error ? err.message : String(err))}`,
            isError: true,
          }
        }
      }

      // Fallback: Node.js
      //
      // `multiline` maps to 's' (dotAll), NOT 'm'. rg's --multiline-dotall
      // means "`.` matches newlines"; JS 'm' means "`^`/`$` match at line
      // breaks" — a different flag entirely. With 'm' the same pattern silently
      // matched differently depending on whether ripgrep happened to be
      // installed, so a cross-line pattern that worked on one machine returned
      // nothing on another.
      const flags = (input['case_insensitive'] ? 'i' : '') + (input['multiline'] ? 's' : '')
      const rejection = rejectRedosProne(pattern)
      if (rejection) return { content: rejection, isError: true }
      let regex: RegExp
      try {
        regex = new RegExp(pattern, flags)
      } catch (err) {
        return { content: `Error: invalid regular expression: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
      const matchedFiles: string[] = []
      const startedAt = Date.now()
      let filesScanned = 0
      let bytesScanned = 0
      let stoppedEarly = false
      async function scanDir(dir: string): Promise<void> {
        if (stoppedEarly || _ctx.abortSignal.aborted) return
        try {
          for (const entry of await readdir(dir, { withFileTypes: true })) {
            if (_ctx.abortSignal.aborted || Date.now() - startedAt > FALLBACK_MAX_MS || filesScanned >= FALLBACK_MAX_FILES || bytesScanned >= FALLBACK_MAX_BYTES) {
              stoppedEarly = true
              break
            }
            const full = join(dir, entry.name)
            if (entry.isDirectory()) {
              if (!['node_modules', '.git', 'dist'].includes(entry.name)) await scanDir(full)
            } else {
              try {
                const fileStat = await stat(full)
                filesScanned++
                bytesScanned += fileStat.size
                if (bytesScanned > FALLBACK_MAX_BYTES) { stoppedEarly = true; break }
                // Skip rather than test: matching time is superlinear in input
                // length for a backtracking engine, and one oversized file is
                // not worth the tail risk on a synchronous call.
                if (fileStat.size > FALLBACK_MAX_FILE_BYTES) { stoppedEarly = true; continue }
                if (regex.test(await readFile(full, 'utf-8'))) matchedFiles.push(full)
              } catch { /* skip */ }
            }
          }
        } catch { /* skip */ }
      }
      try {
        const searchStat = await stat(searchPath)
        if (searchStat.isFile()) {
          if (searchStat.size > FALLBACK_MAX_FILE_BYTES) return { content: `Error: file too large to search safely without ripgrep (${searchStat.size} bytes)`, isError: true }
          if (regex.test(await readFile(searchPath, 'utf-8'))) matchedFiles.push(searchPath)
        } else await scanDir(searchPath)
      } catch (e) { return { content: `Error: ${e instanceof Error ? e.message : String(e)}`, isError: true } }
      if (matchedFiles.length === 0) return { content: 'No matches found', isError: false }
      const suffix = stoppedEarly ? '\n[Search stopped early due to fallback safety limits]' : ''
      return { content: matchedFiles.slice(0, headLimit).join('\n') + suffix, isError: false }
    },
  }
}
