export interface ModelCallScope {
  workspaceId: string
  instanceId: string
  coordinatorRoot?: string
  maxConcurrentModelCalls?: number
}

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
  const lease = await provider(scope, controller.signal)
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
    },
  }
}
