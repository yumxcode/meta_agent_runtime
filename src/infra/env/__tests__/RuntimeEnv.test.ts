import { describe, it, expect, afterEach } from 'vitest'
import {
  RuntimeEnv,
  ENV_REGISTRY,
  readIntEnv,
  readIntEnvOr,
  readFloatEnv,
  isEnvSet,
  envEquals,
  readStringEnv,
} from '../RuntimeEnv.js'

const TOUCHED = [
  'META_AGENT_AUTOCOMPACT_PCT_OVERRIDE',
  'META_AGENT_LONG_CONTEXT_AUTOCOMPACT_THRESHOLD',
  'DISABLE_COMPACT',
  'DISABLE_AUTO_COMPACT',
  'META_AGENT_IGNORE_USER_PERMISSIONS',
  'META_AGENT_SEARCH_PROVIDER',
  'RT_ENV_TEST_INT',
  'RT_ENV_TEST_FLOAT',
  'RT_ENV_TEST_STR',
]

afterEach(() => {
  for (const k of TOUCHED) delete process.env[k]
})

describe('RuntimeEnv generic parsers', () => {
  it('readIntEnv: parses, rejects out-of-range as undefined', () => {
    process.env['RT_ENV_TEST_INT'] = '50'
    expect(readIntEnv('RT_ENV_TEST_INT', { min: 1, max: 100 })).toBe(50)
    process.env['RT_ENV_TEST_INT'] = '0'
    expect(readIntEnv('RT_ENV_TEST_INT', { min: 1 })).toBeUndefined()
    process.env['RT_ENV_TEST_INT'] = 'abc'
    expect(readIntEnv('RT_ENV_TEST_INT')).toBeUndefined()
    delete process.env['RT_ENV_TEST_INT']
    expect(readIntEnv('RT_ENV_TEST_INT')).toBeUndefined()
  })

  it('readIntEnvOr: clamps in-range, falls back on unparyable', () => {
    process.env['RT_ENV_TEST_INT'] = '999'
    expect(readIntEnvOr('RT_ENV_TEST_INT', 10, 1, 64)).toBe(64) // clamp to max
    process.env['RT_ENV_TEST_INT'] = '-5'
    expect(readIntEnvOr('RT_ENV_TEST_INT', 10, 1, 64)).toBe(1)  // clamp to min
    process.env['RT_ENV_TEST_INT'] = ''
    expect(readIntEnvOr('RT_ENV_TEST_INT', 10)).toBe(10)        // empty → fallback
  })

  it('readFloatEnv: honours gt/lte bounds', () => {
    process.env['RT_ENV_TEST_FLOAT'] = '0.5'
    expect(readFloatEnv('RT_ENV_TEST_FLOAT', { gt: 0, lte: 1 })).toBe(0.5)
    process.env['RT_ENV_TEST_FLOAT'] = '0'
    expect(readFloatEnv('RT_ENV_TEST_FLOAT', { gt: 0, lte: 1 })).toBeUndefined()
    process.env['RT_ENV_TEST_FLOAT'] = '1.5'
    expect(readFloatEnv('RT_ENV_TEST_FLOAT', { gt: 0, lte: 1 })).toBeUndefined()
  })

  it('isEnvSet / envEquals / readStringEnv', () => {
    expect(isEnvSet('RT_ENV_TEST_STR')).toBe(false)
    process.env['RT_ENV_TEST_STR'] = '  hello  '
    expect(isEnvSet('RT_ENV_TEST_STR')).toBe(true)
    expect(readStringEnv('RT_ENV_TEST_STR')).toBe('hello') // trimmed
    process.env['RT_ENV_TEST_STR'] = '   '
    expect(readStringEnv('RT_ENV_TEST_STR')).toBeUndefined() // empty after trim
    process.env['RT_ENV_TEST_STR'] = 'true'
    expect(envEquals('RT_ENV_TEST_STR', '1', 'true')).toBe(true)
    expect(envEquals('RT_ENV_TEST_STR', '1')).toBe(false)
  })
})

describe('RuntimeEnv named accessors (live reads)', () => {
  it('reflects env mutations made after import (no frozen snapshot)', () => {
    expect(RuntimeEnv.compactDisabled()).toBe(false)
    process.env['DISABLE_AUTO_COMPACT'] = '1'
    expect(RuntimeEnv.compactDisabled()).toBe(true)
  })

  it('autoCompactPctOverride enforces (0,1]', () => {
    process.env['META_AGENT_AUTOCOMPACT_PCT_OVERRIDE'] = '0.8'
    expect(RuntimeEnv.autoCompactPctOverride()).toBe(0.8)
    process.env['META_AGENT_AUTOCOMPACT_PCT_OVERRIDE'] = '2'
    expect(RuntimeEnv.autoCompactPctOverride()).toBeUndefined()
  })

  it('ignoreUserPermissions accepts 1 or true', () => {
    expect(RuntimeEnv.ignoreUserPermissions()).toBe(false)
    process.env['META_AGENT_IGNORE_USER_PERMISSIONS'] = 'true'
    expect(RuntimeEnv.ignoreUserPermissions()).toBe(true)
  })

  it('searchProviderPin lowercases and trims', () => {
    process.env['META_AGENT_SEARCH_PROVIDER'] = '  Tavily '
    expect(RuntimeEnv.searchProviderPin()).toBe('tavily')
  })

  it('longContextAutoCompactCap requires positive int', () => {
    process.env['META_AGENT_LONG_CONTEXT_AUTOCOMPACT_THRESHOLD'] = '120000'
    expect(RuntimeEnv.longContextAutoCompactCap()).toBe(120000)
    process.env['META_AGENT_LONG_CONTEXT_AUTOCOMPACT_THRESHOLD'] = '-1'
    expect(RuntimeEnv.longContextAutoCompactCap()).toBeUndefined()
  })
})

describe('ENV_REGISTRY', () => {
  it('has unique, documented entries', () => {
    const names = ENV_REGISTRY.map(e => e.name)
    expect(new Set(names).size).toBe(names.length)
    for (const e of ENV_REGISTRY) {
      expect(e.name).toMatch(/^[A-Z][A-Z0-9_]+$/)
      expect(e.description.length).toBeGreaterThan(0)
    }
  })
})
