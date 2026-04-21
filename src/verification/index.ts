/**
 * Verification utilities — executable acceptance criteria (Principle 8).
 *
 * The gap between a demo and a production agent is verifiability.
 * CompletionGuard provides the hook; this module provides the factory that
 * turns real, runnable checks into guards — so quality is measured by
 * artifacts, not by the model's self-assessment.
 *
 * "能写测试就别只写总结，能跑真实检查就别让模型自己评价'应该没问题'。
 *  给模型一个外部反馈回路，质量提升幅度可达 2–3 倍。"
 *
 * Usage:
 * ```ts
 * import { createVerificationGuard } from '@hermes/runtime/verification';
 * import { execSync } from 'child_process';
 * import fs from 'fs';
 *
 * const agent = new AgentRuntime({
 *   ...
 *   completionGuards: [
 *     createVerificationGuard([
 *       {
 *         description: 'Tests pass',
 *         check: async () => {
 *           try { execSync('npm test', { stdio: 'pipe' }); return true; }
 *           catch (e) { return { pass: false, detail: String(e) }; }
 *         },
 *       },
 *       {
 *         description: 'Output file exists',
 *         check: async () => fs.existsSync('./dist/bundle.js'),
 *       },
 *     ]),
 *   ],
 * });
 * ```
 */

import type { CompletionGuard } from '../types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single runnable acceptance check. */
export interface VerificationAssertion {
  /**
   * Human-readable label shown in the feedback injected into the conversation
   * when the check fails.  Keep it short and action-oriented.
   * Example: "All tests pass", "Output file dist/index.js exists"
   */
  description: string;

  /**
   * The check function.
   *
   * Return `true` / `{ pass: true }` to indicate success.
   * Return `false` or `{ pass: false }` to indicate failure (generic message).
   * Return `{ pass: false, detail: '...' }` to include diagnostic detail in
   * the feedback message — e.g. the test failure output or the missing path.
   *
   * Throwing is treated as a failure with the error message as detail.
   */
  check: () => Promise<boolean | VerificationResult>;
}

export interface VerificationResult {
  pass: boolean;
  /** Optional detail shown to the LLM when pass=false. */
  detail?: string;
}

// ---------------------------------------------------------------------------
// Guard factory
// ---------------------------------------------------------------------------

/**
 * Create a `CompletionGuard` from a list of runnable `VerificationAssertion`s.
 *
 * All assertions are run in parallel.  If any fail, a structured feedback
 * message is injected into the conversation listing the failures with their
 * diagnostic detail.  The agent is then expected to address the failures
 * before attempting to complete the task again.
 *
 * The guard short-circuits on the first batch failure — it does not
 * re-run passing checks on subsequent iterations (each call re-runs all).
 *
 * @param assertions - One or more runnable checks that define "done".
 * @param opts.failurePrefix - Custom prefix for the feedback message.
 */
export function createVerificationGuard(
  assertions: VerificationAssertion[],
  opts: { failurePrefix?: string } = {},
): CompletionGuard {
  return async (_proposedResponse, _steps, _history) => {
    // Run all checks concurrently — faster than sequential and checks should
    // be independent (each verifies a different aspect of the output).
    const results = await Promise.allSettled(
      assertions.map(async (a) => {
        let raw: boolean | VerificationResult;
        try {
          raw = await a.check();
        } catch (err) {
          raw = { pass: false, detail: (err as Error).message };
        }
        const result: VerificationResult =
          typeof raw === 'boolean' ? { pass: raw } : raw;
        return { description: a.description, result };
      }),
    );

    const failures: Array<{ description: string; detail?: string }> = [];
    for (const r of results) {
      // allSettled: 'rejected' means the check itself threw (already wrapped
      // above, so this path is a belt-and-suspenders fallback).
      if (r.status === 'rejected') {
        failures.push({ description: '(unknown check)', detail: String(r.reason) });
      } else if (!r.value.result.pass) {
        failures.push({ description: r.value.description, detail: r.value.result.detail });
      }
    }

    if (failures.length === 0) return { satisfied: true }; // All checks passed

    const prefix = opts.failurePrefix ?? 'Verification failed — the following checks did not pass:';
    const lines = failures.map(({ description, detail }) =>
      detail ? `  ✗ ${description}: ${detail}` : `  ✗ ${description}`,
    );

    return {
      satisfied: false,
      feedback:
        `${prefix}\n${lines.join('\n')}\n\n` +
        `Address all failing checks before reporting the task as complete.`,
    };
  };
}

// ---------------------------------------------------------------------------
// Built-in assertion helpers
// ---------------------------------------------------------------------------

/**
 * Assert that a file (or directory) exists at the given path.
 *
 * @example
 * ```ts
 * fileExists('./dist/bundle.js', 'Build output')
 * ```
 */
export function fileExists(filePath: string, label?: string): VerificationAssertion {
  return {
    description: label ?? `File exists: ${filePath}`,
    check: async () => {
      const { access } = await import('fs/promises');
      try {
        await access(filePath);
        return true;
      } catch {
        return { pass: false, detail: `${filePath} not found` };
      }
    },
  };
}

/**
 * Assert that a shell command exits with code 0.
 * Captures stdout+stderr and attaches the tail (last 20 lines) as detail on failure.
 *
 * @example
 * ```ts
 * shellPasses('npm test', 'Tests pass')
 * shellPasses('tsc --noEmit', 'TypeScript compiles')
 * ```
 */
export function shellPasses(command: string, label?: string): VerificationAssertion {
  return {
    description: label ?? `Command succeeds: ${command}`,
    check: async () => {
      const { execSync } = await import('child_process');
      try {
        execSync(command, { stdio: 'pipe' });
        return true;
      } catch (err: unknown) {
        const e = err as { stdout?: Buffer; stderr?: Buffer; message?: string };
        const output = [
          e.stdout?.toString().trim(),
          e.stderr?.toString().trim(),
        ]
          .filter(Boolean)
          .join('\n')
          .split('\n')
          .slice(-20)      // last 20 lines — enough context without flooding
          .join('\n');
        return { pass: false, detail: output || e.message || 'command failed' };
      }
    },
  };
}

/**
 * Assert that a string or regex pattern is found in a file's contents.
 *
 * @example
 * ```ts
 * fileContains('./src/index.ts', /export.*AgentRuntime/, 'AgentRuntime exported')
 * ```
 */
export function fileContains(
  filePath: string,
  pattern: string | RegExp,
  label?: string,
): VerificationAssertion {
  return {
    description: label ?? `${filePath} contains ${String(pattern)}`,
    check: async () => {
      const { readFile } = await import('fs/promises');
      let content: string;
      try {
        content = await readFile(filePath, 'utf-8');
      } catch {
        return { pass: false, detail: `${filePath} not found` };
      }
      const found =
        typeof pattern === 'string' ? content.includes(pattern) : pattern.test(content);
      return found ? true : { pass: false, detail: `Pattern not found in ${filePath}` };
    },
  };
}
