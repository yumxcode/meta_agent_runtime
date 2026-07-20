import type { ActivationUsage } from '../spec/GraphTypes.js'

export function emptyUsage(): ActivationUsage {
  return { turns: 0, costUsd: 0, durationMs: 0 }
}

export function addUsage(current: ActivationUsage | undefined, increment: ActivationUsage | undefined): ActivationUsage {
  const left = current ?? emptyUsage()
  const right = increment ?? emptyUsage()
  return {
    turns: left.turns + right.turns,
    costUsd: left.costUsd + right.costUsd,
    durationMs: left.durationMs + right.durationMs,
  }
}

/** Exponential retry backoff derived from the consumed attempt count, capped at one minute. */
export function retryDelayMs(attempt: number): number {
  return Math.min(60_000, 1_000 * 2 ** Math.max(0, attempt - 1))
}
