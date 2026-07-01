import { describe, expect, it } from 'vitest'
import { AUTO_DENIED_TOOL_NAMES, type SessionMode } from '../../core/modes.js'
import { createStandardTools } from '../index.js'
import { createSystemTools } from '../system/index.js'

const AUTONOMOUS_MODES: SessionMode[] = ['auto', 'simple_auto', 'auto_orch']

describe('createStandardTools — auto capability boundary', () => {
  for (const mode of AUTONOMOUS_MODES) {
    it(`removes global/remote mutation tools while retaining read-only counterparts in ${mode}`, async () => {
      const tools = await createStandardTools({
        mode,
        include: ['shell', 'mcp', 'system'],
        system: { cwd: process.cwd() },
      })
      const names = new Set(tools.map(tool => tool.name))

      for (const denied of AUTO_DENIED_TOOL_NAMES) {
        expect(names.has(denied), `${denied} should not be exposed in ${mode} mode`).toBe(false)
      }

      expect(names.has('bash')).toBe(true)
      expect(names.has('cron_list')).toBe(true)
      expect(names.has('mcp_call')).toBe(true)
      expect(names.has('list_mcp_resources')).toBe(true)
      expect(names.has('read_mcp_resource')).toBe(true)
    })

    it(`uses unattended UI tools in ${mode}`, async () => {
      const tools = await createStandardTools({
        mode,
        include: ['ui', 'shell', 'system'],
        system: { cwd: process.cwd() },
      })
      const names = new Set(tools.map(tool => tool.name))

      expect(names.has('ask_user')).toBe(false)
      expect(names.has('send_message')).toBe(false)
      expect(names.has('todo_write')).toBe(true)
      expect(names.has('progress_note')).toBe(true)
      expect(names.has('artifacts_register')).toBe(true)
    })

    it(`filters direct system-tool construction in ${mode}`, async () => {
      const tools = await createSystemTools({ mode, cwd: process.cwd() })
      const names = new Set(tools.map(tool => tool.name))

      for (const denied of AUTO_DENIED_TOOL_NAMES) {
        expect(names.has(denied), `${denied} should not be exposed in ${mode} system tools`).toBe(false)
      }
      expect(names.has('cron_list')).toBe(true)
    })
  }

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
