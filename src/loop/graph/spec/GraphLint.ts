import type { LoopGraphSpec } from './GraphTypes.js'

/**
 * Static lint for the recurring "write surface" failure class.
 *
 * Three distilled graphs in a row failed the same way for different reasons:
 * an invented directory that did not exist, a git push blocked by the
 * project-root .git protection, and finally a work tree placed OUTSIDE the
 * project where the sandbox denies every write. The common root cause: the
 * facts about what is writable lived only in prose prompts, checked by a
 * semantic reviewer that misses variants. These rules make the cheap,
 * high-precision half of that check mechanical.
 *
 * Contract: Distill treats every finding as blocking (the Compiler can always
 * repair a prompt or a lane); `loop create` only PRINTS findings — a human
 * hand-authoring a graph may overrule a heuristic.
 */
export interface GraphLintFinding {
  level: 'error' | 'warning'
  rule: 'absolute-path' | 'outside-project-write' | 'undeclared-workspace-write' | 'git-without-capability' | 'precomputed-routing' | 'duplicate-route-condition' | 'same-lane-agent-split' | 'dead-literal-route' | 'unbounded-wait' | 'mixed-snapshot-routing' | 'static-effect-idempotency' | 'terminal-fanout-cancellation'
  at: string
  message: string
}

export function lintLoopGraph(spec: LoopGraphSpec): GraphLintFinding[] {
  const findings: GraphLintFinding[] = []
  lintAgentWorkspacePrompts(spec, findings)
  lintPrecomputedRouting(spec, findings)
  lintDuplicateRouteConditions(spec, findings)
  lintSameLaneAgentSplits(spec, findings)
  lintDeadLiteralRoutes(spec, findings)
  lintUnboundedWaits(spec, findings)
  lintMixedSnapshotRouting(spec, findings)
  lintStaticEffectIdempotency(spec, findings)
  lintTerminalFanOut(spec, findings)
  return findings
}

/** A lifetime Activation cap cannot release a bounded graph that is already
 * parked. Continuous graphs intentionally omit the lifetime cap and may wait
 * forever for their next external event. */
function lintUnboundedWaits(spec: LoopGraphSpec, findings: GraphLintFinding[]): void {
  const bounded = spec.limits.maxTotalActivations !== undefined || spec.limits.maxActivations !== undefined
  if (!bounded || spec.limits.maxWallTimeMs !== undefined) return
  for (const [nodeId, node] of Object.entries(spec.nodes ?? {})) {
    const unboundedEvent = node.type === 'wait' && node.wait.kind === 'event' && node.wait.timeoutMs === undefined
    const unboundedJoin = node.type === 'join' && node.timeoutMs === undefined
    if (!unboundedEvent && !unboundedJoin) continue
    findings.push({
      level: 'warning', rule: 'unbounded-wait', at: `nodes.${nodeId}`,
      message: `${unboundedEvent ? 'event Wait' : 'Join'} has no timeout while this is a lifetime-bounded graph with no maxWallTimeMs; it can remain waiting forever before the total Activation cap is reached — add a node timeout or graph wall limit, or make the graph continuous by using maxLiveActivations without maxTotalActivations`,
    })
  }
}

function lintMixedSnapshotRouting(spec: LoopGraphSpec, findings: GraphLintFinding[]): void {
  if ((spec.concurrency?.maxActivations ?? 1) <= 1 || spec.concurrency?.stateConsistency === 'serializable') return
  for (const transition of spec.transitions ?? []) {
    if (!transition.when?.includes('$state') || !transition.when.includes('$output')) continue
    findings.push({
      level: 'warning', rule: 'mixed-snapshot-routing', at: `transitions '${transition.id}'.when`,
      message: 'commit_latest evaluates fresh $state together with $output computed from the Activation claim snapshot; use serializable when this decision requires one coherent snapshot, or route only on raw output facts that are independent of mutable State',
    })
  }
}

function lintStaticEffectIdempotency(spec: LoopGraphSpec, findings: GraphLintFinding[]): void {
  for (const [nodeId, node] of Object.entries(spec.nodes ?? {})) {
    if (node.type !== 'effect' || !node.idempotencyKey || !('literal' in node.idempotencyKey) || !nodeInCycle(spec, nodeId)) continue
    findings.push({
      level: 'warning', rule: 'static-effect-idempotency', at: `nodes.${nodeId}.idempotencyKey`,
      message: 'cyclic Effect uses a static idempotency key, so a provider may deduplicate later iterations; omit the key for the per-Activation default or include an iteration/correlation value',
    })
  }
}

function lintTerminalFanOut(spec: LoopGraphSpec, findings: GraphLintFinding[]): void {
  for (const transition of spec.transitions ?? []) {
    const targets = targetNodeIds(transition.to)
    if (targets.length < 2 || !targets.some(nodeId => reachesTerminalBeforeJoin(spec, nodeId))) continue
    findings.push({
      level: 'warning', rule: 'terminal-fanout-cancellation', at: `transitions '${transition.id}'.to`,
      message: 'fan-out has a branch that can reach a Terminal before a Join; Terminal is a graph-wide barrier and cancels remaining ready/running/waiting siblings — add an explicit Join first unless race-to-terminal cancellation is intentional',
    })
  }
}

function nodeInCycle(spec: LoopGraphSpec, start: string): boolean {
  const pending = [...outgoingNodeIds(spec, start)]
  const seen = new Set<string>()
  while (pending.length) {
    const nodeId = pending.pop()!
    if (nodeId === start) return true
    if (seen.has(nodeId)) continue
    seen.add(nodeId)
    pending.push(...outgoingNodeIds(spec, nodeId))
  }
  return false
}

function reachesTerminalBeforeJoin(spec: LoopGraphSpec, start: string): boolean {
  const pending = [start]
  const seen = new Set<string>()
  while (pending.length) {
    const nodeId = pending.pop()!
    if (seen.has(nodeId)) continue
    seen.add(nodeId)
    const node = spec.nodes[nodeId]
    if (node?.type === 'terminal') return true
    if (node?.type === 'join') continue
    pending.push(...outgoingNodeIds(spec, nodeId))
  }
  return false
}

function outgoingNodeIds(spec: LoopGraphSpec, nodeId: string): string[] {
  return (spec.transitions ?? []).filter(transition => transition.from === nodeId).flatMap(transition => targetNodeIds(transition.to))
}

function targetNodeIds(to: LoopGraphSpec['transitions'][number]['to']): string[] {
  return (Array.isArray(to) ? to : [to]).map(target => typeof target === 'string' ? target : target.node)
}

/** A persistent Lane is a continuous session boundary, not a phase bucket.
 * Multiple Agents can be legitimate, so this is deliberately an advisory for
 * semantic review rather than a mechanical rejection. */
function lintSameLaneAgentSplits(spec: LoopGraphSpec, findings: GraphLintFinding[]): void {
  for (const [laneId, lane] of Object.entries(spec.lanes ?? {})) {
    if (lane.context !== 'persistent') continue
    const agents = Object.entries(spec.nodes ?? {})
      .filter(([, node]) => node?.type === 'agent' && node.lane === laneId)
      .map(([nodeId]) => nodeId)
    if (agents.length < 2) continue
    findings.push({
      level: 'warning', rule: 'same-lane-agent-split', at: `lanes.${laneId}`,
      message: `persistent lane contains ${agents.length} Agent nodes (${agents.join(', ')}); verify every split has an independent persistence, permission/concurrency, Kernel Wait/Event, failure-isolation, or terminal boundary — a different prompt, role name, first-run flag, or budget is not such a boundary; otherwise merge bootstrap/pivot/monitor phases into one autonomous Agent mode`,
    })
  }
}

/** Two transitions with the same source, outcome and predicate are not two
 * branches: the higher-priority one permanently shadows the other. This is a
 * mechanical routing error, not a semantic-review judgement. */
function lintDuplicateRouteConditions(spec: LoopGraphSpec, findings: GraphLintFinding[]): void {
  const firstByCondition = new Map<string, string>()
  for (const transition of spec.transitions ?? []) {
    if (typeof transition.when !== 'string' || transition.default === true) continue
    const condition = transition.when.trim().replace(/\s+/g, ' ')
    const key = `${transition.from}\0${transition.on ?? 'success'}\0${condition}`
    const first = firstByCondition.get(key)
    if (!first) {
      firstByCondition.set(key, transition.id)
      continue
    }
    findings.push({
      level: 'error', rule: 'duplicate-route-condition', at: `transitions '${transition.id}'.when`,
      message: `has the same from/on/when predicate as transition '${first}'; one branch will always shadow the other — make the predicates mutually exclusive (including any state threshold)`,
    })
  }
}

const ABSOLUTE_PATH_RE = /(?:^|[\s"'`(=])(?:\/(?:Users|home|root|srv|Volumes)\/|~\/)/
const WRITE_VERB_RE = /\b(edit|write|modify|update|commit|push|clone|create|save|append)\b|编辑|修改|写入|提交|推送/i
const OUTSIDE_PROJECT_RE = /outside\s+(?:of\s+)?(?:this|the)\s+project|项目之?外/i
const OUTSIDE_NEGATION_RE = /\b(?:never|not|don'?t|do\s+not|avoid|no)\b[^.\n]{0,40}outside|outside[^.\n]{0,40}\b(?:forbidden|prohibited|denied|read[- ]?only)\b|(?:禁止|不得|不要|勿)[^。\n]{0,20}项目之?外/i
const GIT_MUTATION_RE = /\bgit\s+(?:add|commit|push)\b/i
const EXPLICIT_WRITE_VERB_RE = /\b(?:write|edit|modify|update|create|save|append|replace)\b|(?:写入|编辑|修改|更新|创建|保存|追加|替换)/i
const NEGATED_WRITE_RE = /\b(?:never|not|don'?t|do\s+not|mustn'?t|avoid)\b[^.。\n]{0,28}\b(?:write|edit|modify|update|create|save|append|replace)\b|(?:禁止|不得|不要|无需|不应|绝不)[^。\n]{0,18}(?:写入|编辑|修改|更新|创建|保存|追加|替换)/i
const BACKTICK_PATH_RE = /`([^`\n]+)`/g
const PLAIN_PATH_RE = /(?:^|[\s("'])((?:\.?[A-Za-z0-9_-]+\/)+(?:[A-Za-z0-9_.*<>{}-]+\.[A-Za-z0-9_-]+)?)(?=$|[.\s,;:)'])/g

function lintAgentWorkspacePrompts(spec: LoopGraphSpec, findings: GraphLintFinding[]): void {
  for (const [nodeId, node] of Object.entries(spec.nodes ?? {})) {
    if (!node || node.type !== 'agent') continue
    const lane = spec.lanes?.[node.lane]
    const text = [node.prompt, node.systemInstructions, lane?.agentProfile?.systemInstructions]
      .filter((part): part is string => typeof part === 'string').join('\n')
    const at = `nodes.${nodeId}.prompt`

    if (ABSOLUTE_PATH_RE.test(text)) {
      findings.push({
        level: 'error', rule: 'absolute-path', at,
        message: 'prompt references an absolute or home path; the workspace is project-relative and the sandbox denies all writes outside the project root — bring the resource inside the project under a Lane write prefix',
      })
    }
    if (OUTSIDE_PROJECT_RE.test(text) && WRITE_VERB_RE.test(text) && !OUTSIDE_NEGATION_RE.test(text)) {
      findings.push({
        level: 'error', rule: 'outside-project-write', at,
        message: "prompt directs write/edit/git work at a location outside the project; there is NO writable location outside the project root — clone or move it inside the project under an owned write prefix and declare it as a directory precondition",
      })
    }
    for (const target of explicitPromptWriteTargets(text)) {
      const declared = (lane?.workspace?.write ?? []).some(rule => pathCoveredByWriteRule(target, rule.path))
      if (declared) continue
      findings.push({
        level: 'error', rule: 'undeclared-workspace-write', at,
        message: `prompt explicitly writes '${target}', but lane '${node.lane}' does not declare a covering workspace.write rule`,
      })
    }
    if (GIT_MUTATION_RE.test(text)) {
      const hasScm = lane?.scm === 'git'
      const ownedPrefixes = (lane?.workspace?.write ?? []).filter(rule => rule.mode === 'owned').map(rule => rule.path)
      if (!hasScm && ownedPrefixes.length === 0) {
        findings.push({
          level: 'error', rule: 'git-without-capability', at,
          message: `prompt performs git add/commit/push but lane '${node.lane}' has neither scm:'git' nor an owned write prefix that could host a nested repository`,
        })
      } else if (!hasScm) {
        findings.push({
          level: 'warning', rule: 'git-without-capability', at,
          message: `git add/commit/push relies on a nested repository; verify the repo lives under an owned prefix of lane '${node.lane}' (${ownedPrefixes.join(', ')}) — the project-root .git stays protected without scm:'git'`,
        })
      }
    }
  }
}

/** Extract only explicit backtick-delimited project paths from imperative
 * write sentences. This intentionally avoids guessing paths from general prose:
 * false negatives go to semantic review, while a hit is safe to block. */
function explicitPromptWriteTargets(text: string): string[] {
  const targets = new Set<string>()
  for (const line of text.split('\n')) {
    // Keep the verb and target in the same sentence. A common prompt shape is
    // "create state/task.json. Use the baseline from .oma/history.md"; scanning
    // the whole line incorrectly grants the write verb to the read-only source.
    const clauses = line.split(/(?:[。！？；]|[.!?;](?=\s|$))\s*/)
    for (const clause of clauses) {
      if (!EXPLICIT_WRITE_VERB_RE.test(clause) || NEGATED_WRITE_RE.test(clause)) continue
      for (const match of clause.matchAll(BACKTICK_PATH_RE)) {
        const target = normalizePromptPath(match[1]!)
        if (target) targets.add(target)
      }
      // Models often omit Markdown delimiters in imperative prose ("create
      // state/ and logs/"). Restrict plain matches to directory-looking tokens
      // or filenames with extensions to avoid treating branch names as paths.
      for (const match of clause.matchAll(PLAIN_PATH_RE)) {
        const target = normalizePromptPath(match[1]!)
        if (target) targets.add(target)
      }
    }
  }
  return [...targets]
}

function normalizePromptPath(raw: string): string | null {
  let path = raw.trim().replace(/^\.\//, '')
  if (!path || path.startsWith('$') || /\s/.test(path) || !path.includes('/')) return null
  // Templates such as exp-loop-iter<N>-<slug> remain beneath the stable prefix.
  path = path.split(/[<*{]/, 1)[0]!.replace(/\/+$/, '')
  if (!path || path === '..' || path.startsWith('../')) return null
  return path
}

function pathCoveredByWriteRule(target: string, declared: string): boolean {
  const prefix = declared.replace(/^\.\//, '').replace(/\/+$/, '')
  return target === prefix || target.startsWith(`${prefix}/`)
}

const PRECOMPUTED_BOOLEAN_RE = /\$output\.((?:is|should|need|needs|has)_[A-Za-z0-9_]+)\s*[!=]=\s*(?:true|false)/

function lintPrecomputedRouting(spec: LoopGraphSpec, findings: GraphLintFinding[]): void {
  for (const transition of spec.transitions ?? []) {
    if (typeof transition.when !== 'string') continue
    const match = PRECOMPUTED_BOOLEAN_RE.exec(transition.when)
    if (!match) continue
    findings.push({
      level: 'warning', rule: 'precomputed-routing', at: `transitions '${transition.id}'.when`,
      message: `routes on the agent-precomputed boolean '$output.${match[1]}'; prefer raw facts so the deterministic rule lives in the graph (e.g. "$output.new_findings_count == 0 || $output.improvement == 'worsened'") and add those fields to the outputSchema`,
    })
  }
}

/**
 * Precise dead-route detection for the decidable subclass: a string state
 * variable whose every update is a literal `builtin/set`. Its reachable value
 * domain is exactly {initial} ∪ {set literals}; an equality route against a
 * value outside that domain can never fire.
 */
function lintDeadLiteralRoutes(spec: LoopGraphSpec, findings: GraphLintFinding[]): void {
  for (const [name, variable] of Object.entries(spec.state ?? {})) {
    if (typeof variable?.initial !== 'string') continue
    const domain = new Set<string>([variable.initial])
    let fullyLiteral = true
    for (const transition of spec.transitions ?? []) for (const update of transition.updates ?? []) {
      if (update.target !== name) continue
      const argument = update.args?.[0]
      if (update.reducer?.startsWith('builtin/set@') && update.args?.length === 1 &&
          argument && typeof argument === 'object' && 'literal' in argument && typeof argument.literal === 'string') {
        domain.add(argument.literal)
      } else fullyLiteral = false
    }
    if (!fullyLiteral) continue
    const equalityRe = new RegExp(`\\$state\\.${name}\\s*==\\s*'([^']*)'`, 'g')
    for (const transition of spec.transitions ?? []) {
      if (typeof transition.when !== 'string') continue
      for (const match of transition.when.matchAll(equalityRe)) {
        if (domain.has(match[1]!)) continue
        findings.push({
          level: 'warning', rule: 'dead-literal-route', at: `transitions '${transition.id}'.when`,
          message: `compares $state.${name} to '${match[1]}' but reducers only ever assign {${[...domain].join(', ')}}; this route can never fire — remove it or assign the value somewhere`,
        })
      }
    }
  }
}

export function formatGraphLintFindings(findings: readonly GraphLintFinding[]): string[] {
  return findings.map(finding => `lint(${finding.level}) ${finding.rule} at ${finding.at}: ${finding.message}`)
}
