/**
 * How long an agent may wait, and which tool it should use to do it.
 *
 * The reported failure, in robotics mode: the agent wrote
 *
 *     bash("sleep 180 && KEY=$(account-pool get --json | …)")
 *
 * over and over. It never worked and never could:
 *
 *   • bash clamped its own timeout to a flat 120s, so a 180s sleep was killed
 *     before the `&&` ever ran;
 *   • raising that constant alone would have changed nothing, because the
 *     kernel's `timeouts.toolMs` (180s) aborts the call from above;
 *   • the `sleep` tool caps at 60s — and robotics never registered it, because
 *     RoboticsSession builds its tool surface by hand and skips
 *     createSystemTools();
 *   • `self_timer`, which sleep's own prompt points at, is auto-mode only and
 *     stays that way (robotics is interactive; a durable park does not fit).
 *
 * So the agent had NO legal way to wait past two minutes, and the one it
 * invented was structurally impossible. These tests pin the two halves of the
 * fix: bash's cap now derives from the kernel budget instead of contradicting
 * it, and `sleep` is a real long-wait primitive that robotics can reach.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { createBashTool } from '../shell/bash/index.js'
import { createSleepTool } from '../system/sleep/index.js'
import type { ToolCallContext } from '../../core/types.js'

const ENV = 'META_AGENT_TOOL_TIMEOUT_MS'
let previous: string | undefined

beforeEach(() => { previous = process.env[ENV] })
afterEach(() => {
  if (previous === undefined) delete process.env[ENV]
  else process.env[ENV] = previous
})

/** The `max:` figure the model is shown for bash's timeout_ms. */
async function advertisedMax(): Promise<number> {
  const tool = await createBashTool()
  const schema = tool.inputSchema as { properties: { timeout_ms: { description: string } } }
  const m = schema.properties.timeout_ms.description.match(/max:\s*(\d+)/)
  return Number(m?.[1])
}

function ctx(signal: AbortSignal): ToolCallContext {
  return { abortSignal: signal } as ToolCallContext
}

// ── bash: cap derives from the kernel budget ─────────────────────────────────

describe('bash timeout cap', () => {
  it('sits just under the kernel per-tool budget, not above it', async () => {
    // The point of the margin: BASH's timer should fire, because it kills the
    // process group and returns the output captured so far. The kernel's abort
    // is blunter and produces a bare "Command aborted".
    process.env[ENV] = '180000'
    expect(await advertisedMax()).toBe(179_000)
  })

  it('rises when the operator raises timeouts.toolMs', async () => {
    // Previously pinned at 120000 no matter what the operator configured.
    process.env[ENV] = '600000'
    expect(await advertisedMax()).toBe(599_000)
  })

  it('never exceeds the hard ceiling, however large the budget', async () => {
    process.env[ENV] = '3600000'
    expect(await advertisedMax()).toBe(600_000)
  })

  it('falls back to the hard ceiling when the kernel timeout is disabled', async () => {
    process.env[ENV] = '0'
    expect(await advertisedMax()).toBe(600_000)
  })

  it('the advertised max is read live, not frozen at module load', async () => {
    process.env[ENV] = '200000'
    const first = await advertisedMax()
    process.env[ENV] = '400000'
    const second = await advertisedMax()
    expect(second).toBeGreaterThan(first)
  })

  it('is comfortably above the old 120s wall', async () => {
    delete process.env[ENV]                      // default toolMs = 180s
    expect(await advertisedMax()).toBeGreaterThan(120_000)
  })
})

// ── sleep: the sanctioned long wait ──────────────────────────────────────────

describe('sleep as the long-wait primitive', () => {
  it('advertises a 30-minute ceiling, not 60 seconds', async () => {
    const tool = await createSleepTool()
    const schema = tool.inputSchema as { properties: { duration_ms: { description: string } } }
    expect(schema.properties.duration_ms.description).toContain('1800000')
  })

  it('opts out of the kernel per-tool timeout, or it could never outlast it', async () => {
    // Without this the kernel would abort any sleep past timeouts.toolMs (3
    // min) — exactly the bound the tool exists to escape.
    const tool = await createSleepTool()
    expect(tool.timeoutMs).toBeGreaterThan(30 * 60_000)
  })

  it('stays cooperatively abortable despite the long ceiling', async () => {
    // A 30-minute block is only acceptable because Ctrl+C ends it at once.
    const tool = await createSleepTool()
    expect(tool.abortSupport).toBe('cooperative')

    const controller = new AbortController()
    const startedAt = Date.now()
    const call = tool.call({ duration_ms: 60_000 }, ctx(controller.signal))
    controller.abort()

    await expect(call).rejects.toThrow(/Sleep aborted/)
    expect(Date.now() - startedAt).toBeLessThan(500)
  })

  it('an abort REJECTS — resolving would make Ctrl+C a no-op', async () => {
    // A resolved ToolResult reads to the kernel as "the tool completed", and
    // the loop carries on. Returning a friendly "interrupted" result here
    // looked tidier and quietly disarmed interrupt.
    const controller = new AbortController()
    controller.abort()
    const tool = await createSleepTool()
    await expect(tool.call({ duration_ms: 1000 }, ctx(controller.signal))).rejects.toThrow()
  })

  it('reports how far the wait got, so a poller knows whether to re-check', async () => {
    const controller = new AbortController()
    const tool = await createSleepTool()
    const call = tool.call({ duration_ms: 60_000 }, ctx(controller.signal))
    await new Promise(r => setTimeout(r, 30))
    controller.abort()
    await expect(call).rejects.toThrow(/of 60000ms/)
  })

  it('clamps an over-long request and SAYS it clamped', async () => {
    // A silent clamp is how an agent ends up believing it waited 45 minutes.
    const tool = await createSleepTool()
    const r = await tool.call({ duration_ms: 1 }, ctx(new AbortController().signal))
    expect(r.isError).toBe(false)
    expect(String(r.content)).toContain('Slept for 1ms')
  })

  it('rejects a non-positive duration', async () => {
    const tool = await createSleepTool()
    for (const d of [0, -5, Number.NaN]) {
      const r = await tool.call({ duration_ms: d }, ctx(new AbortController().signal))
      expect(r.isError, String(d)).toBe(true)
    }
  })

  it('steers the model away from `bash("sleep …")`', async () => {
    // The behaviour that produced the bug was the model having no idea this
    // tool existed or that the shell alternative could not work.
    const tool = await createSleepTool()
    expect(tool.description).toMatch(/sleep 180/)
    expect(tool.description).toMatch(/SEPARATE tool call|SEPARATE bash call/)
  })
})

// ── The two tools must not contradict each other ─────────────────────────────

describe('bash and sleep together', () => {
  it('sleep can wait far longer than any single bash command', async () => {
    delete process.env[ENV]
    const sleep = await createSleepTool()
    expect(sleep.timeoutMs!).toBeGreaterThan(await advertisedMax())
  })

  it('bash tells the model not to wait inside a command', async () => {
    // bash's description is a ToolDescription function (it varies with the
    // available tool set), so it has to be resolved before asserting on it.
    const bash = await createBashTool()
    const text = typeof bash.description === 'function'
      ? await bash.description({ toolNames: new Set(['bash', 'sleep']) } as never)
      : bash.description
    expect(text).toMatch(/NEVER wait inside a command/)
    expect(text).toMatch(/sleep 180/)
  })
})
