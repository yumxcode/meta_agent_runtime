/**
 * unifiedDiff — line diffing and unified-diff rendering, with no dependencies.
 *
 * Why hand-rolled: this runtime ships three runtime dependencies on purpose,
 * and a diff is a well-understood algorithm with a small correct implementation.
 * Pulling in `diff` (or worse, shelling out to `git diff`, which needs a repo
 * and a clean index) to render a few hunks would cost more than it saves.
 *
 * The algorithm is Myers' O(ND) shortest-edit-script, which is what git itself
 * uses. It is optimal in edit-script length, which matters: an LCS-by-dynamic-
 * programming implementation is O(N*M) in BOTH time and memory, and a pair of
 * 20k-line files would allocate a 400M-cell table.
 */

export interface DiffOptions {
  /** Lines of unchanged context around each hunk. Default: 3. */
  context?: number
  /** Path shown on the `---` line. Default: `a/<path>`. */
  oldLabel?: string
  /** Path shown on the `+++` line. Default: `b/<path>`. */
  newLabel?: string
}

export type EditOp =
  | { kind: 'equal'; oldIndex: number; newIndex: number }
  | { kind: 'delete'; oldIndex: number }
  | { kind: 'insert'; newIndex: number }

/**
 * Split into lines for diffing.
 *
 * A trailing newline does NOT produce a final empty line: "a\nb\n" is two
 * lines, not three. Treating it as three makes every complete file look like it
 * differs from itself in the last position, and the resulting diff carries a
 * phantom hunk at EOF.
 */
export function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * Myers diff. Returns the edit script transforming `a` into `b`.
 *
 * `maxEditDistance` bounds the search: past it, the function falls back to
 * "delete everything, insert everything", which is a correct (if unhelpful)
 * edit script. Two files with no common structure would otherwise make the
 * O(ND) search degenerate to O(N*M) — the exact case where a diff is least
 * useful and most expensive.
 */
export function diffLines(
  a: readonly string[],
  b: readonly string[],
  maxEditDistance = 4_000,
): EditOp[] {
  const n = a.length
  const m = b.length
  if (n === 0 && m === 0) return []

  const max = Math.min(n + m, maxEditDistance)
  const offset = max
  const size = 2 * max + 1
  // v[k + offset] = furthest x reached on diagonal k. `trace` keeps a snapshot
  // per edit-distance so the path can be walked backwards at the end.
  let v = new Int32Array(size)
  const trace: Int32Array[] = []

  let found = -1
  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice())
    const next = v.slice()
    for (let k = -d; k <= d; k += 2) {
      const idx = k + offset
      if (idx < 0 || idx >= size) continue
      let x: number
      // Choose the move that gets us furthest: down (insert) or right (delete).
      if (k === -d || (k !== d && (v[idx - 1] ?? -1) < (v[idx + 1] ?? -1))) {
        x = v[idx + 1] ?? 0
      } else {
        x = (v[idx - 1] ?? 0) + 1
      }
      let y = x - k
      // Follow the diagonal (the "snake") through equal lines for free.
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      next[idx] = x
      if (x >= n && y >= m) {
        trace.push(next.slice())
        found = d
        v = next
        break outer
      }
    }
    v = next
  }

  if (found < 0) {
    // Bailed out past maxEditDistance: emit the trivially-correct script.
    const ops: EditOp[] = []
    for (let i = 0; i < n; i++) ops.push({ kind: 'delete', oldIndex: i })
    for (let j = 0; j < m; j++) ops.push({ kind: 'insert', newIndex: j })
    return ops
  }

  // Walk the trace backwards to recover the path.
  const ops: EditOp[] = []
  let x = n
  let y = m
  for (let d = found; d > 0; d--) {
    const vPrev = trace[d] as Int32Array
    const k = x - y
    const idx = k + offset
    const goDown = k === -d || (k !== d && (vPrev[idx - 1] ?? -1) < (vPrev[idx + 1] ?? -1))
    const prevK = goDown ? k + 1 : k - 1
    const prevX = vPrev[prevK + offset] ?? 0
    const prevY = prevX - prevK

    while (x > prevX && y > prevY) {
      x--
      y--
      ops.push({ kind: 'equal', oldIndex: x, newIndex: y })
    }
    if (goDown) {
      y--
      ops.push({ kind: 'insert', newIndex: y })
    } else {
      x--
      ops.push({ kind: 'delete', oldIndex: x })
    }
  }
  while (x > 0 && y > 0) {
    x--
    y--
    ops.push({ kind: 'equal', oldIndex: x, newIndex: y })
  }
  // d === 0 leftovers: one side is exhausted, the other is a pure run.
  while (x > 0) ops.push({ kind: 'delete', oldIndex: --x })
  while (y > 0) ops.push({ kind: 'insert', newIndex: --y })

  ops.reverse()
  return ops
}

/**
 * Render a unified diff. Returns '' when the two texts are identical — callers
 * use that to decide whether a file belongs in a summary at all.
 */
export function unifiedDiff(
  oldText: string,
  newText: string,
  path: string,
  options: DiffOptions = {},
): string {
  if (oldText === newText) return ''
  const context = options.context ?? 3
  const a = splitLines(oldText)
  const b = splitLines(newText)
  const ops = diffLines(a, b)

  const oldEndsNl = oldText === '' || oldText.endsWith('\n')
  const newEndsNl = newText === '' || newText.endsWith('\n')

  // Group the edit script into hunks: runs of change, padded with `context`
  // equal lines, merged when their padding overlaps.
  const changed = ops
    .map((op, i) => (op.kind === 'equal' ? -1 : i))
    .filter(i => i >= 0)

  if (changed.length === 0) {
    // Every LINE is identical, yet the texts differ — the only way that
    // happens is a trailing newline being added or removed. Returning ''
    // here (the obvious early exit) reports "no change" for a file that
    // really did change, which is the one thing a diff must never do.
    if (oldEndsNl === newEndsNl) return ''
    const lastIndex = Math.max(a.length, b.length)
    const lastLine = a[lastIndex - 1] ?? b[lastIndex - 1] ?? ''
    return [
      `--- ${options.oldLabel ?? `a/${path}`}`,
      `+++ ${options.newLabel ?? `b/${path}`}`,
      `@@ -${lastIndex},1 +${lastIndex},1 @@`,
      `-${lastLine}`,
      `+${lastLine}`,
      `\\ No newline at end of file (before: ${oldEndsNl}, after: ${newEndsNl})`,
    ].join('\n')
  }

  interface Hunk { start: number; end: number }
  const hunks: Hunk[] = []
  for (const i of changed) {
    const start = Math.max(0, i - context)
    const end = Math.min(ops.length - 1, i + context)
    const last = hunks[hunks.length - 1]
    if (last && start <= last.end + 1) last.end = Math.max(last.end, end)
    else hunks.push({ start, end })
  }

  const oldLabel = options.oldLabel ?? `a/${path}`
  const newLabel = options.newLabel ?? `b/${path}`
  const out: string[] = [`--- ${oldLabel}`, `+++ ${newLabel}`]

  for (const hunk of hunks) {
    const slice = ops.slice(hunk.start, hunk.end + 1)
    let oldStart = 0
    let newStart = 0
    let oldCount = 0
    let newCount = 0
    let seenOld = false
    let seenNew = false
    const body: string[] = []

    for (const op of slice) {
      if (op.kind === 'equal') {
        if (!seenOld) { oldStart = op.oldIndex; seenOld = true }
        if (!seenNew) { newStart = op.newIndex; seenNew = true }
        oldCount++
        newCount++
        body.push(` ${a[op.oldIndex] ?? ''}`)
      } else if (op.kind === 'delete') {
        if (!seenOld) { oldStart = op.oldIndex; seenOld = true }
        oldCount++
        body.push(`-${a[op.oldIndex] ?? ''}`)
      } else {
        if (!seenNew) { newStart = op.newIndex; seenNew = true }
        newCount++
        body.push(`+${b[op.newIndex] ?? ''}`)
      }
    }

    // Unified-diff line numbers are 1-based, and a zero-length side is
    // conventionally rendered with a start of the line BEFORE it.
    const oldFrom = oldCount === 0 ? oldStart : oldStart + 1
    const newFrom = newCount === 0 ? newStart : newStart + 1
    out.push(`@@ -${oldFrom},${oldCount} +${newFrom},${newCount} @@`)
    out.push(...body)
  }

  // "\ No newline at end of file" matters: without it, a diff that only removes
  // a trailing newline renders as no change at all.
  if (!oldEndsNl || !newEndsNl) {
    out.push(`\\ No newline at end of file (before: ${oldEndsNl}, after: ${newEndsNl})`)
  }

  return out.join('\n')
}

/** Count added/removed lines without rendering — used for compact summaries. */
export function diffStat(oldText: string, newText: string): { added: number; removed: number } {
  if (oldText === newText) return { added: 0, removed: 0 }
  const ops = diffLines(splitLines(oldText), splitLines(newText))
  let added = 0
  let removed = 0
  for (const op of ops) {
    if (op.kind === 'insert') added++
    else if (op.kind === 'delete') removed++
  }
  return { added, removed }
}
