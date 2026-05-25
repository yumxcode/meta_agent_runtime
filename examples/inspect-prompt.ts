/**
 * inspect-prompt.ts — 全链路 Prompt 检视工具
 *
 * 分层打印系统 prompt 的每一个组成部分，帮助验证：
 *   • 静态区 S1-S10 是否正确构建
 *   • 动态区 D1-D10 各 section 是否按预期解析
 *   • Memory 系统是否正常加载并按 query 召回相关 topic
 *   • 最终送入 API 的完整 prompt 是什么
 *
 * 运行模式：
 *   # 离线 —— 直接检视 prompt（无需 API Key，仅打印不发送）
 *   tsx examples/inspect-prompt.ts
 *
 *   # 在线 —— 通过 Mock Server 完整走一遍 submit() 后打印
 *   INSPECT_LIVE=1 tsx examples/inspect-prompt.ts
 *
 *   # 真实 API（DeepSeek）
 *   DEEPSEEK_API_KEY=sk-xxx INSPECT_LIVE=1 tsx examples/inspect-prompt.ts
 *
 * Run from the package root:
 *   cd packages/meta-agent-runtime && npx tsx examples/inspect-prompt.ts
 */

import fs from 'fs/promises'
import path from 'path'
import http from 'http'
import { randomUUID } from 'crypto'

// ── Internal modules (path imports to avoid re-export gaps) ────────────────
import { buildStaticSystemPrompt, SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '../src/core/staticPrompt.js'
import {
  buildMemoryGuidanceSection,
  buildMemoryContentSection,
  buildEnvInfoSection,
  buildLanguageSection,
  buildCurrentModeSection,
  buildMcpInstructionsSection,
  buildOutputStyleSection,
  buildSummarizeToolResultsSection,
} from '../src/core/dynamicPrompt.js'
import { SectionRegistry } from '../src/core/systemPromptSections.js'
import { MetaAgentSession } from '../src/index.js'
import { MEMORY_DIR, getMemoryEntrypoint } from '../src/core/memory/paths.js'
import { ensureMemoryDirExists } from '../src/core/memory/memdir.js'

// ── Display helpers ────────────────────────────────────────────────────────

const BOLD   = '\x1b[1m'
const CYAN   = '\x1b[36m'
const GREEN  = '\x1b[32m'
const YELLOW = '\x1b[33m'
const DIM    = '\x1b[2m'
const RESET  = '\x1b[0m'
const RED    = '\x1b[31m'

function banner(text: string): void {
  const line = '═'.repeat(72)
  console.log(`\n${BOLD}${CYAN}${line}`)
  console.log(`  ${text}`)
  console.log(`${line}${RESET}\n`)
}

function sectionHeader(label: string, name: string): void {
  console.log(`${BOLD}${GREEN}┌─ ${label}  ${DIM}(${name})${RESET}`)
}

function sectionBody(text: string | null): void {
  if (text === null || text.trim() === '') {
    console.log(`${DIM}│  (empty — section skipped)${RESET}`)
  } else {
    const lines = text.split('\n')
    for (const line of lines) {
      console.log(`${DIM}│${RESET}  ${line}`)
    }
  }
  console.log(`${DIM}└${'─'.repeat(70)}${RESET}\n`)
}

function stat(label: string, value: string | number): void {
  console.log(`  ${YELLOW}${label}:${RESET}  ${value}`)
}

/** Rough token estimate: ~4 chars per token (English average). */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

// ── Phase 1 — Static zone (S1-S10) ────────────────────────────────────────

async function inspectStaticZone(): Promise<string> {
  banner('STATIC ZONE  ·  S1 – S10  (cache-stable across all sessions)')

  const staticPrompt = buildStaticSystemPrompt()

  // Section boundaries are identified by the pattern used in staticPrompt.ts:
  // each section begins with a comment like:
  //   // ── S1 — Identity Definition ...
  // We reconstruct a rough split by looking for "## " headers in the text.
  // For accurate per-section stats we just print the full static prompt with
  // char + token count, then note that individual S* sections are visible inside.

  sectionHeader('S1-S10 (full static zone)', 'buildStaticSystemPrompt()')
  sectionBody(staticPrompt)

  stat('Static zone chars',  staticPrompt.length.toLocaleString())
  stat('Static zone ~tokens', estimateTokens(staticPrompt).toLocaleString())
  console.log()

  return staticPrompt
}

// ── Phase 2 — Dynamic zone (D1-D10) ────────────────────────────────────────

async function inspectDynamicZone(query: string): Promise<string> {
  banner(`DYNAMIC ZONE  ·  D1 – D10  (agentic mode, query: "${query}")`)

  const sessionId     = randomUUID()
  const sessionStartMs = Date.now()
  const registry      = new SectionRegistry()

  // Build each section individually so we can print them with labels.
  const sections: Array<{ label: string; name: string; section: ReturnType<typeof buildMemoryGuidanceSection> }> = [
    { label: 'D1a  Memory Guidance',       name: 'memory_guidance',        section: buildMemoryGuidanceSection() },
    { label: 'D1b  Memory Content',        name: 'memory_content',         section: buildMemoryContentSection(query) },
    { label: 'D2   Environment Info',      name: 'env_info',               section: buildEnvInfoSection(sessionId, sessionStartMs, []) },
    { label: 'D3   Language',              name: 'language',               section: buildLanguageSection(undefined) },
    { label: 'D4   Current Mode',          name: 'current_mode',           section: buildCurrentModeSection('agentic') },
    { label: 'D5   MCP Instructions',      name: 'mcp_instructions',       section: buildMcpInstructionsSection(undefined) },
    { label: 'D6   Output Style',          name: 'output_style',           section: buildOutputStyleSection(undefined) },
    { label: 'D7   Summarize Tool Results','name': 'summarize_tool_results', section: buildSummarizeToolResultsSection() },
  ]

  const resolvedParts: string[] = []

  for (const { label, name, section } of sections) {
    sectionHeader(label, name)
    const [text] = await registry.resolve([section])
    const resolved = text ?? null
    sectionBody(resolved)
    if (resolved) resolvedParts.push(resolved)
  }

  const dynamicPrompt = resolvedParts.join('\n\n')
  stat('Dynamic zone chars',  dynamicPrompt.length.toLocaleString())
  stat('Dynamic zone ~tokens', estimateTokens(dynamicPrompt).toLocaleString())
  console.log()

  return dynamicPrompt
}

// ── Phase 3 — Memory system demo ───────────────────────────────────────────

async function inspectMemory(query: string): Promise<void> {
  banner(`MEMORY SYSTEM  ·  dir: ${MEMORY_DIR}`)

  await ensureMemoryDirExists()
  const entrypoint = getMemoryEntrypoint()

  // Check whether MEMORY.md exists
  let indexExists = false
  try {
    await fs.access(entrypoint)
    indexExists = true
  } catch {
    /* no-op */
  }

  if (!indexExists) {
    console.log(`  ${YELLOW}ℹ  MEMORY.md not found — seeding a demo memory file…${RESET}\n`)

    // Seed a synthetic memory so the recall path can be demonstrated.
    const demoTopic = path.join(MEMORY_DIR, 'battery_soh_analysis.md')
    await fs.writeFile(
      entrypoint,
      [
        '# Meta-Agent Memory Index',
        '',
        '## Topic files',
        '- battery_soh_analysis.md — SOH degradation model parameters for NMC cells',
      ].join('\n'),
      'utf8',
    )
    await fs.writeFile(
      demoTopic,
      [
        '---',
        'name: Battery SOH Analysis',
        'filename: battery_soh_analysis.md',
        'type: domain_knowledge',
        'date: 2025-01-01',
        '---',
        '',
        '# Battery SOH Analysis',
        '',
        'Capacity fade model for NMC 811 cells at 25°C:',
        '  SOH(n) = 1 - k₁·n^0.5 - k₂·n',
        'where k₁ = 2.1e-4 and k₂ = 3.8e-6 (empirical fit, prov-abc123)',
        '',
        'Safe operating bounds: SOH > 0.80 before EOLT flag.',
      ].join('\n'),
      'utf8',
    )
    console.log(`  ✅  Seeded: MEMORY.md + battery_soh_analysis.md`)
    console.log()
  }

  // Now resolve D1b with the given query and print what got recalled.
  const reg     = new SectionRegistry()
  const section = buildMemoryContentSection(query)
  const [content] = await reg.resolve([section])

  sectionHeader('D1b  Memory Content (resolved for query)', 'memory_content')
  sectionBody(content ?? null)
}

// ── Phase 4 — Full assembled prompt via submit() + mock server ────────────

/**
 * Minimal Anthropic SSE mock server: returns a single text turn "OK".
 * This lets us call submit() without a real API key and then read
 * getLastSystemPrompt() to see the full assembled prompt.
 */
function startMockServer(): Promise<{ port: number; server: http.Server }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (chunk: Buffer) => { body += chunk.toString() })
      req.on('end', () => {
        // Minimal Anthropic SSE response
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
        })

        const write = (event: string, data: object) =>
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)

        write('message_start', {
          type: 'message_start',
          message: { id: 'msg_mock', type: 'message', role: 'assistant', content: [], model: 'mock', stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } },
        })
        write('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
        write('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Prompt inspection OK.' } })
        write('content_block_stop', { type: 'content_block_stop', index: 0 })
        write('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } })
        write('message_stop', { type: 'message_stop' })
        res.end()
      })
    })

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number }
      resolve({ port: addr.port, server })
    })
    server.on('error', reject)
  })
}

async function inspectViaSubmit(query: string): Promise<void> {
  banner('FULL ASSEMBLED PROMPT  ·  via MetaAgentSession.submit() + mock server')

  // Check for live API
  const deepseekKey  = process.env['DEEPSEEK_API_KEY']
  const anthropicKey = process.env['ANTHROPIC_API_KEY']

  let apiKey:  string
  let baseURL: string | undefined

  if (deepseekKey) {
    apiKey  = deepseekKey
    baseURL = 'https://api.deepseek.com/anthropic'
    console.log(`  ${GREEN}Using DeepSeek API (live)${RESET}\n`)
  } else if (anthropicKey) {
    apiKey  = anthropicKey
    baseURL = undefined
    console.log(`  ${GREEN}Using Anthropic API (live)${RESET}\n`)
  } else {
    // Start mock server
    const { port, server } = await startMockServer()
    apiKey  = 'mock-key'
    baseURL = `http://127.0.0.1:${port}`
    console.log(`  ${YELLOW}No API key found — using mock server at ${baseURL}${RESET}\n`)

    // Build session pointing at mock
    const session = new MetaAgentSession({ apiKey, baseURL, model: 'claude-opus-4-6', maxTurns: 1 })

    // Drain the generator
    for await (const _ of session.submit(query, 'agentic')) { /* no-op */ }

    const assembled = session.getLastSystemPrompt()
    server.close()

    printAssembledPrompt(assembled, query)
    return
  }

  // Live API path
  const session = new MetaAgentSession({
    apiKey,
    ...(baseURL ? { baseURL } : {}),
    maxTurns: 1,
  })

  for await (const _ of session.submit(query, 'agentic')) { /* no-op */ }

  const assembled = session.getLastSystemPrompt()
  printAssembledPrompt(assembled, query)
}

function printAssembledPrompt(assembled: string | null, query: string): void {
  if (!assembled) {
    console.log(`${RED}  ✗  getLastSystemPrompt() returned null — submit() was not called?${RESET}`)
    return
  }

  // Split at the boundary marker
  const boundaryIdx = assembled.indexOf('<!-- SYSTEM_PROMPT_DYNAMIC_BOUNDARY -->')
  if (boundaryIdx === -1) {
    console.log(`${YELLOW}  ⚠  BOUNDARY marker not found (custom system prompt mode)${RESET}\n`)
    sectionHeader('Full system prompt', 'assembled')
    sectionBody(assembled)
  } else {
    const staticPart  = assembled.slice(0, boundaryIdx).trim()
    const dynamicPart = assembled.slice(boundaryIdx + '<!-- SYSTEM_PROMPT_DYNAMIC_BOUNDARY -->'.length).trim()

    sectionHeader('Static zone (S1-S10)', 'buildStaticSystemPrompt()')
    sectionBody(staticPart)

    console.log(`  ${YELLOW}── SYSTEM_PROMPT_DYNAMIC_BOUNDARY ───────────────────────────────────${RESET}\n`)

    sectionHeader(`Dynamic zone (D1-D10, query="${query}")`, 'buildDynamicSections()')
    sectionBody(dynamicPart)
  }

  console.log()
  stat('Total chars',    assembled.length.toLocaleString())
  stat('Total ~tokens',  estimateTokens(assembled).toLocaleString())
  stat('Static chars',  assembled.indexOf('<!-- SYSTEM_PROMPT_DYNAMIC_BOUNDARY -->') > -1
    ? assembled.slice(0, assembled.indexOf('<!-- SYSTEM_PROMPT_DYNAMIC_BOUNDARY -->')).length.toLocaleString()
    : 'N/A (custom prompt)')
  console.log()
}

// ── Main ───────────────────────────────────────────────────────────────────

const QUERY = process.env['INSPECT_QUERY'] ?? 'Analyse the SOH degradation for my battery cell.'
const LIVE  = process.env['INSPECT_LIVE']  === '1'

banner('META-AGENT  PROMPT  INSPECTOR')
console.log(`  Query: "${QUERY}"`)
console.log(`  Mode:  ${LIVE ? 'live submit()' : 'offline (static + dynamic sections only)'}`)
console.log()

await inspectStaticZone()
await inspectMemory(QUERY)
await inspectDynamicZone(QUERY)

if (LIVE) {
  await inspectViaSubmit(QUERY)
} else {
  banner('FULL ASSEMBLED PROMPT  ·  (offline preview)')
  const staticPrompt  = buildStaticSystemPrompt()
  const sessionId     = randomUUID()
  const sessionStartMs = Date.now()
  const registry      = new SectionRegistry()

  const dynamicSections = [
    buildMemoryGuidanceSection(),
    buildMemoryContentSection(QUERY),
    buildEnvInfoSection(sessionId, sessionStartMs, []),
    buildLanguageSection(undefined),
    buildCurrentModeSection('agentic'),
    buildMcpInstructionsSection(undefined),
    buildOutputStyleSection(undefined),
    buildSummarizeToolResultsSection(),
  ]

  const dynamicParts: string[] = []
  for (const s of dynamicSections) {
    const [text] = await registry.resolve([s])
    if (text) dynamicParts.push(text)
  }
  const dynamicPrompt = dynamicParts.join('\n\n')

  const assembled = staticPrompt + SYSTEM_PROMPT_DYNAMIC_BOUNDARY + dynamicPrompt
  printAssembledPrompt(assembled, QUERY)

  console.log(`  ${DIM}Tip: set INSPECT_LIVE=1 to call submit() against a mock/real API and verify the prompt reaches the model.${RESET}`)
  console.log()
}

banner('DONE')
