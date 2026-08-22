/**
 * ToolVisibility — which tool schemas are sent to the model this turn.
 *
 * The problem
 * -----------
 * Every registered tool's full JSON Schema goes into the request on EVERY turn.
 * With the built-in set that is fine. It stops being fine the moment a user
 * connects MCP servers: a filesystem server, a database server and a ticketing
 * server between them expose sixty tools, each with a description and a
 * parameter schema, and the tool block alone can outweigh the conversation.
 * The cost is paid on every turn of every session, whether or not the model
 * ever calls one of them.
 *
 * That makes tool count — not context length, not model capability — the
 * binding constraint on how much the runtime can be connected to. It is the
 * one limit that gets WORSE the more useful the setup is.
 *
 * The approach
 * ------------
 * Tools declare a `namespace` and, optionally, `deferLoading`. Deferred tools
 * are NOT sent as schemas; instead a single `tool_search` tool is sent, whose
 * description names each namespace and how many tools it holds. When the model
 * needs one, it searches, the matching schemas are revealed for the rest of the
 * session, and it calls them normally.
 *
 * Two decisions worth stating, because both could reasonably have gone the
 * other way:
 *
 *   1. Revelation is STICKY for the session. A tool revealed on turn 3 stays
 *      visible on turn 40. Un-revealing would save more tokens, but it would
 *      also invalidate the prompt cache on the turn it happens and make the
 *      model re-search for a tool it already found — paying twice to save once.
 *
 *   2. Deferred tools remain EXECUTABLE even before they are revealed. Hiding a
 *      schema is a context-budget optimisation, not a permission boundary; the
 *      permission layer is the permission boundary. If the model guesses a
 *      valid name and calls it correctly, refusing on the grounds that it was
 *      supposed to search first would be pure ceremony.
 *
 * This module lives in the KERNEL because the kernel is what decides which
 * schemas go on the wire. It is typed over a minimal structural shape so both
 * `KernelTool` and `MetaAgentTool` satisfy it without either layer importing
 * the other.
 */

import { isEnvSet } from '../../infra/env/RuntimeEnv.js'

/** The minimum a tool must expose to participate in visibility decisions. */
export interface VisibilityTool {
  readonly name: string
  readonly namespace?: string
  readonly deferLoading?: boolean
  readonly description?: unknown
}

/** Namespace assigned to any tool that does not declare one. */
export const DEFAULT_NAMESPACE = 'core'

/**
 * Escape hatch: force every tool schema to be sent, as before.
 *
 * Exists so a deferral-related failure can be diagnosed by flipping one env var
 * rather than by reasoning about which schemas were present on which turn.
 */
export function eagerToolsForced(): boolean {
  return isEnvSet('META_AGENT_TOOLS_EAGER')
}

export function namespaceOf(tool: VisibilityTool): string {
  return tool.namespace ?? DEFAULT_NAMESPACE
}

export function isDeferred(tool: VisibilityTool): boolean {
  return tool.deferLoading === true
}

export interface NamespaceSummary {
  namespace: string
  total: number
  /** How many of them are still hidden. */
  hidden: number
  /** A few representative names, to make the namespace recognisable. */
  sample: string[]
}

/**
 * Per-session record of which deferred tools have been revealed.
 *
 * Keyed by session id and held process-wide for the same reason the shell
 * session store is: sub-agents run inside the parent's process, and a
 * per-construction registry would forget every revelation between tool calls.
 */
export class ToolVisibilityRegistry {
  private revealed = new Map<string, Set<string>>()

  reveal(sessionId: string, toolNames: readonly string[]): void {
    let set = this.revealed.get(sessionId)
    if (!set) {
      set = new Set()
      this.revealed.set(sessionId, set)
    }
    for (const name of toolNames) set.add(name)
  }

  isRevealed(sessionId: string, toolName: string): boolean {
    return this.revealed.get(sessionId)?.has(toolName) ?? false
  }

  revealedNames(sessionId: string): string[] {
    return [...(this.revealed.get(sessionId) ?? [])]
  }

  clear(sessionId?: string): void {
    if (sessionId === undefined) this.revealed.clear()
    else this.revealed.delete(sessionId)
  }

  /**
   * The tools whose schemas should be sent this turn: everything not deferred,
   * plus every deferred tool already revealed for this session.
   */
  visible<T extends VisibilityTool>(sessionId: string, tools: readonly T[]): T[] {
    if (eagerToolsForced()) return [...tools]
    return tools.filter(t => !isDeferred(t) || this.isRevealed(sessionId, t.name))
  }

  /** The deferred tools still hidden from this session — what `tool_search` searches. */
  hidden<T extends VisibilityTool>(sessionId: string, tools: readonly T[]): T[] {
    if (eagerToolsForced()) return []
    return tools.filter(t => isDeferred(t) && !this.isRevealed(sessionId, t.name))
  }

  /** Namespace-level summary for the `tool_search` description. */
  summarise(sessionId: string, tools: readonly VisibilityTool[]): NamespaceSummary[] {
    const byNamespace = new Map<string, { total: number; hidden: number; sample: string[] }>()
    for (const tool of tools) {
      if (!isDeferred(tool)) continue
      const ns = namespaceOf(tool)
      let entry = byNamespace.get(ns)
      if (!entry) {
        entry = { total: 0, hidden: 0, sample: [] }
        byNamespace.set(ns, entry)
      }
      entry.total++
      if (!this.isRevealed(sessionId, tool.name)) {
        entry.hidden++
        if (entry.sample.length < 4) entry.sample.push(tool.name)
      }
    }
    return [...byNamespace.entries()]
      .map(([namespace, v]) => ({ namespace, ...v }))
      .sort((a, b) => b.hidden - a.hidden || a.namespace.localeCompare(b.namespace))
  }
}

// ── Process-global registry ───────────────────────────────────────────────────

let _registry: ToolVisibilityRegistry | null = null

export function toolVisibility(): ToolVisibilityRegistry {
  if (!_registry) _registry = new ToolVisibilityRegistry()
  return _registry
}

export function resetToolVisibility(): void {
  _registry = null
}

/**
 * The tool list to put on the wire for `sessionId`.
 *
 * Fast path first: when nothing is deferred — which is every session that has
 * not connected an MCP server or enabled a domain toolkit — this returns the
 * input array unchanged and allocates nothing.
 */
export function visibleToolsForApi<T extends VisibilityTool>(
  tools: readonly T[],
  sessionId: string,
): T[] {
  let anyDeferred = false
  for (const tool of tools) {
    if (isDeferred(tool)) { anyDeferred = true; break }
  }
  if (!anyDeferred) return tools as T[]
  return toolVisibility().visible(sessionId, tools)
}

// ── Search ────────────────────────────────────────────────────────────────────

export interface ToolSearchHit<T> {
  tool: T
  score: number
}

/**
 * Rank hidden tools against a free-text query.
 *
 * Deliberately a local lexical score rather than an embedding lookup: this runs
 * inside a tool call the model is waiting on, the corpus is tens of items, and
 * a network round-trip to rank forty strings would cost more than the tokens it
 * saves. Exact-name and namespace matches dominate so that a model that already
 * knows the tool's name gets it back first.
 */
export function searchTools<T extends VisibilityTool>(
  query: string,
  tools: readonly T[],
  limit = 10,
): ToolSearchHit<T>[] {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter(t => t.length > 1)
  if (terms.length === 0) {
    return tools.slice(0, limit).map(tool => ({ tool, score: 1 }))
  }

  const hits: ToolSearchHit<T>[] = []
  for (const tool of tools) {
    const name = tool.name.toLowerCase()
    const ns = namespaceOf(tool).toLowerCase()
    // Only STRING descriptions participate: a dynamic description is a function
    // that may read session state, and resolving dozens of them to rank a
    // search would be both slow and surprising.
    const desc = typeof tool.description === 'string' ? tool.description.toLowerCase() : ''

    let score = 0
    for (const term of terms) {
      if (name === term) score += 100
      else if (name.includes(term)) score += 30
      if (ns === term) score += 25
      else if (ns.includes(term)) score += 8
      if (desc.includes(term)) score += 5
    }
    if (score > 0) hits.push({ tool, score })
  }

  return hits
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
    .slice(0, limit)
}
