/**
 * Every input a tool accepts must be described to the model.
 *
 * A parameter that exists in `inputSchema` but appears nowhere in the
 * description is invisible: the model sees the name and a one-line schema blurb
 * with no guidance on when to use it, so in practice it never does. That is the
 * silent half of the failure — the loud half is a parameter that was RENAMED in
 * the schema while the prose kept the old name, which sends the model to a
 * field that no longer exists.
 *
 * Neither shows up in a type check or in any behavioural test, because both
 * tools and tests address parameters by their real names. This is the check.
 */
import { describe, it, expect } from 'vitest'
import type { MetaAgentTool } from '../../core/types.js'
import { createFsTools } from '../fs/index.js'
import { createShellTools } from '../shell/index.js'
import { createToolSearchTool } from '../registry/tool_search/index.js'

async function resolveDescription(tool: MetaAgentTool): Promise<string> {
  return typeof tool.description === 'string'
    ? tool.description
    : tool.description({
        tools: [tool],
        toolNames: new Set([tool.name]),
        sessionId: 'test-session',
      })
}

function declaredParameters(tool: MetaAgentTool): string[] {
  const props = (tool.inputSchema as { properties?: Record<string, unknown> }).properties
  return props ? Object.keys(props) : []
}

/** The tools added in 0.9.0 — the ones whose prose is newest and least worn in. */
async function subjectTools(): Promise<MetaAgentTool[]> {
  const [fs, shell, search] = await Promise.all([
    createFsTools(),
    createShellTools(),
    createToolSearchTool({ allTools: () => [] }),
  ])
  const names = new Set([
    'apply_patch', 'turn_diff', 'exec_session', 'write_stdin', 'close_session',
  ])
  return [...[...fs, ...shell].filter(t => names.has(t.name)), search]
}

describe('tool description coverage', () => {
  it('documents every declared parameter', async () => {
    const gaps: string[] = []
    for (const tool of await subjectTools()) {
      const description = await resolveDescription(tool)
      for (const param of declaredParameters(tool)) {
        // Backticked is the convention these descriptions use; accept a bare
        // mention too rather than enforcing a house style here.
        const mentioned =
          description.includes(`\`${param}\``) ||
          new RegExp(`\\b${param.replace(/_/g, '_')}\\b`).test(description)
        if (!mentioned) gaps.push(`${tool.name}.${param}`)
      }
    }
    expect(gaps, 'declared but undocumented — the model will never use these').toEqual([])
  })

  it('does not promise parameters that no longer exist', async () => {
    const ghosts: string[] = []
    for (const tool of await subjectTools()) {
      const description = await resolveDescription(tool)
      const declared = new Set(declaredParameters(tool))
      // Parameters are documented as bulleted `- \`name\` — …` lines; anything
      // in that position that is not in the schema is a stale rename.
      for (const match of description.matchAll(/^-\s+`([a-z][a-z0-9_]*)`\s+—/gm)) {
        const name = match[1] as string
        if (!declared.has(name)) ghosts.push(`${tool.name}.${name}`)
      }
    }
    expect(ghosts, 'documented but not in inputSchema — a stale rename').toEqual([])
  })

  it('gives every tool enough prose to choose it by', async () => {
    // A one-line description is a tool the model can name but not judge. These
    // all carry a "use this when / use the other one when" contrast, which is
    // the part that actually drives correct selection.
    for (const tool of await subjectTools()) {
      const description = await resolveDescription(tool)
      expect(description.length, `${tool.name} description is too thin`).toBeGreaterThan(200)
    }
  })
})
