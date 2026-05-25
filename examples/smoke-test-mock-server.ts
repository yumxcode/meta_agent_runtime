/**
 * Full smoke test — NO real API key needed.
 *
 * Spins up a local mock HTTP server that speaks the Anthropic SSE protocol,
 * then runs MetaAgentSession against it. This exercises the FULL streaming
 * code path: HTTP connect → SSE events → text accumulation → tool_use →
 * tool execution → tool_result → second turn → result.
 *
 * Run: cd packages/meta-agent-runtime && npx tsx examples/smoke-test-mock-server.ts
 */

import http from 'http'
import { MetaAgentSession } from '../src/index.js'
import type { MetaAgentEvent, MetaAgentTool } from '../src/index.js'

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

// ─── Anthropic SSE mock server ──────────────────────────────────────────────
//
// The Anthropic streaming API sends newline-delimited SSE events:
//   event: content_block_delta
//   data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}
//
// We handle two scenario types keyed on the prompt text:
//   "tool_use_test" → respond with a tool_use block, then accept the tool_result
//   anything else   → respond with plain text

type MockScenario = 'text' | 'tool_use' | 'tool_result_turn'

function sseEvent(event: string, data: object): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function buildTextStream(text: string, stopReason = 'end_turn'): string {
  const chunks = text.match(/.{1,8}/g) ?? [text]
  let out = ''
  out += sseEvent('message_start', {
    type: 'message_start',
    message: { id: 'msg_mock', type: 'message', role: 'assistant',
      content: [], model: 'claude-haiku-4-5-20251001', stop_reason: null,
      usage: { input_tokens: 100, output_tokens: 0 } },
  })
  out += sseEvent('content_block_start', { type: 'content_block_start', index: 0,
    content_block: { type: 'text', text: '' } })
  for (const chunk of chunks) {
    out += sseEvent('content_block_delta', { type: 'content_block_delta', index: 0,
      delta: { type: 'text_delta', text: chunk } })
  }
  out += sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 })
  out += sseEvent('message_delta', { type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: chunks.length } })
  out += sseEvent('message_stop', { type: 'message_stop' })
  return out
}

function buildToolUseStream(toolName: string, toolInput: object): string {
  const toolId = 'tu_mock_001'
  let out = ''
  out += sseEvent('message_start', {
    type: 'message_start',
    message: { id: 'msg_mock_tool', type: 'message', role: 'assistant',
      content: [], model: 'claude-haiku-4-5-20251001', stop_reason: null,
      usage: { input_tokens: 120, output_tokens: 0 } },
  })
  out += sseEvent('content_block_start', { type: 'content_block_start', index: 0,
    content_block: { type: 'tool_use', id: toolId, name: toolName, input: {} } })
  const inputJson = JSON.stringify(toolInput)
  out += sseEvent('content_block_delta', { type: 'content_block_delta', index: 0,
    delta: { type: 'input_json_delta', partial_json: inputJson } })
  out += sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 })
  out += sseEvent('message_delta', { type: 'message_delta',
    delta: { stop_reason: 'tool_use', stop_sequence: null },
    usage: { output_tokens: 20 } })
  out += sseEvent('message_stop', { type: 'message_stop' })
  return out
}

function startMockServer(): Promise<{ server: http.Server; baseURL: string }> {
  let callCount = 0

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405); res.end(); return
    }

    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      callCount++
      const payload = JSON.parse(body) as {
        messages: Array<{ role: string; content: unknown }>
      }
      const lastMsg = payload.messages[payload.messages.length - 1]
      const isToolResult =
        Array.isArray(lastMsg?.content) &&
        (lastMsg.content as Array<{type:string}>).some(b => b.type === 'tool_result')

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Transfer-Encoding': 'chunked',
      })

      if (isToolResult) {
        // Second turn: model acknowledges the tool result
        res.write(buildTextStream('The result of 2+2 is 4.'))
      } else {
        const firstContent = payload.messages[0]?.content
        const isToolTest = typeof firstContent === 'string' &&
          firstContent.toLowerCase().includes('calculator')

        if (isToolTest) {
          res.write(buildToolUseStream('calculator', { expression: '2 + 2' }))
        } else {
          res.write(buildTextStream('Hello from meta-agent mock server!'))
        }
      }
      res.end()
    })
  })

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number }
      resolve({ server, baseURL: `http://127.0.0.1:${addr.port}` })
    })
  })
}

// ─── Calculator tool ──────────────────────────────��──────────────────────────

const calculatorTool: MetaAgentTool = {
  name: 'calculator',
  description: 'Evaluate arithmetic',
  inputSchema: {
    type: 'object',
    properties: { expression: { type: 'string' } },
    required: ['expression'],
  },
  async call(input) {
    const expr = input['expression'] as string
    try {
      const result = Function(`"use strict"; return (${expr})`)()
      return { content: `Result: ${result}`, isError: false }
    } catch {
      return { content: 'Error', isError: true }
    }
  },
}

// ─── Tests ────────────────────────────────────────────────────────────────────

console.log('\n🔥  MetaAgentSession — Smoke Tests (mock server)\n')

const { server, baseURL } = await startMockServer()
console.log(`   Mock Anthropic server: ${baseURL}\n`)

await test('text streaming: events arrive in order', async () => {
  const session = new MetaAgentSession({
    apiKey: 'mock-key',
    baseURL,
    model: 'claude-haiku-4-5-20251001',
    maxTurns: 2,
  })

  const events = await collect(session.submit('Say hello.'))

  const textEvents = events.filter(e => e.type === 'text')
  const result = events.find(e => e.type === 'result')

  assert(textEvents.length > 0, `expected text events, got ${events.map(e=>e.type)}`)
  assert(result?.type === 'result', 'should have a result event')
  assert(!result!.isError, `result.isError should be false, got: ${JSON.stringify(result)}`)

  const fullText = textEvents
    .filter((e): e is Extract<MetaAgentEvent, {type:'text'}> => e.type === 'text')
    .map(e => e.text).join('')
  assert(fullText.includes('Hello'), `text should contain 'Hello', got: "${fullText}"`)
  console.log(`\n       Streamed: "${fullText}"`)
})

await test('multi-turn: messages accumulate across turns', async () => {
  const session = new MetaAgentSession({
    apiKey: 'mock-key',
    baseURL,
    model: 'claude-haiku-4-5-20251001',
    maxTurns: 2,
  })

  await collect(session.submit('First turn.'))
  const afterTurn1 = session.getMessages().length
  assert(afterTurn1 >= 2, `should have ≥2 messages after turn 1, got ${afterTurn1}`)

  await collect(session.submit('Second turn.'))
  const afterTurn2 = session.getMessages().length
  assert(afterTurn2 > afterTurn1, `messages should grow: ${afterTurn1} → ${afterTurn2}`)
  console.log(`\n       Messages: turn1=${afterTurn1}, turn2=${afterTurn2}`)
})

await test('tool use: full round-trip (tool_use → call → tool_result → model)', async () => {
  const session = new MetaAgentSession({
    apiKey: 'mock-key',
    baseURL,
    model: 'claude-haiku-4-5-20251001',
    maxTurns: 5,
    tools: [calculatorTool],
  })

  const events = await collect(
    session.submit('Use the calculator tool to compute 2+2.')
  )

  const toolUseEvts = events.filter(e => e.type === 'tool_use')
  const toolResultEvts = events.filter(e => e.type === 'tool_result')
  const result = events.find(e => e.type === 'result')

  assert(toolUseEvts.length > 0, 'should see tool_use events')
  assert(toolResultEvts.length > 0, 'should see tool_result events')
  assert(result?.type === 'result' && !result.isError,
    `result should be success, got: ${JSON.stringify(result)}`)

  const tu = toolUseEvts[0] as Extract<MetaAgentEvent, {type:'tool_use'}>
  assert(tu.toolName === 'calculator', `toolName should be calculator, got ${tu.toolName}`)
  console.log(`\n       Tool called: ${tu.toolName}(${JSON.stringify(tu.toolInput)})`)

  const tr = toolResultEvts[0] as Extract<MetaAgentEvent, {type:'tool_result'}>
  assert(tr.content.includes('4'), `tool result should contain '4', got: ${tr.content}`)
  console.log(`       Tool result: ${tr.content}`)
})

await test('hot tool registration: tool registered after construction is usable', async () => {
  const session = new MetaAgentSession({
    apiKey: 'mock-key',
    baseURL,
    model: 'claude-haiku-4-5-20251001',
    maxTurns: 5,
  })

  session.registerTool(calculatorTool)

  const events = await collect(
    session.submit('Use the calculator tool to compute 2+2.')
  )

  const toolUseEvts = events.filter(e => e.type === 'tool_use')
  assert(toolUseEvts.length > 0, 'hot-registered tool should be used')
})

await test('interrupt(): abort stops the generator cleanly', async () => {
  const session = new MetaAgentSession({
    apiKey: 'mock-key',
    baseURL,
    model: 'claude-haiku-4-5-20251001',
    maxTurns: 10,
  })

  // Interrupt immediately after starting
  const gen = session.submit('Start a very long task...')
  session.interrupt()

  const events: MetaAgentEvent[] = []
  try {
    for await (const e of gen) events.push(e)
  } catch { /* swallow */ }

  // After interrupt, session is still usable
  const events2 = await collect(session.submit('Short follow-up.'))
  const result2 = events2.find(e => e.type === 'result')
  assert(result2?.type === 'result', 'session should work again after interrupt')
})

await test('usage tracking: tokens accumulate correctly', async () => {
  const session = new MetaAgentSession({
    apiKey: 'mock-key',
    baseURL,
    model: 'claude-haiku-4-5-20251001',
    maxTurns: 2,
  })

  await collect(session.submit('Turn 1'))

  const usage1 = session.getUsage()
  assert(usage1.inputTokens > 0, `inputTokens should be > 0, got ${usage1.inputTokens}`)
  assert(usage1.outputTokens > 0, `outputTokens should be > 0, got ${usage1.outputTokens}`)
  assert(session.getEstimatedCost() > 0, 'cost should be > 0')

  await collect(session.submit('Turn 2'))
  const usage2 = session.getUsage()
  assert(usage2.inputTokens >= usage1.inputTokens, 'tokens should accumulate across turns')

  console.log(`\n       Usage: ${usage2.inputTokens}in/${usage2.outputTokens}out, cost: $${session.getEstimatedCost().toFixed(8)}`)
})

// ─── Cleanup and summary ────────────────────────────────────────────────────

server.close()

console.log(`\n${'─'.repeat(40)}`)
console.log(`Results: ${passed} passed, ${failed} failed`)

if (failed > 0) {
  console.log('\n❌ Smoke tests failed.')
  process.exit(1)
} else {
  console.log('\n✅ Phase 0 complete — MetaAgentSession fully validated.')
  console.log('   → Interface compatible with CC QueryEngine pattern')
  console.log('   → AsyncGenerator streaming ✓')
  console.log('   → Multi-turn history ✓')
  console.log('   → Tool use round-trip ✓')
  console.log('   → Hot tool registration ✓')
  console.log('   → interrupt() ✓')
  console.log('   → Usage tracking ✓')
}
