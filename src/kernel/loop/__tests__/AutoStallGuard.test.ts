import { describe, it, expect } from 'vitest'
import {
  allToolResultsErrored, turnMutatedFs,
  AUTO_STALL_FAILURE_LIMIT, AUTO_STALL_SOFT_LIMIT, AUTO_NO_FS_PROGRESS_LIMIT,
} from '../AutoStallGuard.js'
import type { KernelMessage } from '../../types/KernelMessage.js'

function resultMsg(id: string, isError: boolean): KernelMessage {
  return { uuid: id, role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'x', is_error: isError }] }
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
