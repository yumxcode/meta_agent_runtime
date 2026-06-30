import { describe, it, expect } from 'vitest'
import {
  allToolResultsErrored, turnMutatedFs,
  AUTO_STALL_FAILURE_LIMIT, AUTO_STALL_SOFT_LIMIT, AUTO_NO_FS_PROGRESS_LIMIT,
  AUTO_RECURRING_ERROR_LIMIT, RECURRING_ERROR_WINDOW,
  normalizeErrorSignature, collectTurnErrors, buildRecurringErrorReflection,
} from '../AutoStallGuard.js'
import type { KernelMessage } from '../../types/KernelMessage.js'

function resultMsg(id: string, isError: boolean): KernelMessage {
  return { uuid: id, role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'x', is_error: isError }] }
}

function errMsg(id: string, content: string): KernelMessage {
  return { uuid: id, role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: true }] }
}

describe('allToolResultsErrored', () => {
  it('true when every tool result errored', () => {
    expect(allToolResultsErrored([resultMsg('a', true), resultMsg('b', true)])).toBe(true)
  })

  it('false when any tool result succeeded', () => {
    expect(allToolResultsErrored([resultMsg('a', true), resultMsg('b', false)])).toBe(false)
  })

  it('false when there were no tool results at all', () => {
    expect(allToolResultsErrored([])).toBe(false)
    expect(allToolResultsErrored([{ uuid: 'u', role: 'user', content: [{ type: 'text', text: 'hi' }] }])).toBe(false)
  })

  it('exposes a sane failure limit', () => {
    expect(AUTO_STALL_FAILURE_LIMIT).toBeGreaterThanOrEqual(3)
  })
})

describe('turnMutatedFs', () => {
  const names = new Map<string, string>([
    ['w', 'write_file'], ['e', 'edit_file'], ['n', 'notebook_edit'],
    ['b', 'bash'], ['r', 'read_file'],
  ])

  it('true when a successful FS-mutating tool ran', () => {
    expect(turnMutatedFs([resultMsg('w', false)], names)).toBe(true)
    expect(turnMutatedFs([resultMsg('e', false)], names)).toBe(true)
  })

  it('false when the FS-mutating tool errored', () => {
    expect(turnMutatedFs([resultMsg('w', true)], names)).toBe(false)
  })

  it('false for non-FS tools (read/bash do not count as FS progress)', () => {
    expect(turnMutatedFs([resultMsg('r', false)], names)).toBe(false)
    expect(turnMutatedFs([resultMsg('b', false)], names)).toBe(false)
  })

  it('thresholds are ordered: soft < hard, and no-FS limit is generous', () => {
    expect(AUTO_STALL_SOFT_LIMIT).toBeLessThan(AUTO_STALL_FAILURE_LIMIT)
    expect(AUTO_NO_FS_PROGRESS_LIMIT).toBeGreaterThan(AUTO_STALL_FAILURE_LIMIT)
  })
})

describe('normalizeErrorSignature (conservative)', () => {
  it('collapses volatile tokens (line numbers / paths / addresses) to one signature', () => {
    const a = normalizeErrorSignature('bash', "AttributeError: 'str' object has no attribute 'get' at /a/b/x.py:155")
    const b = normalizeErrorSignature('bash', "AttributeError: 'str' object has no attribute 'get' at /c/d/y.py:9012")
    expect(a).toBe(b)
  })

  it('keeps genuinely different errors distinct', () => {
    const a = normalizeErrorSignature('bash', "AttributeError: 'str' object has no attribute 'get'")
    const b = normalizeErrorSignature('bash', "KeyError: 'rows'")
    expect(a).not.toBe(b)
  })

  it('different tools with the same text are distinct', () => {
    expect(normalizeErrorSignature('bash', 'boom')).not.toBe(normalizeErrorSignature('edit_file', 'boom'))
  })
})

describe('collectTurnErrors', () => {
  const names = new Map<string, string>([['b', 'bash'], ['w', 'write_file']])

  it('returns only errored results, signed by tool + normalized text', () => {
    const errs = collectTurnErrors([errMsg('b', 'KeyError: rows'), resultMsg('w', false)], names)
    expect(errs).toHaveLength(1)
    expect(errs[0]!.signature).toBe(normalizeErrorSignature('bash', 'KeyError: rows'))
    expect(errs[0]!.sample).toContain('KeyError')
  })

  it('two failures differing only by line number share a signature (the loop key)', () => {
    const errs = collectTurnErrors(
      [errMsg('b', 'Traceback x.py:10 KeyError'), errMsg('b', 'Traceback x.py:88 KeyError')],
      names,
    )
    expect(errs[0]!.signature).toBe(errs[1]!.signature)
  })
})

describe('recurring-error axis config + reflection', () => {
  it('limit is soft (>= existing hard stall limit) and window is generous', () => {
    expect(AUTO_RECURRING_ERROR_LIMIT).toBeGreaterThanOrEqual(AUTO_STALL_FAILURE_LIMIT)
    expect(RECURRING_ERROR_WINDOW).toBeGreaterThan(AUTO_RECURRING_ERROR_LIMIT)
  })

  it('reflection includes the error sample and the recurrence count', () => {
    const text = buildRecurringErrorReflection("KeyError: 'rows'", 6)
    expect(text).toContain("KeyError: 'rows'")
    expect(text).toContain('6')
  })
})
