/**
 * textWidth — how many COLUMNS a string occupies in a terminal.
 *
 * Its own module, below even term.ts, because every CLI surface that truncates
 * to the terminal width needs it and none of them may end up importing each
 * other to get it. There is exactly one definition of "wide" here.
 *
 * Why this matters, concretely: a CJK glyph advances the cursor two columns but
 * counts as one UTF-16 code unit. The thinking meter measured with
 * `String.length`, so a Chinese status line that passed the "fits in
 * `columns - 1`" check still wrapped to a second row — and `hide()` erases
 * exactly one row (`\r\x1b[2K`), leaving the wrapped remainder on screen as
 * debris that the next real output had to write around. The frame renderer had
 * the correct implementation all along; it just was not reachable from here.
 */

/**
 * East Asian Wide / Fullwidth ranges, coarse but stable. Deliberately not a
 * full Unicode EAW table: the extra precision buys nothing for the strings the
 * CLI renders (CJK task goals, status labels) and a lookup table would have to
 * be regenerated per Unicode release.
 */
function isWide(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  )
}

/** Columns `text` occupies in a terminal. Iterates code POINTS, not code units. */
export function displayWidth(text: string): number {
  let width = 0
  for (const ch of text) width += isWide(ch) ? 2 : 1
  return width
}

/** Truncate to a display width, appending `…` when anything was cut. */
export function fit(text: string, limit: number): string {
  if (limit <= 0) return ''
  if (displayWidth(text) <= limit) return text
  let out = ''
  let width = 0
  for (const ch of text) {
    const w = isWide(ch) ? 2 : 1
    if (width + w > limit - 1) break
    out += ch
    width += w
  }
  return `${out}…`
}

/**
 * Truncate to a display width with NO ellipsis.
 *
 * For a line whose only requirement is "must not wrap" — the status line, where
 * spending a column on `…` would be spending it on nothing.
 */
export function clampWidth(text: string, limit: number): string {
  if (limit <= 0) return ''
  if (displayWidth(text) <= limit) return text
  let out = ''
  let width = 0
  for (const ch of text) {
    const w = isWide(ch) ? 2 : 1
    if (width + w > limit) break
    out += ch
    width += w
  }
  return out
}

/** Split into lines of at most `limit` columns, never cutting a wide glyph. */
export function wrapToWidth(text: string, limit: number): string[] {
  if (!text) return []
  if (limit <= 0) return [text]
  const lines: string[] = []
  let current = ''
  let width = 0
  for (const ch of text) {
    const chWidth = isWide(ch) ? 2 : 1
    if (current && width + chWidth > limit) {
      lines.push(current)
      current = ''
      width = 0
    }
    current += ch
    width += chWidth
  }
  if (current) lines.push(current)
  return lines
}
