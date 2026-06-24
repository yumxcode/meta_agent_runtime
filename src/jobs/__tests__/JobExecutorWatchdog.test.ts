import { describe, expect, it, vi } from 'vitest'
import { LocalExecutor } from '../JobExecutor.js'
import type { ExecutorCallbacks } from '../JobExecutor.js'
import type { JobContext, JobHandler, ProgressReporter } from '../types.js'

function makeCallbacks(): ExecutorCallbacks & {
  completed: string[]
  failed: Array<{ id: string; err: Error }>
  cancelled: string[]
} {
  const completed: string[] = []
  const failed: Array<{ id: string; err: Error }> = []
  const cancelled: string[] = []
  return {
    completed, failed, cancelled,
    onQueued: () => {},
    onStarted: () => {},
    onProgress: () => {},
    onCompleted: (id) => { completed.push(id) },
    onFailed: (id, err) => { failed.push({ id, err }) },
    onCancelled: (id) => { cancelled.push(id) },
  }
}

describe('LocalExecutor watchdog', () => {
  it('force-fails and frees the slot for a handler that ignores abort', async () => {
    // maxConcurrent = 1 so a wedged job would otherwise block the queue forever.
    const exec = new LocalExecutor(1)

    // A handler that never settles and never checks the abort signal.
    const wedged: JobHandler = () => new Promise(() => { /* never resolves */ })
    const quick: JobHandler = async () => ({ output: { ok: true }, summary: 'ok', artifacts: [] })

    const cb1 = makeCallbacks()
    const cb2 = makeCallbacks()

    // 50ms watchdog on the wedged job; the second job is queued behind it.
    exec.submit('wedged', wedged, {}, ctx('wedged', 50), cb1)
    exec.submit('quick', quick, {}, ctx('quick'), cb2)

    // Before the watchdog fires, the queued job has not started.
    expect(cb2.completed).toHaveLength(0)

    await new Promise(r => setTimeout(r, 120))

    // The wedged job was force-failed by the watchdog...
    expect(cb1.failed.map(f => f.id)).toContain('wedged')
    expect(cb1.failed[0]!.err.message).toMatch(/watchdog/)
    // ...and the slot was released so the queued job ran to completion.
    expect(cb2.completed).toContain('quick')
  })

  it('does not double-fire when a handler settles after the watchdog', async () => {
    const exec = new LocalExecutor(2)
    let release: (() => void) | undefined
    const slow: JobHandler = () => new Promise(resolve => {
      release = () => resolve({ output: {}, summary: '', artifacts: [] })
    })
    const cb = makeCallbacks()
    exec.submit('slow', slow, {}, ctx('slow', 30), cb)

    await new Promise(r => setTimeout(r, 80))
    // Watchdog already failed it once.
    expect(cb.failed).toHaveLength(1)

    // Now let the original handler finally resolve — must be a no-op.
    release?.()
    await new Promise(r => setTimeout(r, 20))
    expect(cb.completed).toHaveLength(0)
    expect(cb.failed).toHaveLength(1)
  })

  it('lets normal jobs complete without watchdog interference', async () => {
    const exec = new LocalExecutor(4)
    const cb = makeCallbacks()
    const quick: JobHandler = async () => ({ output: { n: 1 }, summary: 'done', artifacts: [] })
    exec.submit('q', quick, {}, ctx('q', 10_000), cb)
    await new Promise(r => setTimeout(r, 30))
    expect(cb.completed).toEqual(['q'])
    expect(cb.failed).toHaveLength(0)
  })
})

function ctx(jobId: string, timeoutMs?: number): Omit<JobContext, 'abortSignal'> {
  return {
    jobId,
    sessionId: 's',
    agentId: 'a',
    domain: 'generic',
    fidelityLevel: 0,
    ...(timeoutMs !== undefined && { timeoutMs }),
  }
}

// Silence unused import lint for ProgressReporter (kept for signature clarity).
void (undefined as unknown as ProgressReporter)
