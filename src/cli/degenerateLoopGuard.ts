/**
 * Stop a phase that has started arguing with itself.
 *
 * A Distill reviewer once spent its entire wall-clock window re-emitting the
 * same paragraph — "however, I need to reconsider the locus…" — six times over,
 * never reaching a verdict, until the operator pressed Ctrl+C. Nothing in the
 * host noticed: turn limits do not help when the repetition happens inside one
 * message, and the wall limit only fires twenty minutes later, after the budget
 * is gone and with no output to show for it.
 *
 * The detector is deliberately dumb and conservative. It looks for one
 * substantial block of text reproduced verbatim several times; genuine output
 * does not do that, while a model stuck in a deliberation cycle does it almost
 * immediately. Whitespace is normalised so re-wrapping does not hide a repeat,
 * and the window is large enough that repetitive-but-legitimate structure
 * (table rows, list items, JSON records) cannot trip it — those differ in their
 * identifiers, so an exact 600-character match never lands.
 */
export interface DegenerateLoopGuardOptions {
  /** Characters compared for repetition. Large enough that structured output
   * with differing ids cannot match exactly. */
  windowChars?: number
  /** How many times the window must appear before the phase is cut off. */
  repeats?: number
  /** Do not even look until the stream is this long; short outputs are cheap. */
  minTextChars?: number
}

export interface DegenerateLoopGuard {
  /** Feed accumulated text. Returns a reason once the loop is detected, else
   * `undefined`. Idempotent: it reports only the first time. */
  inspect(accumulated: string): string | undefined
}

const normalize = (text: string): string => text.replace(/\s+/g, ' ')

export function createDegenerateLoopGuard(options: DegenerateLoopGuardOptions = {}): DegenerateLoopGuard {
  const windowChars = options.windowChars ?? 600
  const repeats = options.repeats ?? 3
  const minTextChars = options.minTextChars ?? windowChars * repeats
  let tripped = false
  let checkedAt = 0

  return {
    inspect(accumulated: string): string | undefined {
      if (tripped || accumulated.length < minTextChars) return undefined
      // Re-scanning on every chunk would be quadratic; a stride keeps it cheap
      // while still catching a cycle within a few hundred characters.
      if (accumulated.length - checkedAt < windowChars / 2) return undefined
      checkedAt = accumulated.length

      const normalized = normalize(accumulated)
      if (normalized.length < windowChars * repeats) return undefined
      const needle = normalized.slice(-windowChars)
      let count = 0
      let index = normalized.indexOf(needle)
      while (index !== -1) {
        count++
        if (count >= repeats) break
        index = normalized.indexOf(needle, index + 1)
      }
      if (count < repeats) return undefined

      tripped = true
      return `输出陷入重复循环：同一段 ${windowChars} 字符的文本已原样出现 ${count} 次，判定为无法收敛的自我论证，已中止本阶段以免耗尽预算。`
    },
  }
}
