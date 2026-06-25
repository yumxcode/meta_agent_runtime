import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  loadModelConfig,
  getValue,
  setValue,
  deleteValue,
  listValues,
  clearSessionConfig,
} from '../ConfigService.js'
import { setModelConfigPathsForTest, resetModelConfigFileCache } from '../../modelConfigFile.js'
import { createConfigTool } from '../../../tools/system/config/index.js'
import type { ToolCallContext } from '../../types.js'

describe('ConfigService — layered config (global / project / session)', () => {
  let globalDir: string
  let projectDir: string

  beforeEach(() => {
    globalDir = mkdtempSync(join(tmpdir(), 'cfg-global-'))
    projectDir = mkdtempSync(join(tmpdir(), 'cfg-project-'))
    // Pin the global layer at a temp config.json (ConfigService reads
    // modelConfigCandidatePaths()[0] for the global path).
    setModelConfigPathsForTest([join(globalDir, 'config.json')])
    clearSessionConfig()
  })
  afterEach(() => {
    setModelConfigPathsForTest(null)
    resetModelConfigFileCache()
    clearSessionConfig()
    rmSync(globalDir, { recursive: true, force: true })
    rmSync(projectDir, { recursive: true, force: true })
  })

  it('project overrides global per field; non-overridden fields inherit global', () => {
    setValue('LLM.mainModel', 'global-model', { scope: 'global' })
    setValue('LLM.flashModel', 'global-flash', { scope: 'global' })
    setValue('LLM.mainModel', 'project-model', { scope: 'project', projectDir })

    const cfg = loadModelConfig({ projectDir })
    expect(cfg.mainModel).toBe('project-model') // project wins
    expect(cfg.flashModel).toBe('global-flash') // inherited from global
  })

  it('session overrides project (highest precedence)', () => {
    setValue('LLM.mainModel', 'project-model', { scope: 'project', projectDir })
    setValue('LLM.mainModel', 'session-model', { scope: 'session' })
    expect(loadModelConfig({ projectDir }).mainModel).toBe('session-model')
    clearSessionConfig()
    expect(loadModelConfig({ projectDir }).mainModel).toBe('project-model')
  })

  it('grouped (LLM.*) wins over flat within a layer', () => {
    setValue('mainModel', 'flat', { scope: 'project', projectDir })
    setValue('LLM.mainModel', 'grouped', { scope: 'project', projectDir })
    expect(loadModelConfig({ projectDir }).mainModel).toBe('grouped')
  })

  it('get: merged effective vs single scope; delete removes from a layer', () => {
    setValue('ui.theme', 'dark', { scope: 'project', projectDir })
    expect(getValue('ui.theme', { projectDir })).toBe('dark')          // merged
    expect(getValue('ui.theme', { projectDir, scope: 'global' })).toBeUndefined()
    expect(deleteValue('ui.theme', { projectDir })).toBe(true)
    expect(getValue('ui.theme', { projectDir })).toBeUndefined()
    expect(deleteValue('ui.theme', { projectDir })).toBe(false)        // already gone
  })

  it('list returns merged config by default and a single layer when scoped', () => {
    setValue('a', 1, { scope: 'global' })
    setValue('b', 2, { scope: 'project', projectDir })
    const merged = listValues({ projectDir })
    expect(merged['a']).toBe(1)
    expect(merged['b']).toBe(2)
    const globalOnly = listValues({ projectDir, scope: 'global' })
    expect(globalOnly['a']).toBe(1)
    expect(globalOnly['b']).toBeUndefined()
  })
})

describe('config tool ↔ runtime (the disconnect is closed)', () => {
  let globalDir: string
  let projectDir: string

  beforeEach(() => {
    globalDir = mkdtempSync(join(tmpdir(), 'cfg-tg-'))
    projectDir = mkdtempSync(join(tmpdir(), 'cfg-tp-'))
    setModelConfigPathsForTest([join(globalDir, 'config.json')])
    clearSessionConfig()
  })
  afterEach(() => {
    setModelConfigPathsForTest(null)
    resetModelConfigFileCache()
    clearSessionConfig()
    rmSync(globalDir, { recursive: true, force: true })
    rmSync(projectDir, { recursive: true, force: true })
  })

  const ctx = { sessionId: 's', workspaceRoot: projectDir } as unknown as ToolCallContext

  it('config set (project, default scope) feeds loadModelConfig', async () => {
    const tool = await createConfigTool(projectDir)
    const res = await tool.call({ action: 'set', key: 'LLM.mainModel', value: 'glm-4.7' }, ctx)
    expect(res.isError).toBeFalsy()
    expect(res.content).toMatch(/next session/i) // surfaces the timing caveat
    // The runtime-read loader now sees the tool's write.
    expect(loadModelConfig({ projectDir }).mainModel).toBe('glm-4.7')
  })

  it('config get reads back the merged value', async () => {
    const tool = await createConfigTool(projectDir)
    await tool.call({ action: 'set', key: 'ui.theme', value: 'dark' }, ctx)
    const res = await tool.call({ action: 'get', key: 'ui.theme' }, ctx)
    expect(res.content).toContain('dark')
  })
})
