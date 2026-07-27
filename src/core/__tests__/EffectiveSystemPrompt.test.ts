/**
 * End-to-end system-prompt assembly assertions.
 *
 * The existing prompt tests (AssembleSystemPrompt / CompactPrompt /
 * AutoPromptIdentity) all check ONE builder's output in isolation. Three real
 * defects survived that coverage because they lived in the seams BETWEEN
 * builders:
 *
 *   - S2 documented 7 of the 11 `<context>` child tags the model actually sees;
 *   - the delegation guidance told the model sub-agent notifications appear in
 *     the SYSTEM prompt long after they had been moved to the user message;
 *   - D4a injected campaign-only V&V/fidelity vocabulary into agentic, the one
 *     mode where neither concept exists.
 *
 * These tests assert on the ASSEMBLED prompt for each mode, so that class of
 * drift fails in CI instead of at review time.
 */
import { describe, it, expect } from 'vitest'
import { buildStaticSystemPrompt } from '../staticPrompt.js'
import { buildDynamicSections } from '../dynamicPrompt.js'
import { SectionRegistry } from '../systemPromptSections.js'
import { MODE_PROFILES } from '../modes.js'
import { VOLATILE_SECTION_TAG_SPECS } from '../volatileSectionTags.js'
import type { SessionMode } from '../modes.js'

/**
 * Modes that assemble their prompt through buildStaticSystemPrompt +
 * buildDynamicSections. `campaign` is deliberately excluded: it currently
 * assembles its own prompt (see docs/reviews/code-review-stability-and-prompts-2026-07-27.md
 * P1-1) and is under active development.
 */
const ASSEMBLED_MODES: SessionMode[] = ['agentic', 'auto', 'simple_auto', 'robotics']

async function buildEffectivePrompt(mode: SessionMode): Promise<string> {
  const registry = new SectionRegistry()
  const sections = buildDynamicSections({
    sessionId: 'test-session',
    sessionStartMs: Date.parse('2026-07-27T00:00:00Z'),
    mode,
    // A directory that cannot contain AGENT.md / skills, so the assertions
    // below describe the runtime's OWN contribution, not the repo's.
    projectDir: '/nonexistent-project-dir-for-prompt-assembly-test',
  })
  const dynamic = await registry.resolveToString(sections)
  return `${buildStaticSystemPrompt(mode)}\n\n${dynamic}`
}

describe('effective system prompt — per-mode assembly', () => {
  it('carries the mode identity line for every assembled mode', async () => {
    for (const mode of ASSEMBLED_MODES) {
      const prompt = await buildEffectivePrompt(mode)
      expect(prompt, `${mode} must contain its identityLine`)
        .toContain(MODE_PROFILES[mode].identityLine)
      expect(prompt, `${mode} must contain its currentModeText`)
        .toContain(MODE_PROFILES[mode].currentModeText)
    }
  })

  it('stays within a sane token budget (regression guard against prompt bloat)', async () => {
    for (const mode of ASSEMBLED_MODES) {
      const prompt = await buildEffectivePrompt(mode)
      // ~2.2 chars/token for mixed CJK+ASCII. 2500 tokens is roughly 1.7x the
      // current largest mode — generous, but it will catch a section being
      // accidentally reintroduced or duplicated.
      expect(prompt.length, `${mode} system prompt is unexpectedly large`).toBeLessThan(2500 * 2.2)
      expect(prompt.length, `${mode} system prompt is suspiciously small`).toBeGreaterThan(1000)
    }
  })
})

describe('S2 <context> tag glossary', () => {
  it('documents EVERY tag the runtime can emit', async () => {
    const prompt = await buildEffectivePrompt('robotics')
    for (const spec of Object.values(VOLATILE_SECTION_TAG_SPECS)) {
      expect(prompt, `S2 must explain the <${spec.tag}> tag`).toContain(`\`<${spec.tag}>\``)
    }
  })

  it('documents no tag the runtime cannot emit', async () => {
    const prompt = await buildEffectivePrompt('agentic')
    const known = new Set(Object.values(VOLATILE_SECTION_TAG_SPECS).map(s => s.tag))
    // Pull every `<tag>` the glossary sentence mentions out of the S2 block.
    const glossary = prompt.slice(prompt.indexOf('**per-turn context 块**'))
      .split('**处理规则**')[0] ?? ''
    const mentioned = [...glossary.matchAll(/`<([a-z_]+)>`/g)]
      .map(m => m[1]!)
      // `<context>` is the WRAPPER the sentence introduces, not a child tag.
      .filter(tag => tag !== 'context')
    expect(mentioned.length).toBeGreaterThan(0)
    for (const tag of mentioned) {
      expect(known.has(tag), `S2 mentions <${tag}> but no section emits it`).toBe(true)
    }
  })
})

describe('prompt/runtime consistency', () => {
  it('points the model at <notifications> for sub-agent completions, not the system prompt', async () => {
    const prompt = await buildEffectivePrompt('auto')
    expect(prompt).toContain('<notifications>')
    // The pre-fix wording claimed the notifications block appears at the top of
    // the system prompt; it is injected into the user message.
    expect(prompt).not.toContain('系统提示顶部')
  })

  it('does not leak campaign V&V / fidelity vocabulary into agentic', async () => {
    const prompt = await buildEffectivePrompt('agentic')
    // Both are campaign-pipeline concepts that do not exist in agentic mode.
    expect(prompt).not.toContain('PRE-CALL ABORT')
    expect(prompt).not.toContain('fidelity level')
  })

  it('advertises the skill tool with its real invocation syntax', async () => {
    for (const mode of ASSEMBLED_MODES) {
      const prompt = await buildEffectivePrompt(mode)
      // The manifest is absent without skills on disk; when present it must not
      // teach a bare-word form the tool does not accept.
      expect(prompt).not.toContain('`skill list`')
    }
  })

  it('states the untrusted-data rule so injected content cannot pose as a user turn', async () => {
    for (const mode of ASSEMBLED_MODES) {
      const prompt = await buildEffectivePrompt(mode)
      expect(prompt, `${mode} must carry the untrusted-data hard rule`).toContain('不可信数据')
    }
  })
})

describe('autonomous mode text sharing', () => {
  it('keeps auto and simple_auto identical except for their own bullet', () => {
    const auto = MODE_PROFILES.auto
    const simple = MODE_PROFILES.simple_auto
    expect(simple.identityLine).toBe(auto.identityLine)

    const autoBullets = auto.currentModeText.split('\n').filter(l => l.startsWith('- '))
    const simpleBullets = simple.currentModeText.split('\n').filter(l => l.startsWith('- '))
    const shared = autoBullets.filter(b => simpleBullets.includes(b))
    // 4 common + the shared closing bullet.
    expect(shared.length).toBe(5)
    // Each carries exactly one bullet the other does not.
    expect(autoBullets.length - shared.length).toBe(1)
    expect(simpleBullets.length - shared.length).toBe(1)
    expect(auto.currentModeText).toContain('progress_note')
    expect(simple.currentModeText).toContain('轻量模式')
  })
})

describe('D2 env info', () => {
  it('reports TODAY, not the session start date', async () => {
    // A loop daemon booted weeks ago must not keep telling the model it is
    // still boot day.
    const prompt = await buildEffectivePrompt('auto')
    const today = new Date().toISOString().slice(0, 10)
    expect(prompt).toContain(`当前日期：${today}`)
    expect(prompt).not.toContain('当前日期：2026-07-27T')
  })
})
