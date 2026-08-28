#!/usr/bin/env node
/**
 * probe-vision — measure what each provider actually does with an image.
 *
 * Three things the published docs cannot settle, in order of how much they
 * matter to the runtime:
 *
 *   1. Does Zhipu's ANTHROPIC-COMPAT endpoint (/api/anthropic) accept an
 *      `image` block? Their image documentation only covers the OpenAI-style
 *      `image_url` block on /paas/v4, but this runtime speaks the Anthropic
 *      wire format to Zhipu. If the answer is no, `providers/registry.ts` has
 *      to route vision-capable GLM models to the openai protocol — a change
 *      that belongs in the registry, not at any call site.
 *
 *   2. Does deepseek-*-vision-* support tool_calls? The agentic loop depends on
 *      tool calling. A vision model without it can only serve as a flash-side
 *      model, never as the main one, and the registry entry should say so.
 *
 *   3. What does an image actually cost? `VisionLimits.imageTokenCeiling` feeds
 *      both the compaction threshold and the cost ledger. DeepSeek publishes
 *      384; GLM publishes nothing and currently carries a guess of 1600.
 *
 * Usage:
 *   ZHIPU_API_KEY=... DEEPSEEK_API_KEY=... node scripts/probe-vision.mjs
 *
 * Nothing here is wired into the build or the test suite: it makes real,
 * billable API calls. Run it deliberately, then fold the findings into the
 * registry the way the prompt-cache probe's results were folded in.
 */

// A 1×1 red PNG. Small enough that the token figures reported back are almost
// entirely the per-image floor, which is exactly the number we want to read.
const RED_DOT_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const PROMPT = 'Reply with exactly one word: the dominant colour of this image.'

function ok(label, detail = '') {
  console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`)
}
function bad(label, detail = '') {
  console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`)
}
function skip(label) {
  console.log(`  \x1b[90m·\x1b[0m ${label} (skipped: no API key)`)
}

function usageOf(json) {
  const u = json?.usage ?? {}
  const input = u.input_tokens ?? u.prompt_tokens
  const output = u.output_tokens ?? u.completion_tokens
  return input !== undefined ? `input=${input} output=${output ?? '?'}` : ''
}

async function post(url, headers, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { /* keep the raw text */ }
  return { status: res.status, json, text }
}

// ── 1. Zhipu, Anthropic-compat endpoint ──────────────────────────────────────

async function probeZhipuAnthropic(key) {
  const base = 'https://open.bigmodel.cn/api/anthropic/v1/messages'
  const headers = { authorization: `Bearer ${key}`, 'anthropic-version': '2023-06-01' }

  for (const [label, source] of [
    ['base64 source', { type: 'base64', media_type: 'image/png', data: RED_DOT_PNG }],
    ['url source', { type: 'url', url: 'https://www.gstatic.com/webp/gallery/1.png' }],
  ]) {
    const { status, json, text } = await post(base, headers, {
      model: 'glm-5.3-flash',
      max_tokens: 64,
      messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT }, { type: 'image', source }] }],
    })
    if (status === 200) {
      ok(`glm-5.3-flash /api/anthropic ${label}`, usageOf(json))
    } else {
      bad(`glm-5.3-flash /api/anthropic ${label}`, `HTTP ${status}: ${(json?.error?.message ?? text).slice(0, 200)}`)
    }
  }
}

// ── 2. Zhipu, OpenAI endpoint — the documented path, as a control ────────────

async function probeZhipuOpenAI(key) {
  const { status, json, text } = await post(
    'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    { authorization: `Bearer ${key}` },
    {
      model: 'glm-5.3-flash',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: PROMPT },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${RED_DOT_PNG}` } },
        ],
      }],
    },
  )
  if (status === 200) ok('glm-5.3-flash /paas/v4 image_url', usageOf(json))
  else bad('glm-5.3-flash /paas/v4 image_url', `HTTP ${status}: ${(json?.error?.message ?? text).slice(0, 200)}`)
}

// ── 3. DeepSeek vision: images, then tool calling ────────────────────────────

async function probeDeepSeek(key) {
  const url = 'https://api.deepseek.com/chat/completions'
  const headers = { authorization: `Bearer ${key}` }
  const model = 'deepseek-v4-flash-vision-exp'

  const image = await post(url, headers, {
    model,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: PROMPT },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${RED_DOT_PNG}` } },
      ],
    }],
  })
  if (image.status === 200) ok(`${model} image_url`, usageOf(image.json))
  else bad(`${model} image_url`, `HTTP ${image.status}: ${(image.json?.error?.message ?? image.text).slice(0, 200)}`)

  // Tool calling decides whether this model can ever be the MAIN model.
  const tools = await post(url, headers, {
    model,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'Call describe_image with one word for the dominant colour.' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${RED_DOT_PNG}` } },
      ],
    }],
    tools: [{
      type: 'function',
      function: {
        name: 'describe_image',
        description: 'Record a one-word description of an image.',
        parameters: {
          type: 'object',
          properties: { colour: { type: 'string' } },
          required: ['colour'],
          additionalProperties: false,
        },
      },
    }],
  })
  if (tools.status === 200) {
    const called = tools.json?.choices?.[0]?.message?.tool_calls?.length > 0
    if (called) ok(`${model} tool_calls with an image`, 'usable as the main model')
    else bad(`${model} tool_calls with an image`, 'HTTP 200 but no tool_call — flash-side use only')
  } else {
    bad(`${model} tool_calls`, `HTTP ${tools.status}: ${(tools.json?.error?.message ?? tools.text).slice(0, 200)}`)
  }

  // The negative control: the registry claims non-vision DeepSeek models reject
  // images outright. If that stops being true, the family rule can be relaxed.
  const nonVision = await post(url, headers, {
    model: 'deepseek-v4-flash',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: PROMPT },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${RED_DOT_PNG}` } },
      ],
    }],
  })
  if (nonVision.status === 400) ok('deepseek-v4-flash rejects images (as the registry assumes)')
  else bad('deepseek-v4-flash rejects images', `got HTTP ${nonVision.status} — the family rule may be too strict`)
}

// ── Runner ───────────────────────────────────────────────────────────────────

const zhipuKey = process.env.ZHIPU_API_KEY ?? process.env.ZAI_API_KEY ?? process.env.GLM_API_KEY
const deepseekKey = process.env.DEEPSEEK_API_KEY

console.log('\nvision capability probe — real API calls, billable\n')

console.log('Zhipu (the open question: does /api/anthropic take image blocks?)')
if (zhipuKey) {
  await probeZhipuAnthropic(zhipuKey)
  await probeZhipuOpenAI(zhipuKey)
} else {
  skip('Zhipu')
}

console.log('\nDeepSeek')
if (deepseekKey) await probeDeepSeek(deepseekKey)
else skip('DeepSeek')

console.log(`
Reading the results:
  • Zhipu /api/anthropic OK          → registry needs no change; GLM vision works today.
  • Zhipu /api/anthropic 4xx but
    /paas/v4 OK                      → route vision-capable GLM models to the
                                       'openai' protocol in providers/registry.ts.
  • DeepSeek tool_calls absent       → keep deepseek-*-vision-* out of models.default.
  • input_tokens for the 1×1 dot     → the per-image floor; set VisionLimits.imageTokenCeiling.
`)
