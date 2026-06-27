import { describe, expect, it } from 'vitest'
import { AUTO_DENIED_TOOL_NAMES } from '../../core/modes.js'
import { createStandardTools } from '../index.js'
import { createSystemTools } from '../system/index.js'

describe('createStandardTools — auto capability boundary', () => {
  it('removes global/remote mutation tools while retaining read-only counterparts', async () => {
    const tools = await createStandardTools({
      mode: 'auto',
      include: ['shell', 'mcp', 'system'],
      system: { cwd: process.cwd() },
    })
    const names = new Set(tools.map(tool => tool.name))

    for (const denied of AUTO_DENIED_TOOL_NAMES) {
      expect(names.has(denied), `${denied} should not be exposed in auto mode`).toBe(false)
    }

    expect(names.has('bash')).toBe(true)
    expect(names.has('cron_list')).toBe(true)
    expect(names.has('mcp_call')).toBe(true)
    expect(names.has('list_mcp_resources')).toBe(true)
    expect(names.has('read_mcp_resource')).toBe(true)
  })

  it('applies the same hidden tool boundary to auto-orch', async () => {
    const tools = await createStandardTools({
      mode: 'auto-orch',
      include: ['ui', 'shell', 'mcp', 'system'],
      system: { cwd: process.cwd() },
    })
    const names = new Set(tools.map(tool => tool.name))

    for (const denied of AUTO_DENIED_TOOL_NAMES) {
      expect(names.has(denied), `${denied} should not be exposed in auto-orch mode`).toBe(false)
    }

    expect(names.has('ask_user')).toBe(false)
    expect(names.has('send_message')).toBe(false)
    expect(names.has('todo_write')).toBe(true)
    expect(names.has('bash')).toBe(true)
    expect(names.has('cron_list')).toBe(true)
  })

  it('also filters direct system-tool construction for auto-orch', async () => {
    const tools = await createSystemTools({ mode: 'auto-orch', cwd: process.cwd() })
    const names = new Set(tools.map(tool => tool.name))

    for (const denied of AUTO_DENIED_TOOL_NAMES) {
      expect(names.has(denied), `${denied} should not be exposed in auto-orch system tools`).toBe(false)
    }
    expect(names.has('cron_list')).toBe(true)
  })

  it('keeps the existing toolset outside auto mode', async () => {
    const tools = await createStandardTools({
      mode: 'agentic',
      include: ['shell', 'mcp', 'system'],
      system: { cwd: process.cwd() },
    })
    const names = new Set(tools.map(tool => tool.name))

    for (const expected of AUTO_DENIED_TOOL_NAMES) {
      expect(names.has(expected), `${expected} should remain available outside auto mode`).toBe(true)
    }
  })
})
