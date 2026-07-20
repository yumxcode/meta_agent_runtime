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
  rule: 'absolute-path' | 'outside-project-write' | 'git-without-capability' | 'precomputed-routing' | 'dead-literal-route'
  at: string
  message: string
}

export function lintLoopGraph(spec: LoopGraphSpec): GraphLintFinding[] {
  const findings: GraphLintFinding[] = []
  lintAgentWorkspacePrompts(spec, findings)
  lintPrecomputedRouting(spec, findings)
  lintDeadLiteralRoutes(spec, findings)
  return findings
}

const ABSOLUTE_PATH_RE = /(?:^|[\s"'`(=])(?:\/(?:Users|home|root|srv|Volumes)\/|~\/)/
const WRITE_VERB_RE = /\b(edit|write|modify|update|commit|push|clone|create|save|append)\b|编辑|修改|写入|提交|推送/i
const OUTSIDE_PROJECT_RE = /outside\s+(?:of\s+)?(?:this|the)\s+project|项目之?外/i
const OUTSIDE_NEGATION_RE = /\b(?:never|not|don'?t|do\s+not|avoid|no)\b[^.\n]{0,40}outside|outside[^.\n]{0,40}\b(?:forbidden|prohibited|denied|read[- ]?only)\b|(?:禁止|不得|不要|勿)[^。\n]{0,20}项目之?外/i
const GIT_MUTATION_RE = /\bgit\s+(?:add|commit|push)\b/i

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
