import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  ToolVisibilityRegistry,
  toolVisibility,
  resetToolVisibility,
  visibleToolsForApi,
  searchTools,
  namespaceOf,
  isDeferred,
  eagerToolsForced,
  DEFAULT_NAMESPACE,
  type VisibilityTool,
} from '../tools/ToolVisibility.js'

const tool = (
  name: string,
  namespace?: string,
  deferLoading?: boolean,
  description?: string,
): VisibilityTool => ({
  name,
  ...(namespace !== undefined ? { namespace } : {}),
  ...(deferLoading !== undefined ? { deferLoading } : {}),
  ...(description !== undefined ? { description } : {}),
})

const SESSION = 'sess-1'

let registry: ToolVisibilityRegistry

beforeEach(() => {
  registry = new ToolVisibilityRegistry()
  delete process.env['META_AGENT_TOOLS_EAGER']
})

afterEach(() => {
  resetToolVisibility()
  delete process.env['META_AGENT_TOOLS_EAGER']
})

describe('classification', () => {
  it('defaults an undeclared namespace to core', () => {
    expect(namespaceOf(tool('read_file'))).toBe(DEFAULT_NAMESPACE)
    expect(namespaceOf(tool('x', 'mcp'))).toBe('mcp')
  })

  it('treats only an explicit true as deferred', () => {
    expect(isDeferred(tool('a'))).toBe(false)
    expect(isDeferred(tool('b', 'ns', false))).toBe(false)
    expect(isDeferred(tool('c', 'ns', true))).toBe(true)
  })
})

describe('visibility', () => {
  const tools = [
    tool('read_file'),
    tool('bash'),
    tool('db_query', 'mcp', true),
    tool('db_write', 'mcp', true),
    tool('ticket_create', 'tickets', true),
  ]

  it('hides deferred tools until they are revealed', () => {
    expect(registry.visible(SESSION, tools).map(t => t.name)).toEqual(['read_file', 'bash'])
    expect(registry.hidden(SESSION, tools).map(t => t.name)).toEqual([
      'db_query', 'db_write', 'ticket_create',
    ])
  })

  it('reveals a tool for the rest of the session', () => {
    registry.reveal(SESSION, ['db_query'])
    expect(registry.visible(SESSION, tools).map(t => t.name)).toContain('db_query')
    // Sticky: un-revealing would invalidate the prompt cache and make the model
    // re-search for something it already found — paying twice to save once.
    expect(registry.visible(SESSION, tools).map(t => t.name)).toContain('db_query')
    expect(registry.hidden(SESSION, tools).map(t => t.name)).not.toContain('db_query')
  })

  it('scopes revelation per session', () => {
    registry.reveal(SESSION, ['db_query'])
    expect(registry.visible('other', tools).map(t => t.name)).not.toContain('db_query')
  })

  it('clears one session or all of them', () => {
    registry.reveal(SESSION, ['db_query'])
    registry.reveal('other', ['db_write'])
    registry.clear(SESSION)
    expect(registry.revealedNames(SESSION)).toHaveLength(0)
    expect(registry.revealedNames('other')).toHaveLength(1)
    registry.clear()
    expect(registry.revealedNames('other')).toHaveLength(0)
  })

  it('summarises namespaces by how much is still hidden', () => {
    const summary = registry.summarise(SESSION, tools)
    expect(summary.map(s => s.namespace)).toEqual(['mcp', 'tickets'])
    expect(summary[0]).toMatchObject({ namespace: 'mcp', total: 2, hidden: 2 })
    expect(summary[0]?.sample).toEqual(['db_query', 'db_write'])

    registry.reveal(SESSION, ['db_query'])
    expect(registry.summarise(SESSION, tools)[0]).toMatchObject({ total: 2, hidden: 1 })
  })
})

describe('visibleToolsForApi', () => {
  it('returns the input array untouched when nothing is deferred', () => {
    // The fast path matters: this runs on every turn of every session, and the
    // overwhelmingly common case is that no tool is deferred at all.
    const plain = [tool('read_file'), tool('bash')]
    expect(visibleToolsForApi(plain, SESSION)).toBe(plain)
  })

  it('filters through the process-global registry when something is deferred', () => {
    const tools = [tool('read_file'), tool('hidden_one', 'mcp', true)]
    expect(visibleToolsForApi(tools, SESSION).map(t => t.name)).toEqual(['read_file'])

    toolVisibility().reveal(SESSION, ['hidden_one'])
    expect(visibleToolsForApi(tools, SESSION).map(t => t.name)).toEqual(['read_file', 'hidden_one'])
  })
})

describe('META_AGENT_TOOLS_EAGER escape hatch', () => {
  const tools = [tool('read_file'), tool('hidden', 'mcp', true)]

  it('is off by default', () => {
    expect(eagerToolsForced()).toBe(false)
  })

  it('sends every schema and reports nothing hidden when set', () => {
    process.env['META_AGENT_TOOLS_EAGER'] = '1'
    expect(eagerToolsForced()).toBe(true)
    expect(registry.visible(SESSION, tools)).toHaveLength(2)
    expect(registry.hidden(SESSION, tools)).toHaveLength(0)
    expect(visibleToolsForApi(tools, SESSION)).toHaveLength(2)
  })
})

describe('searchTools', () => {
  const corpus = [
    tool('db_query', 'mcp', true, 'Run a read-only SQL query against the database'),
    tool('db_write', 'mcp', true, 'Insert or update rows in the database'),
    tool('slack_post', 'chat', true, 'Post a message to a Slack channel'),
    tool('calendar_list', 'office', true, 'List upcoming calendar events'),
  ]

  it('ranks an exact name match first', () => {
    expect(searchTools('db_write', corpus)[0]?.tool.name).toBe('db_write')
  })

  it('matches on description text', () => {
    const names = searchTools('sql query', corpus).map(h => h.tool.name)
    expect(names[0]).toBe('db_query')
  })

  it('matches on namespace', () => {
    const names = searchTools('mcp', corpus).map(h => h.tool.name)
    expect(names).toEqual(expect.arrayContaining(['db_query', 'db_write']))
    expect(names).not.toContain('slack_post')
  })

  it('finds a tool from a task description rather than its name', () => {
    // The case that matters in practice: the model knows what it wants to do,
    // not what the tool is called.
    expect(searchTools('send a message to the team channel', corpus)[0]?.tool.name).toBe('slack_post')
  })

  it('returns nothing for a query that matches nothing', () => {
    expect(searchTools('quantum chromodynamics', corpus)).toHaveLength(0)
  })

  it('honours the limit', () => {
    expect(searchTools('database', corpus, 1)).toHaveLength(1)
  })

  it('falls back to a listing for an empty query', () => {
    expect(searchTools('', corpus, 2)).toHaveLength(2)
  })

  it('ignores non-string descriptions instead of resolving them', () => {
    // A dynamic description is a function that may read session state; calling
    // dozens of them to rank a search would be slow and surprising.
    const dynamic = [{ name: 'dyn', namespace: 'x', deferLoading: true, description: () => 'x' }]
    expect(() => searchTools('anything', dynamic)).not.toThrow()
    expect(searchTools('dyn', dynamic)).toHaveLength(1)
  })

  it('is deterministic for equal scores', () => {
    const tied = [tool('b_tool', 'ns', true, 'same'), tool('a_tool', 'ns', true, 'same')]
    expect(searchTools('same', tied).map(h => h.tool.name)).toEqual(['a_tool', 'b_tool'])
  })
})

describe('process-global instance', () => {
  it('is shared, so revelations survive between tool calls', () => {
    expect(toolVisibility()).toBe(toolVisibility())
  })

  it('reset drops every revelation', () => {
    toolVisibility().reveal(SESSION, ['x'])
    resetToolVisibility()
    expect(toolVisibility().revealedNames(SESSION)).toHaveLength(0)
  })
})
