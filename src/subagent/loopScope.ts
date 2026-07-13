import { registeredModelCallScope } from '../infra/modelCallAdmission.js'

export interface LoopTaskScope {
  workspaceId: string
  loopInstanceId: string
  hostCoordinatorRoot?: string
  hostMaxConcurrentModelCalls?: number
}

/** Recover the loop scope from a kernel-owned lineage session id. */
export function loopTaskScopeFromSessionId(sessionId: string | undefined): LoopTaskScope | null {
  if (!sessionId) return null
  const registered = registeredModelCallScope(sessionId)
  if (registered) return {
    workspaceId: registered.workspaceId,
    loopInstanceId: registered.instanceId,
    ...(registered.coordinatorRoot ? { hostCoordinatorRoot: registered.coordinatorRoot } : {}),
    ...(registered.maxConcurrentModelCalls !== undefined
      ? { hostMaxConcurrentModelCalls: registered.maxConcurrentModelCalls }
      : {}),
  }
  const match = /^loop:(ws-[0-9a-f-]{36}):([^:]+):/i.exec(sessionId)
  return match ? { workspaceId: match[1]!, loopInstanceId: match[2]! } : null
}
