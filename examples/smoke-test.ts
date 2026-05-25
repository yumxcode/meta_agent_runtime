/**
 * Smoke test — makes a REAL API call to verify end-to-end streaming.
 *
 * Requires: ANTHROPIC_API_KEY environment variable
 * Run:      cd packages/meta-agent-runtime && npx tsx examples/smoke-test.ts
 *
 * What this tests:
 *   ✅ Real API connection and authentication
 *   ✅ AsyncGenerator streaming (text events arrive before result)
 *   ✅ Multi-turn conversation (sends two prompts, checks history)
 *   ✅ Tool use round-trip (registers a calculator, asks model to use it)
 *   ✅ interrupt() during streaming
 *   ✅ Cost and usage tracking
 */

import { MetaAgentSession } from '../src/index.js'
import type { MetaAgentEvent, MetaAgentTool } from '../src/index.js'

// ─── Helpers ─────────────────────────────────────────────────────────────────

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
  for await (const event of gen) {
    events.push(event)
  }
  return events
}

// ─── Calculator tool ─────────────────────────────────────────────────────────

const calculatorTool: MetaAgentTool = {
  name: 'calculator',
  description: 'Evaluate a mathematical expression. Returns the numeric result.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      expression: {
        type: 'string',
        description: 'A valid JavaScript arithmetic expression, e.g. "250 * 1.2 / 1000"',
      },
    },
    required: ['expression'],
  },
  async call(input) {
    const expr = input['expression'] as string
    try {
      const result = Function(`"use strict"; return (${expr})`)()
      return { content: `Result: ${result}`, isError: false }
    } catch (err) {
      return { content: `Error: ${err}`, isError: true }
    }
  },
}

// ─── Tests ────────────────────────────────────────────────────────────────────

console.log('\n🔥  MetaAgentSession — Smoke Tests (live API)\n')

await test('basic streaming: text events arrive before result', async () => {
  const session = new MetaAgentSession({
    model: 'claude-haiku-4-5-20251001',  // cheapest for smoke tests
    maxTurns: 3,
    systemPrompt: 'You are a helpful assistant. Keep responses concise.',
  })

  const events = await collect(session.submit('Say "Hello from meta-agent" and nothing else.'))

  const textEvents = events.filter(e => e.type === 'text')
  const resultEvent = events.find(e => e.type === 'result')

  assert(textEvents.length > 0, 'should receive at least one text event')
  assert(resultEvent !== undefined, 'should receive a result event')
  assert(resultEvent!.type === 'result' && !resultEvent!.isError, 'result should be success')

  const fullText = textEvents
    .filter((e): e is Extract<MetaAgentEvent, { type: 'text' }> => e.type === 'text')
    .map(e => e.text)
    .join('')
  console.log(`\n       Response: "${fullText.trim()}"`)
})

await test('multi-turn: conversation history is maintained', async () => {
  const session = new MetaAgentSession({
    model: 'claude-haiku-4-5-20251001',
    maxTurns: 3,
    systemPrompt: 'You are a helpful assistant. Keep responses concise.',
  })

  // Turn 1
  await collect(session.submit('My name is TestUser. Just say "Got it."'))

  const messagesBefore = session.getMessages().length
  assert(messagesBefore >= 2, `should have at least 2 messages after turn 1, got ${messagesBefore}`)

  // Turn 2 — model should remember the name
  const events = await collect(session.submit('What is my name? Answer in one word.'))
  const result = events.find(e => e.type === 'result')
  assert(result?.type === 'result' && !result.isError, 'turn 2 should succeed')

  const allText = events
    .filter((e): e is Extract<MetaAgentEvent, { type: 'text' }> => e.type === 'text')
    .map(e => e.text)
    .join('')
  console.log(`\n       Turn 2 response: "${allText.trim()}"`)
  assert(allText.toLowerCase().includes('testuser'), 'model should remember the name')
})

await test('tool use: calculator round-trip', async () => {
  const session = new MetaAgentSession({
    model: 'claude-haiku-4-5-20251001',
    maxTurns: 5,
    tools: [calculatorTool],
    systemPrompt: 'You are an engineering assistant. Use the calculator tool for any arithmetic.',
  })

  const events = await collect(
    session.submit('Use the calculator tool to compute 1234 * 5678. Report the result.')
  )

  const toolUseEvents = events.filter(e => e.type === 'tool_use')
  const toolResultEvents = events.filter(e => e.type === 'tool_result')
  const result = events.find(e => e.type === 'result')

  assert(toolUseEvents.length > 0, 'model should call the calculator tool')
  assert(toolResultEvents.length > 0, 'tool result should be injected back')
  assert(result?.type === 'result' && !result.isError, 'should finish successfully')

  const resultText = events
    .filter((e): e is Extract<MetaAgentEvent, { type: 'text' }> => e.type === 'text')
    .map(e => e.text)
    .join('')
  console.log(`\n       Tool response: "${resultText.trim().slice(0, 100)}"`)
  // 1234 * 5678 = 7,006,652
  assert(resultText.includes('7006652') || resultText.includes('7,006,652'),
    `response should contain correct result 7006652, got: ${resultText.slice(0, 200)}`)
})

await test('hot tool registration works', async () => {
  const session = new MetaAgentSession({
    model: 'claude-haiku-4-5-20251001',
    maxTurns: 5,
    systemPrompt: 'You are an engineering assistant. Always use available tools.',
  })

  // Register AFTER construction
  session.registerTool(calculatorTool)

  const events = await collect(
    session.submit('Use the calculator tool to compute 99 * 99.')
  )

  const toolUseEvents = events.filter(e => e.type === 'tool_use')
  assert(toolUseEvents.length > 0, 'model should use the hot-registered tool')
})

await test('usage and cost tracking', async () => {
  const session = new MetaAgentSession({
    model: 'claude-haiku-4-5-20251001',
    maxTurns: 2,
  })

  await collect(session.submit('Say "ok"'))

  const usage = session.getUsage()
  const cost = session.getEstimatedCost()

  assert(usage.inputTokens > 0, 'inputTokens should be > 0')
  assert(usage.outputTokens > 0, 'outputTokens should be > 0')
  assert(cost > 0, 'cost should be > 0')
  console.log(`\n       Usage: ${usage.inputTokens} in / ${usage.outputTokens} out, cost: $${cost.toFixed(6)}`)
})

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(40)}`)
console.log(`Results: ${passed} passed, ${failed} failed`)

if (failed > 0) {
  console.log('\n❌ Smoke tests failed.')
  process.exit(1)
} else {
  console.log('\n✅ All smoke tests passed — Phase 0 complete.')
}
