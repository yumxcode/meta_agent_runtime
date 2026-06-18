/**
 * Campaign-mode prompt sections.
 *
 * These live in the campaign package (not core/dynamicPrompt) so the shared
 * prompt builder no longer imports campaign internals — the "fake-shared"
 * coupling called out in architecture-review-2026-06-18.md §1.1. CampaignSession
 * owns its prompt assembly (it injects an enriched `<context>` user-message
 * prefix), so these builders are campaign's to use/inject, exactly like robotics
 * owns R1–R6.
 *
 * Sections:
 *   D4b campaign_knowledge   — DOE phases / fidelity / Pareto conceptual guidance
 *   D8  campaign_context     — active campaign phase/Pareto state [uncached]
 *   D9  session_provenance   — V&V/provenance records this session
 *   D10 phase_guidance       — per-phase guidance delegated to each plugin [uncached]
 */
import {
  systemPromptSection,
  DANGEROUS_uncachedSystemPromptSection,
  type SystemPromptSection,
} from '../core/systemPromptSections.js'
import type { RuntimeContext } from '../runtime/RuntimeContext.js'
import { MetaAgentContextStore, USER_CHECKPOINT_PHASES, MACHINE_PHASES } from './index.js'
import { campaignRegistry } from './registry.js'

// ── D8/D10 micro-cache — 500 ms TTL ───────────────────────────────────────────
// MetaAgentContextStore already has a 2 s TTL cache, but D8 and D10 both read it
// within the same submit() turn; this module-level cache lets them share one
// in-process value. Invalidated implicitly by the 500 ms window.
const D8_D10_CACHE_TTL_MS = 500

interface _CtxCacheEntry {
  ctx: Awaited<ReturnType<typeof MetaAgentContextStore.read>>
  ts:  number
}

let _ctxCache: _CtxCacheEntry | null = null

/** Read MetaAgentContextStore with a 500 ms in-process TTL. */
async function _readCtxCached() {
  const now = Date.now()
  if (_ctxCache && (now - _ctxCache.ts) < D8_D10_CACHE_TTL_MS) {
    return _ctxCache.ctx
  }
  const ctx = await MetaAgentContextStore.read()
  _ctxCache = { ctx, ts: now }
  return ctx
}

// ── D4b — Campaign Domain Knowledge [memoized] ────────────────────────────────
export function buildCampaignKnowledgeSection(): SystemPromptSection {
  return systemPromptSection('campaign_knowledge', () => {
    return `\
## Campaign Domain Knowledge

**Campaign system**: Campaigns are plugin-based. Each plugin type (e.g. \`doe\`, \`paper-repro\`) \
defines its own phase graph. The DOE phase graph is the default reference; \
other plugins may use a subset or a different structure — always inspect \`campaignType\` before assuming DOE phases apply.

**DOE campaign phases** (state machine):
- \`IDLE\` → \`SAMPLING\` → \`EVALUATING_L0\` → \`PARETO_READY_L0\`
- \`PARETO_READY_L0\` → \`ESCALATING_L1\` → \`PARETO_READY_L1\` (if L1 warranted)
- \`PARETO_READY_L1\` → \`ESCALATING_L2\` → \`PARETO_READY_L2\` (if L2 warranted)
- Any active phase → \`REPORTING\` → \`DONE\`
- Any active phase → \`FAILED\` (on timeout, constraint violation, or explicit failure)

**Fidelity levels**:
- L0 (analytical): Fast closed-form or empirical models. Use for initial screening — 2–3 sig figs.
- L1 (surrogate): Trained surrogate models. Higher accuracy, moderate compute — 3–4 sig figs.
- L2 (high-fidelity): Full simulation (FEA, CFD, etc.). Slowest, highest accuracy — 4–5 sig figs.

**Escalation thresholds** (PARETO_READY → ESCALATING):
- Escalate L0 → L1 if: Pareto hypervolume improvement < 2 % across the last 3 iterations, \
OR fewer than 5 non-dominated designs exist, OR a high-gradient region has < 3 evaluated points.
- Escalate L1 → L2 if: top-3 Pareto designs are within 5 % of each other on all objectives \
(L1 cannot disambiguate them) AND L2 cost is within budget.
- Proceed to REPORTING if neither condition applies at the current fidelity level.
- Always present Pareto evidence and receive explicit user acknowledgment before escalating.

**Pareto front**: The set of non-dominated designs — no other design in the evaluated set \
is strictly better on all objectives simultaneously. Improvement in Pareto hypervolume \
across iterations signals that the design space is not yet fully explored.`
  })
}

// ── D8 — Campaign Context [DANGEROUS_uncached] ────────────────────────────────
export function buildCampaignContextSection(): SystemPromptSection {
  return DANGEROUS_uncachedSystemPromptSection(
    'campaign_context',
    async () => {
      const ctx = await _readCtxCached()
      if (!ctx || ctx.activeCampaigns.length === 0) return null
      const blocks = ctx.activeCampaigns.map(c => c.contextBlock)
      return ['## 活跃工程 Campaign', ...blocks].join('\n\n')
    },
    'Campaign state updates every few seconds during active runs; stale context ' +
    'would cause the agent to miss phase transitions and act on outdated Pareto fronts.',
  )
}

// ── D9 — Session Provenance [memoized, invalidated on new records] ────────────
export function buildSessionProvenanceSection(
  rtx: RuntimeContext,
  sessionStartMs: number,
): SystemPromptSection {
  return systemPromptSection('session_provenance', async () => {
    try {
      const records = await rtx.provenanceTracker.list({ since: sessionStartMs })
      if (records.length === 0) return null

      type VVEntry = { passed: boolean; severity?: string }
      const hasFailure = (r: { validationResults: VVEntry[] }) =>
        r.validationResults.some(v => !v.passed)
      const hasWarning = (r: { validationResults: VVEntry[] }) =>
        r.validationResults.some(v => v.passed && v.severity === 'warning')
      const isProblematic = (r: { validationResults: VVEntry[] }) =>
        hasFailure(r) || hasWarning(r)
      const problems  = records.filter(isProblematic).reverse()
      const successes = records.filter(r => !isProblematic(r)).reverse()
      const recent = [...problems, ...successes].slice(0, 10)
      const lines = recent.map(r => {
        const vv = hasFailure(r) ? '✗' : hasWarning(r) ? '⚠' : '✓'
        const ts = new Date(r.timestamp).toISOString().slice(11, 16) + 'Z'
        const inputStr = Object.entries(r.input ?? {})
          .slice(0, 3)
          .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
          .join(', ')
        const inputSummary = inputStr.length > 50 ? inputStr.slice(0, 47) + '...' : inputStr
        return `  [${r.id}] ${r.toolName}(${inputSummary}) → ${vv}  fidelity=L${r.fidelityLevel}  ${ts}`
      })

      return (
        `## 本会话计算记录\n\n` +
        lines.join('\n') +
        `\n\n` +
        `工具：\`get_provenance(<id>)\` 查看完整记录 · ` +
        `\`get_computation_lineage\` 追踪派生链 · ` +
        `\`find_duplicate_computation\` 重复检查`
      )
    } catch {
      return null
    }
  })
}

// ── D10 — Phase Guidance [DANGEROUS_uncached] ─────────────────────────────────
// Delegates to each campaign's plugin for phase-specific guidance strings.
export function buildPhaseGuidanceSection(): SystemPromptSection {
  return DANGEROUS_uncachedSystemPromptSection(
    'phase_guidance',
    async () => {
      try {
        const ctx = await _readCtxCached()
        if (!ctx || ctx.activeCampaigns.length === 0) return null

        const guidanceLines: string[] = []
        for (const campaign of ctx.activeCampaigns) {
          const phase      = campaign.phase as string
          const pluginType = campaign.pluginType

          let guidance = ''
          if (pluginType && campaignRegistry.has(pluginType)) {
            const plugin = campaignRegistry.get(pluginType)
            try {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              guidance = plugin.buildPhaseGuidance(phase as never, {} as any)
            } catch {
              // Plugin threw — skip guidance for this campaign
            }
          }

          if (guidance) {
            guidanceLines.push(
              `**${campaign.projectName ?? campaign.campaignId}** (${phase}):\n${guidance}`,
            )
          }

          if (pluginType && campaignRegistry.has(pluginType)) {
            const plugin = campaignRegistry.get(pluginType)
            const isHuman  = (plugin.phases.humanCheckpoints as readonly string[]).includes(phase)
            const isMachine = (plugin.phases.machinePhases as readonly string[]).includes(phase)

            if (isHuman) {
              guidanceLines.push(`  ⏸ 等待你的决策，campaign 将在确认后继续。`)
            } else if (isMachine) {
              guidanceLines.push(`  ⚙ 机器执行阶段——无需调用工具，后台任务正在运行。`)
            }
          } else {
            if (USER_CHECKPOINT_PHASES.has(phase as never)) {
              guidanceLines.push(`  ⏸ 等待你的决策，campaign 将在确认后继续。`)
            }
            if (MACHINE_PHASES.has(phase as never)) {
              guidanceLines.push(`  ⚙ 机器执行阶段——无需调用工具，后台任务正在运行。`)
            }
          }
        }

        if (guidanceLines.length === 0) {
          const names = ctx.activeCampaigns
            .map(c => `${c.projectName ?? c.campaignId} (${c.phase})`)
            .join(', ')
          return `## Campaign 阶段指导\n\n活跃 campaign：${names}。\n` +
            `当前插件类型暂无阶段专属指导。` +
            `可调用 \`get_campaign_status\` 查看详情，或调用 \`list_campaigns\` 检查状态。`
        }
        return `## Campaign 阶段指导\n\n${guidanceLines.join('\n\n')}`
      } catch {
        return null
      }
    },
    'Phase guidance must reflect the current campaign phase, which can change ' +
    'between turns as background jobs complete.',
  )
}
