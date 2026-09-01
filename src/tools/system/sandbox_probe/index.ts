/**
 * sandbox_probe — read-only self-inspection of the effective sandbox policy.
 *
 * WHY THIS TOOL EXISTS
 *
 * A sandboxed session that cannot see its own policy cannot debug itself, and
 * the failure mode is worse than "it doesn't work": it is confident wrong
 * answers. A real example from this runtime — a session investigating why `gh`
 * failed on macOS ran `env | grep -i DBUS`, found nothing, and concluded the
 * child process "has no keyring session". DBUS is the LINUX keyring mechanism;
 * that probe returns empty on every Mac, including the user's own working
 * terminal. The reasoning was fine. The runtime simply offered no way to ask
 * the real question, so a Linux-shaped probe got run on a Mac and its false
 * positive was believed.
 *
 * So this tool reports what the resolver actually decided, including everything
 * it dropped. Dropping a non-existent path is correct behaviour; dropping it
 * invisibly is what made "my config never loaded" indistinguishable from "my
 * config loaded and the tool is still broken".
 *
 * SAFETY: no execution, no spawning, no credential VALUES. Environment
 * variables are reported as set/unset only — the whole point is to be safe to
 * run when something is already going wrong, and printing a token into the
 * model's context to debug a token problem would be its own incident.
 */

import type { MetaAgentTool, ToolCallContext, ToolResult } from '../../../core/types.js'
import { loadToolPrompt } from '../../util.js'
import {
  resolveSandboxPolicy,
  type ResolvedSandboxPolicy,
  type SandboxDiagnostic,
} from '../../../sandbox/sandboxPolicyConfig.js'
import { TOOL_ACCESS_PRESETS } from '../../../sandbox/toolAccessPresets.js'
import { getSandboxAvailability } from '../../../sandbox/detect.js'
import { existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const DIAGNOSTIC_LABEL: Record<SandboxDiagnostic['kind'], string> = {
  'dropped-path': 'DROPPED PATH',
  'dropped-preset': 'DROPPED PRESET',
  'blocked-env': 'BLOCKED ENV',
  'credential-deny-lifted': 'PROTECTION LIFTED',
  'malformed-config': 'CONFLICT',
}

function configLayerReport(projectDir: string): string[] {
  const home = process.env['META_AGENT_HOME'] ?? join(homedir(), '.meta-agent')
  const globalPath = join(home, 'config.json')
  const projectPath = join(projectDir, '.meta-agent', 'config.json')
  const mark = (p: string): string => (existsSync(p) ? '✓ loaded' : '✗ not present')
  return [
    'config layers (later wins):',
    `  global   ${globalPath}  ${mark(globalPath)}`,
    `  project  ${projectPath}  ${mark(projectPath)}`,
  ]
}

function toolAccessReport(policy: ResolvedSandboxPolicy, verbose: boolean): string[] {
  if (policy.toolAccess.length === 0) {
    return ['toolAccess: (none configured)']
  }
  const lines = [`toolAccess: ${policy.toolAccess.join(', ')}`]
  if (!verbose) return lines
  for (const name of policy.toolAccess) {
    const preset = TOOL_ACCESS_PRESETS[name]
    lines.push(`  ${name}:`)
    lines.push(`    why:     ${preset.rationale}`)
    if (preset.read?.length) lines.push(`    read:    ${preset.read.join(', ')}`)
    if (preset.write?.length) lines.push(`    write:   ${preset.write.join(', ')}`)
    if (preset.env?.length) lines.push(`    env:     ${preset.env.join(', ')}`)
    if (preset.network) lines.push(`    network: ${preset.network}`)
  }
  return lines
}

function envReport(policy: ResolvedSandboxPolicy): string[] {
  if (policy.envAllowlist.length === 0) {
    return ['env allowlist: (none beyond the built-in git credential names)']
  }
  // set/unset only — never the value.
  const rows = policy.envAllowlist.map(name => {
    const present = process.env[name] !== undefined && process.env[name] !== ''
    return `  ${present ? '✓ set   ' : '· unset '} ${name}`
  })
  return ['env allowlist (values never shown):', ...rows]
}

/**
 * @param mode Session mode, supplied at construction the same way createSkillTool
 *   receives it. It is NOT on ToolCallContext, and it must match the mode
 *   AgenticSession passed to resolveSandboxPolicy — a probe that resolved under
 *   a different mode would report a policy nobody is running under, which is
 *   worse than reporting nothing.
 */
export async function createSandboxProbeTool(mode?: string): Promise<MetaAgentTool> {
  const description = await loadToolPrompt(import.meta.url)
  return {
    name: 'sandbox_probe',
    description,
    isConcurrencySafe: true,
    inputSchema: {
      type: 'object',
      properties: {
        verbose: {
          type: 'boolean',
          description: 'Include each granted preset\'s rationale and full expansion.',
        },
      },
      required: [],
    },
    async call(input: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolResult> {
      const verbose = input['verbose'] === true
      const projectDir = ctx.workspaceRoot ?? process.cwd()
      const policy = resolveSandboxPolicy(projectDir, mode)
      const availability = getSandboxAvailability()

      const lines: string[] = []
      lines.push(`mode: ${mode ?? '(unknown)'}`)
      lines.push(`workspace: ${projectDir}`)
      lines.push(
        `backend: platform=${availability.platform} ` +
        `sandbox-exec=${availability.sandboxExec} bwrap=${availability.bwrap}` +
        (availability.nestedBwrap ? ' (nested bwrap detected)' : ''),
      )
      lines.push('')
      lines.push(...configLayerReport(projectDir))
      lines.push('')
      lines.push(...toolAccessReport(policy, verbose))
      lines.push('')

      lines.push('granted roots (fed to BOTH the OS sandbox and the permission jail):')
      if (policy.allowedRoots.length === 0) lines.push('  (none — workspace only)')
      for (const root of policy.allowedRoots) {
        const writable = policy.writeAllowPaths.includes(root)
        lines.push(`  ${writable ? 'rw' : 'r '} ${root}`)
      }
      lines.push('')
      lines.push(...envReport(policy))
      lines.push('')
      lines.push(`network: ${policy.network ?? '(unset — backend default)'}`)
      lines.push(
        `credential protection: ${policy.readDenyPaths.length} path(s) read-denied`,
      )
      lines.push('')

      if (policy.diagnostics.length === 0) {
        lines.push('diagnostics: nothing dropped.')
      } else {
        lines.push(`diagnostics (${policy.diagnostics.length}):`)
        for (const d of policy.diagnostics) {
          lines.push(`  [${DIAGNOSTIC_LABEL[d.kind]}] ${d.subject}`)
          lines.push(`      ${d.detail}`)
        }
      }

      return { content: lines.join('\n'), isError: false }
    },
  }
}
