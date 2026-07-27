import type {
  ActivationRecord,
  ActivationUsage,
  FrozenLoopGraphSpec,
  NodeSpec,
} from '../spec/GraphTypes.js'

export interface GraphProgressIdentity {
  at: number
  instanceId: string
  graphId: string
  activationId: string
  nodeId: string
  nodeType: NodeSpec['type']
  phase: string
  laneId?: string
  attempt: number
  segment: number
  continuationVersion: number
}

/**
 * Low-frequency, lifecycle-level graph observability. These events deliberately
 * exclude model text and tool calls: operators see what phase is active and
 * why an execution segment stopped, without coupling the Kernel to an Agent
 * implementation's verbose event stream.
 */
export type GraphProgressEvent =
  | (GraphProgressIdentity & {
      type: 'phase_started'
      resumed: boolean
      resumeReason?: string
    })
  | (GraphProgressIdentity & {
      type: 'phase_completed'
      outcome: string
      summary: string
      usage?: ActivationUsage
    })
  | (GraphProgressIdentity & {
      type: 'phase_retrying'
      reason: string
      replay: boolean
      wakeAt?: number
    })
  | (GraphProgressIdentity & {
      type: 'phase_parked'
      reason: string
      wakeAt?: number
      eventName?: string
    })
  | (GraphProgressIdentity & {
      type: 'phase_failed'
      reason: string
      usage?: ActivationUsage
    })
  | (GraphProgressIdentity & {
      type: 'phase_blocked'
      reason: string
      usage?: ActivationUsage
    })

export type GraphProgressListener = (event: GraphProgressEvent) => void

export function graphProgressIdentity(
  graph: FrozenLoopGraphSpec,
  instanceId: string,
  activation: ActivationRecord,
  at: number,
): GraphProgressIdentity {
  const node = graph.nodes[activation.nodeId]
  if (!node) throw new Error(`activation '${activation.id}' references missing node '${activation.nodeId}'`)
  return {
    at,
    instanceId,
    graphId: graph.id,
    activationId: activation.id,
    nodeId: activation.nodeId,
    nodeType: node.type,
    phase: graphPhaseLabel(node, activation.nodeId),
    ...(activation.laneId ? { laneId: activation.laneId } : {}),
    attempt: activation.attempt,
    segment: activation.segmentCount ?? 0,
    continuationVersion: activation.continuationVersion,
  }
}

export function graphPhaseLabel(node: NodeSpec, nodeId: string): string {
  const description = oneLine(node.description)
  if (description) return description
  switch (node.type) {
    case 'agent': return firstNonEmptyLine(node.prompt) || nodeId
    case 'function': return `Run function ${node.function}`
    case 'effect': return `Run effect ${node.effect}`
    case 'wait': return node.wait.kind === 'timer'
      ? 'Wait for the configured timer'
      : `Wait for event ${node.wait.event}`
    case 'join': return `Join ${node.mode} incoming branches`
    case 'terminal': return `Reach ${node.status} terminal`
  }
}

function firstNonEmptyLine(value: string): string {
  const line = value.split(/\r?\n/).map(item => item.trim()).find(Boolean)
  return oneLine(line)
}

export function oneLine(value: string | undefined, maxLength = 240): string {
  if (!value) return ''
  const compact = value.replace(/\s+/g, ' ').trim()
  if (compact.length <= maxLength) return compact
  return `${compact.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`
}
