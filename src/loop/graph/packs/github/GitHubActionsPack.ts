import type { EffectProvider } from '../../registry/CapabilityRegistry.js'
import type { GraphCapabilityPackV1 } from '../../registry/CapabilityPack.js'
import type { JsonValue } from '../../spec/GraphTypes.js'
import type { ShapeSpec } from '../../spec/ShapeSpec.js'
import {
  GitHubActionsApiError,
  type GitHubActionsClient,
  type GitHubWorkflowRun,
  type GitHubWorkflowRunQuery,
  type GitHubWorkflowRunSelection,
} from './GitHubActionsClient.js'

export const GITHUB_ACTIONS_RESOLVE_RUN_EFFECT = 'github/actions-resolve-run@1'
export const GITHUB_ACTIONS_WATCH_RUN_EFFECT = 'github/actions-watch-run@1'

const RUN_OUTPUT_SCHEMA: ShapeSpec = {
  type: 'object',
  required: ['schemaVersion', 'id', 'headSha', 'status'],
  properties: {
    schemaVersion: { type: 'string', enum: ['github-actions-run-1.0'] },
    id: { type: 'integer', minimum: 1 },
    headSha: { type: 'string', minLength: 1 },
    status: { type: 'string', minLength: 1 },
    workflowId: { type: 'integer', minimum: 1 },
    runNumber: { type: 'integer', minimum: 1 },
    runAttempt: { type: 'integer', minimum: 1 },
  },
  // GitHub conclusion is string|null depending on lifecycle, and ShapeSpec has
  // no unions. Keep the raw fact in the open portion of the contract.
  additionalProperties: true,
}

export interface GitHubActionsCapabilityPackOptions {
  client: GitHubActionsClient
  /** Use "loader" for a module loaded through --graph-pack; embedders may pin their own integrity string. */
  integrity?: string
}

/**
 * Optional, domain-neutral GitHub Actions pack.
 *
 * The pack only resolves an exact workflow run and observes a known run until
 * completion. It never pushes code, dispatches workflows, downloads artifacts,
 * or interprets project metrics.
 */
export function createGitHubActionsCapabilityPack(options: GitHubActionsCapabilityPackOptions): GraphCapabilityPackV1 {
  if (!options?.client) throw new Error('GitHub Actions Capability Pack requires a client')
  return {
    apiVersion: 'graph-pack-v1',
    manifest: {
      id: 'github/actions',
      version: '1',
      integrity: options.integrity ?? 'loader',
      description: 'Resolve exact GitHub Actions runs and durably wait for completion without project-specific semantics.',
    },
    register(target) {
      target.effects.register(createGitHubActionsResolveRunProvider(options.client))
      target.effects.register(createGitHubActionsWatchRunProvider(options.client))
    },
    scenarios: [{
      id: 'github-actions-remote-job',
      description: 'Observe a remote GitHub Actions workflow started by a separately-governed publication step.',
      guidance: [
        'Resolve runs using an exact head SHA and workflow identifier; branch/event/created filters may further narrow identity.',
        'Keep the default unique selection policy unless the operator explicitly accepts oldest/newest semantics.',
        'Pass the resolved numeric run ID into github/actions-watch-run@1 so later reruns cannot change the observed execution.',
        'Treat workflow conclusion as raw external fact; project-specific pass/fail and artifact interpretation belong outside this pack.',
        'Bound both resolve and watch Effect nodes with timeoutMs and route infrastructure failure separately from domain failure.',
      ],
      suggestedCapabilities: [GITHUB_ACTIONS_RESOLVE_RUN_EFFECT, GITHUB_ACTIONS_WATCH_RUN_EFFECT],
    }],
  }
}

export function createGitHubActionsResolveRunProvider(client: GitHubActionsClient): EffectProvider {
  return {
    manifest: {
      id: 'github/actions-resolve-run',
      version: '1',
      integrity: 'builtin:meta-agent-github-actions-resolve-run-v1',
      description: 'Resolve one GitHub Actions workflow run by exact workflow and head SHA.',
      pure: false,
      outputSchema: RUN_OUTPUT_SCHEMA,
      inputSchema: {
        type: 'object',
        required: ['repository', 'workflow', 'headSha'],
        properties: {
          repository: { type: 'string', minLength: 3 },
          workflow: { type: 'string', minLength: 1 },
          headSha: { type: 'string', minLength: 7 },
          branch: { type: 'string', minLength: 1 },
          event: { type: 'string', minLength: 1 },
          created: { type: 'string', minLength: 1 },
          selection: { type: 'string', enum: ['unique', 'oldest', 'newest'] },
        },
        additionalProperties: false,
      },
    },
    async submit(input, idempotencyKey) {
      return {
        schemaVersion: 'github-actions-resolve-receipt-1.0',
        idempotencyKey,
        query: parseResolveInput(input),
      }
    },
    async inspect(receipt) {
      try {
        const parsed = parseResolveReceipt(receipt)
        const runs = await client.listWorkflowRuns(parsed.query)
        if (runs.length === 0) return { status: 'pending' }
        const mismatched = runs.filter(run =>
          run.headSha !== parsed.query.headSha
          || (parsed.query.branch !== undefined && run.headBranch !== parsed.query.branch)
          || (parsed.query.event !== undefined && run.event !== parsed.query.event))
        if (mismatched.length) {
          return {
            status: 'failed',
            error: `GitHub Actions API returned run(s) outside the requested identity: ${mismatched.map(run => run.id).join(', ')}`,
          }
        }
        const selected = selectRun(runs, parsed.selection)
        if ('error' in selected) return { status: 'failed', error: selected.error }
        return { status: 'succeeded', output: runOutput(selected.run) }
      } catch (error) {
        return inspectionFailure(error)
      }
    },
  }
}

export function createGitHubActionsWatchRunProvider(client: GitHubActionsClient): EffectProvider {
  return {
    manifest: {
      id: 'github/actions-watch-run',
      version: '1',
      integrity: 'builtin:meta-agent-github-actions-watch-run-v1',
      description: 'Wait for one exact GitHub Actions run ID and return its terminal facts.',
      pure: false,
      outputSchema: RUN_OUTPUT_SCHEMA,
      inputSchema: {
        type: 'object',
        required: ['repository', 'runId'],
        properties: {
          repository: { type: 'string', minLength: 3 },
          runId: { type: 'integer', minimum: 1 },
          expectedHeadSha: { type: 'string', minLength: 7 },
          expectedWorkflowId: { type: 'integer', minimum: 1 },
        },
        additionalProperties: false,
      },
    },
    async submit(input, idempotencyKey) {
      return {
        schemaVersion: 'github-actions-watch-receipt-1.0',
        idempotencyKey,
        ...parseWatchInput(input),
      }
    },
    async inspect(receipt) {
      try {
        const parsed = parseWatchReceipt(receipt)
        const run = await client.getWorkflowRun(parsed.repository, parsed.runId)
        if (parsed.expectedHeadSha && run.headSha !== parsed.expectedHeadSha) {
          return { status: 'failed', error: `run ${run.id} head SHA mismatch: expected ${parsed.expectedHeadSha}, got ${run.headSha}` }
        }
        if (parsed.expectedWorkflowId && run.workflowId !== parsed.expectedWorkflowId) {
          return { status: 'failed', error: `run ${run.id} workflow ID mismatch: expected ${parsed.expectedWorkflowId}, got ${run.workflowId ?? 'missing'}` }
        }
        if (run.status !== 'completed') return { status: 'pending' }
        // A completed workflow with conclusion=failure is still a successful
        // observation. Graph/project policy decides what that conclusion means.
        return { status: 'succeeded', output: runOutput(run) }
      } catch (error) {
        return inspectionFailure(error)
      }
    },
  }
}

function parseResolveInput(input: Readonly<Record<string, JsonValue>>): Record<string, JsonValue> {
  const query: Record<string, JsonValue> = {
    repository: string(input.repository, 'repository'),
    workflow: workflow(input.workflow),
    headSha: string(input.headSha, 'headSha'),
    selection: selection(input.selection),
  }
  for (const key of ['branch', 'event', 'created'] as const) {
    if (input[key] !== undefined) query[key] = string(input[key], key)
  }
  return query
}

function parseResolveReceipt(receipt: JsonValue): { query: GitHubWorkflowRunQuery; selection: GitHubWorkflowRunSelection } {
  const value = record(receipt, 'resolve receipt')
  if (value.schemaVersion !== 'github-actions-resolve-receipt-1.0') throw new Error('invalid resolve receipt schemaVersion')
  const query = record(value.query, 'resolve receipt query')
  const selected = selection(query.selection)
  return {
    query: {
      repository: string(query.repository, 'query.repository'),
      workflow: workflow(query.workflow),
      headSha: string(query.headSha, 'query.headSha'),
      ...optionalString(query.branch, 'branch'),
      ...optionalString(query.event, 'event'),
      ...optionalString(query.created, 'created'),
    },
    selection: selected,
  }
}

function parseWatchInput(input: Readonly<Record<string, JsonValue>>): Record<string, JsonValue> {
  return {
    repository: string(input.repository, 'repository'),
    runId: integer(input.runId, 'runId'),
    ...(input.expectedHeadSha !== undefined ? { expectedHeadSha: string(input.expectedHeadSha, 'expectedHeadSha') } : {}),
    ...(input.expectedWorkflowId !== undefined ? { expectedWorkflowId: integer(input.expectedWorkflowId, 'expectedWorkflowId') } : {}),
  }
}

function parseWatchReceipt(receipt: JsonValue): {
  repository: string
  runId: number
  expectedHeadSha?: string
  expectedWorkflowId?: number
} {
  const value = record(receipt, 'watch receipt')
  if (value.schemaVersion !== 'github-actions-watch-receipt-1.0') throw new Error('invalid watch receipt schemaVersion')
  return {
    repository: string(value.repository, 'repository'),
    runId: integer(value.runId, 'runId'),
    ...(value.expectedHeadSha !== undefined ? { expectedHeadSha: string(value.expectedHeadSha, 'expectedHeadSha') } : {}),
    ...(value.expectedWorkflowId !== undefined ? { expectedWorkflowId: integer(value.expectedWorkflowId, 'expectedWorkflowId') } : {}),
  }
}

function selectRun(
  runs: GitHubWorkflowRun[],
  selectionPolicy: GitHubWorkflowRunSelection,
): { run: GitHubWorkflowRun } | { error: string } {
  const sorted = [...runs].sort((left, right) => left.id - right.id)
  if (selectionPolicy === 'unique') {
    if (sorted.length !== 1) {
      return { error: `workflow run identity is ambiguous; matched run IDs: ${sorted.map(run => run.id).join(', ')}` }
    }
    return { run: sorted[0]! }
  }
  return { run: selectionPolicy === 'oldest' ? sorted[0]! : sorted[sorted.length - 1]! }
}

function runOutput(run: GitHubWorkflowRun): JsonValue {
  return {
    schemaVersion: 'github-actions-run-1.0',
    id: run.id,
    headSha: run.headSha,
    status: run.status,
    conclusion: run.conclusion,
    ...jsonOptional(run.workflowId, 'workflowId'),
    ...jsonOptional(run.runNumber, 'runNumber'),
    ...jsonOptional(run.runAttempt, 'runAttempt'),
    ...jsonOptional(run.headBranch, 'headBranch'),
    ...jsonOptional(run.event, 'event'),
    ...jsonOptional(run.htmlUrl, 'htmlUrl'),
    ...jsonOptional(run.createdAt, 'createdAt'),
    ...jsonOptional(run.updatedAt, 'updatedAt'),
  }
}

function inspectionFailure(error: unknown): { status: 'pending' } | { status: 'failed'; error: string } {
  if (error instanceof GitHubActionsApiError && error.retryable) return { status: 'pending' }
  return { status: 'failed', error: message(error) }
}

function record(value: JsonValue | undefined, at: string): Record<string, JsonValue> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${at} must be an object`)
  return value
}

function string(value: JsonValue | undefined, at: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${at} must be a non-empty string`)
  return value.trim()
}

function integer(value: JsonValue | undefined, at: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) throw new Error(`${at} must be a positive integer`)
  return value
}

function workflow(value: JsonValue | undefined): string | number {
  return string(value, 'workflow')
}

function selection(value: JsonValue | undefined): GitHubWorkflowRunSelection {
  if (value === undefined) return 'unique'
  if (value === 'unique' || value === 'oldest' || value === 'newest') return value
  throw new Error("selection must be 'unique', 'oldest', or 'newest'")
}

function optionalString(value: JsonValue | undefined, key: 'branch' | 'event' | 'created'): Partial<Record<typeof key, string>> {
  return value === undefined ? {} : { [key]: string(value, key) }
}

function jsonOptional(value: string | number | undefined, key: string): Record<string, JsonValue> {
  return value === undefined ? {} : { [key]: value }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
