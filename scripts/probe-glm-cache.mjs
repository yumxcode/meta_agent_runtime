#!/usr/bin/env node
/**
 * probe-glm-cache.mjs — A0 verification probe.
 *
 * Answers one question with real data: does the configured GLM (Zhipu) endpoint
 * give us ANY prompt-cache discount on the repeated prefix that a Graph-Agent
 * loop re-sends on every turn?
 *
 * Why it matters: src/providers/registry.ts declares
 *
 *     const CAP_ZHIPU = { …, promptCache: false }   // "rejects cache control blocks"
 *
 * If that claim is stale, every turn of every research activation is paying
 * full input price ($0.43/M) for context that could bill at cacheRead
 * ($0.043/M) — a ~10x multiplier on the dominant cost term of the whole loop.
 *
 * The probe runs three requests against the SAME long prefix:
 *
 *   A  turn 1 — long prefix, no cache_control          (establishes the baseline)
 *   B  turn 2 — same prefix + reply + short user msg   (the agent-loop pattern;
 *                                                       nonzero cache_read here
 *                                                       ⇒ automatic server-side
 *                                                       caching exists)
 *   C  turn 2 — same as B but WITH cache_control       (tests whether the
 *      {type:'ephemeral'} breakpoints                   endpoint 400s, silently
 *                                                       ignores, or honours them)
 *
 * Uses raw fetch, not the Anthropic SDK, so non-standard usage fields the
 * server may return (prompt_tokens_details, cached_tokens, …) are visible
 * verbatim rather than dropped by SDK typing.
 *
 * Run on a machine that has your key + network access:
 *
 *   node scripts/probe-glm-cache.mjs
 *   node scripts/probe-glm-cache.mjs --model glm-4.6
 *   node scripts/probe-glm-cache.mjs --prefix-tokens 20000
 *
 * Costs a few cents at most (max_tokens=64, ~3 requests).
 * Never prints the API key. Exit 0 = probe completed, 1 = could not run.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// ── Pricing, mirrored from src/providers/registry.ts (GLM_STD) ───────────────
const GLM_STD = { input: 0.43, output: 1.74, cacheRead: 0.043, cacheWrite: 0.43 }

// ── CLI args ─────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}
const PREFIX_TOKENS = Number(argOf('--prefix-tokens', '8000'))

// ── Config resolution (same precedence as core/modelConfigFile.ts) ───────────
function loadConfigFile() {
  const candidates = [
    join(homedir(), '.claude', 'meta-agent', 'config.json'),
    join(homedir(), '.meta-agent', 'config.json'),
  ]
  for (const p of candidates) {
    try {
      const raw = JSON.parse(readFileSync(p, 'utf8'))
      // grouped format wins over legacy flat
      const cfg = { ...raw, ...(raw.LLM ?? {}) }
      console.log(`• config file: ${p}`)
      return cfg
    } catch { /* try next */ }
  }
  console.log('• config file: none found (using env vars)')
  return {}
}

const file = loadConfigFile()
const apiKey =
  file.apiKey ?? process.env.ZHIPU_API_KEY ?? process.env.ZAI_API_KEY ?? process.env.GLM_API_KEY
const baseURL = (file.baseURL ?? 'https://open.bigmodel.cn/api/anthropic').replace(/\/+$/, '')
const model = argOf('--model', file.mainModel ?? 'glm-5.2')

if (!apiKey) {
  console.error('✗ no API key: set apiKey in config.json or export ZHIPU_API_KEY')
  process.exit(1)
}

const isBearer = /bigmodel\.cn|z\.ai/.test(baseURL)
const authHeader = isBearer ? { Authorization: `Bearer ${apiKey}` } : { 'x-api-key': apiKey }

console.log(`• model:   ${model}`)
console.log(`• baseURL: ${baseURL}`)
console.log(`• auth:    ${isBearer ? 'Authorization: Bearer' : 'x-api-key'}`)

// ── Deterministic filler ─────────────────────────────────────────────────────
// Must be byte-identical across runs (no timestamps, no randomness) or the
// cache test is meaningless. Prose-like, not a repeated single token, so the
// tokenizer behaves normally. ~4 chars/token is the working assumption.
function buildPrefix(targetTokens) {
  const words = [
    'discriminator', 'observation', 'retargeting', 'trajectory', 'kinematic', 'actuator',
    'quaternion', 'contact', 'reward', 'policy', 'expert', 'replay', 'gradient', 'penalty',
    'humanoid', 'locomotion', 'joint', 'velocity', 'torque', 'episode', 'rollout', 'critic',
  ]
  const lines = []
  let i = 0
  while (lines.join('\n').length < targetTokens * 4) {
    const line = []
    for (let k = 0; k < 12; k++) line.push(words[(i * 7 + k * 3) % words.length])
    lines.push(`[${String(i).padStart(5, '0')}] ${line.join(' ')}.`)
    i++
  }
  return lines.join('\n')
}

const PREFIX = buildPrefix(PREFIX_TOKENS)
const SYSTEM = 'You are a fixture used to measure prompt-cache behaviour. Answer in at most 5 words.'
const LONG_USER =
  `Below is a fixed reference block. Do not summarise it.\n\n<block>\n${PREFIX}\n</block>\n\n` +
  `Reply with exactly: ACK`

console.log(`• prefix:  ${PREFIX.length.toLocaleString()} chars (~${Math.round(PREFIX.length / 4).toLocaleString()} tok target ${PREFIX_TOKENS.toLocaleString()})\n`)

// ── HTTP ─────────────────────────────────────────────────────────────────────
async function call(label, body) {
  const t0 = Date.now()
  const res = await fetch(`${baseURL}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...authHeader },
    body: JSON.stringify(body),
  })
  const ms = Date.now() - t0
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = { _unparsable: text.slice(0, 500) } }
  return { label, status: res.status, ms, json }
}

const msg = (role, content) => ({ role, content })
const textBlock = (text, cacheControl) => ({
  type: 'text',
  text,
  ...(cacheControl ? { cache_control: { type: 'ephemeral' } } : {}),
})

// Runs B and C replay turn 1 verbatim then append one short turn — exactly what
// KernelLoop does on every iteration of the agent loop.
const turn2Messages = (cacheControl) => [
  msg('user', [textBlock(LONG_USER, cacheControl)]),
  msg('assistant', 'ACK'),
  msg('user', 'Reply with exactly: ACK2'),
]

const base = { model, max_tokens: 64, system: SYSTEM }

const runs = [
  ['A  turn 1, no cache_control', { ...base, messages: [msg('user', [textBlock(LONG_USER, false)])] }],
  ['B  turn 2, no cache_control', { ...base, messages: turn2Messages(false) }],
  ['C  turn 2, WITH cache_control', { ...base, messages: turn2Messages(true) }],
]

// ── Execute ──────────────────────────────────────────────────────────────────
const results = []
for (const [label, body] of runs) {
  process.stdout.write(`→ ${label} … `)
  try {
    const r = await call(label, body)
    results.push(r)
    console.log(`${r.status} in ${r.ms}ms`)
    if (r.status !== 200) {
      console.log(`   ${JSON.stringify(r.json).slice(0, 400)}`)
    }
  } catch (err) {
    console.log(`network error: ${err?.message ?? err}`)
    results.push({ label, status: 0, ms: 0, json: { _error: String(err?.message ?? err) } })
  }
}

// ── Raw usage, verbatim ──────────────────────────────────────────────────────
console.log('\n── raw usage objects (verbatim from server) ──────────────────────')
for (const r of results) {
  console.log(`\n${r.label}  [HTTP ${r.status}]`)
  console.log(JSON.stringify(r.json?.usage ?? r.json?.error ?? r.json, null, 2))
}

// ── Verdict ──────────────────────────────────────────────────────────────────
const u = (r) => r?.json?.usage ?? {}
const num = (v) => (typeof v === 'number' ? v : 0)
// Anthropic-standard names first, then fields GLM/OpenAI-compat may use instead.
const cacheRead = (r) =>
  num(u(r).cache_read_input_tokens) +
  num(u(r).cached_tokens) +
  num(u(r).prompt_tokens_details?.cached_tokens)
const cacheWrite = (r) => num(u(r).cache_creation_input_tokens)
const inputOf = (r) => num(u(r).input_tokens) + num(u(r).prompt_tokens)
const outputOf = (r) => num(u(r).output_tokens) + num(u(r).completion_tokens)

const [A, B, C] = results

console.log('\n── summary ───────────────────────────────────────────────────────')
console.log('run                            http    input   output  cacheRead  cacheWrite')
for (const r of results) {
  console.log(
    `${r.label.padEnd(30)} ${String(r.status).padStart(4)} ${String(inputOf(r)).padStart(8)} ` +
    `${String(outputOf(r)).padStart(8)} ${String(cacheRead(r)).padStart(10)} ${String(cacheWrite(r)).padStart(11)}`,
  )
}

console.log('\n── verdict ───────────────────────────────────────────────────────')

if (A?.status !== 200 || B?.status !== 200) {
  console.log(
    `1. AUTOMATIC server-side caching: UNKNOWN — run A/B did not return 200, so there is\n` +
    `   no baseline to compare. Fix connectivity/credentials and re-run before concluding.`,
  )
} else if (cacheRead(B) > 0) {
  console.log(
    `1. AUTOMATIC server-side caching: YES — run B reported ${cacheRead(B).toLocaleString()} cached input tokens\n` +
    `   without us sending any cache_control. The repeated prefix IS being discounted.`,
  )
} else {
  console.log(
    `1. AUTOMATIC server-side caching: NO — run B reported 0 cached tokens while re-sending\n` +
    `   an identical ${inputOf(A).toLocaleString()}-token prefix. Every turn pays full input price.`,
  )
}

if (!C || C.status === 0) {
  console.log('2. cache_control accepted: UNKNOWN — run C did not complete.')
} else if (C.status >= 400) {
  console.log(
    `2. cache_control accepted: NO — run C returned HTTP ${C.status}.\n` +
    `   registry.ts CAP_ZHIPU.promptCache = false is CORRECT; leave it alone.`,
  )
} else if (cacheRead(C) > 0 || cacheWrite(C) > 0) {
  console.log(
    `2. cache_control accepted: YES AND HONOURED — HTTP 200, cacheRead=${cacheRead(C).toLocaleString()},\n` +
    `   cacheWrite=${cacheWrite(C).toLocaleString()}. registry.ts CAP_ZHIPU.promptCache = false is STALE.\n` +
    `   ⇒ Flipping it to true is the single highest-ROI change available.`,
  )
} else {
  console.log(
    `2. cache_control accepted: TOLERATED BUT IGNORED — HTTP 200 with zero cache counters.\n` +
    `   Sending it is harmless but buys nothing; promptCache = false is effectively correct.`,
  )
}

// Cost implication, using this repo's own GLM_STD table.
if (A?.status === 200) {
  const ctx = inputOf(A)
  const N = 40 // a typical research activation in the AMP sample ran 26–72 turns
  const full = (ctx * N * GLM_STD.input) / 1e6
  const cached = (ctx * GLM_STD.input + ctx * (N - 1) * GLM_STD.cacheRead) / 1e6
  console.log(
    `\n3. Cost implication at this prefix size (${ctx.toLocaleString()} tok), ${N}-turn activation:\n` +
    `   no cache : $${full.toFixed(4)}\n` +
    `   cached   : $${cached.toFixed(4)}   (${(full / cached).toFixed(1)}x cheaper)\n` +
    `   Real research activations carry far more than this fixture; scale accordingly.`,
  )
}

console.log(
  '\nNext: paste this output back into the audit thread. It decides whether A1/A2\n' +
  '(compaction cap + fresh_per_activation lane) is the whole fix, or whether flipping\n' +
  'CAP_ZHIPU.promptCache comes first.',
)
