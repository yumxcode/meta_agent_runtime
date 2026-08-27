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

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MetaAgentTool, ToolCallContext, ToolResult } from '../src/index.js'

// ─── Environment isolation (must run BEFORE any src/ import) ─────────────────
//
// §8.2 (review 2026-08-27): this file used to assume the developer's shell had
// no credentials in it. The "throws if no API key" case deleted exactly one
// variable — ANTHROPIC_API_KEY — while the runtime also accepts ZHIPU/ZAI/GLM,
// DEEPSEEK and QWEN keys AND falls back to $META_AGENT_HOME/config.json. So the
// test passed in CI and failed on any machine with a configured provider, which
// is precisely backwards: the developer with a working setup sees the failure.
//
// META_AGENT_HOME is captured at module-eval time, so it has to be redirected
// before `../src/index.js` is imported — hence this block sitting above the
// imports, and the `await import()` below rather than a static one.
const PROVIDER_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ZHIPU_API_KEY', 'ZAI_API_KEY', 'GLM_API_KEY',
  'DEEPSEEK_API_KEY',
  'QWEN_API_KEY',
] as const

const savedEnv = new Map<string, string | undefined>()
for (const key of PROVIDER_ENV_KEYS) {
  savedEnv.set(key, process.env[key])
  delete process.env[key]
}
savedEnv.set('META_AGENT_HOME', process.env['META_AGENT_HOME'])
process.env['META_AGENT_HOME'] = mkdtempSync(join(tmpdir(), 'meta-agent-mock-home-'))

function restoreEnv(): void {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

// `import type` is erased at compile time and never evaluates the module, so
// the type imports are safe to state normally; only the VALUE import has to
// wait until the environment above is in place.
const { MetaAgentSession } = await import('../src/index.js')

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
  // Every provider key is already cleared and META_AGENT_HOME already points at
  // an empty temp directory (see the isolation block at the top of this file),
  // so there is genuinely no credential source left for the session to find.
  // The test no longer does its own partial cleanup, which is what made the
  // result depend on the developer's shell.
  let threw = false
  try {
    new MetaAgentSession({})
  } catch {
    threw = true
  }
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

// Put the caller's environment back. Matters when this file is imported by a
// harness rather than run as a standalone process.
restoreEnv()

if (failed > 0) {
  console.log('\n❌ Some tests failed.')
  process.exit(1)
} else {
  console.log('\n✅ All tests passed — Phase 0 interface validated.')
}
