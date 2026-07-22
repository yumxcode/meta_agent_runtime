import type { LoopGraphSpec } from '../spec/GraphTypes.js'

export type GraphEvidenceScenarioId = 'bounded-research' | 'continuous-operations' | 'long-training-supervision'

export interface GraphEvidenceScenario {
  id: GraphEvidenceScenarioId
  description: string
  graph: LoopGraphSpec
  requiredEffects: string[]
  evidence: string[]
}

/**
 * Canonical, domain-shaped GraphSpecs used as evidence fixtures. They exercise
 * existing governance primitives only; none introduces a domain node type or
 * Runtime-only field.
 */
export function createGraphEvidenceScenarios(): GraphEvidenceScenario[] {
  return [boundedResearchScenario(), continuousOperationsScenario(), longTrainingScenario()]
}

export function boundedResearchScenario(): GraphEvidenceScenario {
  return {
    id: 'bounded-research',
    description: 'A bounded convergence loop that routes on raw research facts.',
    requiredEffects: [],
    evidence: ['raw-fact-routing', 'bounded-convergence', 'paused-terminal-resume', 'single-writer-lane'],
    graph: {
      schemaVersion: 'graph-2.0',
      id: 'evidence_bounded_research',
      version: 1,
      goal: 'Iterate research until evidence converges, worsens, or a governance limit stops the loop.',
      state: {
        iteration: { type: { type: 'integer', minimum: 0 }, initial: 0 },
      },
      lanes: {
        research: {
          context: 'persistent',
          workspace: {
            read: ['**'],
            write: [{ path: 'evidence/research', mode: 'owned' }],
          },
          agentProfile: { systemInstructions: 'Own the complete research inner loop and report only raw routing facts.' },
        },
      },
      nodes: {
        research: {
          type: 'agent', lane: 'research', tools: ['read_file'],
          prompt: 'Research, verify, and report new_findings_count plus trend. Keep internal planning inside this Agent.',
          outputSchema: {
            type: 'object', additionalProperties: false,
            required: ['new_findings_count', 'trend'],
            properties: {
              new_findings_count: { type: 'integer', minimum: 0 },
              trend: { type: 'string', enum: ['improved', 'unchanged', 'worsened'] },
            },
          },
          maxAttempts: 2,
        },
        paused: { type: 'terminal', status: 'paused', description: 'Research worsened; require operator review.' },
        done: { type: 'terminal', status: 'done' },
        failed: { type: 'terminal', status: 'failed' },
      },
      transitions: [
        { id: 'research_converged', from: 'research', when: '$output.new_findings_count == 0', priority: 20, to: 'done' },
        { id: 'research_worsened', from: 'research', when: "$output.trend == 'worsened'", priority: 10, to: 'paused' },
        {
          id: 'research_continue', from: 'research', default: true,
          updates: [{ target: 'iteration', reducer: 'builtin/increment@1' }], to: 'research',
        },
        { id: 'research_failed', from: 'research', on: 'failure', to: 'failed' },
        { id: 'research_resume', from: 'paused', on: 'resume', to: 'research' },
      ],
      entrypoints: [{ id: 'start', node: 'research' }],
      limits: { maxTotalActivations: 40, maxLiveActivations: 2, maxWallTimeMs: 7 * 86_400_000, maxCostUsd: 100 },
      concurrency: { maxActivations: 1, maxPerNode: 1, stateConsistency: 'commit_latest' },
    },
  }
}

export function continuousOperationsScenario(): GraphEvidenceScenario {
  return {
    id: 'continuous-operations',
    description: 'A continuous event/timer-driven operations monitor with a bounded live set.',
    requiredEffects: [],
    evidence: ['continuous-loop', 'event-wait', 'timeout-fallback', 'bounded-live-set'],
    graph: {
      schemaVersion: 'graph-2.0',
      id: 'evidence_continuous_operations',
      version: 1,
      goal: 'Continuously inspect operational signals until the Agent reports that monitoring should stop.',
      state: {
        observations: { type: { type: 'integer', minimum: 0 }, initial: 0 },
      },
      lanes: {
        operator: {
          context: 'persistent',
          workspace: { read: ['**'], write: [{ path: 'evidence/operations.jsonl', mode: 'append_only' }] },
        },
      },
      nodes: {
        await_signal: { type: 'wait', wait: { kind: 'event', event: 'operations.signal', timeoutMs: 60_000 } },
        observe: {
          type: 'agent', lane: 'operator', tools: ['read_file', 'append_file'],
          prompt: 'Inspect current operational state and emit severity plus continue_monitoring.',
          outputSchema: {
            type: 'object', additionalProperties: false,
            required: ['severity', 'continue_monitoring'],
            properties: {
              severity: { type: 'string', enum: ['normal', 'warning', 'critical'] },
              continue_monitoring: { type: 'boolean' },
            },
          },
        },
        done: { type: 'terminal', status: 'done' },
        failed: { type: 'terminal', status: 'failed' },
      },
      transitions: [
        { id: 'signal_received', from: 'await_signal', on: 'event', to: 'observe' },
        { id: 'periodic_inspection', from: 'await_signal', on: 'timeout', to: 'observe' },
        { id: 'wait_failed', from: 'await_signal', on: 'failure', to: 'failed' },
        { id: 'monitor_stop', from: 'observe', when: '$output.continue_monitoring == false', priority: 10, to: 'done' },
        {
          id: 'monitor_continue', from: 'observe', default: true,
          updates: [{ target: 'observations', reducer: 'builtin/increment@1' }], to: 'await_signal',
        },
        { id: 'observe_failed', from: 'observe', on: 'failure', to: 'failed' },
      ],
      entrypoints: [{ id: 'start', node: 'await_signal' }],
      limits: { maxLiveActivations: 3, maxCostUsd: 500, maxPendingTimers: 8 },
      concurrency: { maxActivations: 1, maxPerNode: 1, stateConsistency: 'commit_latest' },
    },
  }
}

export function longTrainingScenario(): GraphEvidenceScenario {
  return {
    id: 'long-training-supervision',
    description: 'A long external training job submitted as an Effect and completed by callback event.',
    requiredEffects: ['evidence/training-submit@1'],
    evidence: ['effect-intent', 'event-callback', 'human-intervention', 'deadline'],
    graph: {
      schemaVersion: 'graph-2.0',
      id: 'evidence_long_training',
      version: 1,
      goal: 'Submit a long training job, wait durably for its callback, then evaluate the result.',
      state: {},
      lanes: {
        supervisor: {
          context: 'persistent',
          workspace: { read: ['**'], write: [{ path: 'evidence/training-review.md', mode: 'atomic_replace' }] },
        },
      },
      nodes: {
        submit_training: {
          type: 'effect', effect: 'evidence/training-submit@1', timeoutMs: 120_000,
          inputs: { campaign: { literal: 'reference-campaign' } },
        },
        await_training: {
          type: 'wait', wait: { kind: 'event', event: 'training.completed', timeoutMs: 7 * 86_400_000 },
        },
        evaluate: {
          type: 'agent', lane: 'supervisor', tools: ['read_file', 'write_file'],
          prompt: 'Evaluate the completed training artifacts and emit accepted.',
          outputSchema: {
            type: 'object', additionalProperties: false, required: ['accepted'],
            properties: { accepted: { type: 'boolean' } },
          },
        },
        paused: { type: 'terminal', status: 'paused', description: 'Training needs human review or timed out.' },
        done: { type: 'terminal', status: 'done' },
        failed: { type: 'terminal', status: 'failed' },
      },
      transitions: [
        { id: 'training_submitted', from: 'submit_training', to: 'await_training' },
        { id: 'training_submit_failed', from: 'submit_training', on: 'failure', to: 'failed' },
        { id: 'training_callback', from: 'await_training', on: 'event', to: 'evaluate' },
        { id: 'training_timeout', from: 'await_training', on: 'timeout', to: 'paused' },
        { id: 'training_wait_failed', from: 'await_training', on: 'failure', to: 'failed' },
        { id: 'training_accepted', from: 'evaluate', when: '$output.accepted == true', priority: 10, to: 'done' },
        { id: 'training_review', from: 'evaluate', default: true, to: 'paused' },
        { id: 'training_evaluate_failed', from: 'evaluate', on: 'failure', to: 'failed' },
        { id: 'training_resume', from: 'paused', on: 'resume', to: 'evaluate' },
      ],
      entrypoints: [{ id: 'start', node: 'submit_training' }],
      limits: { maxTotalActivations: 20, maxLiveActivations: 3, maxWallTimeMs: 8 * 86_400_000, maxCostUsd: 100, maxPendingTimers: 4 },
      concurrency: { maxActivations: 1, maxPerNode: 1, stateConsistency: 'commit_latest' },
    },
  }
}
