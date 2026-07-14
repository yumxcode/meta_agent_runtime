import type { ScenarioJson } from './ScenarioPlugin.js'

/**
 * Scenario modules are trusted host extensions, not a security sandbox.  This
 * host boundary still prevents a cooperative but faulty plugin from parking a
 * scheduler seat forever or returning an object large enough to exhaust the
 * capsule/ledger process.
 */
export const DEFAULT_SCENARIO_HOOK_TIMEOUT_MS = 30_000
export const MAX_SCENARIO_HOOK_OUTPUT_BYTES = 1 * 1024 * 1024

export class ScenarioHookError extends Error {
  constructor(
    public readonly scenarioId: string,
    public readonly hook: string,
    message: string,
  ) {
    super(`Scenario '${scenarioId}' hook '${hook}' ${message}`)
    this.name = 'ScenarioHookError'
  }
}

export async function runScenarioHook<T>(input: {
  scenarioId: string
  hook: string
  signal?: AbortSignal
  timeoutMs?: number
  invoke(signal: AbortSignal): Promise<T>
  validate?: (value: T) => string[]
}): Promise<T> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_SCENARIO_HOOK_TIMEOUT_MS
  const controller = new AbortController()
  const relayAbort = (): void => controller.abort(input.signal?.reason)
  input.signal?.addEventListener('abort', relayAbort, { once: true })
  if (input.signal?.aborted) relayAbort()

  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new ScenarioHookError(input.scenarioId, input.hook, `timed out after ${timeoutMs}ms`))
      controller.abort(new Error('scenario hook timeout'))
    }, timeoutMs)
    timer.unref?.()
  })
  const aborted = new Promise<never>((_, reject) => {
    const rejectAbort = (): void => reject(new ScenarioHookError(
      input.scenarioId,
      input.hook,
      `was aborted${controller.signal.reason ? `: ${String(controller.signal.reason)}` : ''}`,
    ))
    controller.signal.addEventListener('abort', rejectAbort, { once: true })
  })

  try {
    const value = await Promise.race([input.invoke(controller.signal), timeout, aborted])
    assertBoundedOutput(input.scenarioId, input.hook, value)
    const errors = input.validate?.(value) ?? []
    if (errors.length > 0) {
      throw new ScenarioHookError(input.scenarioId, input.hook, `returned invalid output: ${errors.join('; ')}`)
    }
    return value
  } finally {
    if (timer) clearTimeout(timer)
    input.signal?.removeEventListener('abort', relayAbort)
  }
}

function assertBoundedOutput(scenarioId: string, hook: string, value: unknown): void {
  let encoded: string
  try {
    encoded = JSON.stringify(value) ?? ''
  } catch (error) {
    throw new ScenarioHookError(
      scenarioId,
      hook,
      `returned a non-serializable value: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const bytes = Buffer.byteLength(encoded)
  if (bytes > MAX_SCENARIO_HOOK_OUTPUT_BYTES) {
    throw new ScenarioHookError(
      scenarioId,
      hook,
      `returned ${bytes} bytes (limit ${MAX_SCENARIO_HOOK_OUTPUT_BYTES})`,
    )
  }
}

export function validateScenarioJson(value: ScenarioJson): string[] {
  return value === undefined ? ['value is undefined'] : []
}
