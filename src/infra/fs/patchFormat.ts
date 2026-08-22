/**
 * patchFormat — parse and apply the multi-file patch envelope.
 *
 * Why a patch format at all
 * -------------------------
 * `edit_file` is a single exact string replacement in a single file. That is
 * the right primitive for a surgical change and it stays. But it cannot express
 * the thing refactoring actually is: "rename this symbol in six files, delete
 * the file that only existed to hold it, and add its replacement" — a set of
 * changes that are only correct TOGETHER. Six sequential `edit_file` calls
 * leave the tree broken between calls, and if the fourth one fails the first
 * three have already landed.
 *
 * So this format is validated as a whole and applied as a whole: every hunk is
 * located and every new file content is computed in memory BEFORE the first
 * byte is written, and a failure mid-write rolls back what was already written.
 *
 * The envelope
 * ------------
 *   *** Begin Patch
 *   *** Add File: relative/path.ts
 *   +every line of the new file, each prefixed with +
 *   *** Delete File: relative/other.ts
 *   *** Update File: relative/third.ts
 *   *** Move to: relative/renamed.ts        (optional, only after Update File)
 *   @@ optional locating context
 *    unchanged line
 *   -removed line
 *   +added line
 *   *** End Patch
 *
 * It is deliberately NOT unified-diff-with-line-numbers. Line numbers are the
 * one part of a diff a language model cannot compute reliably — it has to count
 * — and a patch that is rejected because `@@ -41,7 +41,8 @@` should have said
 * 42 teaches nothing and wastes a turn. Context lines carry the same
 * information and the model already has them in front of it.
 */

import { splitLines } from './unifiedDiff.js'

// ── Parsed shape ──────────────────────────────────────────────────────────────

export interface PatchHunkLine {
  kind: 'context' | 'remove' | 'add'
  text: string
}

export interface PatchHunk {
  /** Text after `@@`, used to disambiguate where the hunk applies. */
  header?: string
  lines: PatchHunkLine[]
}

export type PatchOperation =
  | { kind: 'add'; path: string; contents: string }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; movePath?: string; hunks: PatchHunk[] }

export class PatchParseError extends Error {
  constructor(message: string, readonly line?: number) {
    super(line === undefined ? message : `line ${line}: ${message}`)
    this.name = 'PatchParseError'
  }
}

export class PatchApplyError extends Error {
  constructor(message: string, readonly path?: string) {
    super(path ? `${path}: ${message}` : message)
    this.name = 'PatchApplyError'
  }
}

const BEGIN = '*** Begin Patch'
const END = '*** End Patch'
const ADD = '*** Add File: '
const DELETE = '*** Delete File: '
const UPDATE = '*** Update File: '
const MOVE = '*** Move to: '

function isOperationMarker(line: string): boolean {
  return (
    line.startsWith(ADD) ||
    line.startsWith(DELETE) ||
    line.startsWith(UPDATE) ||
    line === END
  )
}

/**
 * Parse the envelope. Throws `PatchParseError` with a line number — the model
 * gets one precise thing to fix rather than "invalid patch".
 */
export function parsePatch(patch: string): PatchOperation[] {
  const lines = patch.replace(/\r\n/g, '\n').split('\n')

  // Tolerate leading/trailing blank lines and a fenced code block, because
  // models emit both constantly and rejecting the patch over a stray ``` is a
  // wasted turn that teaches nothing about the change itself.
  let start = 0
  while (start < lines.length && (lines[start] ?? '').trim() === '') start++
  if ((lines[start] ?? '').trim().startsWith('```')) start++
  while (start < lines.length && (lines[start] ?? '').trim() === '') start++

  if ((lines[start] ?? '').trim() !== BEGIN) {
    throw new PatchParseError(`patch must start with "${BEGIN}"`, start + 1)
  }

  const ops: PatchOperation[] = []
  let i = start + 1
  let sawEnd = false

  while (i < lines.length) {
    const raw = lines[i] ?? ''
    const line = raw.trimEnd()

    if (line === END) {
      sawEnd = true
      break
    }
    if (line.trim() === '' ) { i++; continue }
    if (line.trim().startsWith('```')) { i++; continue }

    if (line.startsWith(ADD)) {
      const path = line.slice(ADD.length).trim()
      if (!path) throw new PatchParseError('Add File requires a path', i + 1)
      i++
      const body: string[] = []
      while (i < lines.length && !isOperationMarker((lines[i] ?? '').trimEnd())) {
        const content = lines[i] ?? ''
        if (content.startsWith('+')) body.push(content.slice(1))
        else if (content.trim() === '') body.push('')
        else {
          throw new PatchParseError(
            `Add File body lines must start with "+" (got: ${truncate(content)})`,
            i + 1,
          )
        }
        i++
      }
      // A new file ends with a newline unless it is empty. Files without a
      // trailing newline are a real thing but never what a patch MEANT to
      // produce, and the envelope has no way to say "no final newline".
      ops.push({ kind: 'add', path, contents: body.length ? `${body.join('\n')}\n` : '' })
      continue
    }

    if (line.startsWith(DELETE)) {
      const path = line.slice(DELETE.length).trim()
      if (!path) throw new PatchParseError('Delete File requires a path', i + 1)
      ops.push({ kind: 'delete', path })
      i++
      continue
    }

    if (line.startsWith(UPDATE)) {
      const path = line.slice(UPDATE.length).trim()
      if (!path) throw new PatchParseError('Update File requires a path', i + 1)
      i++

      let movePath: string | undefined
      if ((lines[i] ?? '').trimEnd().startsWith(MOVE)) {
        movePath = (lines[i] ?? '').trimEnd().slice(MOVE.length).trim()
        if (!movePath) throw new PatchParseError('Move to requires a path', i + 1)
        i++
      }

      const hunks: PatchHunk[] = []
      let current: PatchHunk | null = null

      while (i < lines.length && !isOperationMarker((lines[i] ?? '').trimEnd())) {
        const content = lines[i] ?? ''
        if (content.trimEnd().startsWith('@@')) {
          if (current) hunks.push(current)
          const header = content.trimEnd().slice(2).trim()
          current = header ? { header, lines: [] } : { lines: [] }
          i++
          continue
        }
        if (!current) current = { lines: [] }

        const marker = content.charAt(0)
        if (marker === '+') current.lines.push({ kind: 'add', text: content.slice(1) })
        else if (marker === '-') current.lines.push({ kind: 'remove', text: content.slice(1) })
        else if (marker === ' ') current.lines.push({ kind: 'context', text: content.slice(1) })
        else if (content === '') current.lines.push({ kind: 'context', text: '' })
        else {
          throw new PatchParseError(
            `hunk lines must start with " ", "-" or "+" (got: ${truncate(content)})`,
            i + 1,
          )
        }
        i++
      }
      if (current) hunks.push(current)
      const nonEmpty = hunks.filter(h => h.lines.length > 0)
      if (nonEmpty.length === 0) {
        throw new PatchParseError(`Update File ${path} has no hunks`, i)
      }
      ops.push({
        kind: 'update',
        path,
        ...(movePath ? { movePath } : {}),
        hunks: nonEmpty,
      })
      continue
    }

    throw new PatchParseError(`unexpected line outside an operation: ${truncate(line)}`, i + 1)
  }

  if (!sawEnd) throw new PatchParseError(`patch must end with "${END}"`)
  if (ops.length === 0) throw new PatchParseError('patch contains no operations')

  // A patch that touches the same path twice is almost always a model
  // assembling two independent edits and not noticing they collide. Applying
  // both would silently drop the first, because the second was written against
  // the ORIGINAL content, not against the first one's output.
  const seen = new Map<string, string>()
  for (const op of ops) {
    const prior = seen.get(op.path)
    if (prior) {
      throw new PatchParseError(
        `path appears twice in one patch (${prior} then ${op.kind}): ${op.path} — ` +
          `combine them into a single operation`,
      )
    }
    seen.set(op.path, op.kind)
  }

  return ops
}

// ── Applying an update to file contents ───────────────────────────────────────

/**
 * Apply one file's hunks to `original`, returning the new contents.
 *
 * Hunks are located by CONTENT, searching forward from the end of the previous
 * hunk. Forward-only search is what makes a multi-hunk patch deterministic when
 * the same few lines appear repeatedly (a `}` on its own, an `import` line):
 * hunk 2 can only match after hunk 1, which is the order the model wrote them.
 */
export function applyHunks(original: string, hunks: PatchHunk[], path: string): string {
  const lines = splitLines(original)
  const endsWithNewline = original === '' || original.endsWith('\n')
  const out: string[] = []
  let cursor = 0

  for (const [index, hunk] of hunks.entries()) {
    const oldBlock = hunk.lines
      .filter(l => l.kind !== 'add')
      .map(l => l.text)
    const newBlock = hunk.lines
      .filter(l => l.kind !== 'remove')
      .map(l => l.text)

    if (oldBlock.length === 0) {
      // Pure insertion with nothing to anchor to. Without an anchor the only
      // honest answer is "where?" — guessing (top? bottom?) produces a patch
      // that applies cleanly and is wrong, which is worse than a rejection.
      throw new PatchApplyError(
        `hunk ${index + 1} has no context or removed lines to locate it; ` +
          `include at least one unchanged line (prefixed with a space) next to the insertion`,
        path,
      )
    }

    const at = findBlock(lines, oldBlock, cursor, hunk.header)
    if (at < 0) {
      throw new PatchApplyError(
        `hunk ${index + 1} did not match the file. ` +
          `Looked for:\n${oldBlock.slice(0, 6).map(l => `  |${l}`).join('\n')}` +
          (oldBlock.length > 6 ? `\n  … (${oldBlock.length - 6} more lines)` : '') +
          `\nRe-read the file: its current contents differ from what the patch expects.`,
        path,
      )
    }

    out.push(...lines.slice(cursor, at))
    out.push(...newBlock)
    cursor = at + oldBlock.length
  }

  out.push(...lines.slice(cursor))
  if (out.length === 0) return ''
  return endsWithNewline ? `${out.join('\n')}\n` : out.join('\n')
}

/**
 * Locate `block` in `lines` at or after `from`.
 *
 * When the hunk carried an `@@ header`, the search first tries to start after
 * the header's own line — that is exactly what the header is for, and it is how
 * a patch disambiguates "the third `return null` in the file".
 */
function findBlock(
  lines: readonly string[],
  block: readonly string[],
  from: number,
  header?: string,
): number {
  if (header) {
    const anchor = lines.findIndex((l, i) => i >= from && l.trim() === header.trim())
    if (anchor >= 0) {
      const hit = search(lines, block, anchor)
      if (hit >= 0) return hit
    }
  }
  const exact = search(lines, block, from)
  if (exact >= 0) return exact

  // Second pass ignoring trailing whitespace. Trailing-space differences are
  // invisible in every UI the model saw the file through, so rejecting on them
  // is rejecting on something it had no way to observe. Leading whitespace is
  // NOT forgiven: in Python it is the semantics.
  return searchRightTrimmed(lines, block, from)
}

function search(lines: readonly string[], block: readonly string[], from: number): number {
  const limit = lines.length - block.length
  for (let i = Math.max(0, from); i <= limit; i++) {
    let ok = true
    for (let j = 0; j < block.length; j++) {
      if (lines[i + j] !== block[j]) { ok = false; break }
    }
    if (ok) return i
  }
  return -1
}

function searchRightTrimmed(
  lines: readonly string[],
  block: readonly string[],
  from: number,
): number {
  const limit = lines.length - block.length
  for (let i = Math.max(0, from); i <= limit; i++) {
    let ok = true
    for (let j = 0; j < block.length; j++) {
      if ((lines[i + j] ?? '').trimEnd() !== (block[j] ?? '').trimEnd()) { ok = false; break }
    }
    if (ok) return i
  }
  return -1
}

function truncate(s: string, n = 60): string {
  return s.length > n ? `${s.slice(0, n)}…` : s
}

/** Human-readable one-line summary of what a patch will do. */
export function describeOperations(ops: readonly PatchOperation[]): string {
  const counts = { add: 0, delete: 0, update: 0, move: 0 }
  for (const op of ops) {
    counts[op.kind]++
    if (op.kind === 'update' && op.movePath) counts.move++
  }
  const parts: string[] = []
  if (counts.add) parts.push(`${counts.add} added`)
  if (counts.update) parts.push(`${counts.update} updated`)
  if (counts.move) parts.push(`${counts.move} moved`)
  if (counts.delete) parts.push(`${counts.delete} deleted`)
  return parts.join(', ') || 'no changes'
}
