import { describe, expect, it } from 'vitest'
import { createDegenerateLoopGuard } from '../degenerateLoopGuard.js'

/**
 * A Distill reviewer once restated the same paragraph six times without ever
 * reaching a verdict, burning its whole wall-clock window until the operator
 * pressed Ctrl+C. Turn limits do not catch that (the repetition is inside one
 * message) and the wall limit only fires long after the budget is gone.
 */
const paragraph = (
  'C5 requires a detailed audit of the repository. The worker prompt does not contain those steps. '
  + 'However, C5 resolves to the graph locus, so node prose does not count as an implementation. '
  + 'Actually, I need to reconsider the locus of C5, because an audit can only ever live in a prompt. '
  + 'Let me re-read the worker prompt once more to check whether the audit content is really missing. '
  + 'Step 1 says read the source and the state files; there is no explicit audit step in the prompt. '
  + 'This is a problem for C5 — the prompt should contain the detailed audit instructions instead. '
)

const feed = (guard: ReturnType<typeof createDegenerateLoopGuard>, chunks: string[]): string | undefined => {
  let accumulated = ''
  for (const chunk of chunks) {
    accumulated += chunk
    const reason = guard.inspect(accumulated)
    if (reason) return reason
  }
  return undefined
}

describe('degenerate loop guard', () => {
  it('cuts off a phase that restates the same paragraph', () => {
    const reason = feed(createDegenerateLoopGuard(), Array.from({ length: 6 }, () => paragraph))
    expect(reason).toContain('重复循环')
    expect(reason).toContain('已中止本阶段')
  })

  it('reports only once, so the caller interrupts a single time', () => {
    const guard = createDegenerateLoopGuard()
    const accumulated = paragraph.repeat(8)
    expect(guard.inspect(accumulated)).toBeTruthy()
    expect(guard.inspect(accumulated + paragraph)).toBeUndefined()
  })

  it('ignores re-wrapping: whitespace differences do not hide a repeat', () => {
    const wrapped = paragraph.replace(/ /g, '\n')
    const reason = feed(createDegenerateLoopGuard(), [paragraph, wrapped, paragraph, wrapped])
    expect(reason).toBeTruthy()
  })

  it('leaves long non-repeating output alone', () => {
    const varied = Array.from({ length: 40 }, (_, index) =>
      `Constraint C${index} resolves to the graph locus and is implemented by transition t${index}, `
      + `which updates counter_${index} and routes to node stage_${index} under a distinct condition. `)
    expect(feed(createDegenerateLoopGuard(), varied)).toBeUndefined()
  })

  it('does not trip on structured records that merely look alike', () => {
    // Verdict tables and JSON arrays repeat their SHAPE but differ in every
    // identifier, so an exact window match never lands — the property that
    // makes this detector safe to run on real envelopes.
    const rows = Array.from({ length: 60 }, (_, index) =>
      `{"constraintId":"C${index}","verdict":"satisfied","graphRefs":["/transitions/${index}"],"note":"checked against the source"},`)
    expect(feed(createDegenerateLoopGuard(), rows)).toBeUndefined()
  })

  it('stays quiet on short output regardless of repetition', () => {
    // Cheap phases are not worth guarding, and a tiny repeated token is normal.
    expect(feed(createDegenerateLoopGuard(), ['ok. '.repeat(20)])).toBeUndefined()
  })
})
