import type { TrajectoryItem } from './types.js'

/** Frozen representative payload for every A3 item variant. Never rewrite an
 * existing fixture to hide a breaking schema change; add a new one and bump the
 * item schema version. */
export const TRAJECTORY_ITEM_FIXTURES: readonly TrajectoryItem[] = [
  {
    type: 'trajectory_meta',
    subject: { kind: 'session', sessionId: 'fixture-session' },
    mode: 'agentic',
    createdAt: 1,
    workspace: '/workspace',
    provider: 'anthropic',
    source: 'fixture',
  },
  { type: 'run_started', reason: 'submit', budget: { maxTurns: 100 } },
  {
    type: 'run_result', outcome: 'success', isError: false, stopReason: 'end_turn',
    usage: { inputTokens: 10, outputTokens: 5 }, costUsd: 0.01, durationMs: 12,
  },
  {
    type: 'turn_context', model: 'fixture-model', provider: 'anthropic',
    approvalPolicy: 'configured', sandboxMode: 'workspace',
    tools: [{ name: 'bash', schemaHash: 'abc' }], budgetRemaining: { costUsd: 1 },
  },
  { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } },
  {
    type: 'tool_outcome', toolUseId: 'tool-1', toolName: 'bash', input: { command: 'true' },
    durationMs: 4, isError: false, outputSummary: 'ok', outputHash: 'abc',
    command: 'true', cwd: '/workspace', exitCode: 0, signal: null, timedOut: false,
  },
  {
    type: 'turn_diff', filesChanged: 1, linesAdded: 2, linesRemoved: 1,
    files: [{ path: 'a.ts', status: 'modified', added: 2, removed: 1, contentHash: 'abc' }],
  },
  {
    type: 'approval', toolUseId: 'tool-1', toolName: 'bash', decision: 'allow',
    decidedBy: 'human', reason: 'approved',
  },
  {
    type: 'compaction', previousTokens: 1000, summaryTokens: 100,
    replacementHistory: [{ role: 'user', content: [{ type: 'text', text: 'summary' }] }],
    windowId: 'window-1',
  },
  {
    type: 'subagent', action: 'completed', taskId: 'task-1',
    childTrajectoryId: '00000000-0000-4000-8000-000000000002',
    usage: { inputTokens: 10, outputTokens: 2 },
  },
  {
    type: 'phase', domain: 'loop_graph', action: 'activation_committed',
    nodeId: 'node-1', activationId: 'activation-1', journalSequence: 2,
  },
  { type: 'job', action: 'progress', jobId: 'job-1', progress: 50, summary: 'halfway' },
  {
    type: 'knowledge', kind: 'experience', action: 'recalled',
    entryIds: ['exp-1'], query: 'controller', operation: 'recall',
  },
  {
    type: 'knowledge', kind: 'experience', action: 'injected',
    entryIds: ['exp-1'], operation: 'inject',
    injected: [{
      entryId: 'exp-1',
      contentHash: 'a'.repeat(64),
      versionChain: ['exp-1@1'],
      sourceCaseId: 'case_0123456789abcdef01234567',
      selectorVersion: 'cue-match-v1',
      queryHash: 'b'.repeat(64),
      slot: 0,
      order: 0,
      targetRunId: '00000000-0000-4000-8000-0000000000a1',
    }],
    excludedCandidates: [{
      entryId: 'exp-2',
      contentHash: 'c'.repeat(64),
      reasonCode: 'excluded_boundary',
    }],
    contextHash: 'd'.repeat(64),
    tokenCost: 420,
  },
  {
    type: 'state_checkpoint', mode: 'auto', stateSchemaVersion: '1.1', revision: 2,
    contentHash: 'abc', storeRef: '/workspace/checkpoint.json',
  },
  {
    type: 'evaluation', evaluator: 'verify', verdict: 'pass', score: 1,
    metrics: { tests: 1 }, evidenceOrdinals: [2, 3], artifactHash: 'abc',
  },
]
