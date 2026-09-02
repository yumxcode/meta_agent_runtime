/**
 * A prompt must settle when stdin ends.
 *
 * `rl.question()` does not invoke its callback when the interface closes, so
 * Ctrl+D at a prompt left the promise pending forever. The REPL happened to
 * survive it — its own `'close'` handler calls `process.exit` — but every other
 * caller inherited a silent hang from a keystroke people press all the time.
 *
 * It resolves EMPTY rather than rejecting: every call site already reads an
 * empty answer as "cancelled" (that is what a bare Enter gives them), and
 * rejecting would turn Ctrl+D into an unhandled rejection, which this CLI
 * treats as fatal — swapping a hang for a spurious `Fatal:` on the way out.
 */
import { describe, expect, it } from 'vitest'
import { createInterface } from 'node:readline'
import { PassThrough } from 'node:stream'
import { askQuestion, isNativeQuestionActive } from '../prompts.js'

function harness() {
  const input = new PassThrough()
  const output = new PassThrough()
  output.resume()
  const rl = createInterface({ input, output, terminal: false })
  return { input, output, rl }
}

describe('askQuestion', () => {
  it('resolves empty when the interface closes with a question pending', async () => {
    const { rl } = harness()
    const pending = askQuestion(rl, 'pick one: ')
    rl.close()
    await expect(pending).resolves.toBe('')
  })

  it('releases the native-question marker on EOF', async () => {
    const { rl } = harness()
    const pending = askQuestion(rl, 'pick one: ')
    expect(isNativeQuestionActive(rl)).toBe(true)
    rl.close()
    await pending
    expect(isNativeQuestionActive(rl)).toBe(false)
  })

  it('still returns a typed answer, trimmed', async () => {
    const { input, rl } = harness()
    const pending = askQuestion(rl, 'name: ')
    input.write('  hello  \n')
    await expect(pending).resolves.toBe('hello')
    rl.close()
  })

  it('a later close does not disturb an already-answered question', async () => {
    const { input, rl } = harness()
    const pending = askQuestion(rl, 'name: ')
    input.write('answered\n')
    expect(await pending).toBe('answered')
    rl.close()
    // No unhandled rejection, no second settle — the close listener was removed.
    await new Promise(resolve => setTimeout(resolve, 10))
  })

  it('rejects when the abort signal fires', async () => {
    const { rl } = harness()
    const controller = new AbortController()
    const pending = askQuestion(rl, 'name: ', controller.signal)
    controller.abort()
    await expect(pending).rejects.toThrow(/timed out or was cancelled/)
    rl.close()
  })
})
