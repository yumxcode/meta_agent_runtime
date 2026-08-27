/**
 * Controlled re-execution, end to end (G1-7 + G1-11).
 *
 * The synthetic fixture is a real git repo containing a script that exits 1.
 * A "candidate" is a shell command; a passing candidate fixes the script, a
 * failing one does nothing. That is the whole of G1's first acceptance
 * criterion — capture, restore, execute, verify, clean up, and get the same
 * answer twice.
 *
 * The adversarial half matters more. Each of these is a way a candidate can
 * pass without doing the work, and every one of them produces a *plausible
 * green result* if the runner does not defend against it:
 *
 *   - rewrite the check so it always exits 0;
 *   - export a PATH that shadows the tool the check calls;
 *   - drop a file into the workspace with the same name as the check script;
 *   - have the bundle live inside the workspace to begin with.
 */
import { mkdtemp, rm, writeFile, mkdir, chmod, readdir } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, describe, expect, it } from 'vitest'
import { runEvalCase } from '../EvalRunner.js'
import { captureBaseSnapshot, type BaseSnapshot } from '../BaseSnapshot.js'
import { assertBundleOutsideWorkspace } from '../EvaluatorBundle.js'
import { runGit } from '../../infra/exec/runGit.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function tempDir(tag = 'evalrunner'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `meta-agent-${tag}-`))
  tempDirs.push(dir)
  return dir
}

/**
 * A repository whose `check.sh` exits 1 until `answer.txt` says `42`.
 * Deliberately trivial: the fixture exists to exercise the runner, not to be a
 * realistic task.
 */
async function fixtureRepo(): Promise<{ dir: string; snapshot: BaseSnapshot }> {
  const dir = await tempDir('fixture')
  await runGit(['init', '--initial-branch=main'], { cwd: dir })
  await runGit(['config', 'user.email', 'test@example.com'], { cwd: dir })
  await runGit(['config', 'user.name', 'Test'], { cwd: dir })
  await writeFile(join(dir, 'answer.txt'), 'wrong\n')
  await runGit(['add', '.'], { cwd: dir })
  await runGit(['commit', '-m', 'initial'], { cwd: dir })
  const snapshot = await captureBaseSnapshot(dir)
  return { dir, snapshot }
}

async function bundle(opts: { command?: string; script?: string } = {}): Promise<string> {
  const dir = await tempDir('bundle')
  if (opts.script !== undefined) {
    const path = join(dir, 'verify.sh')
    await writeFile(path, opts.script)
    await chmod(path, 0o755)
  }
  await writeFile(join(dir, 'bundle.json'), JSON.stringify({
    schemaVersion: 'evaluator-bundle-1.0',
    id: 'evalbundle_fixture',
    createdAt: 1,
    checks: [{
      id: 'answer-is-42',
      statement: 'answer.txt contains 42',
      command: opts.command ?? 'grep -qx 42 "$EVAL_WORKSPACE/answer.txt"',
      timeoutMs: 15_000,
    }],
  }))
  return dir
}

const FIX_IT = 'printf "42\\n" > answer.txt'
const DO_NOTHING = 'true'

describe('G1-11 — the synthetic fixture, end to end', () => {
  it('passes when the candidate does the work', async () => {
    const { dir, snapshot } = await fixtureRepo()
    const report = await runEvalCase({
      caseRef: 'fixture-pass',
      snapshot,
      sourceDir: dir,
      bundleDir: await bundle(),
      candidateCommand: FIX_IT,
    })

    expect(report.phases.map(p => [p.phase, p.status])).toEqual([
      ['setup', 'ok'], ['execute', 'ok'], ['verify', 'ok'], ['teardown', 'ok'],
    ])
    expect(report.checks[0]!.verdict).toBe('pass')
    expect(report.succeeded).toBe(true)
    expect(report.inconclusive).toBe(false)
  })

  it('fails when the candidate does nothing', async () => {
    const { dir, snapshot } = await fixtureRepo()
    const report = await runEvalCase({
      caseRef: 'fixture-fail',
      snapshot,
      sourceDir: dir,
      bundleDir: await bundle(),
      candidateCommand: DO_NOTHING,
    })

    expect(report.checks[0]!.verdict).toBe('fail')
    expect(report.succeeded).toBe(false)
    // Failing is a result, not an error — the run itself is conclusive.
    expect(report.inconclusive).toBe(false)
  })

  it('recomputes the same result on a repeat run', async () => {
    // repeat_pass_rate is a G1 metric, so one snapshot has to give the same
    // answer twice from the same starting state.
    const { dir, snapshot } = await fixtureRepo()
    const bundleDir = await bundle()
    const run = () => runEvalCase({
      caseRef: 'fixture-repeat', snapshot, sourceDir: dir, bundleDir, candidateCommand: FIX_IT,
    })

    const [first, second] = [await run(), await run()]
    expect(second.succeeded).toBe(first.succeeded)
    expect(second.checks.map(c => c.verdict)).toEqual(first.checks.map(c => c.verdict))
  })

  it('starts from the snapshot even after the source repo has moved on', async () => {
    // The property everything rests on: if the case started from the finished
    // state, the answer would already be present and the check would pass for
    // free.
    const { dir, snapshot } = await fixtureRepo()
    await writeFile(join(dir, 'answer.txt'), '42\n')
    await runGit(['add', '.'], { cwd: dir })
    await runGit(['commit', '-m', 'the answer, committed later'], { cwd: dir })

    const report = await runEvalCase({
      caseRef: 'fixture-not-contaminated',
      snapshot,
      sourceDir: dir,
      bundleDir: await bundle(),
      candidateCommand: DO_NOTHING,
    })
    expect(report.checks[0]!.verdict).toBe('fail')
  })

  it('leaves nothing behind', async () => {
    const { dir, snapshot } = await fixtureRepo()
    const workRoot = await tempDir('workroot')
    const report = await runEvalCase({
      caseRef: 'fixture-cleanup',
      snapshot, sourceDir: dir, bundleDir: await bundle(), candidateCommand: FIX_IT, workRoot,
    })

    expect(report.cleanedUp).toBe(true)
    expect(await readdir(workRoot)).toEqual([])
    // A leaked worktree registration breaks the next run of the same snapshot.
    const { stdout } = await runGit(['worktree', 'list'], { cwd: dir, raw: true })
    expect(stdout).not.toContain('evalrun')
  })

  it('cleans up even when the candidate fails', async () => {
    const { dir, snapshot } = await fixtureRepo()
    const workRoot = await tempDir('workroot')
    await runEvalCase({
      caseRef: 'fixture-cleanup-on-failure',
      snapshot, sourceDir: dir, bundleDir: await bundle(),
      candidateCommand: 'exit 3', workRoot,
    })
    expect(await readdir(workRoot)).toEqual([])
  })
})

describe('G1-7 — the candidate cannot buy a pass', () => {
  it('refuses a verdict when the candidate rewrites the check', async () => {
    // The most direct attack: edit the thing that decides whether you passed.
    const { dir, snapshot } = await fixtureRepo()
    const bundleDir = await bundle({ command: './verify.sh', script: '#!/bin/sh\nexit 1\n' })

    const report = await runEvalCase({
      caseRef: 'attack-rewrite-check',
      snapshot,
      sourceDir: dir,
      bundleDir,
      candidateCommand: `printf '#!/bin/sh\\nexit 0\\n' > ${JSON.stringify(join(bundleDir, 'verify.sh'))}`,
    })

    expect(report.bundleTampered).toBe(true)
    expect(report.checks[0]!.verdict).toBe('insufficient_evidence')
    // Critically NOT a pass, and not silently a fail either.
    expect(report.succeeded).toBe(false)
    expect(report.inconclusive).toBe(true)
  })

  it('detects tampering even when the rewrite would have failed anyway', async () => {
    // The integrity check does not depend on the tamper being advantageous.
    const { dir, snapshot } = await fixtureRepo()
    const bundleDir = await bundle()
    const report = await runEvalCase({
      caseRef: 'attack-touch-bundle',
      snapshot,
      sourceDir: dir,
      bundleDir,
      candidateCommand: `printf 'x' >> ${JSON.stringify(join(bundleDir, 'bundle.json'))}`,
    })
    expect(report.bundleTampered).toBe(true)
    expect(report.isolation.bundleHashVerified).toBe(false)
  })

  it('runs checks under a minimal environment, not the ambient one', async () => {
    // A candidate cannot export into a sibling process, so testing that its own
    // `export PATH` fails to reach the check proves nothing — it could never
    // have. What is worth pinning is the runner's own choice: verify uses the
    // `empty` policy, so ambient variables are stripped rather than inherited.
    // This marker survives 'inherit' and 'filtered' and dies under 'empty',
    // which is exactly what makes the assertion discriminating.
    const marker = 'META_AGENT_EVAL_LEAK_MARKER'
    process.env[marker] = 'leaked'
    try {
      const { dir, snapshot } = await fixtureRepo()
      const bundleDir = await tempDir('bundle-env')
      await writeFile(join(bundleDir, 'bundle.json'), JSON.stringify({
        schemaVersion: 'evaluator-bundle-1.0',
        id: 'evalbundle_env',
        createdAt: 1,
        checks: [{
          id: 'no-ambient-env',
          statement: 'the ambient environment does not reach the verifier',
          command: `test -z "$${marker}"`,
          timeoutMs: 15_000,
        }],
      }))

      const report = await runEvalCase({
        caseRef: 'verify-env-minimal',
        snapshot, sourceDir: dir, bundleDir, candidateCommand: FIX_IT,
      })
      expect(report.checks[0]!.verdict).toBe('pass')
      expect(report.isolation.verifyEnvPolicy).toBe('empty')
    } finally {
      delete process.env[marker]
    }
  })

  it('does not put a candidate-writable directory on the verifier PATH', async () => {
    // The real version of the PATH attack: if any PATH entry were inside the
    // workspace, the candidate could plant a binary the check calls by name.
    const { dir, snapshot } = await fixtureRepo()
    const bundleDir = await tempDir('bundle-path')
    await writeFile(join(bundleDir, 'bundle.json'), JSON.stringify({
      schemaVersion: 'evaluator-bundle-1.0',
      id: 'evalbundle_path',
      createdAt: 1,
      checks: [{
        id: 'path-excludes-workspace',
        statement: 'no PATH entry lies inside the candidate workspace',
        command: 'case ":$PATH:" in *":$EVAL_WORKSPACE"*) exit 1 ;; *) exit 0 ;; esac',
        timeoutMs: 15_000,
      }],
    }))

    const report = await runEvalCase({
      caseRef: 'verify-path-clean',
      snapshot, sourceDir: dir, bundleDir, candidateCommand: FIX_IT,
    })
    expect(report.checks[0]!.verdict).toBe('pass')
  })

  it('is not fooled by a same-named script planted in the workspace', async () => {
    // `./verify.sh` resolves against the bundle directory, not the workspace,
    // so planting one next to the code does nothing.
    const { dir, snapshot } = await fixtureRepo()
    const bundleDir = await bundle({
      command: './verify.sh',
      script: '#!/bin/sh\ngrep -qx 42 "$EVAL_WORKSPACE/answer.txt"\n',
    })

    const report = await runEvalCase({
      caseRef: 'attack-shadow-script',
      snapshot,
      sourceDir: dir,
      bundleDir,
      candidateCommand: 'printf "#!/bin/sh\\nexit 0\\n" > verify.sh && chmod +x verify.sh',
    })

    expect(report.bundleTampered).toBe(false)
    expect(report.checks[0]!.verdict).toBe('fail')
    expect(report.isolation.verifyCwdIsBundle).toBe(true)
  })

  it('has a containment guard that rejects a bundle under the workspace', () => {
    // Unit-tested directly because it CANNOT fire through runEvalCase: the
    // workspace is a fresh mkdtemp path, so no caller-supplied bundle can be
    // inside it. The integration test below passes for a different reason (the
    // manifest is missing), which is why this assertion exists separately —
    // otherwise the guard would be untested in both places.
    expect(() => assertBundleOutsideWorkspace('/w/bundle', '/w')).toThrow(/inside the candidate workspace/)
    expect(() => assertBundleOutsideWorkspace('/w', '/w')).toThrow()
    // Segment-wise: a shared prefix is not containment.
    expect(() => assertBundleOutsideWorkspace('/w-backup', '/w')).not.toThrow()
    expect(() => assertBundleOutsideWorkspace('/elsewhere', '/w')).not.toThrow()
  })

  it('refuses to run at all when the bundle sits inside the workspace', async () => {
    // No amount of later checking helps if the candidate owns the bundle from
    // the start, so this is refused during setup.
    const { dir, snapshot } = await fixtureRepo()
    const workRoot = await tempDir('workroot')
    const report = await runEvalCase({
      caseRef: 'attack-bundle-inside',
      snapshot,
      sourceDir: dir,
      // Points at the workspace the runner is about to create.
      bundleDir: join(workRoot, 'workspace'),
      candidateCommand: FIX_IT,
      workRoot,
    })

    expect(report.phases[0]).toMatchObject({ phase: 'setup', status: 'refused' })
    expect(report.succeeded).toBe(false)
  })
})

describe('G1-7 — fail closed', () => {
  it('reports insufficient evidence, never success, when setup fails', async () => {
    const { snapshot } = await fixtureRepo()
    const report = await runEvalCase({
      caseRef: 'setup-broken',
      snapshot,
      sourceDir: await tempDir('not-a-repo'),
      bundleDir: await bundle(),
      candidateCommand: FIX_IT,
    })

    expect(report.phases[0]!.status).toBe('refused')
    expect(report.succeeded).toBe(false)
    expect(report.inconclusive).toBe(true)
    expect(report.checks.every(c => c.verdict === 'insufficient_evidence')).toBe(true)
  })

  it('skips execute and verify entirely when setup fails', async () => {
    const { snapshot } = await fixtureRepo()
    const report = await runEvalCase({
      caseRef: 'setup-broken-phases',
      snapshot,
      sourceDir: await tempDir('not-a-repo'),
      bundleDir: await bundle(),
      candidateCommand: 'echo this must not run',
    })
    expect(report.phases.map(p => p.phase)).not.toContain('execute')
  })

  it('refuses when the bundle manifest is missing, and says nothing was evaluated', async () => {
    // REGRESSION. This previously reported succeeded=false with inconclusive=
    // false and an empty check list, which reads exactly like a candidate that
    // legitimately failed — an infrastructure fault masquerading as a quality
    // result. The original version of this test asserted only `succeeded` and
    // therefore encoded the bug.
    const { dir, snapshot } = await fixtureRepo()
    const report = await runEvalCase({
      caseRef: 'no-bundle',
      snapshot, sourceDir: dir, bundleDir: await tempDir('empty-bundle'),
      candidateCommand: FIX_IT,
    })
    expect(report.phases[0]).toMatchObject({ status: 'refused' })
    expect(report.checks).toEqual([])
    expect(report.succeeded).toBe(false)
    expect(report.inconclusive).toBe(true)
  })

  it('never reports a conclusive run without a single resolved check', async () => {
    // The general form of the bug above: no checks means no evidence, whatever
    // the reason.
    const { dir, snapshot } = await fixtureRepo()
    for (const bundleDir of [await tempDir('empty-bundle-a'), await tempDir('empty-bundle-b')]) {
      const report = await runEvalCase({
        caseRef: 'no-evidence', snapshot, sourceDir: dir, bundleDir, candidateCommand: FIX_IT,
      })
      expect(report.checks.length === 0 ? report.inconclusive : true).toBe(true)
    }
  })

  it('treats a check that times out as unresolved, not failed', async () => {
    // "We ran out of time" is not evidence that the criterion was unmet, and
    // false_success_precision becomes unreadable if the two are merged.
    const { dir, snapshot } = await fixtureRepo()
    const bundleDir = await tempDir('bundle-slow')
    await writeFile(join(bundleDir, 'bundle.json'), JSON.stringify({
      schemaVersion: 'evaluator-bundle-1.0',
      id: 'evalbundle_slow',
      createdAt: 1,
      checks: [{ id: 'slow', statement: 'never finishes', command: 'sleep 30', timeoutMs: 300 }],
    }))

    const report = await runEvalCase({
      caseRef: 'slow-check', snapshot, sourceDir: dir, bundleDir, candidateCommand: FIX_IT,
    })
    expect(report.checks[0]!.verdict).toBe('insufficient_evidence')
    expect(report.succeeded).toBe(false)
    expect(report.inconclusive).toBe(true)
  })

  it('still verifies after the candidate times out', async () => {
    // Partial progress is a real state; the checks decide whether it sufficed.
    const { dir, snapshot } = await fixtureRepo()
    const report = await runEvalCase({
      caseRef: 'slow-candidate',
      snapshot, sourceDir: dir, bundleDir: await bundle(),
      candidateCommand: `${FIX_IT} && sleep 30`,
      executeTimeoutMs: 400,
    })

    expect(report.phases.find(p => p.phase === 'execute')!.status).toBe('timed_out')
    // The work was done before the sleep, so the check should still see it.
    expect(report.checks[0]!.verdict).toBe('pass')
  })

  it('states which isolation guarantees are not yet in force', async () => {
    // A reader must not infer the full G1-6 identity separation from a green
    // run produced by this slice.
    const { dir, snapshot } = await fixtureRepo()
    const report = await runEvalCase({
      caseRef: 'isolation-honesty',
      snapshot, sourceDir: dir, bundleDir: await bundle(), candidateCommand: FIX_IT,
    })

    expect(report.isolation.bundleOutsideWorkspace).toBe(true)
    expect(report.isolation.bundleHashVerified).toBe(true)
    expect(report.isolation.notInForce.join(' ')).toContain('separate OS identity')
  })
})
