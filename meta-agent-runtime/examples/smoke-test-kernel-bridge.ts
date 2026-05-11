/**
 * KernelBridge smoke test — NO real API key needed.
 *
 * Spins up a local mock HTTP server that speaks the Anthropic SSE protocol,
 * then runs KernelBridge against it. Validates that the CC QueryEngine kernel
 * correctly drives the tool-use loop and translates SDKMessages to
 * MetaAgentEvents.
 *
 * Run: cd packages/meta-agent-runtime && npx tsx examples/smoke-test-kernel-bridge.ts
 */

import http from 'http'
import { KernelBridge } from '../src/index.js'
import type { MetaAgentEvent, MetaAgentTool, ToolCallContext } from '../src/index.js'

// ─── Test harness ──────────────────────────────────────────────────────────

let passed = 0
let failed = 0

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  process.stdout.write(`  ⏳  ${name}`)
  try {
    await fn()
    process.stdout.write(`\r  ✅  ${name}\n`)
    passed++
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stdout.write(`\r  ❌  ${name}\n       ${msg}\n`)
    failed++
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

async function collect(gen: AsyncGenerator<MetaAgentEvent>): Promise<MetaAgentEvent[]> {
  const events: MetaAgentEvent[] = []
  for await (const e of gen) events.push(e)
  return events
}

// ─── Anthropic SSE mock server ─────────────────────────────────────────────

function sseEvent(event: string, data: object): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function buildTextStream(text: string, stopReason = 'end_turn'): string {
  return [
    sseEvent('message_start', {
      type: 'message_start',
      message: { id: 'msg_test', type: 'message', role: 'assistant', content: [], model: 'claude-opus-4-6', stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } },
    }),
    sseEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    sseEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text } }),
    sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sseEvent('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 5 } }),
    sseEvent('message_stop', { type: 'message_stop' }),
    'data: [DONE]\n\n',
  ].join('')
}

function buildToolUseStream(toolName: string, toolInput: object, toolUseId = 'tu_001'): string {
  const inputStr = JSON.stringify(toolInput)
  return [
    sseEvent('message_start', {
      type: 'message_start',
      message: { id: 'msg_test2', type: 'message', role: 'assistant', content: [], model: 'claude-opus-4-6', stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } },
    }),
    sseEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: toolUseId, name: toolName, input: {} } }),
    sseEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: inputStr } }),
    sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sseEvent('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 15 } }),
    sseEvent('message_stop', { type: 'message_stop' }),
    'data: [DONE]\n\n',
  ].join('')
}

/** Minimal mock HTTP server for the Anthropic streaming API */
function startMockServer(handler: (body: any) => string): Promise<{ server: http.Server; baseUrl: string }> {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        let parsed: any = {}
        try { parsed = JSON.parse(body) } catch {}

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        })
        const sse = handler(parsed)
        res.end(sse)
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number }
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` })
    })
  })
}

// ─── Tests ─────────────────────────────────────────────────────────────────

async function main() {
  console.log('\nKernelBridge smoke tests\n')

  // ── Test 1: construction and basic API surface ──────────────────────────
  await test('KernelBridge constructs without error', async () => {
    const kb = new KernelBridge({ apiKey: 'test-key' })
    assert(typeof kb.getSessionId() === 'string', 'getSessionId() returns string')
    assert(kb.getSessionId().length > 0, 'sessionId is non-empty')
    assert(typeof kb.getEstimatedCost() === 'number', 'getEstimatedCost() returns number')
    const usage = kb.getUsage()
    assert(usage.inputTokens === 0, 'initial inputTokens === 0')
    assert(usage.outputTokens === 0, 'initial outputTokens === 0')
  })

  // ── Test 2: registerTool ────────────────────────────────────────────────
  await test('registerTool stores tool for use', async () => {
    const kb = new KernelBridge({ apiKey: 'test-key' })
    const echoTool: MetaAgentTool = {
      name: 'echo',
      description: 'Echoes input back',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      call: async (input: Record<string, unknown>, _ctx: ToolCallContext) => ({
        content: String(input.text ?? ''),
        isError: false,
      }),
    }
    kb.registerTool(echoTool) // should not throw
    assert(true, 'registerTool did not throw')
  })

  // ── Test 3: interrupt resets abort controller ───────────────────────────
  await test('interrupt() does not throw and resets state', async () => {
    const kb = new KernelBridge({ apiKey: 'test-key' })
    kb.interrupt() // should not throw
    assert(true, 'interrupt() completed without error')
  })

  // ── Test 4: getMessages() returns an array ──────────────────────────────
  await test('getMessages() returns array before any submit', async () => {
    const kb = new KernelBridge({ apiKey: 'test-key' })
    const msgs = kb.getMessages()
    assert(Array.isArray(msgs), 'getMessages() returns array')
  })

  // ── Test 5: full submit → text event (mock server) ──────────────────────
  const { server: textServer, baseUrl: textBase } = await startMockServer(() =>
    buildTextStream('Hello from kernel!')
  )

  await test('submit() yields text event via mock server', async () => {
    const kb = new KernelBridge({
      apiKey: 'test-key',
      baseURL: textBase,
    })

    const events = await collect(kb.submit('Say hello'))

    const textEvents = events.filter(e => e.type === 'text')
    assert(textEvents.length > 0, `expected text events, got ${events.map(e => e.type).join(', ')}`)

    const allText = (textEvents as any[]).map((e: any) => e.text).join('')
    assert(allText.includes('Hello'), `expected "Hello" in text, got "${allText}"`)

    // All events should carry sessionId
    for (const e of events) {
      if ('sessionId' in e) {
        assert(
          (e as any).sessionId === kb.getSessionId(),
          `sessionId mismatch: ${(e as any).sessionId} !== ${kb.getSessionId()}`
        )
      }
    }
  })

  textServer.close()

  // ── Test 6: submit() yields result event ───────────────────────────────
  const { server: resultServer, baseUrl: resultBase } = await startMockServer(() =>
    buildTextStream('Done.', 'end_turn')
  )

  await test('submit() yields result event at end', async () => {
    const kb = new KernelBridge({
      apiKey: 'test-key',
      baseURL: resultBase,
    })

    const events = await collect(kb.submit('Finish'))
    const resultEvents = events.filter(e => e.type === 'result')
    assert(resultEvents.length > 0, `expected result event, got: ${events.map(e => e.type).join(', ')}`)

    const result = resultEvents[0] as any
    assert(typeof result.durationMs === 'number', 'result.durationMs is number')
    assert(typeof result.numTurns === 'number', 'result.numTurns is number')
    assert(typeof result.isError === 'boolean', 'result.isError is boolean')
    assert(result.subtype !== undefined, 'result.subtype is defined')
  })

  resultServer.close()

  // ── Test 7: tool_use + tool_result round-trip ──────────────────────────
  let callCount = 0
  const { server: toolServer, baseUrl: toolBase } = await startMockServer(body => {
    const msgs: any[] = body.messages ?? []
    // If last message is tool_result, respond with text; otherwise respond with tool_use
    const lastMsg = msgs[msgs.length - 1]
    const hasToolResult = Array.isArray(lastMsg?.content) &&
      lastMsg.content.some((b: any) => b.type === 'tool_result')
    callCount++
    if (hasToolResult) {
      return buildTextStream('Echo result received.', 'end_turn')
    }
    return buildToolUseStream('echo', { text: 'ping' })
  })

  await test('submit() drives tool_use → tool_result loop', async () => {
    callCount = 0
    const kb = new KernelBridge({
      apiKey: 'test-key',
      baseURL: toolBase,
    })

    const echoTool: MetaAgentTool = {
      name: 'echo',
      description: 'Echoes text',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      call: async (input: Record<string, unknown>, _ctx: ToolCallContext) => ({
        content: `echoed: ${input.text}`,
        isError: false,
      }),
    }
    kb.registerTool(echoTool)

    const events = await collect(kb.submit('Use the echo tool'))

    const toolUseEvents = events.filter(e => e.type === 'tool_use')
    const toolResultEvents = events.filter(e => e.type === 'tool_result')
    const resultEvents = events.filter(e => e.type === 'result')

    assert(toolUseEvents.length > 0, 'expected tool_use events')
    assert(toolResultEvents.length > 0, 'expected tool_result events')
    assert(resultEvents.length > 0, 'expected final result event')
    assert(callCount >= 2, `expected >= 2 API calls (got ${callCount}) — tool loop ran`)
  })

  toolServer.close()

  // ── Test 8: usage accumulation ─────────────────────────────────────────
  const { server: usageServer, baseUrl: usageBase } = await startMockServer(() =>
    buildTextStream('Usage test.')
  )

  await test('usage is accumulated after submit()', async () => {
    const kb = new KernelBridge({
      apiKey: 'test-key',
      baseURL: usageBase,
    })
    await collect(kb.submit('Count tokens'))
    const usage = kb.getUsage()
    // Mock server sends input_tokens:10, output_tokens:5
    assert(usage.inputTokens > 0, `expected inputTokens > 0, got ${usage.inputTokens}`)
    assert(usage.outputTokens > 0, `expected outputTokens > 0, got ${usage.outputTokens}`)
  })

  usageServer.close()

  // ── Summary ─────────────────────────────────────────────────────────────
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exit(1)
}

main().catch(err => {
  console.error('Unexpected error:', err)
  process.exit(1)
})
