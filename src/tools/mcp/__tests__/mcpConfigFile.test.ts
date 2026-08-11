/**
 * mcp.json loading and ${VAR} interpolation.
 *
 * The bug that motivated this file: a missing credential did NOT skip the
 * server. `interpolateEnv` decided missing-ness from the FINAL string —
 * `value.includes('${') && !result.trim()` — so it only fired when the whole
 * value came out blank. The overwhelmingly common shape, and the one in this
 * module's own docstring, is
 *
 *   "Authorization": "Bearer ${ZHIPU_API_KEY}"
 *
 * With the key unset that becomes `"Bearer "`, whose `.trim()` is `"Bearer"` —
 * non-empty, so the value passed. The server was registered, its tools were
 * advertised to the model in the system prompt, and every call 401'd at the
 * remote end. The operator's symptom was "MCP is flaky", with nothing anywhere
 * naming the missing variable.
 *
 * Missing-ness is now decided per placeholder, and the warning names the
 * variable.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  interpolateEnv,
  interpolateRecord,
  loadMcpConfig,
} from '../mcpConfigFile.js'
import { mcpClients } from '../registry.js'

const dirs: string[] = []
const TOKEN = 'MCP_TEST_TOKEN_XYZ'
const OTHER = 'MCP_TEST_OTHER_XYZ'

beforeEach(() => {
  delete process.env[TOKEN]
  delete process.env[OTHER]
  mcpClients.clear()
})
afterEach(async () => {
  delete process.env[TOKEN]
  delete process.env[OTHER]
  mcpClients.clear()
  await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true })))
  vi.restoreAllMocks()
})

async function configFile(config: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-config-'))
  dirs.push(dir)
  const path = join(dir, 'mcp.json')
  await writeFile(path, JSON.stringify(config))
  return path
}

// ── interpolateEnv ────────────────────────────────────────────────────────────

describe('interpolateEnv', () => {
  it('substitutes a present variable', () => {
    process.env[TOKEN] = 'sk-live'
    expect(interpolateEnv(`\${${TOKEN}}`)).toEqual({ ok: true, value: 'sk-live' })
  })

  it('reports a bare missing placeholder', () => {
    expect(interpolateEnv(`\${${TOKEN}}`)).toEqual({ ok: false, missing: [TOKEN] })
  })

  it('reports a placeholder EMBEDDED in literal text — the regression', () => {
    // Pre-fix this returned "Bearer " and the server was registered broken.
    expect(interpolateEnv(`Bearer \${${TOKEN}}`)).toEqual({ ok: false, missing: [TOKEN] })
  })

  it('reports a placeholder with a literal prefix', () => {
    expect(interpolateEnv(`sk-\${${TOKEN}}`)).toEqual({ ok: false, missing: [TOKEN] })
  })

  it('reports EVERY missing variable in one value, deduped', () => {
    expect(interpolateEnv(`\${${TOKEN}}:\${${OTHER}}:\${${TOKEN}}`))
      .toEqual({ ok: false, missing: [TOKEN, OTHER] })
  })

  it('fails the value when only ONE of several placeholders is missing', () => {
    process.env[TOKEN] = 'present'
    expect(interpolateEnv(`\${${TOKEN}}/\${${OTHER}}`)).toEqual({ ok: false, missing: [OTHER] })
  })

  it('passes through a value with no placeholders', () => {
    expect(interpolateEnv('application/json')).toEqual({ ok: true, value: 'application/json' })
  })

  it('treats an empty-string variable as missing, not as a valid empty credential', () => {
    process.env[TOKEN] = ''
    expect(interpolateEnv(`Bearer \${${TOKEN}}`)).toEqual({ ok: false, missing: [TOKEN] })
  })
})

describe('interpolateRecord', () => {
  it('resolves every field when all variables are present', () => {
    process.env[TOKEN] = 'v'
    expect(interpolateRecord({ Authorization: `Bearer \${${TOKEN}}`, 'X-Trace': 'on' }))
      .toEqual({ ok: true, value: { Authorization: 'Bearer v', 'X-Trace': 'on' } })
  })

  it('rejects the whole record and names the offending FIELD', () => {
    expect(interpolateRecord({ 'X-Trace': 'on', Authorization: `Bearer \${${TOKEN}}` }))
      .toEqual({ ok: false, field: 'Authorization', missing: [TOKEN] })
  })

  it('an absent record is an empty success, not a failure', () => {
    expect(interpolateRecord(undefined)).toEqual({ ok: true, value: {} })
  })
})

// ── loadMcpConfig ─────────────────────────────────────────────────────────────

describe('loadMcpConfig', () => {
  it('registers an http server whose credentials resolve', async () => {
    process.env[TOKEN] = 'sk-live'
    const path = await configFile({
      mcpServers: { search: { type: 'http', url: 'https://example.test/mcp', headers: { Authorization: `Bearer \${${TOKEN}}` } } },
    })
    expect(loadMcpConfig(path)).toEqual(['search'])
    expect(mcpClients.has('search')).toBe(true)
  })

  it('SKIPS a server whose Bearer token resolved empty — the regression', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const path = await configFile({
      mcpServers: { search: { type: 'http', url: 'https://example.test/mcp', headers: { Authorization: `Bearer \${${TOKEN}}` } } },
    })
    expect(loadMcpConfig(path)).toEqual([])
    expect(mcpClients.has('search')).toBe(false)
    // And it says WHICH variable, not just "missing environment variable".
    const message = warn.mock.calls.map(c => String(c[0])).join('\n')
    expect(message).toContain(TOKEN)
    expect(message).toContain('headers.Authorization')
  })

  it('SKIPS a stdio server whose env credential resolved empty', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const path = await configFile({
      mcpServers: { local: { type: 'stdio', command: 'echo', env: { API_KEY: `sk-\${${TOKEN}}` } } },
    })
    expect(loadMcpConfig(path)).toEqual([])
    expect(mcpClients.has('local')).toBe(false)
  })

  it('registers a stdio server that declares no env block at all', async () => {
    const path = await configFile({ mcpServers: { local: { type: 'stdio', command: 'echo', args: ['hi'] } } })
    expect(loadMcpConfig(path)).toEqual(['local'])
  })

  it('registers an sse server through the same HTTP path', async () => {
    const path = await configFile({ mcpServers: { push: { type: 'sse', url: 'https://example.test/sse' } } })
    expect(loadMcpConfig(path)).toEqual(['push'])
  })

  it('accepts every spelling of the streamable-http type', async () => {
    for (const type of ['http', 'streamable-http', 'streamableHttp']) {
      mcpClients.clear()
      const path = await configFile({ mcpServers: { s: { type, url: 'https://example.test/mcp' } } })
      expect(loadMcpConfig(path), type).toEqual(['s'])
    }
  })

  it('skips an unknown server type but keeps loading the rest', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const path = await configFile({
      mcpServers: {
        weird: { type: 'carrier-pigeon', url: 'https://example.test' },
        good: { type: 'http', url: 'https://example.test/mcp' },
      },
    })
    expect(loadMcpConfig(path)).toEqual(['good'])
  })

  it('one skipped server does not prevent the others from registering', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    process.env[OTHER] = 'present'
    const path = await configFile({
      mcpServers: {
        broken: { type: 'http', url: 'https://a.test/mcp', headers: { Authorization: `Bearer \${${TOKEN}}` } },
        working: { type: 'http', url: 'https://b.test/mcp', headers: { Authorization: `Bearer \${${OTHER}}` } },
      },
    })
    expect(loadMcpConfig(path)).toEqual(['working'])
  })

  it('a missing file is not an error', () => {
    expect(loadMcpConfig(join(tmpdir(), 'definitely-absent-mcp.json'))).toEqual([])
  })

  it('reports malformed JSON without throwing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const dir = await mkdtemp(join(tmpdir(), 'mcp-config-'))
    dirs.push(dir)
    const path = join(dir, 'mcp.json')
    await writeFile(path, '{not json')
    expect(loadMcpConfig(path)).toEqual([])
    expect(warn).toHaveBeenCalled()
  })

  it('tolerates a file with no mcpServers key', async () => {
    expect(loadMcpConfig(await configFile({ somethingElse: 1 }))).toEqual([])
  })

  it('the config file replaces an already-registered server of the same name', async () => {
    const stub = { listTools: async () => [], callTool: async () => ({ content: [] }) }
    mcpClients.set('search', stub as never)
    const path = await configFile({ mcpServers: { search: { type: 'http', url: 'https://example.test/mcp' } } })
    expect(loadMcpConfig(path)).toEqual(['search'])
    expect(mcpClients.get('search')).not.toBe(stub)
  })
})
