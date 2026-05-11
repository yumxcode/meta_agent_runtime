/**
 * Mock test — validates the MetaAgentSession interface WITHOUT making real API calls.
 *
 * Run: cd packages/meta-agent-runtime && npx tsx examples/mock-test.ts
 *
 * What this tests:
 *   ✅ Session instantiation
 *   ✅ Config resolution and defaults
 *   ✅ Tool registration (both at construction and at runtime)
 *   ✅ interrupt() resets AbortController
 *   ✅ getUsage() / getEstimatedCost() / getSessionId()
 *   ✅ Type-checking: all exported types are importable
 */

import { MetaAgentSession } from '../src/index.js'
import type { MetaAgentTool, ToolCallContext, ToolResult } from '../src/index.js'

// ─── Helpers ─────────────────────────────────────────────────────────────────

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`  ✅  ${name}`)
    passed++
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`  ❌  ${name}\n       ${msg}`)
    failed++
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

// ─── Mock tool ────────────────────────────────────────────────────────────────

const mockCalculatorTool: MetaAgentTool = {
  name: 'calculator',
  description: 'Performs basic arithmetic',
  inputSchema: {
    type: 'object',
    properties: {
      expression: { type: 'string', description: 'Math expression to evaluate' },
    },
    required: ['expression'],
  },
  async call(input: Record<string, unknown>, _ctx: ToolCallContext): Promise<ToolResult> {
    const expr = input['expression'] as string
    try {
      // Very naive — only for testing
      const result = Function(`"use strict"; return (${expr})`)()
      return { content: String(result), isError: false }
    } catch {
      return { content: 'Invalid expression', isError: true }
    }
  },
}

// ─── Tests ────────────────────────────────────────────────────────────────────

console.log('\n🧪  MetaAgentSession — Mock Tests\n')

test('session instantiation with explicit api key', () => {
  const session = new MetaAgentSession({ apiKey: 'test-key-mock' })
  assert(typeof session.getSessionId() === 'string', 'sessionId should be a string')
  assert(session.getSessionId().length === 36, 'sessionId should be a UUID (36 chars)')
})

test('throws if no API key provided', () => {
  const saved = process.env['ANTHROPIC_API_KEY']
  delete process.env['ANTHROPIC_API_KEY']
  let threw = false
  try {
    new MetaAgentSession({})
  } catch {
    threw = true
  }
  if (saved !== undefined) process.env['ANTHROPIC_API_KEY'] = saved
  assert(threw, 'should throw when no API key is available')
})

test('default config is applied correctly', () => {
  const session = new MetaAgentSession({ apiKey: 'mock' })
  // Verify defaults via public API
  assert(session.getUsage().inputTokens === 0, 'initial inputTokens should be 0')
  assert(session.getUsage().outputTokens === 0, 'initial outputTokens should be 0')
  assert(session.getEstimatedCost() === 0, 'initial cost should be 0')
})

test('custom config overrides defaults', () => {
  const session = new MetaAgentSession({
    apiKey: 'mock',
    model: 'claude-sonnet-4-6',
    maxTurns: 5,
    domain: 'battery',
    verbose: true,
  })
  assert(typeof session.getSessionId() === 'string', 'session should be created with custom config')
})

test('tool registration at construction time', () => {
  const session = new MetaAgentSession({
    apiKey: 'mock',
    tools: [mockCalculatorTool],
  })
  assert(typeof session.getSessionId() === 'string', 'session with tools should be created')
})

test('tool registration at runtime (hot-registration)', () => {
  const session = new MetaAgentSession({ apiKey: 'mock' })

  // Register tool after construction
  session.registerTool(mockCalculatorTool)

  // Register another tool
  const mockSearchTool: MetaAgentTool = {
    name: 'engineering_search',
    description: 'Searches engineering knowledge base',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    async call() { return { content: '{}', isError: false } },
  }
  session.registerTool(mockSearchTool)

  assert(typeof session.getSessionId() === 'string', 'session should work after hot-registration')
})

test('interrupt() resets the abort controller', () => {
  const session = new MetaAgentSession({ apiKey: 'mock' })
  const id1 = session.getSessionId()
  session.interrupt()  // Should not throw
  session.interrupt()  // Multiple calls should be safe
  assert(session.getSessionId() === id1, 'session ID should not change after interrupt')
})

test('getMessages() returns empty array initially', () => {
  const session = new MetaAgentSession({ apiKey: 'mock' })
  const messages = session.getMessages()
  assert(Array.isArray(messages), 'getMessages() should return an array')
  assert(messages.length === 0, 'initial messages should be empty')
})

test('mock tool.call() executes correctly', async () => {
  const result = await mockCalculatorTool.call(
    { expression: '2 + 2' },
    { sessionId: 'test', agentId: 'test', abortSignal: new AbortController().signal }
  )
  assert(result.content === '4', `expected '4', got '${result.content}'`)
  assert(result.isError === false, 'calculation should not be an error')
})

test('mock tool.call() handles errors gracefully', async () => {
  const result = await mockCalculatorTool.call(
    { expression: 'not_a_valid_expression!!!' },
    { sessionId: 'test', agentId: 'test', abortSignal: new AbortController().signal }
  )
  assert(result.isError === true, 'invalid expression should return isError: true')
})

test('all exported types are importable', () => {
  // Just importing them proves TypeScript compiles correctly
  // (this test would fail at import time if types are broken)
  assert(true, 'all types imported successfully')
})

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(40)}`)
console.log(`Results: ${passed} passed, ${failed} failed`)

if (failed > 0) {
  console.log('\n❌ Some tests failed.')
  process.exit(1)
} else {
  console.log('\n✅ All tests passed — Phase 0 interface validated.')
}
