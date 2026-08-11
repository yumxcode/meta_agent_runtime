/**
 * The Ctrl+G steer prompt must read a FRESH line, never queued type-ahead.
 *
 * Reported symptom, robotics mode, mid-turn:
 *
 *     steer › 已取消，继续。
 *     ⠧ 推理中 · ~828 tokens · 260.2s
 *
 * — the `steer ›` prompt appeared with no cursor and cancelled itself in the
 * same instant.
 *
 * Mechanism: nothing drains `_inputQueue` while a turn streams (the main REPL
 * loop is parked inside streamPrompt), so every Enter pressed mid-turn parks a
 * line there as type-ahead. `steering.read()` called `_nextInput()`, which pops
 * that queue first. A bare Enter had left `''`, so the read resolved
 * immediately, `trimmed` was empty, and stream.ts printed "已取消，继续。" over
 * the prompt that had just been drawn.
 *
 * The nastier half of the same bug: if the parked line had TEXT in it, that
 * text was silently injected as the steering correction — a line the user typed
 * as their next prompt, delivered as a mid-turn instruction instead.
 *
 * The queue helpers are closures inside startRepl(), so these tests exercise a
 * faithful transcription of them. That is a real limitation, and the reason the
 * transcription is kept to the exact four lines that matter.
 */
import { describe, expect, it } from 'vitest'

/** Verbatim shape of the queue helpers in cli/repl.ts. */
function makeQueue(opts: { closed?: boolean } = {}) {
  const inputQueue: string[] = []
  const inputResolvers: Array<(v: string | null) => void> = []
  let rlClosed = opts.closed ?? false

  return {
    inputQueue,
    inputResolvers,
    close(): void {
      rlClosed = true
      for (const r of inputResolvers.splice(0)) r(null)
    },
    /** rl.on('line') → _enqueueInput */
    enqueue(line: string): void {
      if (inputResolvers.length > 0) inputResolvers.shift()!(line)
      else inputQueue.push(line)
    },
    /** The main REPL loop's reader — drains type-ahead, by design. */
    nextInput(): Promise<string | null> {
      if (rlClosed && inputQueue.length === 0) return Promise.resolve(null)
      if (inputQueue.length > 0) return Promise.resolve(inputQueue.shift()!)
      return new Promise(resolve => inputResolvers.push(resolve))
    },
    /** The steer reader — fresh lines only. */
    nextFreshInput(): Promise<string | null> {
      if (rlClosed) return Promise.resolve(null)
      return new Promise(resolve => inputResolvers.push(resolve))
    },
    /** SIGINT while a steer prompt is up. */
    interruptDuringSteer(): void {
      for (const r of inputResolvers.splice(0)) r(null)
    },
  }
}

/** Resolves to the sentinel if `p` has not settled within a tick or two. */
async function settledOr<T>(p: Promise<T>, sentinel: T): Promise<T> {
  return Promise.race([p, new Promise<T>(r => setTimeout(() => r(sentinel), 20))])
}

describe('steer reads fresh input, not type-ahead', () => {
  it('a bare Enter pressed mid-turn no longer cancels the steer prompt', async () => {
    const q = makeQueue()
    q.enqueue('')                          // user hit Enter while the turn streamed

    const read = q.nextFreshInput()
    // THE regression: with _nextInput() this resolved to '' immediately, and
    // stream.ts printed "已取消，继续。" over a prompt with no cursor.
    expect(await settledOr(read, '__pending__')).toBe('__pending__')

    q.enqueue('慢一点，先看日志')            // now the user actually types
    expect(await read).toBe('慢一点，先看日志')
  })

  it('type-ahead TEXT is not silently injected as a correction', async () => {
    const q = makeQueue()
    q.enqueue('等下再说这个')                // meant as the NEXT prompt

    const read = q.nextFreshInput()
    expect(await settledOr(read, '__pending__')).toBe('__pending__')
    q.enqueue('用 mpc 而不是 pid')
    expect(await read).toBe('用 mpc 而不是 pid')
  })

  it('the type-ahead stays queued for the main loop afterwards', async () => {
    const q = makeQueue()
    q.enqueue('等下再说这个')

    const read = q.nextFreshInput()
    q.enqueue('用 mpc 而不是 pid')
    expect(await read).toBe('用 mpc 而不是 pid')

    // Unchanged behaviour: the line the user typed mid-turn is still their next
    // prompt. Dropping it to "clean up" would lose work they had already typed.
    expect(await q.nextInput()).toBe('等下再说这个')
  })

  it('an empty steer line still cancels — the intended way to back out', async () => {
    const q = makeQueue()
    const read = q.nextFreshInput()
    q.enqueue('')
    expect(((await read) ?? '').trim()).toBe('')
  })

  it('the main loop keeps draining type-ahead', async () => {
    // The fix must not change how the main REPL loop consumes input.
    const q = makeQueue()
    q.enqueue('第一句')
    q.enqueue('第二句')
    expect(await q.nextInput()).toBe('第一句')
    expect(await q.nextInput()).toBe('第二句')
  })

  it('EOF resolves a pending steer read instead of hanging', async () => {
    const q = makeQueue()
    const read = q.nextFreshInput()
    q.close()
    expect(await read).toBeNull()
  })

  it('a steer read on an already-closed readline returns null immediately', async () => {
    const q = makeQueue({ closed: true })
    expect(await q.nextFreshInput()).toBeNull()
  })

  it('Ctrl+C while the steer prompt is up unblocks it on the FIRST press', async () => {
    // Previously the pending resolver survived the SIGINT drain window, so the
    // turn hung until a second Ctrl+C closed readline.
    const q = makeQueue()
    const read = q.nextFreshInput()
    q.interruptDuringSteer()
    expect(await read).toBeNull()
  })

  it('two steer reads in a row each get their own fresh line', async () => {
    const q = makeQueue()
    const first = q.nextFreshInput()
    q.enqueue('第一次纠正')
    expect(await first).toBe('第一次纠正')

    const second = q.nextFreshInput()
    expect(await settledOr(second, '__pending__')).toBe('__pending__')
    q.enqueue('第二次纠正')
    expect(await second).toBe('第二次纠正')
  })
})
