import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  loadModelConfigFile,
  setModelConfigPathsForTest,
  resetModelConfigFileCache,
} from '../modelConfigFile.js'

/**
 * Global model config file loader.
 *
 * Uses a path override so tests read a real temp file instead of the user's
 * ~/.claude/meta-agent/config.json.
 */
describe('loadModelConfigFile', () => {
  let dir: string
  let pathA: string
  let pathB: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcf-'))
    pathA = join(dir, 'a.json')
    pathB = join(dir, 'b.json')
  })
  afterEach(() => {
    setModelConfigPathsForTest(null)
    resetModelConfigFileCache()
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns {} when no file exists', () => {
    setModelConfigPathsForTest([pathA, pathB])
    expect(loadModelConfigFile()).toEqual({})
  })

  it('reads the model fields plus apiKey / baseURL', () => {
    writeFileSync(pathA, JSON.stringify({
      mainModel: 'glm-5.1',
      fallbackModel: 'glm-4.6',
      flashModel: 'glm-4.5-air',
      compactModel: 'glm-5.1',
      apiKey: 'k',
      baseURL: 'https://open.bigmodel.cn/api/anthropic',
    }))
    setModelConfigPathsForTest([pathA, pathB])
    expect(loadModelConfigFile()).toEqual({
      mainModel: 'glm-5.1',
      fallbackModel: 'glm-4.6',
      flashModel: 'glm-4.5-air',
      compactModel: 'glm-5.1',
      apiKey: 'k',
      baseURL: 'https://open.bigmodel.cn/api/anthropic',
    })
  })

  it('reads the GROUPED format ({ LLM: {...}, web_search: {...} })', () => {
    writeFileSync(pathA, JSON.stringify({
      LLM: {
        mainModel: 'glm-5.1',
        fallbackModel: 'glm-4.7',
        flashModel: 'glm-4.5-air',
        compactModel: 'glm-5.1',
        apiKey: 'k-grouped',
        baseURL: 'https://open.bigmodel.cn/api/anthropic',
      },
      web_search: {
        tavilyApiKey: 'tvly-grouped',
      },
    }))
    setModelConfigPathsForTest([pathA, pathB])
    expect(loadModelConfigFile()).toEqual({
      mainModel: 'glm-5.1',
      fallbackModel: 'glm-4.7',
      flashModel: 'glm-4.5-air',
      compactModel: 'glm-5.1',
      apiKey: 'k-grouped',
      baseURL: 'https://open.bigmodel.cn/api/anthropic',
      tavilyApiKey: 'tvly-grouped',
    })
  })

  it('grouped fields override legacy flat fields when both are present', () => {
    writeFileSync(pathA, JSON.stringify({
      mainModel: 'flat-model',
      tavilyApiKey: 'tvly-flat',
      LLM: { mainModel: 'grouped-model' },
      web_search: { tavilyApiKey: 'tvly-grouped' },
    }))
    setModelConfigPathsForTest([pathA, pathB])
    const cfg = loadModelConfigFile()
    expect(cfg.mainModel).toBe('grouped-model')
    expect(cfg.tavilyApiKey).toBe('tvly-grouped')
  })

  it('prefers the first existing candidate path', () => {
    writeFileSync(pathA, JSON.stringify({ mainModel: 'from-a' }))
    writeFileSync(pathB, JSON.stringify({ mainModel: 'from-b' }))
    setModelConfigPathsForTest([pathA, pathB])
    expect(loadModelConfigFile().mainModel).toBe('from-a')
  })

  it('falls back to the second path when the first is missing', () => {
    writeFileSync(pathB, JSON.stringify({ mainModel: 'from-b' }))
    setModelConfigPathsForTest([pathA, pathB])
    expect(loadModelConfigFile().mainModel).toBe('from-b')
  })

  it('ignores non-string / empty fields', () => {
    writeFileSync(pathA, JSON.stringify({ mainModel: 'glm-5.1', fallbackModel: 123, flashModel: '   ' }))
    setModelConfigPathsForTest([pathA, pathB])
    expect(loadModelConfigFile()).toEqual({ mainModel: 'glm-5.1' })
  })

  it('returns {} on malformed JSON without throwing', () => {
    writeFileSync(pathA, '{ not valid json')
    setModelConfigPathsForTest([pathA, pathB])
    expect(loadModelConfigFile()).toEqual({})
  })

  it('returns {} when the JSON root is not an object', () => {
    writeFileSync(pathA, JSON.stringify(['glm-5.1']))
    setModelConfigPathsForTest([pathA, pathB])
    expect(loadModelConfigFile()).toEqual({})
  })

  it('caches: a second call does not re-read a changed file', () => {
    writeFileSync(pathA, JSON.stringify({ mainModel: 'first' }))
    setModelConfigPathsForTest([pathA, pathB])
    expect(loadModelConfigFile().mainModel).toBe('first')
    writeFileSync(pathA, JSON.stringify({ mainModel: 'second' }))
    expect(loadModelConfigFile().mainModel).toBe('first') // cached
    resetModelConfigFileCache()
    expect(loadModelConfigFile().mainModel).toBe('second') // re-read
  })
})
