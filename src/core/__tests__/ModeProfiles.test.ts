import { describe, it, expect } from 'vitest'
import { AUTO_DENIED_TOOL_NAMES, MODE_PROFILES, MODE_WEIGHT, type SessionMode } from '../modes.js'
import { buildStaticSystemPrompt } from '../staticPrompt.js'
import { buildCurrentModeSection } from '../dynamicPrompt.js'
import { SectionRegistry } from '../systemPromptSections.js'

const ALL_MODES: SessionMode[] = ['agentic', 'auto', 'simple_auto', 'campaign', 'robotics', 'auto-orch']

async function render(section: ReturnType<typeof buildCurrentModeSection>): Promise<string> {
  const [t] = await new SectionRegistry().resolve([section])
  return t ?? ''
}

describe('MODE_PROFILES single source of truth', () => {
  it('has an entry for every SessionMode', () => {
    for (const m of ALL_MODES) expect(MODE_PROFILES[m]).toBeDefined()
    expect(Object.keys(MODE_PROFILES).sort()).toEqual([...ALL_MODES].sort())
  })

  it('MODE_WEIGHT is derived from the table', () => {
    for (const m of ALL_MODES) expect(MODE_WEIGHT[m]).toBe(MODE_PROFILES[m].weight)
    // Relationships relied on by SessionRouter._raiseMode.
    expect(MODE_WEIGHT.auto).toBe(MODE_WEIGHT.agentic)
    expect(MODE_WEIGHT.campaign).toBeGreaterThan(MODE_WEIGHT.auto)
    expect(MODE_WEIGHT.robotics).toBeGreaterThan(MODE_WEIGHT.campaign)
  })

  it('compactProfile equals the mode itself for every mode', () => {
    for (const m of ALL_MODES) expect(MODE_PROFILES[m].compactProfile).toBe(m)
  })

  it('auto + auto-orch carry agenticOverrides (autonomy jail); agentic does not', () => {
    expect(MODE_PROFILES.agentic.agenticOverrides).toBeUndefined()
    expect(MODE_PROFILES.auto.agenticOverrides?.promptMode).toBe('auto')
    expect(MODE_PROFILES.auto.agenticOverrides?.autonomy).toMatchObject({
      autoApproveInWorkspace: true,
      lockWorkspace: true,
      deniedTools: AUTO_DENIED_TOOL_NAMES,
    })
    // auto-orch reuses the same autonomy jail (it is a flavour of auto).
    expect(MODE_PROFILES['auto-orch'].agenticOverrides?.promptMode).toBe('auto-orch')
    expect(MODE_PROFILES['auto-orch'].agenticOverrides?.autonomy).toMatchObject({
      autoApproveInWorkspace: true,
      lockWorkspace: true,
      deniedTools: AUTO_DENIED_TOOL_NAMES,
    })
  })

  it('static identity (S1) is sourced from the table for each mode', () => {
    expect(buildStaticSystemPrompt('agentic')).toContain(MODE_PROFILES.agentic.identityLine)
    expect(buildStaticSystemPrompt('auto')).toContain(MODE_PROFILES.auto.identityLine)
    // campaign appends its V&V suffix
    const camp = buildStaticSystemPrompt('campaign')
    expect(camp).toContain(MODE_PROFILES.campaign.identityLine)
    expect(camp).toContain(MODE_PROFILES.campaign.identitySuffix!)
  })

  it('D4 current-mode text is sourced from the table for each mode', async () => {
    for (const m of ALL_MODES) {
      const text = await render(buildCurrentModeSection(m))
      expect(text).toContain(MODE_PROFILES[m].currentModeText)
    }
  })
})
