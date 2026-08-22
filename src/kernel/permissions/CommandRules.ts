/**
 * Declarative command rules — the replacement for a hard-coded regex list.
 *
 * What was wrong with the list
 * ---------------------------
 * `SensitiveCommandPatterns.ts` is a good list, honestly documented as
 * best-effort. Its problem is not the patterns; it is that **only a code change
 * can alter them**. An operator who knows their environment — "flag any write
 * under /etc", "`kubectl delete` is the dangerous one here", "our deploy script
 * is fine, stop asking" — has no way to say so. So the list is simultaneously
 * too broad for one user and too narrow for the next, permanently, and the only
 * available response is to disable the whole gate.
 *
 * What this changes, and what it deliberately does not
 * ----------------------------------------------------
 * Rules become data: built-in defaults (a faithful port of the existing list)
 * plus operator rules layered on top, with the ability to ALLOW a pattern the
 * defaults flag. That last part deserves care, so it is bounded:
 *
 *   - An `allow` rule can only suppress an ASK. It cannot unlock the workspace
 *     jail, the OS sandbox, or the autonomy capability boundary — none of which
 *     are implemented here. Those live in PermissionPolicy and the sandbox, and
 *     nothing in this file is consulted by them.
 *   - Rules are still **best-effort pattern matching**, exactly as before, with
 *     exactly the same caveat: a match means "worth asking", a non-match means
 *     "no signal", and neither means "safe". Making the list configurable does
 *     not make it a security boundary, and an operator who deletes every rule
 *     has widened their prompts, not their containment.
 *
 * That framing is the whole reason this is safe to make configurable: the
 * decisions with a security argument behind them were never in this list.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { META_AGENT_HOME } from '../../core/metaAgentHome.js'
import { SENSITIVE_SHELL_PATTERNS } from './SensitiveCommandPatterns.js'

/** What a matching rule means. */
export type CommandRuleAction =
  /** Require approval. The default meaning of every built-in rule. */
  | 'ask'
  /** Suppress an ask that a lower-precedence rule would have raised. */
  | 'allow'

export interface CommandRule {
  /** Stable identifier, used to override or disable a built-in. */
  id: string
  /** Human-readable label surfaced in the approval prompt. */
  label: string
  /** JS regular expression source, applied to the raw command string. */
  pattern: string
  /** Regex flags. Only `i` and `m` are honoured; others are ignored. */
  flags?: string
  /** Default: 'ask'. */
  action?: CommandRuleAction
  /** Set false to switch a rule off without deleting it. */
  enabled?: boolean
}

export interface CommandRulesConfig {
  /**
   * Rules layered ON TOP of the built-ins. A rule whose `id` matches a built-in
   * replaces it; a new `id` is appended.
   */
  rules?: CommandRule[]
  /**
   * Ignore the built-in rules entirely and use only `rules`.
   *
   * Deliberately explicit rather than implied by supplying rules: someone
   * adding one project-specific pattern almost never means "and drop the other
   * thirty", and the version of this that inferred it would silently unflag
   * `sudo`.
   */
  replaceBuiltins?: boolean
}

export interface CommandRuleMatch {
  /** The rule that decided the outcome. */
  rule: CommandRule
  /** Its label, for the prompt. */
  label: string
}

/**
 * The built-in rules, derived from `SENSITIVE_SHELL_PATTERNS`.
 *
 * Generated from that array rather than copied so the two cannot drift: the old
 * list stays the single definition of the default patterns, and this module
 * adds layering and identity on top. Ids are derived from the label so an
 * operator can name one in config without this file having to enumerate them.
 */
export function builtinCommandRules(): CommandRule[] {
  return SENSITIVE_SHELL_PATTERNS.map(({ pattern, label }) => ({
    id: labelToId(label),
    label,
    pattern: pattern.source,
    ...(pattern.flags ? { flags: pattern.flags } : {}),
    action: 'ask' as const,
  }))
}

function labelToId(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

/**
 * Merge operator rules over the built-ins.
 *
 * Later wins on id collision, and `enabled: false` removes. Order is preserved
 * so evaluation is deterministic — with `allow` rules in play, "which rule
 * matched first" is a decision, not an implementation detail.
 */
export function mergeCommandRules(
  config: CommandRulesConfig | undefined,
): CommandRule[] {
  const base = config?.replaceBuiltins ? [] : builtinCommandRules()
  const merged = new Map<string, CommandRule>()
  for (const rule of base) merged.set(rule.id, rule)
  for (const rule of config?.rules ?? []) {
    if (!rule.id || !rule.pattern) continue
    merged.set(rule.id, rule)
  }
  return [...merged.values()].filter(r => r.enabled !== false)
}

/**
 * Compiled form. Regexes are built once per policy, not per command: a
 * shell-heavy turn evaluates this list on every call, and recompiling thirty
 * patterns each time is pure waste.
 */
export interface CompiledCommandRules {
  evaluate(command: string): CommandRuleMatch | null
  /** Rule count, for diagnostics. */
  readonly size: number
}

export function compileCommandRules(rules: readonly CommandRule[]): CompiledCommandRules {
  const compiled: { rule: CommandRule; re: RegExp }[] = []
  for (const rule of rules) {
    try {
      // Flags are filtered rather than passed through: `g` on a shared RegExp
      // carries `lastIndex` between calls, which makes `test()` alternate
      // between true and false on identical input — a bug that looks exactly
      // like a flaky rule.
      const flags = (rule.flags ?? '').split('').filter(f => f === 'i' || f === 'm').join('')
      compiled.push({ rule, re: new RegExp(rule.pattern, flags) })
    } catch {
      // A malformed operator pattern must not break every command. Skipping it
      // loses one rule; throwing would lose the whole gate.
      continue
    }
  }

  return {
    size: compiled.length,
    evaluate(command: string): CommandRuleMatch | null {
      let asked: CommandRuleMatch | null = null
      for (const { rule, re } of compiled) {
        if (!re.test(command)) continue
        const action = rule.action ?? 'ask'
        // An `allow` match short-circuits: it is the operator saying "I know
        // about this one". Checking it against the whole list rather than only
        // later rules means an allow can suppress a built-in regardless of
        // where it sits in the merged order.
        if (action === 'allow') return null
        asked ??= { rule, label: rule.label }
      }
      return asked
    },
  }
}

/**
 * Load rules from disk, layered global → project.
 *
 * Same precedence and same locations as the rest of the runtime's config, so an
 * operator does not have to learn a second layering model for this one file.
 */
export function loadCommandRules(
  workspaceRoot: string | undefined,
  inline?: CommandRulesConfig,
  ignoreUserConfig?: boolean,
): CommandRule[] {
  if (inline) return mergeCommandRules(inline)
  if (ignoreUserConfig) return builtinCommandRules()

  const layers: CommandRulesConfig[] = []
  const globalPath = join(META_AGENT_HOME, 'command-rules.json')
  const projectPath = workspaceRoot
    ? join(workspaceRoot, '.meta-agent', 'command-rules.json')
    : null

  for (const path of [globalPath, projectPath]) {
    if (!path) continue
    const layer = readRulesFile(path)
    if (layer) layers.push(layer)
  }
  if (layers.length === 0) return builtinCommandRules()

  return mergeCommandRules({
    replaceBuiltins: layers.some(l => l.replaceBuiltins === true),
    rules: layers.flatMap(l => l.rules ?? []),
  })
}

function readRulesFile(path: string): CommandRulesConfig | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown
    if (typeof parsed !== 'object' || parsed === null) return null
    const config = parsed as CommandRulesConfig
    if (config.rules !== undefined && !Array.isArray(config.rules)) return null
    return config
  } catch {
    // Missing file is the common case; a malformed one falls back to built-ins
    // rather than failing the session, matching how permissions.json behaves.
    return null
  }
}
