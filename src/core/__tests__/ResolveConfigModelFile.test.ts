import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { resolveConfig } from '../config.js'
import { setModelConfigPathsForTest, resetModelConfigFileCache } from '../modelConfigFile.js'

/**
 * resolveConfig precedence: config file > CLI/caller config > provider defaults.
 */
const PROVIDER_KEYS = [
  'ZHIPU_API_KEY', 'ZAI_API_KEY', 'GLM_API_KEY',
  'DEEPSEEK_API_KEY', 'QWEN_API_KEY', 'ANTHROPIC_API_KEY',
] as const

describe('resolveConfig — model config file', () => {
  let dir: string
  let path: string
  let saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rcm-'))
    path = join(dir, 'config.json')
    saved = {}
    for (const k of PROVIDER_KEYS) { saved[k] = process.env[k]; delete process.env[k] }
  })
  afterEach(() => {
    setModelConfigPathsForTest(null)
    resetModelConfigFileCache()
    rmSync(dir, { recursive: true, force: true })
    for (const k of PROVIDER_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it('uses provider defaults when no file and no caller overrides', () => {
    process.env['ZHIPU_API_KEY'] = 'zk'
    setModelConfigPathsForTest([path]) // missing → {}
    const r = resolveConfig({})
    expect(r.model).toBe('glm-5.2')
    expect(r.fallbackModel).toBe('glm-4.6')
    expect(r.flashModel).toBe('glm-5.2')
    expect(r.compactModel).toBe('glm-5.2')
  })

  it('config file overrides caller (CLI) model values', () => {
    process.env['ZHIPU_API_KEY'] = 'zk'
    writeFileSync(path, JSON.stringify({
      mainModel: 'glm-4.7', fallbackModel: 'glm-4.5', flashModel: 'glm-4.5-air', compactModel: 'glm-5.1',
    }))
    setModelConfigPathsForTest([path])
    const r = resolveConfig({
      model: 'cli-model',
      fallbackModel: 'cli-fallback',
      flashModel: 'cli-flash',
      compactModel: 'cli-compact',
    })
    expect(r.model).toBe('glm-4.7')
    expect(r.fallbackModel).toBe('glm-4.5')
    expect(r.flashModel).toBe('glm-4.5-air')
    expect(r.compactModel).toBe('glm-5.1')
  })

  it('compactModel falls back to flashModel when omitted', () => {
    process.env['ZHIPU_API_KEY'] = 'zk'
    writeFileSync(path, JSON.stringify({ flashModel: 'glm-4.5-air' }))
    setModelConfigPathsForTest([path])
    const r = resolveConfig({})
    expect(r.flashModel).toBe('glm-4.5-air')
    expect(r.compactModel).toBe('glm-4.5-air')
  })

  it('config file apiKey / baseURL drive provider detection', () => {
    // No env keys set; file supplies both → zhipu inferred from baseURL.
    writeFileSync(path, JSON.stringify({
      apiKey: 'file-key',
      baseURL: 'https://open.bigmodel.cn/api/anthropic',
    }))
    setModelConfigPathsForTest([path])
    const r = resolveConfig({})
    expect(r.apiKey).toBe('file-key')
    expect(r.baseURL).toBe('https://open.bigmodel.cn/api/anthropic')
    expect(r.model).toBe('glm-5.2')
  })

  it('caller value is used when the file omits that field', () => {
    process.env['ZHIPU_API_KEY'] = 'zk'
    writeFileSync(path, JSON.stringify({ mainModel: 'glm-4.7' }))
    setModelConfigPathsForTest([path])
    const r = resolveConfig({ fallbackModel: 'cli-fallback' })
    expect(r.model).toBe('glm-4.7')          // from file
    expect(r.fallbackModel).toBe('cli-fallback') // from caller (file omitted it)
  })

  it('preserves auto-series worktree-cleanup option', () => {
    process.env['ZHIPU_API_KEY'] = 'zk'
    setModelConfigPathsForTest([path])
    const r = resolveConfig({ autoWorktreeCleanup: 'safe' })
    expect(r.autoWorktreeCleanup).toBe('safe')
  })
})
