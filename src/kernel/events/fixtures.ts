/**
 * Canonical event corpus — the frozen evidence that the contract has not moved.
 *
 * Every entry is a real event shape a consumer may already be parsing. The
 * fixture test validates all of them against the LIVE schema, so a field rename
 * or a narrowed type fails here first, with a diff a reviewer can read, instead
 * of failing in someone's telemetry pipeline three weeks later.
 *
 * Two rules for editing this file:
 *
 *   1. **Never edit an existing fixture to make a test pass.** That inverts the
 *      whole mechanism — the fixture is the old contract, and rewriting it is
 *      how you erase the evidence that you broke it. Add a NEW fixture for the
 *      new shape and bump the schema version instead.
 *   2. **Cover the optional fields.** A fixture that only exercises required
 *      fields cannot detect an optional field being removed, and optional
 *      fields are exactly where consumers accumulate quiet dependencies. Hence
 *      the `_minimal` / `_full` pairs below.
 */

import type { KernelEvent } from '../types/KernelEvent.js'

export interface EventFixture {
  /** Stable name, used in test output so a failure names the case. */
  name: string
  /** Schema version this fixture was captured under. */
  capturedIn: string
  event: KernelEvent
}

export const EVENT_FIXTURES: readonly EventFixture[] = [
  {
    name: 'text_delta',
    capturedIn: '1.0.0',
    event: { type: 'text_delta', delta: 'Hello, world', sessionId: 'sess-1' },
  },
  {
    name: 'text_delta_empty',
    capturedIn: '1.0.0',
    // Empty deltas really are emitted (a stream that opens a block and closes
    // it without content); a schema that required non-empty would break them.
    event: { type: 'text_delta', delta: '', sessionId: 'sess-1' },
  },
  {
    name: 'thinking_delta',
    capturedIn: '1.0.0',
    event: { type: 'thinking_delta', delta: 'Considering the options…', sessionId: 'sess-1' },
  },
  {
    name: 'tool_use_object_input',
    capturedIn: '1.0.0',
    event: {
      type: 'tool_use',
      id: 'toolu_01',
      name: 'read_file',
      input: { file_path: '/w/src/a.ts' },
      sessionId: 'sess-1',
    },
  },
  {
    name: 'tool_use_empty_input',
    capturedIn: '1.0.0',
    // Zero-argument tools (close_session with no id, turn_diff with defaults)
    // send `{}`. The schema must not require a populated input.
    event: { type: 'tool_use', id: 'toolu_02', name: 'turn_diff', input: {}, sessionId: 'sess-1' },
  },
  {
    name: 'tool_result_ok',
    capturedIn: '1.0.0',
    event: {
      type: 'tool_result',
      id: 'toolu_01',
      toolName: 'read_file',
      content: 'file contents',
      isError: false,
      sessionId: 'sess-1',
    },
  },
  {
    name: 'tool_result_error',
    capturedIn: '1.0.0',
    event: {
      type: 'tool_result',
      id: 'toolu_03',
      toolName: 'bash',
      content: 'Error: command not found',
      isError: true,
      sessionId: 'sess-1',
    },
  },
  {
    name: 'compact_start',
    capturedIn: '1.0.0',
    event: { type: 'compact_start', sessionId: 'sess-1' },
  },
  {
    name: 'compact_boundary',
    capturedIn: '1.0.0',
    event: {
      type: 'compact_boundary',
      compactMetadata: { summaryTokens: 1_200, previousTokens: 84_000 },
      sessionId: 'sess-1',
    },
  },
  {
    name: 'compact_failed_minimal',
    capturedIn: '1.0.0',
    event: {
      type: 'compact_failed',
      attempt: 1,
      error: 'model returned an unusable summary',
      consecutiveFailures: 1,
      sessionId: 'sess-1',
    },
  },
  {
    name: 'compact_failed_with_query_source',
    capturedIn: '1.0.0',
    event: {
      type: 'compact_failed',
      attempt: 2,
      querySource: 'auto_compact',
      error: 'timeout',
      consecutiveFailures: 2,
      sessionId: 'sess-1',
    },
  },
  {
    name: 'api_retry_with_status',
    capturedIn: '1.0.0',
    event: {
      type: 'api_retry',
      attempt: 1,
      maxRetries: 5,
      retryDelayMs: 1_000,
      errorStatus: 529,
      sessionId: 'sess-1',
    },
  },
  {
    name: 'api_retry_null_status',
    capturedIn: '1.0.0',
    // A network-level failure has no HTTP status. `null` is a real value here,
    // not a missing field — a schema that made it optional-undefined instead
    // would quietly change what consumers must handle.
    event: {
      type: 'api_retry',
      attempt: 2,
      maxRetries: 5,
      retryDelayMs: 2_000,
      errorStatus: null,
      sessionId: 'sess-1',
    },
  },
  {
    name: 'tool_use_summary',
    capturedIn: '1.0.0',
    event: {
      type: 'tool_use_summary',
      summary: 'Read three files and ran the test suite.',
      precedingToolUseIds: ['toolu_01', 'toolu_02', 'toolu_03'],
      sessionId: 'sess-1',
    },
  },
  {
    name: 'system_message_warning',
    capturedIn: '1.0.0',
    event: {
      type: 'system_message',
      subtype: 'warning',
      text: '[drift] 航向检查不可用',
      sessionId: 'sess-1',
    },
  },
  {
    name: 'system_message_info',
    capturedIn: '1.0.0',
    event: { type: 'system_message', subtype: 'info', text: 'sandbox active', sessionId: 'sess-1' },
  },
  {
    name: 'result_success_minimal',
    capturedIn: '1.0.0',
    event: {
      type: 'result',
      subtype: 'success',
      sessionId: 'sess-1',
      usage: {
        inputTokens: 1_000,
        outputTokens: 500,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
      },
      costUsd: 0.0123,
      numTurns: 4,
      stopReason: 'end_turn',
      resultText: 'Done.',
    },
  },
  {
    name: 'result_error_full',
    capturedIn: '1.0.0',
    // Every optional field populated at once: the only fixture that can detect
    // one of them being dropped.
    event: {
      type: 'result',
      subtype: 'error_during_execution',
      sessionId: 'sess-1',
      usage: {
        inputTokens: 9_000,
        outputTokens: 1_200,
        cacheWriteTokens: 2_000,
        cacheReadTokens: 7_000,
      },
      costUsd: 1.5,
      numTurns: 30,
      stopReason: null,
      resultText: 'Stopped.',
      errors: ['tool timeout', 'stream aborted'],
      failure: { kind: 'tool_timeout', toolName: 'bash' } as never,
      permissionDenials: [
        {
          toolName: 'bash',
          toolUseId: 'toolu_09',
          reason: 'bash.command is outside workspace: /etc/passwd',
          timestamp: 1_700_000_000_000,
        },
      ],
    },
  },
  // The four circuit-breaker exits. Consumers branch on `subtype` to decide
  // whether a run can be resumed, so each one needs its own fixture — a rename
  // here changes what a caller does, not just what it logs.
  {
    name: 'result_error_max_turns',
    capturedIn: '1.0.0',
    event: {
      type: 'result',
      subtype: 'error_max_turns',
      sessionId: 'sess-1',
      usage: {
        inputTokens: 50_000, outputTokens: 8_000,
        cacheWriteTokens: 0, cacheReadTokens: 40_000,
      },
      costUsd: 0.9,
      numTurns: 60,
      stopReason: 'max_turns',
      resultText: 'Stopped: turn limit reached.',
    },
  },
  {
    name: 'result_error_max_budget_usd',
    capturedIn: '1.0.0',
    event: {
      type: 'result',
      subtype: 'error_max_budget_usd',
      sessionId: 'sess-1',
      usage: {
        inputTokens: 120_000, outputTokens: 20_000,
        cacheWriteTokens: 5_000, cacheReadTokens: 100_000,
      },
      costUsd: 20,
      numTurns: 48,
      stopReason: 'max_budget_usd',
      resultText: 'Stopped: budget exhausted.',
    },
  },
  {
    name: 'result_error_max_output_tokens',
    capturedIn: '1.0.0',
    event: {
      type: 'result',
      subtype: 'error_max_output_tokens',
      sessionId: 'sess-1',
      usage: {
        inputTokens: 10_000, outputTokens: 64_000,
        cacheWriteTokens: 0, cacheReadTokens: 0,
      },
      costUsd: 0.4,
      numTurns: 3,
      stopReason: 'max_tokens',
      resultText: 'Stopped: output token ceiling reached.',
    },
  },
  {
    name: 'result_error_blocking_limit',
    capturedIn: '1.0.0',
    event: {
      type: 'result',
      subtype: 'error_blocking_limit',
      sessionId: 'sess-1',
      usage: {
        inputTokens: 2_000, outputTokens: 300,
        cacheWriteTokens: 0, cacheReadTokens: 0,
      },
      costUsd: 0.05,
      numTurns: 1,
      stopReason: 'blocking_limit',
      resultText: 'Stopped: prompt too long after compaction.',
      errors: ['prompt is too long'],
    },
  },
  {
    name: 'result_parked',
    capturedIn: '1.0.0',
    event: {
      type: 'result',
      subtype: 'parked',
      sessionId: 'sess-1',
      usage: {
        inputTokens: 500,
        outputTokens: 100,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
      },
      costUsd: 0.01,
      numTurns: 2,
      stopReason: 'parked',
      resultText: 'Parked until the build finishes.',
      parkRequest: {
        kind: 'park',
        afterMs: 600_000,
        reason: 'waiting on a long build',
        checkpoint: { step: 'build' },
      },
    },
  },
]

/** Every result subtype must appear in at least one fixture — see the test. */
export const RESULT_SUBTYPES_IN_FIXTURES = new Set(
  EVENT_FIXTURES.filter(f => f.event.type === 'result').map(
    f => (f.event as Extract<KernelEvent, { type: 'result' }>).subtype,
  ),
)
