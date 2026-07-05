/**
 * RETIRED: code probe adapters removed. All waiting is now driven by the worker
 * (self-timer) or by external events (events/ files) — there is no code probe
 * polling, and status-checking / remediation lives in the worker agent itself.
 * This file is emptied in place (sandbox unlink is blocked); run
 * `git rm src/loop/effects/ProbeAdapters.ts` to finalize.
 */
export {}
