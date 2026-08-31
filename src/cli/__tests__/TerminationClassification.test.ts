/**
 * Termination presentation must follow `stopReason`, not the coarse subtype.
 *
 * Reported from real use: a 2-hour auto run hit its configured wall-clock limit,
 * checkpointed correctly, printed "Progress was checkpointed; resume the session
 * to continue." — and then the CLI printed
 *
 *     ✗  执行过程中发生错误。请检查以下错误信息，调整指令后重试。
 *
 * with no error information following it. `KernelSession.subtypeMap` folds ten
 * distinct termination reasons into `error_during_execution`, and the printer
 * branched on that subtype, so a planned suspension, a user's Ctrl+C and a real
 * runtime fault were indistinguishable at the point of presentation.
 */
import { describe, expect, it } from 'vitest'
import {
  classifyTermination,
  resumeCommand,
  terminationLabel,
  warrantsTerminationDiagnosis,
} from '../termination.js'
import { formatDuration } from '../../infra/duration.js'

/** Exactly what the kernel emits for the reported 2h wall-clock stop. */
const wallClockStop = { subtype: 'error_during_execution', stopReason: 'auto_runtime_limit' }

describe('classifyTermination', () => {
  it('treats a checkpointed autonomy ceiling as suspension, not error', () => {
    expect(classifyTermination(wallClockStop)).toBe('suspended')
    expect(classifyTermination({ subtype: 'error_during_execution', stopReason: 'auto_tool_batch_limit' }))
      .toBe('suspended')
  })

  it('treats a user interrupt as interruption, not error', () => {
    for (const stopReason of ['aborted_streaming', 'aborted_tools']) {
      expect(classifyTermination({ subtype: 'error_during_execution', stopReason })).toBe('interrupted')
    }
  })

  it('still reports genuine faults as abnormal', () => {
    for (const stopReason of [
      'no_progress', 'verify_exhausted', 'auto_verify_unavailable',
      'auto_drift_unavailable', 'phase_hook_fail', 'error',
    ]) {
      expect(classifyTermination({ subtype: 'error_during_execution', stopReason })).toBe('abnormal')
    }
  })

  it('routes configured ceilings to the limit class', () => {
    for (const stopReason of ['max_turns', 'max_budget_usd', 'max_output_tokens', 'blocking_limit']) {
      expect(classifyTermination({ subtype: 'error_max_turns', stopReason })).toBe('limit')
    }
  })

  it('keeps success and parked distinct from every failure class', () => {
    expect(classifyTermination({ subtype: 'success', stopReason: null })).toBe('success')
    expect(classifyTermination({ subtype: 'parked', stopReason: 'parked' })).toBe('parked')
  })

  it('falls back to the subtype when stopReason is absent', () => {
    // Older producers and subtype-only callers must keep working.
    expect(classifyTermination({ subtype: 'error_max_turns' })).toBe('limit')
    expect(classifyTermination({ subtype: 'error_max_budget' })).toBe('limit')
    expect(classifyTermination({ subtype: 'error_during_execution' })).toBe('abnormal')
  })

  it('defaults an unrecognised reason to abnormal', () => {
    // Safe direction: show the diagnosis rather than silently hide a failure
    // whose reason nobody has classified yet.
    expect(classifyTermination({ subtype: 'error_during_execution', stopReason: 'brand_new_reason' }))
      .toBe('abnormal')
  })
})

describe('warrantsTerminationDiagnosis', () => {
  it('does not bill an LLM call to explain a planned suspension', () => {
    expect(warrantsTerminationDiagnosis(wallClockStop)).toBe(false)
  })

  it('does not bill an LLM call to explain the user pressing Ctrl+C', () => {
    expect(warrantsTerminationDiagnosis({ subtype: 'error_during_execution', stopReason: 'aborted_tools' }))
      .toBe(false)
  })

  it('still diagnoses a stall, which is what the diagnosis is for', () => {
    expect(warrantsTerminationDiagnosis({ subtype: 'error_during_execution', stopReason: 'no_progress' }))
      .toBe(true)
  })
})

describe('terminationLabel', () => {
  it('names the precise reason instead of hedging across four possibilities', () => {
    expect(terminationLabel(wallClockStop)).toContain('auto_runtime_limit')
    // The old subtype-only label could only offer this disjunction, which is
    // what the diagnosis prompt was being fed.
    expect(terminationLabel(wallClockStop)).not.toContain('可能是')
  })

  it('distinguishes reasons that share one subtype', () => {
    const labels = ['no_progress', 'verify_exhausted', 'auto_drift_unavailable', 'aborted_tools']
      .map(stopReason => terminationLabel({ subtype: 'error_during_execution', stopReason }))
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('keeps the hedged wording only where nothing better is knowable', () => {
    expect(terminationLabel({ subtype: 'error_during_execution' })).toContain('可能是')
  })
})

describe('operator-facing details', () => {
  it('renders the ceiling in a unit a human reads, not milliseconds', () => {
    // The reported message said "reached its 7200000ms wall-clock limit".
    expect(formatDuration(7_200_000)).toBe('2h')
    expect(formatDuration(90_000)).toBe('1m30s')
    expect(formatDuration(45_000)).toBe('45s')
  })

  it('spells out the resume command, since "resume the session" needs an id', () => {
    expect(resumeCommand('abc-123', 'auto')).toBe('meta-agent --mode auto --resume abc-123 "继续"')
    // agentic is the default mode; no flag needed.
    expect(resumeCommand('abc-123', 'agentic')).toBe('meta-agent --resume abc-123 "继续"')
    expect(resumeCommand('abc-123', null)).toBe('meta-agent --resume abc-123 "继续"')
  })
})
