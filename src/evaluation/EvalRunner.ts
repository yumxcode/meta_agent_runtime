/**
 * EvalRunner — controlled re-execution of one case (G1-7).
 *
 *   setup → execute(candidate) → verify(evaluator) → teardown
 *
 * The phases are separated because their trust levels differ. `execute` runs
 * candidate-controlled code; `verify` decides whether it worked. Letting those
 * two share a working directory, an environment, or a definition of success is
 * how an evaluation quietly starts measuring nothing.
 *
 * ── The verdict vocabulary, and why `insufficient_evidence` exists ──────────
 *
 * A check that could not run is NOT a failing check. Collapsing the two would
 * corrupt exactly the metric G1 cares most about: `false_success_precision`
 * counts wrong completions among *claimed* completions, so a runner that turns
 * infrastructure problems into `fail` (or worse, lets them pass) makes the
 * headline safety number unreadable. Every path that cannot produce evidence
 * returns `insufficient_evidence`, and a run with any such check is not a
 * result — it is a run that needs fixing and repeating.
 *
 * ── What this slice does and does not isolate ───────────────────────────────
 *
 * In force here:
 *   - the bundle lives outside the candidate workspace, checked before setup;
 *   - the bundle is hashed before execute and again before verify, and any
 *     change aborts the verdict (defeats "candidate edits the test");
 *   - verify runs from the bundle directory, so a same-named file dropped in
 *     the workspace cannot shadow a check;
 *   - verify runs under the `empty` env policy, so a candidate-exported PATH
 *     cannot redirect the tools a check calls;
 *   - every phase is time-bounded, output-bounded, and killed as a process
 *     group so background children cannot outlive it;
 *   - teardown always runs and reports whether it actually cleaned up.
 *
 * NOT in force yet (full G1-6): a separate OS identity, read-only mounts, and
 * independent credentials for the verifier. `EvalRunReport.isolation` states
 * this per run rather than leaving a reader to assume the stronger guarantee.
 */

import { mkdtemp, rm, readdir } from 'fs/promises'
import { join, resolve } from 'path'
import { tmpdir } from 'os'
import {
  runShellCommand,
  ShellCommandRefused,
  type ShellCommandResult,
} from '../infra/exec/runShellCommand.js'
import type { SandboxHandle } from '../sandbox/types.js'
import {
  restoreBaseSnapshot,
  discardRestoredSnapshot,
  verifyRestore,
  type BaseSnapshot,
} from './BaseSnapshot.js'
import {
  loadEvaluatorBundle,
  hashEvaluatorBundle,
  assertBundleOutsideWorkspace,
  type EvaluatorBundle,
} from './EvaluatorBundle.js'

export type EvalPhase = 'setup' | 'execute' | 'verify' | 'teardown'

export type PhaseStatus =
  | 'ok'
  /** Ran to completion and reported failure. A legitimate outcome, not an error. */
  | 'failed'
  | 'timed_out'
  /** A guard refused before anything ran. */
  | 'refused'
  /** Not attempted, because an earlier phase made it meaningless. */
  | 'skipped'

export interface PhaseOutcome {
  phase: EvalPhase
  status: PhaseStatus
  durationMs: number
  exitCode?: number | null
  stdout?: string
  stderr?: string
  error?: string
}

/**
 * `insufficient_evidence` is deliberately not a synonym for `fail`: one says
 * the candidate did not meet the criterion, the other says nobody knows.
 */
export type CheckVerdict = 'pass' | 'fail' | 'insufficient_evidence'

export interface CheckOutcome {
  checkId: string
  statement: string
  verdict: CheckVerdict
  exitCode?: number | null
  durationMs: number
  stdout?: string
  stderr?: string
  reason?: string
}

export interface IsolationReport {
  /**
   * The bundle is not inside the candidate's workspace.
   *
   * True by CONSTRUCTION, not by inspection: the workspace is a freshly created
   * `mkdtemp` directory, so nothing that existed beforehand can be inside it and
   * `assertBundleOutsideWorkspace` cannot fire for any caller-supplied path. The
   * guard is retained as defence in depth for a future caller that supplies an
   * explicit workspace directory, but a reviewer should not read this flag as
   * evidence that a meaningful check ran.
   *
   * The protection that actually does work here is `bundleHashVerified`.
   */
  bundleOutsideWorkspace: boolean
  bundleHashVerified: boolean
  verifyEnvPolicy: 'empty' | 'filtered' | 'inherit'
  verifyCwdIsBundle: boolean
  processGroupKill: boolean
  osSandbox: boolean
  /** Protections the full G1-6 adds that are not in force here. */
  notInForce: string[]
}

export interface EvalRunReport {
  caseRef: string
  startedAt: number
  finishedAt: number
  phases: PhaseOutcome[]
  checks: CheckOutcome[]
  /** True only when every check passed and none lacked evidence. */
  succeeded: boolean
  /** True when any check lacked evidence — the run is not a usable result. */
  inconclusive: boolean
  /** Set when the bundle changed between execute and verify. */
  bundleTampered: boolean
  isolation: IsolationReport
  workspaceDir?: string
  cleanedUp: boolean
}

export interface EvalRunRequest {
  caseRef: string
  snapshot: BaseSnapshot
  /** Repository the snapshot's commit is materialised from. */
  sourceDir: string
  /** Directory holding bundle.json plus any scripts it calls. */
  bundleDir: string
  /**
   * The candidate's work, as a command.
   *
   * A real candidate is an agent session; for the synthetic fixture and for
   * deterministic regression cases a command is the whole of it. Either way the
   * runner treats this as untrusted.
   */
  candidateCommand: string
  executeTimeoutMs?: number
  setupTimeoutMs?: number
  captureLimit?: number
  sandboxHandle?: SandboxHandle
  signal?: AbortSignal
  /** Parent directory for the ephemeral workspace. Defaults to the OS temp dir. */
  workRoot?: string
}

const DEFAULT_EXECUTE_TIMEOUT_MS = 120_000
const DEFAULT_CAPTURE_LIMIT = 64_000

const NOT_IN_FORCE = [
  'separate OS identity for the verifier (G1-6)',
  'read-only mount of the workspace during verify (G1-6)',
  'independent credentials and network policy for the verifier (G1-6)',
]

/**
 * Run one case end to end.
 *
 * Never throws for an evaluation outcome — a failed candidate, a failed check
 * and a broken environment are all reported in the returned structure. It
 * throws only if the caller passes something structurally impossible.
 */
export async function runEvalCase(request: EvalRunRequest): Promise<EvalRunReport> {
  const startedAt = Date.now()
  const phases: PhaseOutcome[] = []
  const captureLimit = request.captureLimit ?? DEFAULT_CAPTURE_LIMIT
  const signal = request.signal ?? new AbortController().signal

  let workspaceDir: string | undefined
  let bundle: EvaluatorBundle | undefined
  let hashBeforeExecute: string | undefined
  let bundleTampered = false
  let cleanedUp = false

  const isolation: IsolationReport = {
    bundleOutsideWorkspace: false,
    bundleHashVerified: false,
    verifyEnvPolicy: 'empty',
    verifyCwdIsBundle: true,
    processGroupKill: process.platform !== 'win32',
    osSandbox: Boolean(request.sandboxHandle),
    notInForce: NOT_IN_FORCE,
  }

  // ── setup ────────────────────────────────────────────────────────────────
  const setupStarted = Date.now()
  try {
    bundle = await loadEvaluatorBundle(request.bundleDir)

    const workRoot = request.workRoot ?? tmpdir()
    workspaceDir = await mkdtemp(join(workRoot, 'meta-agent-evalrun-'))
    const restoreTarget = join(workspaceDir, 'workspace')

    // Checked against the real workspace path, before anything is restored into
    // it — a bundle inside the workspace means the candidate can rewrite its
    // own passing condition, and there is no point running at all.
    assertBundleOutsideWorkspace(request.bundleDir, restoreTarget)
    isolation.bundleOutsideWorkspace = true

    await restoreBaseSnapshot(request.snapshot, restoreTarget, { sourceDir: request.sourceDir })

    // A restore that silently drifted would make every downstream number a
    // measurement of the wrong starting state.
    const mismatches = await verifyRestore(request.snapshot, restoreTarget)
    if (mismatches.length > 0) {
      throw new Error(`restored workspace does not match the snapshot: ${mismatches.join(', ')}`)
    }

    hashBeforeExecute = await hashEvaluatorBundle(request.bundleDir)
    phases.push({ phase: 'setup', status: 'ok', durationMs: Date.now() - setupStarted })
  } catch (err) {
    phases.push({
      phase: 'setup',
      status: 'refused',
      durationMs: Date.now() - setupStarted,
      error: err instanceof Error ? err.message : String(err),
    })
    // Fail closed: with no trustworthy starting state there is nothing to
    // execute and nothing a check could legitimately conclude.
    return finish({
      request, startedAt, phases, bundle, isolation,
      checks: skippedChecks(bundle, 'setup did not complete'),
      workspaceDir,
      cleanedUp: await teardown(phases, request, workspaceDir),
      bundleTampered: false,
    })
  }

  // ── execute ──────────────────────────────────────────────────────────────
  const executeStarted = Date.now()
  const workspacePath = join(workspaceDir, 'workspace')
  try {
    const result = await runShellCommand({
      command: request.candidateCommand,
      cwd: workspacePath,
      workspaceRoot: workspacePath,
      timeoutMs: request.executeTimeoutMs ?? DEFAULT_EXECUTE_TIMEOUT_MS,
      signal,
      captureLimit,
      ...(request.sandboxHandle ? { sandboxHandle: request.sandboxHandle } : {}),
    })
    phases.push(executePhase(result, Date.now() - executeStarted))
  } catch (err) {
    phases.push({
      phase: 'execute',
      status: err instanceof ShellCommandRefused ? 'refused' : 'failed',
      durationMs: Date.now() - executeStarted,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  // A candidate that failed or timed out is still verified: partial progress is
  // a real state and the checks are what decide whether it was enough. Only the
  // integrity of the checks themselves can stop verification.

  // ── verify ───────────────────────────────────────────────────────────────
  const verifyStarted = Date.now()
  const hashBeforeVerify = await hashEvaluatorBundle(request.bundleDir).catch(() => undefined)
  bundleTampered = hashBeforeVerify === undefined || hashBeforeVerify !== hashBeforeExecute
  isolation.bundleHashVerified = !bundleTampered

  let checks: CheckOutcome[]
  if (bundleTampered) {
    // The definition of success changed while the candidate was running. No
    // verdict from these checks means anything now.
    phases.push({
      phase: 'verify',
      status: 'refused',
      durationMs: Date.now() - verifyStarted,
      error: 'evaluator bundle changed between execute and verify',
    })
    checks = skippedChecks(bundle, 'evaluator bundle was modified during execute')
  } else {
    checks = await runChecks(bundle, request, workspacePath, captureLimit, signal)
    const anyUnknown = checks.some(check => check.verdict === 'insufficient_evidence')
    phases.push({
      phase: 'verify',
      status: anyUnknown ? 'failed' : 'ok',
      durationMs: Date.now() - verifyStarted,
    })
  }

  // ── teardown ─────────────────────────────────────────────────────────────
  cleanedUp = await teardown(phases, request, workspaceDir)

  return finish({
    request, startedAt, phases, checks, bundle, isolation,
    workspaceDir, cleanedUp, bundleTampered,
  })
}

async function runChecks(
  bundle: EvaluatorBundle,
  request: EvalRunRequest,
  workspacePath: string,
  captureLimit: number,
  signal: AbortSignal,
): Promise<CheckOutcome[]> {
  const outcomes: CheckOutcome[] = []

  for (const check of bundle.checks) {
    const started = Date.now()
    try {
      const result = await runShellCommand({
        command: check.command,
        // Run from the bundle, not the workspace: a script the candidate drops
        // into the workspace must not be able to shadow a check by name.
        cwd: resolve(request.bundleDir),
        workspaceRoot: resolve(request.bundleDir),
        timeoutMs: check.timeoutMs,
        signal,
        captureLimit,
        // Minimal environment: whatever the candidate exported, including PATH,
        // does not reach the process deciding whether it succeeded.
        envPolicy: 'empty',
        // The workspace arrives as a variable rather than interpolated into the
        // command, so quoting is not something the candidate can influence.
        envOverrides: { EVAL_WORKSPACE: workspacePath },
      })

      outcomes.push({
        checkId: check.id,
        statement: check.statement,
        verdict: result.timedOut || result.aborted
          // A check that ran out of time did not observe a failure; it observed
          // nothing.
          ? 'insufficient_evidence'
          : result.code === 0 ? 'pass' : 'fail',
        exitCode: result.code,
        durationMs: Date.now() - started,
        stdout: result.stdout,
        stderr: result.stderr,
        ...(result.timedOut ? { reason: `check exceeded ${check.timeoutMs}ms` } : {}),
        ...(result.aborted ? { reason: 'run was aborted' } : {}),
      })
    } catch (err) {
      outcomes.push({
        checkId: check.id,
        statement: check.statement,
        verdict: 'insufficient_evidence',
        durationMs: Date.now() - started,
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return outcomes
}

function executePhase(result: ShellCommandResult, durationMs: number): PhaseOutcome {
  return {
    phase: 'execute',
    // A non-zero exit is the candidate failing, which is an outcome the run is
    // meant to capture — not a runner error.
    status: result.timedOut ? 'timed_out' : result.code === 0 ? 'ok' : 'failed',
    durationMs,
    exitCode: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
  }
}

function skippedChecks(bundle: EvaluatorBundle | undefined, reason: string): CheckOutcome[] {
  return (bundle?.checks ?? []).map(check => ({
    checkId: check.id,
    statement: check.statement,
    verdict: 'insufficient_evidence' as const,
    durationMs: 0,
    reason,
  }))
}

/**
 * Always attempt cleanup, and report honestly whether it worked.
 *
 * A leaked git worktree registration breaks the *next* run of the same
 * snapshot, which then surfaces as an unrelated mystery several cases later.
 */
async function teardown(
  phases: PhaseOutcome[],
  request: EvalRunRequest,
  workspaceDir: string | undefined,
): Promise<boolean> {
  const started = Date.now()
  if (!workspaceDir) {
    phases.push({ phase: 'teardown', status: 'skipped', durationMs: 0 })
    return true
  }

  try {
    await discardRestoredSnapshot(join(workspaceDir, 'workspace'), { sourceDir: request.sourceDir })
    await rm(workspaceDir, { recursive: true, force: true })
    const leftovers = await readdir(workspaceDir).catch(() => null)
    const clean = leftovers === null
    phases.push({
      phase: 'teardown',
      status: clean ? 'ok' : 'failed',
      durationMs: Date.now() - started,
      ...(clean ? {} : { error: `workspace not fully removed: ${workspaceDir}` }),
    })
    return clean
  } catch (err) {
    phases.push({
      phase: 'teardown',
      status: 'failed',
      durationMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    })
    return false
  }
}

function finish(args: {
  request: EvalRunRequest
  startedAt: number
  phases: PhaseOutcome[]
  checks: CheckOutcome[]
  bundle: EvaluatorBundle | undefined
  isolation: IsolationReport
  workspaceDir: string | undefined
  cleanedUp: boolean
  bundleTampered: boolean
}): EvalRunReport {
  // An empty check list means nothing was evaluated — the bundle failed to
  // load, or setup died before it could be read. Left as `inconclusive: false`
  // this reported `succeeded: false` with no unresolved checks, which reads
  // exactly like a candidate that legitimately failed. That is the fail-closed
  // violation this module exists to prevent, so absence of checks is treated as
  // absence of evidence.
  const inconclusive = args.checks.length === 0 ||
    args.checks.some(check => check.verdict === 'insufficient_evidence')
  return {
    caseRef: args.request.caseRef,
    startedAt: args.startedAt,
    finishedAt: Date.now(),
    phases: args.phases,
    checks: args.checks,
    // A run with any unresolved check is not a success even if the rest passed:
    // "we could not tell" must never round up.
    succeeded: args.checks.length > 0 && !inconclusive &&
      args.checks.every(check => check.verdict === 'pass'),
    inconclusive,
    bundleTampered: args.bundleTampered,
    isolation: args.isolation,
    ...(args.workspaceDir !== undefined ? { workspaceDir: args.workspaceDir } : {}),
    cleanedUp: args.cleanedUp,
  }
}
