/**
 * cli/env — the `meta-agent env` report.
 *
 * Prints the environment-variable surface from ENV_REGISTRY plus, since a code
 * review found operators had no way to tell whether the OS sandbox was actually
 * in force, the resolved sandbox backend.
 */
import { ENV_REGISTRY } from '../infra/env/RuntimeEnv.js'
import { describeSandboxBackend } from '../sandbox/index.js'
import { bold, cyan, dim, green, yellow } from './term.js'

/** Mask credential-like values so `env` never prints a secret in full. */
function maskEnvValue(name: string, value: string): string {
  if (/KEY|TOKEN|SECRET|PASSWORD/i.test(name)) {
    return value.length <= 4 ? '****' : `${value.slice(0, 2)}…${value.slice(-2)} (set)`
  }
  return value
}

/**
 * Print the environment-variable config surface from ENV_REGISTRY: the single
 * source of truth (name / type / current effective value / default / purpose).
 * Env vars are read live from process.env — they are NOT stored in any file.
 */
export function printEnvTable(asJson: boolean): void {
  const rows = ENV_REGISTRY.map(e => {
    const raw = process.env[e.name]
    const current = raw === undefined || raw === '' ? null : maskEnvValue(e.name, raw)
    return { name: e.name, type: e.type, current, default: e.default, description: e.description }
  })

  // Whether an OS sandbox is actually in force is a fact the operator cannot
  // otherwise observe: on a host without bwrap/sandbox-exec, agentic/robotics
  // degrade to plain `bash -c` and the only thing left is a best-effort path
  // scan. Reporting it here (and in --json, for scripted preflight checks)
  // makes "am I actually jailed?" answerable.
  const sandbox = describeSandboxBackend()

  if (asJson) {
    console.log(JSON.stringify({ sandbox, env: rows }, null, 2))
    return
  }

  console.log(bold('sandbox backend'))
  console.log()
  if (sandbox.enforced) {
    console.log(`  ${green('●')} ${sandbox.backend}  ${dim('— shell commands run inside an OS-enforced workspace jail')}`)
  } else {
    console.log(`  ${yellow('●')} ${bold('none')}  ${dim(`— ${sandbox.reason ?? 'unavailable'}`)}`)
    console.log(`     ${yellow('Shell commands run WITHOUT an OS-enforced workspace jail.')}`)
    console.log(dim('     Path checks still apply but are a best-effort typo guard, not containment.'))
    console.log(dim('     auto / simple_auto fail closed instead of degrading.'))
  }
  console.log()

  const headers = ['ENV VAR', 'TYPE', 'CURRENT', 'DEFAULT', 'DESCRIPTION']
  const data = rows.map(r => [r.name, r.type, r.current ?? '(unset)', r.default, r.description])
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...data.map(row => row[i]!.length)),
  )
  // Pad on RAW strings (ANSI escapes would corrupt width math), THEN colorize.
  const pad = (s: string, w: number): string => s + ' '.repeat(Math.max(0, w - s.length))

  console.log(bold('meta-agent environment variables') +
    dim('  (read live from process.env — not stored in any file)'))
  console.log()
  console.log(cyan(headers.map((h, i) => pad(h, widths[i]!)).join('  ').trimEnd()))
  console.log(dim(widths.map(w => '─'.repeat(w)).join('  ')))
  for (const row of data) {
    const c = row.map((cell, i) => pad(cell!, widths[i]!))
    const isSet = row[2] !== '(unset)'
    console.log([
      c[0],
      dim(c[1]!),
      isSet ? c[2] : dim(c[2]!),
      c[3],
      dim(c[4]!),
    ].join('  ').trimEnd())
  }
  console.log()
  console.log(dim('Set via the shell/launcher (e.g. export META_AGENT_TOOL_TIMEOUT_MS=60000). ' +
    'Provider keys (ZHIPU_API_KEY, …) are resolved separately by the provider registry.'))
}
