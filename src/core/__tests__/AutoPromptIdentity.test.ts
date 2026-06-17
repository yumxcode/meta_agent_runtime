import { describe, it, expect } from 'vitest'
import { buildStaticSystemPrompt } from '../staticPrompt.js'
import { buildCurrentModeSection } from '../dynamicPrompt.js'
import { SectionRegistry } from '../systemPromptSections.js'
import { buildAutoModeAnchors } from '../compact/agenticCompactAnchors.js'

async function renderSection(section: ReturnType<typeof buildCurrentModeSection>): Promise<string> {
  const [text] = await new SectionRegistry().resolve([section])
  return text ?? ''
}

describe('AUTO-mode prompt identity & current-mode consistency', () => {
  it('static identity for auto is goal-oriented and does NOT claim "Agentic"', () => {
    const s = buildStaticSystemPrompt('auto')
    expect(s).toContain('自主运行')
    expect(s).toContain('目标的达成')
    // The old bug: auto fell back to the agentic identity line.
    expect(s).not.toContain('当前模式：**Agentic**')
  })

  it('agentic identity still reads as Agentic (no regression)', () => {
    const s = buildStaticSystemPrompt('agentic')
    expect(s).toContain('当前模式：**Agentic**')
  })

  it('D4 auto section drops "无需你自行判断边界" and asserts the workspace boundary', async () => {
    const text = await renderSection(buildCurrentModeSection('auto'))
    expect(text).not.toContain('无需你自行判断边界')
    expect(text).toContain('工作区边界内')
    // Authorization scope + persistence + termination guidance present.
    expect(text).toContain('授权')
    expect(text).toContain('git push')
    expect(text).toContain('持续推进')
    expect(text).toMatch(/总结|未完成/)
  })

  it('static (S1) and dynamic (D4) agree on the mode for auto — both AUTO, no contradiction', async () => {
    const s1 = buildStaticSystemPrompt('auto')
    const d4 = await renderSection(buildCurrentModeSection('auto'))
    expect(d4).toContain('AUTO')
    expect(s1).not.toContain('**Agentic**')
  })

  it('compaction auto anchors stay aligned with D4 wording (boundary + authorization)', () => {
    const anchors = buildAutoModeAnchors('/tmp/ws') ?? ''
    expect(anchors).toContain('工作区边界内')
    expect(anchors).toContain('git push')
    expect(anchors).toContain('jail root')
  })
})
