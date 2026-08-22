/**
 * tool_search at the tool layer, plus the registration policy in
 * createStandardTools.
 *
 * The property under test throughout: deferral must change what the model
 * SEES, never what it can DO, and must never leave a capability that exists but
 * cannot be found.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { MetaAgentTool, ToolCallContext } from '../../core/types.js'
import { createToolSearchTool } from '../registry/tool_search/index.js'
import { createStandardTools } from '../index.js'
import { toolVisibility, resetToolVisibility, visibleToolsForApi } from '../../kernel/tools/ToolVisibility.js'

const SESSION = 'sess-tool-search'

function ctx(overrides: Partial<ToolCallContext> = {}): ToolCallContext {
  return {
    sessionId: SESSION,
    agentId: SESSION,
    abortSignal: new AbortController().signal,
    ...overrides,
  }
}

function fakeTool(
  name: string,
  namespace: string,
  description: string,
  deferLoading = true,
): MetaAgentTool {
  return {
    name, namespace, deferLoading, description,
    abortSupport: 'bounded',
    inputSchema: { type: 'object', properties: {}, required: [] },
    async call() { return { content: `${name} ran`, isError: false } },
  }
}

const CORPUS: MetaAgentTool[] = [
  fakeTool('db_query', 'mcp', 'Run a read-only SQL query against the database'),
  fakeTool('db_write', 'mcp', 'Insert or update rows in the database'),
  fakeTool('slack_post', 'chat', 'Post a message to a Slack channel'),
  fakeTool('read_file', 'fs', 'Read a file', false),
]

let search: MetaAgentTool

beforeEach(async () => {
  resetToolVisibility()
  search = await createToolSearchTool({ allTools: () => CORPUS })
})

afterEach(() => {
  resetToolVisibility()
  delete process.env['META_AGENT_TOOLS_EAGER']
})

describe('tool_search — searching', () => {
  it('finds a tool and reports what it loaded', async () => {
    const res = await search.call({ query: 'sql database' }, ctx())
    expect(res.isError).toBe(false)
    expect(res.content).toContain('db_query')
    // The descriptions come back inline as well as being revealed: without
    // that, the model burns a turn discovering what it just loaded.
    expect(res.content).toMatch(/read-only SQL query/)
  })

  it('reveals the schema so the next request carries it', async () => {
    expect(visibleToolsForApi(CORPUS, SESSION).map(t => t.name)).toEqual(['read_file'])
    await search.call({ query: 'slack' }, ctx())
    expect(visibleToolsForApi(CORPUS, SESSION).map(t => t.name)).toEqual(
      expect.arrayContaining(['read_file', 'slack_post']),
    )
  })

  it('restricts to a namespace when asked', async () => {
    const res = await search.call({ query: 'database', namespace: 'chat' }, ctx())
    expect(res.content).toMatch(/No unloaded tools in namespace "chat"|No tool matched/)
    expect(res.content).not.toContain('db_query')
  })

  it('names the namespaces that do have hidden tools when a filter misses', async () => {
    const res = await search.call({ query: 'x', namespace: 'nonexistent' }, ctx())
    expect(res.content).toMatch(/mcp|chat/)
  })

  it('honours the limit and clamps it', async () => {
    const res = await search.call({ query: 'database', limit: 1 }, ctx())
    expect(res.content).toMatch(/Loaded 1 tool/)
  })

  it('tells the model to stop searching when nothing matches', async () => {
    // The failure this prevents: a model rewording the same query five times
    // because a miss reads as "try harder" rather than "it is not there".
    const res = await search.call({ query: 'quantum chromodynamics' }, ctx())
    expect(res.isError).toBe(false)
    expect(res.content).toMatch(/treat the capability as unavailable/)
  })

  it('says everything is loaded once nothing is left hidden', async () => {
    await search.call({ query: 'db' }, ctx())
    await search.call({ query: 'slack' }, ctx())
    const res = await search.call({ query: 'anything' }, ctx())
    expect(res.content).toMatch(/already loaded/)
    expect(res.content).toMatch(/not connected to this session/)
  })

  it('validates its input', async () => {
    expect((await search.call({}, ctx())).isError).toBe(true)
    expect((await search.call({ query: 42 }, ctx())).isError).toBe(true)
  })
})

describe('tool_search — the description carries the inventory', () => {
  it('names each namespace and how much is hidden', async () => {
    // This inventory is the model's ONLY signal that hidden capability exists.
    // Without it, deferral is indistinguishable from "this runtime cannot do
    // that", and the model confidently reports a capability as missing.
    const describe_ = search.description as (c: never) => Promise<string>
    const text = await describe_({
      tools: CORPUS, toolNames: new Set(CORPUS.map(t => t.name)), sessionId: SESSION,
    } as never)
    expect(text).toMatch(/mcp: 2 tool\(s\) not loaded/)
    expect(text).toMatch(/chat: 1 tool\(s\) not loaded/)
    expect(text).toContain('db_query')
  })

  it('reports everything loaded once the inventory is exhausted', async () => {
    toolVisibility().reveal(SESSION, ['db_query', 'db_write', 'slack_post'])
    const describe_ = search.description as (c: never) => Promise<string>
    const text = await describe_({
      tools: CORPUS, toolNames: new Set(), sessionId: SESSION,
    } as never)
    expect(text).toMatch(/All available tools are currently loaded/)
  })

  it('reflects registrations that happened after construction', async () => {
    // MCP servers connect mid-session; a snapshot taken at construction would
    // describe a registry that no longer exists.
    let live: MetaAgentTool[] = []
    const dynamic = await createToolSearchTool({ allTools: () => live })
    live = [fakeTool('late_arrival', 'late', 'Registered after construction')]
    const res = await dynamic.call({ query: 'late_arrival' }, ctx())
    expect(res.content).toContain('late_arrival')
  })
})

describe('deferral is not a permission boundary', () => {
  it('a hidden tool still executes if called by name', async () => {
    // Hiding a schema is a context-budget optimisation. Refusing to run a
    // correctly-formed call because the model did not search first would be
    // pure ceremony, and would put a budget decision on the security path.
    const hidden = CORPUS.find(t => t.name === 'db_write') as MetaAgentTool
    const res = await hidden.call({}, ctx())
    expect(res.isError).toBe(false)
    expect(res.content).toBe('db_write ran')
  })
})

describe('createStandardTools — registration policy', () => {
  it('defers nothing and registers no tool_search by default', async () => {
    // Deferral is actively harmful for tools the model needs to make basic
    // progress: it does not search for a file reader, it gives up or guesses.
    const tools = await createStandardTools({ include: ['fs', 'shell'] })
    expect(tools.some(t => t.deferLoading)).toBe(false)
    expect(tools.map(t => t.name)).not.toContain('tool_search')
  })

  it('labels every tool with its category namespace', async () => {
    const tools = await createStandardTools({ include: ['fs', 'shell'] })
    expect(tools.find(t => t.name === 'read_file')?.namespace).toBe('fs')
    expect(tools.find(t => t.name === 'bash')?.namespace).toBe('shell')
  })

  it('defers a requested category and registers tool_search with it', async () => {
    const tools = await createStandardTools({ include: ['fs', 'mcp'], defer: ['mcp'] })
    expect(tools.find(t => t.name === 'mcp_call')?.deferLoading).toBe(true)
    expect(tools.find(t => t.name === 'read_file')?.deferLoading).toBeUndefined()
    expect(tools.map(t => t.name)).toContain('tool_search')
  })

  it('makes the deferred category invisible to the API but still present in the registry', async () => {
    const tools = await createStandardTools({ include: ['fs', 'mcp'], defer: ['mcp'] })
    const visible = visibleToolsForApi(tools, SESSION).map(t => t.name)
    expect(visible).not.toContain('mcp_call')
    expect(visible).toContain('tool_search')
    // Still in config.tools, so a call by name executes normally.
    expect(tools.map(t => t.name)).toContain('mcp_call')
  })

  it('tool_search can find the tools that createStandardTools deferred', async () => {
    const tools = await createStandardTools({ include: ['fs', 'mcp'], defer: ['mcp'] })
    const searchTool = tools.find(t => t.name === 'tool_search') as MetaAgentTool
    const res = await searchTool.call({ query: 'mcp' }, ctx())
    expect(res.content).toContain('mcp_call')
    expect(visibleToolsForApi(tools, SESSION).map(t => t.name)).toContain('mcp_call')
  })

  it('a per-tool deferLoading declaration survives a non-deferred category', async () => {
    const tools = await createStandardTools({ include: ['fs'] })
    expect(tools.every(t => t.deferLoading !== true)).toBe(true)
  })
})
