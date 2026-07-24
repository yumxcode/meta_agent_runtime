import type { ProviderId } from '../../providers/registry.js'

export type ExecutionFailureCategory =
  | 'provider_transient'
  | 'provider_blocked'
  | 'runtime_transient'
  | 'task_failure'
  | 'deterministic'
  | 'budget'

export interface ExecutionFailure {
  category: ExecutionFailureCategory
  message: string
  retryable: boolean
  providerId?: ProviderId
  code?: string
  status?: number
  retryAfterMs?: number
  details?: string[]
}

export interface ClassifyExecutionFailureInput {
  subtype?: string
  stopReason?: string | null
  resultText?: string
  errors?: readonly string[]
  providerId?: ProviderId
}

const TASK_STOP_REASONS = new Set([
  'no_progress',
  'blocking_limit',
  'verify_exhausted',
  'auto_verify_unavailable',
  'auto_drift_unavailable',
  'auto_runtime_limit',
  'auto_tool_batch_limit',
  'phase_hook_fail',
])

const BLOCKED_RE = /\b(?:subscription|billing|payment(?: required)?|credit(?:s| balance)?|quota exceeded|insufficient[_ -]?quota|account (?:is )?(?:disabled|suspended)|api key (?:is )?(?:invalid|expired)|authentication|unauthorized|forbidden|access denied|credential(?:s)? (?:are )?(?:invalid|expired))\b/i
const TRANSIENT_RE = /\b(?:rate.?limit|too many requests|overload(?:ed)?|temporar(?:y|ily)|try again|timeout|timed out|network|socket|connection|econn(?:reset|refused|aborted)|enotfound|eai_again|gateway|service unavailable)\b/i

export function classifyExecutionFailure(input: ClassifyExecutionFailureInput): ExecutionFailure {
  const details = compactDetails([...(input.errors ?? []), input.resultText ?? ''])
  const combined = details.join(' | ')
  const status = extractStatus(combined)
  const code = extractCode(combined)
  const base = {
    ...(input.providerId ? { providerId: input.providerId } : {}),
    ...(code ? { code } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(details.length ? { details } : {}),
  }

  if (input.subtype === 'error_max_budget' || input.subtype === 'error_max_budget_usd' ||
      input.subtype === 'error_max_turns' || input.subtype === 'error_max_output_tokens') {
    return { category: 'budget', message: first(details, input.subtype), retryable: false, ...base }
  }
  if (input.stopReason && TASK_STOP_REASONS.has(input.stopReason)) {
    return { category: 'task_failure', message: first(details, input.stopReason), retryable: false, ...base }
  }
  if (status === 401 || status === 402 || status === 403 || BLOCKED_RE.test(combined)) {
    return {
      category: 'provider_blocked',
      message: first(details, 'Provider credentials, subscription, or billing require operator action'),
      retryable: false,
      ...base,
    }
  }
  if (status === 408 || status === 409 || status === 425 || status === 429 ||
      (status !== undefined && status >= 500 && status < 600) || TRANSIENT_RE.test(combined)) {
    return {
      category: 'provider_transient',
      message: first(details, 'Provider is temporarily unavailable'),
      retryable: true,
      ...base,
    }
  }
  if (input.stopReason === 'aborted_streaming' || input.stopReason === 'aborted_tools' ||
      input.subtype === 'error_during_execution') {
    return {
      category: 'runtime_transient',
      message: first(details, 'Runtime execution failed without a deterministic task error'),
      retryable: true,
      ...base,
    }
  }
  return {
    category: 'task_failure',
    message: first(details, input.subtype ?? input.stopReason ?? 'Task execution failed'),
    retryable: false,
    ...base,
  }
}

export function serializeExecutionError(error: unknown): string[] {
  if (error instanceof Error) {
    const value = error as Error & {
      status?: unknown; statusCode?: unknown; code?: unknown; type?: unknown
      error?: unknown; cause?: unknown
    }
    return compactDetails([
      value.message,
      scalar('status', value.status ?? value.statusCode),
      scalar('code', value.code),
      scalar('type', value.type),
      nested(value.error),
      nested(value.cause),
    ])
  }
  if (error && typeof error === 'object') {
    const value = error as Record<string, unknown>
    return compactDetails([
      scalar('message', value.message),
      scalar('status', value.status ?? value.statusCode),
      scalar('code', value.code),
      scalar('type', value.type),
      nested(value.error),
    ])
  }
  return compactDetails([String(error ?? 'Unknown error')])
}

export function isInfrastructureFailure(failure: ExecutionFailure | undefined): boolean {
  return failure?.category === 'provider_blocked' ||
    failure?.category === 'provider_transient' ||
    failure?.category === 'runtime_transient'
}

function compactDetails(values: readonly string[]): string[] {
  const unique = new Set<string>()
  for (const value of values) {
    const normalized = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2_000)
    if (normalized) unique.add(normalized)
  }
  return [...unique].slice(0, 8)
}

function first(details: readonly string[], fallback: string): string {
  return details.find(value => value.trim().length > 0) ?? fallback
}

function extractStatus(value: string): number | undefined {
  const labelled = /(?:status(?:Code)?|http(?: status)?)\s*[:=]?\s*(\d{3})/i.exec(value)
  if (labelled) return Number(labelled[1])
  const standalone = /\b(401|402|403|408|409|425|429|5\d\d)\b/.exec(value)
  return standalone ? Number(standalone[1]) : undefined
}

function extractCode(value: string): string | undefined {
  return /(?:code|type)\s*[:=]\s*["']?([A-Za-z0-9_.-]{2,80})/i.exec(value)?.[1]
}

function scalar(label: string, value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? `${label}=${String(value)}` : ''
}

function nested(value: unknown): string {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return ''
  const record = value as Record<string, unknown>
  return [
    scalar('message', record.message),
    scalar('status', record.status ?? record.statusCode),
    scalar('code', record.code),
    scalar('type', record.type),
  ].filter(Boolean).join(' ')
}
