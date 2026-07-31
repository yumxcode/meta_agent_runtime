/**
 * Recovering a structured envelope from model prose.
 *
 * Every Distill phase ends by returning JSON, and every phase has lost a whole
 * attempt to the same mechanical slip: a model writing Chinese prose quotes a
 * document with ASCII double quotes and does not escape them —
 *
 *     "precheck": "L131 明确说"具体阈值必须在训练前写入 task_spec.md"；当前无参数"
 *
 * — which makes the entire envelope invalid. Worse, the brace scanner that
 * looks for candidate objects tracks string state with the same quotes, so it
 * desynchronises and reports *zero* candidates. The user then sees "no
 * parseable envelope", which reads like a missing field and sends them looking
 * in the wrong place.
 *
 * The repair here is deliberately narrow and deterministic: inside a string, a
 * quote only ends that string if the next non-whitespace character can legally
 * follow a value. Anything else is an inner quote and gets escaped. This cannot
 * invent structure — it only ever converts a parse failure into the parse the
 * model plainly intended.
 */

/** Characters that may legally follow a closing string quote in JSON. */
const VALUE_TERMINATORS = new Set([',', '}', ']', ':'])

/**
 * Escape ASCII quotes that appear *inside* JSON string values.
 *
 * Returns the input unchanged when nothing needed escaping, so callers can
 * cheaply tell whether a repair was involved.
 */
export function repairUnescapedQuotes(source: string): string {
  let out = ''
  let inString = false
  let escaped = false
  let repaired = false
  for (let index = 0; index < source.length; index++) {
    const char = source[index]!
    if (!inString) {
      out += char
      if (char === '"') inString = true
      continue
    }
    if (escaped) { out += char; escaped = false; continue }
    if (char === '\\') { out += char; escaped = true; continue }
    if (char !== '"') { out += char; continue }
    if (closesString(source, index)) { out += char; inString = false; continue }
    // An inner quote: the model meant it as text, not as structure.
    out += '\\"'
    repaired = true
  }
  return repaired ? out : source
}

function closesString(source: string, quoteIndex: number): boolean {
  for (let index = quoteIndex + 1; index < source.length; index++) {
    const char = source[index]!
    if (char === ' ' || char === '\t' || char === '\r' || char === '\n') continue
    return VALUE_TERMINATORS.has(char)
  }
  // Trailing quote at end of input closes the string.
  return true
}

/** Every balanced `{…}` span that parses, trying a quote repair per span. */
export function extractJsonObjects(source: string): unknown[] {
  const objects: unknown[] = []
  for (const span of braceSpans(source)) {
    const parsed = tryJson(span)
    if (parsed !== undefined) { objects.push(parsed); continue }
    const repairedSpan = repairUnescapedQuotes(span)
    if (repairedSpan === span) continue
    const reparsed = tryJson(repairedSpan)
    if (reparsed !== undefined) objects.push(reparsed)
  }
  return objects
}

/**
 * Candidate spans by brace balance.
 *
 * Runs twice when needed: once on the raw text, and — because an unescaped
 * quote desynchronises string tracking and can hide the outermost object
 * entirely — once on a quote-repaired copy. Without the second pass the top
 * level object of a malformed envelope is never even offered to the parser.
 */
function braceSpans(source: string): string[] {
  const spans = scanBraceSpans(source)
  const repaired = repairUnescapedQuotes(source)
  if (repaired === source) return spans
  return [...scanBraceSpans(repaired), ...spans]
}

function scanBraceSpans(source: string): string[] {
  const spans: string[] = []
  for (let start = 0; start < source.length; start++) {
    if (source[start] !== '{') continue
    let depth = 0, inString = false, escaped = false
    for (let end = start; end < source.length; end++) {
      const char = source[end]!
      if (inString) {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === '"') inString = false
      } else if (char === '"') inString = true
      else if (char === '{') depth++
      else if (char === '}' && --depth === 0) {
        spans.push(source.slice(start, end + 1))
        start = end
        break
      }
    }
  }
  return spans
}

export function tryJson(value: string): unknown {
  try { return JSON.parse(value.trim()) } catch { return undefined }
}

/** All plausible structured readings of a phase result, best-effort. */
export function structuredJsonCandidates(output: unknown, summary?: string): unknown[] {
  const candidates: unknown[] = [output]
  const harvest = (text: string): void => {
    const direct = tryJson(text)
    if (direct !== undefined) candidates.push(direct)
    candidates.push(...extractJsonObjects(text))
  }
  if (typeof output === 'string') harvest(output)
  if (summary) harvest(summary)
  return candidates
}

/**
 * Say what is actually wrong with the envelope.
 *
 * "No parseable envelope" is true but useless: it reads like a missing field,
 * while the real cause is usually a quoting slip several thousand characters
 * in. Pointing at the offending line is the difference between a five-second
 * fix and a lost session.
 */
export function describeJsonDefect(output: unknown, summary?: string): string | undefined {
  const text = typeof output === 'string' ? output : summary
  if (typeof text !== 'string' || !text.trim()) {
    return typeof output === 'object' && output !== null
      ? '模型返回了对象，但其中缺少必需的顶层键'
      : '模型没有返回任何文本或结构化输出'
  }
  const span = scanBraceSpans(text)[0] ?? text
  if (tryJson(span) !== undefined) return undefined
  const repaired = repairUnescapedQuotes(span)
  if (repaired !== span && tryJson(repaired) !== undefined) {
    return `JSON 字符串内含未转义的半角双引号（宿主已自动修复；请在提示中改用中文引号或转义）`
  }
  try {
    JSON.parse(span)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // V8 locates some defects and not others: "Expected ',' or '}' … at
    // position 166 (line 5 column 51)" versus a bare "Unexpected token ','".
    // Report the location when it is offered and stay honest when it is not —
    // a fabricated line number is worse than none.
    const offset = Number(/position (\d+)/.exec(message)?.[1] ?? NaN)
    if (Number.isFinite(offset)) {
      const line = span.slice(0, offset).split('\n').length
      const context = span.slice(Math.max(0, offset - 60), offset + 60).replace(/\s+/g, ' ')
      return `JSON 解析失败于第 ${line} 行（偏移 ${offset}）：${message}\n附近文本：…${context}…`
    }
    const line = /line (\d+)/.exec(message)?.[1]
    return line ? `JSON 解析失败于第 ${line} 行：${message}` : `JSON 解析失败：${message}`
  }
  return undefined
}
