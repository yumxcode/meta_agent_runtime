import type { ObservationResult } from '../types.js'

export type ObservationStatus = ObservationResult['status']
export type ReducerInputPolicy = 'skip_reduction' | 'fail_stop'

export interface ReducerObservableInput {
  observable: string
  /** `present` is mandatory; absent/error may be delivered to the reducer. */
  accepts: ObservationStatus[]
  /** Required exactly when absent is not accepted by the reducer. */
  onAbsent?: ReducerInputPolicy
  /** Required exactly when error is not accepted by the reducer. */
  onError?: ReducerInputPolicy
}

export interface ReducerManifest {
  id: string
  version: string
  inputs: ReducerObservableInput[]
}

export interface ReducerInput<Event> {
  event: Readonly<Event>
  observations: Readonly<Record<string, ObservationResult>>
}

export interface Reducer<State, Event> {
  readonly manifest: ReducerManifest
  reduce(previous: Readonly<State>, input: Readonly<ReducerInput<Event>>): State
}

export type ReducerPreparation<Event> =
  | { kind: 'ready'; input: ReducerInput<Event> }
  | { kind: 'skip'; observable: string; status: 'absent' | 'error' }
  | { kind: 'fail_stop'; code: string; message: string }

const ID_RE = /^[a-z][a-z0-9._/-]*$/i
const STATUSES: readonly ObservationStatus[] = ['present', 'absent', 'error']

/** Freeze-time validation: every non-present state has one explicit path. */
export function validateReducerManifest(
  manifest: ReducerManifest,
  knownObservables: ReadonlySet<string>,
): string[] {
  const errs: string[] = []
  if (!manifest.id || !ID_RE.test(manifest.id)) errs.push('reducer.id is invalid')
  if (!manifest.version?.trim()) errs.push('reducer.version is required')
  const seen = new Set<string>()
  for (const [index, input] of (manifest.inputs ?? []).entries()) {
    const at = `reducer.inputs[${index}]`
    if (!knownObservables.has(input.observable)) {
      errs.push(`${at}.observable '${input.observable}' is not declared`)
    }
    if (seen.has(input.observable)) errs.push(`${at}.observable '${input.observable}' is duplicated`)
    seen.add(input.observable)
    const accepts = new Set(input.accepts ?? [])
    if (accepts.size !== (input.accepts ?? []).length) errs.push(`${at}.accepts contains duplicates`)
    for (const status of accepts) {
      if (!STATUSES.includes(status)) errs.push(`${at}.accepts contains invalid status '${status}'`)
    }
    if (!accepts.has('present')) errs.push(`${at}.accepts must include 'present'`)
    validateStatePath(at, 'absent', accepts, input.onAbsent, errs)
    validateStatePath(at, 'error', accepts, input.onError, errs)
  }
  return errs
}

function validateStatePath(
  at: string,
  status: 'absent' | 'error',
  accepts: ReadonlySet<ObservationStatus>,
  policy: ReducerInputPolicy | undefined,
  errs: string[],
): void {
  const field = status === 'absent' ? 'onAbsent' : 'onError'
  if (accepts.has(status) && policy !== undefined) {
    errs.push(`${at}.${field} conflicts with accepts '${status}'`)
  } else if (!accepts.has(status) && policy === undefined) {
    errs.push(`${at}.${field} is required when '${status}' is not accepted`)
  } else if (policy !== undefined && policy !== 'skip_reduction' && policy !== 'fail_stop') {
    errs.push(`${at}.${field} must be 'skip_reduction' | 'fail_stop'`)
  }
}

/**
 * Runtime boundary before a pure reducer is invoked. No missing state is
 * coerced: fail_stop wins over skip, and only declared observations are passed.
 */
export function prepareReducerInput<Event>(
  manifest: ReducerManifest,
  event: Readonly<Event>,
  observations: Readonly<Record<string, ObservationResult>>,
): ReducerPreparation<Event> {
  let skipped: { observable: string; status: 'absent' | 'error' } | undefined
  const selected: Record<string, ObservationResult> = {}
  for (const binding of manifest.inputs) {
    const result = observations[binding.observable]
    if (!result) {
      return {
        kind: 'fail_stop',
        code: 'reducer_input_missing',
        message: `reducer '${manifest.id}' input '${binding.observable}' has no ObservationResult`,
      }
    }
    if (binding.accepts.includes(result.status)) {
      selected[binding.observable] = result
      continue
    }
    const policy = result.status === 'absent' ? binding.onAbsent : binding.onError
    if (result.status === 'present' || policy === undefined) {
      return {
        kind: 'fail_stop',
        code: 'reducer_manifest_invalid',
        message: `reducer '${manifest.id}' has no path for ${binding.observable}:${result.status}`,
      }
    }
    if (policy === 'fail_stop') {
      return {
        kind: 'fail_stop',
        code: `reducer_input_${result.status}`,
        message: `reducer '${manifest.id}' rejected ${binding.observable}:${result.status}`,
      }
    }
    skipped ??= { observable: binding.observable, status: result.status }
  }
  if (skipped) return { kind: 'skip', ...skipped }
  return { kind: 'ready', input: { event, observations: selected } }
}
