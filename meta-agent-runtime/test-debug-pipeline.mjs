/**
 * test-debug-pipeline.mjs
 *
 * 端到端验证 debug 文件写入链路，从包内编译产物 .test-build/ 导入。
 * 运行：node test-debug-pipeline.mjs
 */

import { strict as assert } from 'node:assert'
import { existsSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASE = join(__dirname, '.test-build')

// ── test runner ────────────────────────────────────────────────────────────────
let passed = 0, failed = 0
async function test(name, fn) {
  try { await fn(); console.log(`  ✅  ${name}`); passed++ }
  catch (err) { console.error(`  ❌  ${name}\n      ${err.message}`); failed++ }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. resolveConfig 透传 debugMode
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[1] resolveConfig')
const { resolveConfig } = await import(`${BASE}/core/config.js`)

await test('debugMode=true 透传到 ResolvedConfig', async () => {
  const cfg = resolveConfig({ debugMode: true })
  assert.strictEqual(cfg.debugMode, true, `期望 true，得到 ${cfg.debugMode}`)
})
await test('debugMode 未设置时为 undefined', async () => {
  assert.strictEqual(resolveConfig({}).debugMode, undefined)
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. SessionRouter._cfg.debugMode — 核心 bug 修复验证
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[2] SessionRouter._cfg.debugMode  ← 修复前此项必然 FAIL')
process.env.ANTHROPIC_API_KEY = 'sk-test-dummy'
const { SessionRouter } = await import(`${BASE}/routing/SessionRouter.js`)

await test('debugMode=true 经 SessionRouter 构造后仍为 true', async () => {
  const router = new SessionRouter({ debugMode: true })
  const cfg = router['_cfg']
  assert.strictEqual(cfg.debugMode, true,
    `_cfg.debugMode=${cfg.debugMode}。` +
    `SessionRouter 构造函数解构 debugMode 后未重注入，导致丢失。`)
})
await test('debugMode 未设置时 _cfg.debugMode 不为 true', async () => {
  const router = new SessionRouter({})
  assert.ok(router['_cfg'].debugMode !== true)
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. RoboticsSession — sessionId 一致 + debugMode 透传
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[3] RoboticsSession')
const { RoboticsSession } = await import(`${BASE}/robotics/RoboticsSession.js`)

await test('outer.getSessionId() === inner.sessionId', async () => {
  const rs = new RoboticsSession({ debugMode: true })
  const outer = rs.getSessionId()
  const inner = rs['inner'].sessionId
  assert.strictEqual(outer, inner,
    `外层=${outer.slice(0,8)} 内层=${inner.slice(0,8)} 不一致`)
})
await test('inner.config.debugMode === true', async () => {
  const d = new RoboticsSession({ debugMode: true })['inner'].config.debugMode
  assert.strictEqual(d, true, `inner debugMode=${d}，期望 true`)
})
await test('未设置时 inner.config.debugMode 不为 true', async () => {
  assert.ok(new RoboticsSession({})['inner'].config.debugMode !== true)
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. MetaAgentSession._writeDebugFile 磁盘写入
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[4] _writeDebugFile 磁盘写入')
const { MetaAgentSession } = await import(`${BASE}/core/MetaAgentSession.js`)
const testSid = `test-${randomUUID()}`
const debugDir = join(homedir(), '.meta-agent', 'debug', testSid)
if (existsSync(debugDir)) rmSync(debugDir, { recursive: true })

await test('写入 turn-001-req.json 并校验内容', async () => {
  await MetaAgentSession._writeDebugFile(testSid, 1, 'req', { hello: 'world', turn: 1 })
  const file = join(debugDir, 'turn-001-req.json')
  assert.ok(existsSync(file), `文件不存在: ${file}`)
  const json = JSON.parse(await readFile(file, 'utf8'))
  assert.strictEqual(json.hello, 'world')
})
await test('写入 turn-001-res.json', async () => {
  await MetaAgentSession._writeDebugFile(testSid, 1, 'res', { stop_reason: 'end_turn' })
  assert.ok(existsSync(join(debugDir, 'turn-001-res.json')))
})
await test('文件名左补零 turn-042-req.json', async () => {
  await MetaAgentSession._writeDebugFile(testSid, 42, 'req', { turn: 42 })
  assert.ok(existsSync(join(debugDir, 'turn-042-req.json')))
})
rmSync(debugDir, { recursive: true })
console.log('    (测试目录已清理)')

// ─────────────────────────────────────────────────────────────────────────────
// 5. 完整链路：opts.debug → SessionRouter → MetaAgentSession.config
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[5] 完整配置链路')

await test('MetaAgentSession.config.debugMode 经完整链路最终为 true', async () => {
  // 模拟 makeRouter: cfg.debugMode = true
  const { mode, debugMode, ...sessionConfig } = { debugMode: true }
  // 修复后的 SessionRouter: re-inject debugMode
  const resolved = resolveConfig({ ...sessionConfig, debugMode })
  assert.strictEqual(resolved.debugMode, true, 'resolveConfig 未透传')
  // _cfgAsConfig() spread
  const session = new MetaAgentSession({ ...resolved, tools: [] })
  assert.strictEqual(session.config.debugMode, true,
    `MetaAgentSession.config.debugMode=${session.config.debugMode}`)
})

await test('完整链路 debugMode=false 时最终不为 true', async () => {
  const { mode, debugMode, ...sessionConfig } = { debugMode: false }
  const resolved = resolveConfig({ ...sessionConfig, debugMode })
  const session = new MetaAgentSession({ ...resolved, tools: [] })
  assert.ok(session.config.debugMode !== true)
})

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(56)}`)
if (failed === 0) {
  console.log(`✅  ALL ${passed} TESTS PASSED — debug 文件写入链路修复确认\n`)
  process.exit(0)
} else {
  console.log(`❌  ${failed} FAILED / ${passed} PASSED\n`)
  process.exit(1)
}
