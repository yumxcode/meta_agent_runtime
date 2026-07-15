/**
 * Expr DSL — operator matrix, static checks, and every rejection path.
 * The evaluator is the only thing standing between graph data and kernel
 * decisions, so its error paths are as load-bearing as its happy paths.
 */
import { describe, expect, it } from 'vitest'
import { parse, evaluate, evaluateBool, collectRefs, ExprError } from '../Expr.js'

const ctx = {
  stale_count: 2,
  iteration: 5,
  new_findings: 0,
  metric_delta: -0.5,
  'budget.lifetime.exhausted': false,
  status: 'healthy',
  flag: true,
}

const evalSrc = (src: string) => evaluate(parse(src), ctx)

describe('parse + evaluate matrix', () => {
  it('arithmetic with precedence and grouping', () => {
    expect(evalSrc('1 + 2 * 3')).toBe(7)
    expect(evalSrc('(1 + 2) * 3')).toBe(9)
    expect(evalSrc('10 / 4')).toBe(2.5)
    expect(evalSrc('-iteration + 1')).toBe(-4)
  })

  it('relational and equality', () => {
    expect(evalSrc('stale_count >= 2')).toBe(true)
    expect(evalSrc('stale_count < 2')).toBe(false)
    expect(evalSrc('iteration <= 5 && iteration > 4')).toBe(true)
    expect(evalSrc("status == 'healthy'")).toBe(true)
    expect(evalSrc('status != "stale"')).toBe(true)
    expect(evalSrc('flag == true')).toBe(true)
  })

  it('logical ops with short-circuit (right side never evaluated)', () => {
    // `missing` is not in ctx — would throw if evaluated.
    expect(evaluate(parse('false && missing'), ctx)).toBe(false)
    expect(evaluate(parse('true || missing'), ctx)).toBe(true)
    expect(evalSrc('!flag || flag')).toBe(true)
  })

  it('evaluates compound graph routing rules', () => {
    expect(evalSrc('new_findings == 0 || metric_delta < 0')).toBe(true)
    expect(evalSrc('new_findings > 0 && metric_delta >= 0')).toBe(false)
    expect(evalSrc('budget.lifetime.exhausted')).toBe(false)
  })
})

describe('static checks (create-time)', () => {
  it('rejects undeclared identifiers when a declaration set is given', () => {
    const declared = new Set(['stale_count'])
    expect(() => parse('stale_count >= 2', declared)).not.toThrow()
    expect(() => parse('stale_countt >= 2', declared)).toThrow(/undeclared identifier/)
  })

  it('collectRefs is deduped and complete', () => {
    expect(collectRefs(parse('a + a * b.c && !d'))).toEqual(['a', 'b.c', 'd'])
  })
})

describe('whitelist rejections', () => {
  const bad: Array<[string, RegExp]> = [
    ['foo(1)', /function calls/],
    ['a[0]', /indexing/],
    ['a ? b : c', /ternary/],
    ['a = 2', /assignment/],
    ['a === 2', /assignment/],   // '===' lexes as '==' then '='
    ['a @ b', /unexpected character/],
    ['"unterminated', /unterminated string/],
    ['', /empty/],
    ['a +', /unexpected end/],
    ['(a', /closing parenthesis/],
    ['1 2', /trailing tokens/],
  ]
  for (const [src, re] of bad) {
    it(`rejects ${JSON.stringify(src)}`, () => {
      expect(() => parse(src)).toThrow(re)
    })
  }
})

describe('strict runtime typing (no coercion)', () => {
  const cases: Array<[string, RegExp]> = [
    ['1 && true', /needs booleans/],
    ['!1', /needs a boolean/],
    ['-flag', /needs a number/],
    ["1 == '1'", /share a type/],
    ["'a' < 'b'", /needs numbers/],
    ['1 / 0', /division by zero/],
    ['nope > 1', /missing from context/],
  ]
  for (const [src, re] of cases) {
    it(`throws on ${JSON.stringify(src)}`, () => {
      expect(() => evalSrc(src)).toThrow(re)
    })
  }

  it('evaluateBool refuses non-boolean results', () => {
    expect(() => evaluateBool(parse('1 + 1'), ctx)).toThrow(/must yield a boolean/)
    expect(evaluateBool(parse('1 + 1 == 2'), ctx)).toBe(true)
  })

  it('ExprError carries the source expression', () => {
    try {
      parse('a[1]')
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(ExprError)
      expect((err as ExprError).message).toContain('a[1]')
    }
  })
})

describe('AST is plain JSON (frozen-snapshot requirement)', () => {
  it('round-trips through JSON.stringify/parse and still evaluates', () => {
    const ast = parse('stale_count >= 2 && !budget.lifetime.exhausted')
    const revived = JSON.parse(JSON.stringify(ast))
    expect(evaluate(revived, ctx)).toBe(true)
  })
})
