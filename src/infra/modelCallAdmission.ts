export interface ModelCallScope {
  workspaceId: string
  instanceId: string
  coordinatorRoot?: string
  maxConcurrentModelCalls?: number
  /** In-process diagnostics hook; never persisted or sent to the coordinator. */
  onAdmissionEvent?: (event: ModelCallAdmissionEvent) => void
}

export type ModelCallAdmissionEvent =
  | { type: 'waiting'; at: number }
  | { type: 'acquired'; at: number }
  | { type: 'released'; at: number }

export interface ModelCallLease {
  heartbeatIntervalMs: number
  heartbeat(): Promise<boolean>
  release(): Promise<void>
}

type Provider = (scope: ModelCallScope, signal: AbortSignal) => Promise<ModelCallLease>

const scopes = new Map<string, ModelCallScope>()
let provider: Provider | null = null

export function setModelCallAdmissionProvider(next: Provider): void {
  provider ??= next
}

export function registerModelCallScope(sessionId: string, scope: ModelCallScope): () => void {
  scopes.set(sessionId, scope)
  return () => {
    if (scopes.get(sessionId) === scope) scopes.delete(sessionId)
  }
}

export function registeredModelCallScope(sessionId: string | undefined): ModelCallScope | null {
  return sessionId ? scopes.get(sessionId) ?? null : null
}

export async function acquireRegisteredModelCall(
  sessionId: string | undefined,
  parentSignal: AbortSignal,
): Promise<{ signal: AbortSignal; release(): Promise<void> } | null> {
  const scope = sessionId ? scopes.get(sessionId) : undefined
  if (!scope || !provider) return null
  const controller = new AbortController()
  const forwardAbort = (): void => controller.abort(parentSignal.reason)
  if (parentSignal.aborted) forwardAbort()
  else parentSignal.addEventListener('abort', forwardAbort, { once: true })
  scope.onAdmissionEvent?.({ type: 'waiting', at: Date.now() })
  let lease: ModelCallLease
  try {
    lease = await provider(scope, controller.signal)
  } catch (error) {
    // The parent signal is typically a long-lived daemon signal. Leaving the
    // forwarder attached after a failed admission (lock timeout, vanished
    // ticket, abort) leaks one closure per failure for the signal's lifetime.
    parentSignal.removeEventListener('abort', forwardAbort)
    throw error
  }
  scope.onAdmissionEvent?.({ type: 'acquired', at: Date.now() })
  const heartbeat = setInterval(() => {
    void lease.heartbeat().then(ok => {
      if (!ok) controller.abort(new Error('host model-call lease lost'))
    }).catch(() => controller.abort(new Error('host model-call heartbeat failed')))
  }, lease.heartbeatIntervalMs)
  heartbeat.unref?.()
  let released = false
  return {
    signal: controller.signal,
    async release(): Promise<void> {
      if (released) return
      released = true
      clearInterval(heartbeat)
      parentSignal.removeEventListener('abort', forwardAbort)
      await lease.release()
      scope.onAdmissionEvent?.({ type: 'released', at: Date.now() })
    },
  }
}
