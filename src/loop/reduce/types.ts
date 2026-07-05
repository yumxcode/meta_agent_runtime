/**
 * reduce/types — the minimal, IR-agnostic shapes the deterministic code-node
 * sandbox needs (spec §7 迁移清单, D3). Relocated from core/auto_orch when the
 * v1 graph engine was retired: the freeze/review/run mechanism is kept as the
 * v2 custom-reduction backend, but decoupled from the deleted LoopIR/Verdict —
 * only the fields the sandbox actually reads survive here.
 */

/** The closed set of actions a code node's verdict may request. */
export type VerdictAction = 'continue' | 'inject' | 'reject' | 'branch' | 'done' | 'abort'

/** Engine-agnostic verdict a deterministic code node returns. */
export interface OrchVerdict {
  action: VerdictAction
  /** Routing key for `branch`; may annotate any verdict for observability. */
  label?: string
  /** Meta messages to inject (used by `inject` / `reject`). */
  messages?: string[]
  /** Evidence the producer cites (file:line, command + exit code, …). */
  evidence?: string[]
  /** Free-text note; never load-bearing. */
  note?: string
  /** True when the producer did not actually run. */
  skipped?: boolean
  /** Opaque producer payload, surfaced to observability only. */
  data?: Record<string, unknown>
}

/** Contract supplied before a generated code node is materialised. */
export interface CodeNodeSpec {
  description: string
  inputs?: string[]
  outputs?: string[]
  labels?: string[]
}

/** Per-code-node runtime limits. */
export interface CodeNodeBounds {
  timeoutMs?: number
  maxOutputBytes?: number
}

/**
 * The subset of a plan node the code sandbox reads. Named `OrchNode` so the
 * relocated CodeNodeRunner/CodeNodeAuthor bodies stay byte-for-byte identical;
 * graph-only fields (edges, hooks, parallel branches, roles) were dropped.
 */
export interface OrchNode {
  id: string
  kind: 'code' | string
  taskDescription: string
  /** Missing before authoring; filled after freeze with a content-addressed file. */
  codeRef?: string
  /** SHA-256 of the source at codeRef. Required once materialised. */
  sourceHash?: string
  /** Author contract used by the code_author when codeRef is absent. */
  codeSpec?: CodeNodeSpec
  /** JSON-serialisable input passed to main(input, api). */
  input?: Record<string, unknown>
  /** Host API capabilities the generated code may use. */
  capabilities?: string[]
  /** Runtime bounds for this deterministic code invocation. */
  codeBounds?: CodeNodeBounds
}

/** A plan carrying code nodes to materialise. */
export interface OrchPlan {
  nodes: OrchNode[]
}
