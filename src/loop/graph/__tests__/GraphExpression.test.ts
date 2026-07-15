import { describe, expect, it } from 'vitest'
import {
  compileCondition,
  createBuiltinFunctionRegistry,
  createBuiltinReducerRegistry,
  evaluateCondition,
  evaluateValueExpression,
} from '../index.js'

describe('graph deterministic expressions', () => {
  it('evaluates $state in the program instead of asking an LLM to calculate', () => {
    const condition = compileCondition('$state.retry_count >= 8 && $output.passed == true')
    expect(evaluateCondition(condition, { state: { retry_count: 8 }, output: { passed: true } })).toBe(true)
  })

  it('resolves JSON values and invokes only registered functions', async () => {
    const output = await evaluateValueExpression(
      { call: 'builtin/length@1', args: [{ ref: '$state.failures' }] },
      { state: { failures: ['a', 'b'] } },
      createBuiltinFunctionRegistry(),
    )
    expect(output).toBe(2)
  })

  it('applies typed builtin reducers', () => {
    const reducers = createBuiltinReducerRegistry()
    expect(reducers.get('builtin/increment@1').reduce(7, [])).toBe(8)
    expect(reducers.get('builtin/bounded-append@1').reduce(['a'], ['b', 1])).toEqual(['b'])
  })

  it('treats an absent optional condition field as non-matching', () => {
    expect(evaluateCondition(compileCondition('$output.ready == true'), { state: {}, output: {} })).toBe(false)
  })
})
