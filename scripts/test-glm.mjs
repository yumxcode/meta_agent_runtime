#!/usr/bin/env node
/**
 * test-glm.mjs — live connectivity check for the configured GLM (Zhipu) provider.
 *
 * Reads ~/.claude/meta-agent/config.json (or ~/.meta-agent/config.json), falling
 * back to env vars, then makes ONE real streaming request to the main model and
 * prints the reply. Run on a machine that has your key + network access:
 *
 *   node scripts/test-glm.mjs
 *
 * Exit code 0 = success, 1 = failure (with a diagnostic message).
 */
import Anthropic from '@anthropic-ai/sdk'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

function loadConfigFile() {
  const candidates = [
    join(homedir(), '.claude', 'meta-agent', 'config.json'),
    join(homedir(), '.meta-agent', 'config.json'),
  ]
  for (const p of candidates) {
    try {
      const cfg = JSON.parse(readFileSync(p, 'utf8'))
      console.log(`• config file: ${p}`)
      return cfg
    } catch { /* try next */ }
  }
  console.log('• config file: none found (using env vars)')
  return {}
}

const file = loadConfigFile()
const apiKey  = file.apiKey  ?? process.env.ZHIPU_API_KEY ?? process.env.ZAI_API_KEY ?? process.env.GLM_API_KEY
const baseURL = file.baseURL ?? 'https://open.bigmodel.cn/api/anthropic'
const model   = file.mainModel ?? 'glm-5.1'

if (!apiKey) {
  console.error('✗ no API key: set apiKey in config.json or export ZHIPU_API_KEY')
  process.exit(1)
}

// Bearer-auth hosts (bigmodel.cn / z.ai) want Authorization: Bearer, not x-api-key.
const isBearer = /bigmodel\.cn|z\.ai/.test(baseURL)
const auth = isBearer ? { apiKey: null, authToken: apiKey } : { apiKey }

console.log(`• model:   ${model}`)
console.log(`• baseURL: ${baseURL}`)
console.log(`• auth:    ${isBearer ? 'Authorization: Bearer' : 'x-api-key'}`)
console.log('• sending one request…\n')

const client = new Anthropic({ ...auth, baseURL, maxRetries: 0 })

try {
  const t0 = Date.now()
  const stream = await client.messages.create({
    model,
    max_tokens: 128,
    stream: true,
    messages: [{ role: 'user', content: '用一句话确认你已收到消息，并说明你是哪个模型。' }],
  })
  let text = ''
  let serverModel = '(not reported)'
  for await (const ev of stream) {
    // The authoritative answer: which model the server actually served.
    if (ev.type === 'message_start' && ev.message?.model) serverModel = ev.message.model
    if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
      text += ev.delta.text
      process.stdout.write(ev.delta.text)
    }
  }
  const ms = Date.now() - t0
  console.log(`\n\n✓ Reachable. Replied in ${ms}ms, ${text.length} chars.`)
  console.log(`• server-reported model: ${serverModel}   ${/^glm/i.test(serverModel) ? '→ GLM ✓' : '→ NOT GLM ✗'}`)
  process.exit(0)
} catch (err) {
  console.error(`\n✗ request failed: ${err?.status ?? ''} ${err?.message ?? err}`)
  if (err?.error) console.error(JSON.stringify(err.error, null, 2))
  process.exit(1)
}
