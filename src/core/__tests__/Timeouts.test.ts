/**
 * Timeout resolution: config file > env var > built-in default.
 *
 * Before this existed, no timeout was reachable from the config file at all —
 * `ModelConfigFile` was a seven-string whitelist that dropped everything else
 * silently, so `"toolMs": 60000` produced no effect and no warning.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs'
import { rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  TIMEOUT_DEFAULTS,
  TIMEOUT_FIELD_NAMES,
  parseTimeoutSection,
  resolveTimeouts,
  setTimeoutOverrides,
  resetTimeoutsForTest,
  configureTimeouts,
  flashTimeoutMs,
  timeout,
} from '../timeouts.js'
import { loadModelConfigFile, setModelConfigPathsForTest, resetModelConfigFileCache } from '../modelConfigFile.js'
import { loadTimeoutConfig, clearSessionConfig } from '../config/ConfigService.js'

const TIMEOUT_ENVS = [
  'META_AGENT_LLM_FIRST_TOKEN_TIMEOUT_MS', 'META_AGENT_LLM_IDLE_TIMEOUT_MS',
  'META_AGENT_COMPACT_TIMEOUT_MS', 'META_AGENT_FLASH_TTFT_MS',
  'META_AGENT_FLASH_TOKENS_PER_SEC', 'META_AGENT_TOOL_TIMEOUT_MS',
  'META_AGENT_MCP_TIMEOUT_MS', 'META_AGENT_MCP_STDIO_TIMEOUT_MS',
  'META_AGENT_JOB_TIMEOUT_MS', 'META_AGENT_VERIFY_MAX_DURATION_MS',
]

let saved: Record<string, string | undefined> = {}
let dirs: string[] = []

beforeEach(() => {
  saved = {}
  for (const k of TIMEOUT_ENVS) { saved[k] = process.env[k]; delete process.env[k] }
  resetTimeoutsForTest()
  resetModelConfigFileCache()
  clearSessionConfig()
})

afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v
  }
  resetTimeoutsForTest()
  setModelConfigPathsForTest(null)
  clearSessionConfig()
  await Promise.all(dirs.map(d => rm(d, { recursive: true, force: true })))
  dirs = []
})

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'to-'))
  dirs.push(d)
  return d
}

describe('defaults', () => {
  it('matches the documented values', () => {
    expect(TIMEOUT_DEFAULTS).toMatchObject({
      llmFirstTokenMs: 90_000,
      llmIdleMs: 60_000,
      compactMs: 720_000,   // 12 min
      flashTtftMs: 30_000,
      flashTokensPerSec: 20,
      toolMs: 180_000,
      mcpMs: 60_000,
      mcpStdioMs: 60_000,
      jobMs: 1_800_000,
      verifyMaxDurationMs: 1_800_000,
    })
  })

  it('resolves to the defaults with no config and no env', () => {
    expect(resolveTimeouts()).toEqual(TIMEOUT_DEFAULTS)
  })
})

describe('precedence: config file > env > default', () => {
  it('env overrides the default', () => {
    process.env['META_AGENT_LLM_IDLE_TIMEOUT_MS'] = '15000'
    expect(timeout('llmIdleMs')).toBe(15_000)
    expect(timeout('llmFirstTokenMs')).toBe(TIMEOUT_DEFAULTS.llmFirstTokenMs)
  })

  it('the config file beats the env var', () => {
    process.env['META_AGENT_LLM_IDLE_TIMEOUT_MS'] = '15000'
    setTimeoutOverrides({ llmIdleMs: 45_000 })
    expect(timeout('llmIdleMs')).toBe(45_000)
  })

  it('falls back per field, not all-or-nothing', () => {
    process.env['META_AGENT_TOOL_TIMEOUT_MS'] = '5000'
    setTimeoutOverrides({ compactMs: 300_000 })
    expect(timeout('compactMs')).toBe(300_000)                       // file
    expect(timeout('toolMs')).toBe(5_000)                            // env
    expect(timeout('mcpMs')).toBe(TIMEOUT_DEFAULTS.mcpMs)            // default
  })

  it('ignores an out-of-range env value rather than clamping it', () => {
    // `toolMs: 0` DISABLES the tool timeout, so silently clamping a bogus
    // negative into 0 would be a dangerous reinterpretation.
    process.env['META_AGENT_TOOL_TIMEOUT_MS'] = '-1'
    expect(timeout('toolMs')).toBe(TIMEOUT_DEFAULTS.toolMs)
  })
})

describe('parseTimeoutSection', () => {
  it('accepts known numeric keys', () => {
    expect(parseTimeoutSection({ timeouts: { toolMs: 1000, llmIdleMs: 2000 } }))
      .toEqual({ toolMs: 1000, llmIdleMs: 2000 })
  })

  it('rejects non-numeric, out-of-range and unknown keys', () => {
    const out = parseTimeoutSection({
      timeouts: {
        toolMs: 'sixty' as unknown as number,   // wrong type
        compactMs: 5,                            // below min (10_000)
        llmIdleMs: 30_000,                       // valid
        tooMs: 1000,                             // typo → unknown key
      },
    })
    expect(out).toEqual({ llmIdleMs: 30_000 })
  })

  it('is a no-op when the section is absent or malformed', () => {
    expect(parseTimeoutSection({})).toEqual({})
    expect(parseTimeoutSection({ timeouts: 'nope' })).toEqual({})
    expect(parseTimeoutSection({ timeouts: [1, 2] })).toEqual({})
    expect(parseTimeoutSection(null)).toEqual({})
  })

  it('covers every declared field', () => {
    const all = Object.fromEntries(TIMEOUT_FIELD_NAMES.map(f => [f, TIMEOUT_DEFAULTS[f]]))
    expect(parseTimeoutSection({ timeouts: all })).toEqual(all)
  })
})

describe('config file end to end', () => {
  it('reads a timeouts section from the global config file', () => {
    const dir = tmp()
    const p = join(dir, 'config.json')
    writeFileSync(p, JSON.stringify({ mainModel: 'glm-5.2', timeouts: { compactMs: 900_000 } }))
    setModelConfigPathsForTest([p])

    const loaded = loadModelConfigFile()
    expect(loaded.mainModel).toBe('glm-5.2')
    expect(loaded.timeouts).toEqual({ compactMs: 900_000 })

    configureTimeouts(() => loadTimeoutConfig())
    expect(timeout('compactMs')).toBe(900_000)
    expect(timeout('toolMs')).toBe(TIMEOUT_DEFAULTS.toolMs)
  })

  it('merges timeouts PER FIELD across global and project layers', () => {
    const globalDir = tmp()
    const globalPath = join(globalDir, 'config.json')
    writeFileSync(globalPath, JSON.stringify({ timeouts: { llmIdleMs: 11_000, toolMs: 22_000 } }))
    setModelConfigPathsForTest([globalPath])

    const projectDir = tmp()
    mkdirSync(join(projectDir, '.meta-agent'), { recursive: true })
    writeFileSync(
      join(projectDir, '.meta-agent', 'config.json'),
      JSON.stringify({ timeouts: { toolMs: 33_000 } }),
    )

    // Project overrides ONLY toolMs; the global llmIdleMs must survive.
    const merged = loadTimeoutConfig({ projectDir })
    expect(merged).toEqual({ llmIdleMs: 11_000, toolMs: 33_000 })
  })
})

describe('flashTimeoutMs derivation', () => {
  it('sizes the budget from maxTokens', () => {
    // 30s TTFT + tokens/20 per second, clamped to [30s, 180s].
    expect(flashTimeoutMs(1_200)).toBe(90_000)   // knowledge extraction
    expect(flashTimeoutMs(1_000)).toBe(80_000)   // principle promotion
    expect(flashTimeoutMs(120)).toBe(36_000)     // small side-calls
  })

  it('clamps both ends', () => {
    expect(flashTimeoutMs(0)).toBe(30_000)         // floor
    expect(flashTimeoutMs(1_000_000)).toBe(180_000) // ceiling
  })

  it('honours the configured rate', () => {
    setTimeoutOverrides({ flashTtftMs: 10_000, flashTokensPerSec: 100 })
    expect(flashTimeoutMs(1_000)).toBe(30_000)   // 10s + 10s → below the floor
    expect(flashTimeoutMs(10_000)).toBe(110_000) // 10s + 100s
  })

  it('previously-hardcoded 30s call sites now get more than 30s', () => {
    // The two the audit flagged as guaranteed-to-time-out at 20 tok/s.
    expect(flashTimeoutMs(1_200)).toBeGreaterThan(30_000)
    expect(flashTimeoutMs(1_000)).toBeGreaterThan(30_000)
  })
})

describe('cache behaviour', () => {
  it('re-resolves after an override change', () => {
    expect(timeout('toolMs')).toBe(TIMEOUT_DEFAULTS.toolMs)
    setTimeoutOverrides({ toolMs: 1_234 })
    expect(timeout('toolMs')).toBe(1_234)
  })

  it('reads env LIVE — a value set after the first resolve still applies', () => {
    // RuntimeEnv's contract ("accessors read process.env on each call rather
    // than snapshotting once at import") exists because tests and embedders
    // legitimately set env after module load. Caching the FINAL table broke it:
    // only the file layer may be cached.
    expect(timeout('verifyMaxDurationMs')).toBe(TIMEOUT_DEFAULTS.verifyMaxDurationMs)
    process.env['META_AGENT_VERIFY_MAX_DURATION_MS'] = '300000'
    expect(timeout('verifyMaxDurationMs')).toBe(300_000)
    delete process.env['META_AGENT_VERIFY_MAX_DURATION_MS']
    expect(timeout('verifyMaxDurationMs')).toBe(TIMEOUT_DEFAULTS.verifyMaxDurationMs)
  })

  it('caches the FILE layer — the loader is not re-invoked per read', () => {
    let calls = 0
    configureTimeouts(() => { calls++; return { toolMs: 7_000 } })
    expect(timeout('toolMs')).toBe(7_000)
    expect(timeout('toolMs')).toBe(7_000)
    expect(timeout('mcpMs')).toBe(TIMEOUT_DEFAULTS.mcpMs)
    expect(calls).toBe(1)
  })

  it('survives a throwing loader', () => {
    configureTimeouts(() => { throw new Error('boom') })
    expect(resolveTimeouts()).toEqual(TIMEOUT_DEFAULTS)
  })
})
