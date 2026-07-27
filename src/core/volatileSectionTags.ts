/**
 * volatileSectionTags — the SINGLE source of truth for the `<context>` block's
 * child tags.
 *
 * Two consumers used to keep independent copies:
 *   - `dynamicPrompt.formatVolatileContext()` — the map that decides which XML
 *     tag each resolved section is wrapped in;
 *   - `staticPrompt.getSystemRulesSection()` (S2) — the prose that TELLS the
 *     model what each tag means.
 *
 * They drifted: S2 documented 7 of the 11 tags, silently omitting
 * `physical_anchors`, `context_boundary`, `session_provenance` and
 * `phase_guidance` — so the model saw blocks it had never been told to
 * interpret. Deriving both from this one table makes that class of drift a
 * compile-time concern instead of a review-time one.
 *
 * Lives in its own module (rather than in either consumer) so `staticPrompt`
 * and `dynamicPrompt` can both import it without forming a cycle.
 */

/** Section name (as registered with SectionRegistry) → `<tag>` + its meaning. */
interface VolatileTagSpec {
  /** XML tag used to wrap the section inside `<context>`. */
  readonly tag: string
  /** One-clause Chinese gloss injected into S2 so the model can interpret it. */
  readonly description: string
}

export const VOLATILE_SECTION_TAG_SPECS = {
  memory_content:         { tag: 'memory',             description: '本会话记忆摘要' },
  experience_index:       { tag: 'experience_index',   description: '经验库索引' },
  physical_anchors:       { tag: 'physical_anchors',   description: '物理锚点（不得被推翻的硬件/物理事实）' },
  robotics_subagents:     { tag: 'subagent_status',    description: '活跃子 Agent 任务' },
  robotics_progress:      { tag: 'progress',           description: '开发进度笔记' },
  robotics_team_mode:     { tag: 'team_status',        description: '团队协作状态' },
  team_context_boundary:  { tag: 'context_boundary',   description: '团队模式下本单元的上下文边界' },
  subagent_notifications: { tag: 'notifications',      description: '子 Agent 完成通知' },
  campaign_context:       { tag: 'campaign_context',   description: '活跃 Campaign 状态' },
  session_provenance:     { tag: 'session_provenance', description: '本会话溯源记录' },
  phase_guidance:         { tag: 'phase_guidance',     description: '当前阶段的操作指引' },
} as const satisfies Record<string, VolatileTagSpec>

/** Maps internal section names to the XML tag used in the user message prefix. */
export const VOLATILE_SECTION_TAGS: Record<string, string> = Object.fromEntries(
  Object.entries(VOLATILE_SECTION_TAG_SPECS).map(([name, spec]) => [name, spec.tag]),
)

/**
 * Render the S2 tag glossary: `` `<tag>` 含义`` joined with `；`.
 * Deduplicated by tag (section name → tag is not injective in principle).
 */
export function renderVolatileTagGlossary(): string {
  const seen = new Set<string>()
  const parts: string[] = []
  for (const spec of Object.values(VOLATILE_SECTION_TAG_SPECS)) {
    if (seen.has(spec.tag)) continue
    seen.add(spec.tag)
    parts.push(`\`<${spec.tag}>\` ${spec.description}`)
  }
  return parts.join('；') + '。'
}
