/**
 * DeterministicEvidence — run the project's objective checks ONCE in the real
 * working tree (where dependencies actually exist) and package the results for
 * the judge.
 *
 * Why here and not inside the judge's read-only snapshot: the snapshot is a
 * fresh `git worktree` with NO node_modules / build artifacts (they're
 * gitignored), so `tsc` / `npm test` would fail spuriously there. We therefore
 * run the heavy, dependency-bearing checks in the main tree and hand the judge
 * their exit codes + tail output as EVIDENCE. The judge's own bash is then only
 * for lightweight inspection inside the snapshot. Objective signals (a compiler
 * exit code) anchor the verdict; the judge covers the semantic gap on top.
 *
 * Best-effort and bounded: each command has a timeout and its output is tail-
 * capped. Anything that throws is reported as "could not run", never raised —
 * the verifier must degrade gracefully, not crash the run it protects.
 */
import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const execFileAsync = promisify(execFile)

/** Per-check wall-clock cap. A check that hangs must not stall the gate. */
const CHECK_TIMEOUT_MS = 120_000
/** Tail of stdout+stderr handed to the judge per check. */
const MAX_OUTPUT_TAIL_CHARS = 4_000

/** npm script names we treat as objective checks, in priority order. */
const CANDIDATE_SCRIPTS = ['typecheck', 'test', 'build', 'lint'] as const

export interface CheckOutcome {
  /** Label shown to the judge (e.g. "npm run typecheck"). */
  command: string
  /** Process exit code, or null when the command could not be spawned. */
  exitCode: number | null
  passed: boolean
  /** Tail of combined stdout/stderr (capped). */
  outputTail: string
}

/** Read package.json scripts, swallowing any parse/IO error. */
function readScripts(projectDir: string): Record<string, string> {
  try {
    const raw = readFileSync(join(projectDir, 'package.json'), 'utf-8')
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> }
    return pkg.scripts ?? {}
  } catch {
    return {}
  }
}

function tail(s: string): string {
  return s.length > MAX_OUTPUT_TAIL_CHARS ? `…${s.slice(-MAX_OUTPUT_TAIL_CHARS)}` : s
}

async function runScript(projectDir: string, script: string): Promise<CheckOutcome> {
  const command = `npm run ${script}`
  try {
    const { stdout, stderr } = await execFileAsync(
      'npm', ['run', '--silent', script],
      { cwd: projectDir, timeout: CHECK_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
    )
    return { command, exitCode: 0, passed: true, outputTail: tail(`${stdout}\n${stderr}`.trim()) }
  } catch (err) {
    // execFile rejects on non-zero exit, timeout, or spawn failure.
    const e = err as { code?: number | string; stdout?: string; stderr?: string; killed?: boolean }
    const exitCode = typeof e.code === 'number' ? e.code : null
    const body = `${e.stdout ?? ''}\n${e.stderr ?? ''}`.trim()
    const note = e.killed ? '[超时被终止] ' : ''
    return { command, exitCode, passed: false, outputTail: tail(note + body) }
  }
}

/**
 * Run every present candidate check and return both the structured outcomes and
 * a judge-ready text block. When the project is not an npm project (or has none
 * of the candidate scripts), returns an empty list and a short note so the judge
 * knows objective signals were unavailable (and must rely on inspection alone).
 */
export async function gatherDeterministicEvidence(
  projectDir: string,
): Promise<{ outcomes: CheckOutcome[]; text: string }> {
  if (!existsSync(join(projectDir, 'package.json'))) {
    return { outcomes: [], text: '（无 package.json：本项目无可机械执行的确定性检查，请完全依赖人工查证。）' }
  }
  const scripts = readScripts(projectDir)
  const present = CANDIDATE_SCRIPTS.filter(s => typeof scripts[s] === 'string')
  if (present.length === 0) {
    return { outcomes: [], text: '（package.json 未定义 typecheck/test/build/lint 脚本：无确定性检查可跑。）' }
  }

  const outcomes: CheckOutcome[] = []
  for (const script of present) {
    outcomes.push(await runScript(projectDir, script))
  }

  const text = outcomes
    .map(o => {
      const verdict = o.passed ? 'PASS' : `FAIL (exit ${o.exitCode ?? 'spawn-error'})`
      return `### ${o.command} → ${verdict}\n${o.outputTail || '(无输出)'}`
    })
    .join('\n\n')

  return { outcomes, text: `已在主工作树执行以下确定性检查（退出码为客观事实，优先于主观判断）：\n\n${text}` }
}
