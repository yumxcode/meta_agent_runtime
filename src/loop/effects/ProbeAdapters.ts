/**
 * ProbeAdapters — the pure-code probes that watch external effects (spec C5,
 * D2/D4). Adapters ship WITH the runtime and are unit-tested; charters select
 * one by `kind` and pass parameters. No probe ever involves an LLM: the
 * expensive seat only wakes when a rule table says the wait has concluded.
 *
 * M2 built-ins:
 *   'file'  — reads a JSON status file (simulated training + any integration
 *             that can drop a status file). Verdicts: running/done/error/
 *             no_balance/plateau (slope-window detection on metric history).
 *
 * Real gradmotion probing lands as another adapter behind the same interface
 * (shelling `gm task data get`); the rule tables and kernel plumbing do not
 * change — that is the point of the registry.
 */
import { readFile, writeFile } from 'fs/promises'
import { resolve } from 'path'
import type { EffectRecord } from './EffectLedger.js'

export interface ProbeInput {
  effect: EffectRecord
  params: Record<string, unknown>
  /** Workspace root for resolving relative param paths. */
  projectDir: string
}

export interface ProbeResult {
  verdict: string
  data?: unknown
}

export interface ProbeAdapter {
  probe(input: ProbeInput): Promise<ProbeResult>
  /** rotate_and_resubmit hook; optional (rule validation warns at runtime). */
  resubmit?(input: ProbeInput): Promise<{ payload?: Record<string, unknown> }>
  /** terminate_and_harvest hook; optional. */
  terminate?(input: ProbeInput): Promise<void>
}

const registry = new Map<string, ProbeAdapter>()

export function registerProbeAdapter(kind: string, adapter: ProbeAdapter): void {
  registry.set(kind, adapter)
}

export function getProbeAdapter(kind: string): ProbeAdapter | null {
  return registry.get(kind) ?? null
}

// ── plateau detection (deterministic, threshold-parameterised) ────────────────

/**
 * True when the metric's recent window improves less than `minSlope` per
 * sample. Requires at least `window` samples — early training never counts
 * as a plateau ("除非有明显的改进倾向" is the >= branch).
 */
export function isPlateau(history: number[], window = 4, minSlope = 1e-3): boolean {
  if (history.length < window) return false
  const recent = history.slice(-window)
  const slope = (recent[recent.length - 1]! - recent[0]!) / (window - 1)
  return slope < minSlope
}

// ── built-in 'file' adapter ───────────────────────────────────────────────────

interface FileStatus {
  state?: 'running' | 'done' | 'error'
  metricHistory?: number[]
  balanceOk?: boolean
  [k: string]: unknown
}

/** Params: { statusFile: string, plateauWindow?: number, plateauMinSlope?: number } */
export const fileProbeAdapter: ProbeAdapter = {
  async probe({ effect, params, projectDir }): Promise<ProbeResult> {
    const rel = typeof params['statusFile'] === 'string'
      ? params['statusFile']
      : typeof effect.payload?.['statusFile'] === 'string'
        ? (effect.payload['statusFile'] as string)
        : null
    if (!rel) return { verdict: 'error', data: { reason: 'no statusFile param' } }
    let status: FileStatus
    try {
      status = JSON.parse(await readFile(resolve(projectDir, rel), 'utf-8')) as FileStatus
    } catch (err) {
      return { verdict: 'error', data: { reason: `status unreadable: ${(err as Error).message}` } }
    }
    if (status.balanceOk === false) return { verdict: 'no_balance', data: status }
    if (status.state === 'done') return { verdict: 'done', data: status }
    if (status.state === 'error') return { verdict: 'error', data: status }
    const window = typeof params['plateauWindow'] === 'number' ? params['plateauWindow'] : 4
    const minSlope = typeof params['plateauMinSlope'] === 'number' ? params['plateauMinSlope'] : 1e-3
    if (isPlateau(status.metricHistory ?? [], window, minSlope)) {
      return { verdict: 'plateau', data: status }
    }
    return { verdict: 'running', data: { samples: status.metricHistory?.length ?? 0 } }
  },

  /** Simulated rotation: reset balance and continue (integration adapters
   * would call account-pool remove/get + real resubmission here). */
  async resubmit({ effect, params, projectDir }) {
    const rel = (params['statusFile'] ?? effect.payload?.['statusFile']) as string | undefined
    if (rel) {
      const abs = resolve(projectDir, rel)
      try {
        const status = JSON.parse(await readFile(abs, 'utf-8')) as FileStatus
        await writeFile(abs, JSON.stringify({ ...status, balanceOk: true }), 'utf-8')
      } catch { /* leave to the next probe to report */ }
    }
    return { payload: { ...effect.payload, rotatedAt: Date.now() } }
  },

  async terminate({ effect, params, projectDir }) {
    const rel = (params['statusFile'] ?? effect.payload?.['statusFile']) as string | undefined
    if (!rel) return
    const abs = resolve(projectDir, rel)
    try {
      const status = JSON.parse(await readFile(abs, 'utf-8')) as FileStatus
      await writeFile(abs, JSON.stringify({ ...status, state: 'done', terminated: true }), 'utf-8')
    } catch { /* nothing to terminate */ }
  },
}

registerProbeAdapter('file', fileProbeAdapter)
