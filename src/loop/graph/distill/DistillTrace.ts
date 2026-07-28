import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

/**
 * Durable trace of one Distill run.
 *
 * Distill artifacts (`loop.graph.json`, `loop.semantic-review.json`, …) are
 * written only after the whole pipeline succeeds, so a failed run used to leave
 * nothing behind but a single fatal line: every rejected compiler envelope,
 * every frozen-but-semantically-rejected graph and every layered reviewer
 * verdict — the parts that actually say *why* — were discarded. This store
 * keeps them, per attempt, for the life of the run.
 *
 * Tracing is best-effort by construction: a failing write must never turn a
 * recoverable Distill attempt into a hard failure, so every method swallows its
 * own errors.
 */
export interface DistillTraceStore {
  /** Absolute path of this run's directory, surfaced in user-facing messages. */
  readonly dir: string
  /** Append one structured record to `timeline.jsonl`. */
  event(entry: Record<string, unknown>): Promise<void>
  /** Write one named artifact. `name` must be a plain file name. */
  artifact(name: string, content: string): Promise<void>
}

/** `.loop/distill/run-<timestamp>/` under the project workspace. */
export function createFileDistillTraceStore(projectDir: string, now: Date = new Date()): DistillTraceStore {
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  const dir = resolve(projectDir, '.loop', 'distill', `run-${stamp}`)
  const timeline = resolve(dir, 'timeline.jsonl')
  let ready: Promise<void> | undefined
  const ensureDir = (): Promise<void> => (ready ??= mkdir(dir, { recursive: true }).then(() => undefined))
  return {
    dir,
    async event(entry) {
      try {
        await ensureDir()
        await appendFile(timeline, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, 'utf8')
      } catch { /* tracing must never break Distill */ }
    },
    async artifact(name, content) {
      try {
        await ensureDir()
        await writeFile(resolve(dir, safeName(name)), content, 'utf8')
      } catch { /* tracing must never break Distill */ }
    },
  }
}

/** Artifact names are host-built, but keep them incapable of escaping the run
 * directory even if a caller ever interpolates model-supplied text. */
function safeName(name: string): string {
  return name.replace(/[/\\]/g, '_').replace(/^\.+/, '_')
}

/** Model output is `unknown` at the executor boundary; render it losslessly
 * enough to diagnose a parse rejection without throwing on cycles. */
export function renderTraceOutput(output: unknown): string {
  if (typeof output === 'string') return output
  if (output === undefined) return '(no output)'
  try {
    return JSON.stringify(output, null, 2) ?? String(output)
  } catch {
    return String(output)
  }
}
