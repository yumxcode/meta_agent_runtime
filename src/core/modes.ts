/**
 * modes.ts — single source of truth for execution modes.
 *
 * Historically "mode" was redeclared as four parallel union types
 * (SessionMode / AgentMode / StaticPromptMode / CompactProfile) across four
 * files, and each mode's behaviour (weight, identity line, current-mode text,
 * compact profile, agentic backend overrides) was scattered across records,
 * ternaries, and `if (mode === …)` branches. Adding a mode meant editing ~10
 * sites, several of which were NOT compiler-enforced.
 *
 * This module centralises all of that:
 *   - `SessionMode` is the canonical union; the other three are aliases of it
 *     (or, for the kernel-layer `CompactProfile`, kept in lockstep by a
 *     compile-time assertion below).
 *   - `MODE_PROFILES` is a `Record<SessionMode, ModeProfile>` — adding a mode is
 *     one new entry, and the exhaustive Record forces every field to be filled.
 *
 * The prompt builders (staticPrompt, dynamicPrompt), the router, and the weight
 * table all read from this one table.
 */
import type { AutonomyProfile } from './types.js'
import type { CompactProfile } from '../kernel/compact/CompactPrompt.js'

// ── Canonical mode union ───────────────────────────────────────────────────────

export type SessionMode = 'agentic' | 'auto' | 'campaign' | 'robotics'

// Compile-time guarantee that the kernel-layer CompactProfile (which cannot
// import this core module without inverting layering) stays in lockstep with
// SessionMode. If a mode is added to one but not the other, this fails to
// compile (`true` is not assignable to `never`).
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never
export const _SESSION_MODE_MATCHES_COMPACT_PROFILE: Exact<SessionMode, CompactProfile> = true

// ── Per-mode profile ───────────────────────────────────────────────────────────

export interface ModeProfile {
  /** Numeric weight for mode comparison (higher = heavier; equal = sibling). */
  weight: number
  /** S1 identity line (full string, including any shared preamble). */
  identityLine: string
  /** Optional extra S1 clause appended after the identity line (campaign V&V hard rule). */
  identitySuffix?: string
  /** D4 "current mode" description body. */
  currentModeText: string
  /** Which compact-prompt template family this mode uses (defaults to itself). */
  compactProfile: CompactProfile
  /**
   * Overrides for modes backed by the shared agentic backend (MetaAgentSession).
   * Only meaningful for 'agentic'/'auto'; undefined for modes with a dedicated
   * Session class (campaign/robotics).
   */
  agenticOverrides?: { autonomy?: AutonomyProfile; promptMode?: SessionMode }
}

// Shared preamble for the three specialist modes. AUTO uses its own goal-oriented
// identity instead (see below) so it never claims to be "Agentic".
const SPECIALIST_PREAMBLE =
  '你是 Meta-Agent，一个自主工程 Agent，支持三种专项模式：' +
  'Agentic（代码开发）、Campaign（工业工程项目）、Robotics（机器人算法及落地）。'

/**
 * Capabilities whose effects cannot be confined to the auto workspace jail.
 *
 * Read-only counterparts remain available:
 *   - memory is recalled into the prompt, but memory_write/delete are blocked;
 *   - cron_list remains available, but scheduling/cancelling is blocked;
 *   - MCP capabilities remain available by explicit product decision.
 */
export const AUTO_DENIED_TOOL_NAMES = [
  'memory_write',
  'memory_delete',
  'cron_create',
  'cron_delete',
  'powershell',
] as const

export const MODE_PROFILES: Record<SessionMode, ModeProfile> = {
  agentic: {
    weight: 1,
    identityLine: `${SPECIALIST_PREAMBLE}当前模式：**Agentic** — 专注于代码开发与软件工程任务。`,
    currentModeText: 'AGENTIC — 多轮工具调用已启用。',
    compactProfile: 'agentic',
  },

  // auto is a sibling of agentic, not heavier: equal weight means registerTool's
  // raise-to-agentic (1 > 1 === false) never clobbers an explicit auto.
  auto: {
    weight: 1,
    identityLine:
      '你是 Meta-Agent，一个自主运行的工程 Agent，专注于目标的达成与任务的解决。' +
      '你会在工作区边界内持续自主推进，直到目标达成或遇到真正的阻塞才停下，' +
      '并在结束时清晰交代已完成与未完成的部分。',
    currentModeText:
      'AUTO — 无人值守自主执行模式：多轮工具调用已启用。\n' +
      '- **授权范围**：对**项目工作路径内**的写入、编辑、删除、替换等操作（含不可逆操作）你已获明确授权，无需逐次请求确认，直接执行即可。\n' +
      '- **边界约束**：解决任务必须保证在工作区边界内完成；影响工作区之外或共享状态的操作（如 git push、对外发布、改动他人环境）不在授权范围，会被系统直接拒绝——遇到这类需求时停下并在总结中说明，不要反复试探。\n' +
      '- **持续推进**：可自行判定的小决策直接做，不要为此停下等待；持续推进直到目标达成或遇到真正的阻塞。\n' +
      '- **进展留痕**：及时使用 `todo_write` 记录任务分解和完成情况，使用 `progress_note` 更新进度摘要，使用 `artifacts_register` 标记关键产出文件——这些信息用于航向检查和会话恢复。\n' +
      '- **终止与总结**：完成或受阻时，给出简洁总结——已完成、未完成、阻塞原因与建议的下一步。',
    compactProfile: 'auto',
    agenticOverrides: {
      promptMode: 'auto',
      autonomy: {
        autoApproveInWorkspace: true,
        lockWorkspace: true,
        deniedTools: AUTO_DENIED_TOOL_NAMES,
      },
    },
  },

  campaign: {
    weight: 2,
    identityLine: `${SPECIALIST_PREAMBLE}当前模式：**Campaign** — 专注于工业工程项目开发，含 DOE 实验设计、多保真度仿真与 Pareto 优化。`,
    identitySuffix:
      '重要：严禁在未获用户明确批准的情况下绕过 V&V 验证器、修改溯源记录，' +
      '或提升仿真保真度（L0 → L1 → L2）。',
    currentModeText: 'CAMPAIGN — 完整多步骤 campaign 工作流已激活；按指示使用 campaign 和仿真工具。',
    compactProfile: 'campaign',
  },

  robotics: {
    weight: 3,
    // 中性表述：多 Agent 编排仅在 multi 变体下激活（由 R1 节裁定）。
    identityLine: `${SPECIALIST_PREAMBLE}当前模式：**Robotics** — 专注于机器人算法开发与落地，含策略训练、仿真到实机迁移，并可选多 Agent 编排。`,
    currentModeText:
      'ROBOTICS — 机器人开发专项模式；ExperienceStore、硬件配置与 Git 工作区已激活。' +
      '是否启用子 Agent 编排以 "Robotics 开发模式" 节为准。' +
      '优先查阅经验库和硬件配置，所有代码须符合绑定平台的安全限制。',
    compactProfile: 'robotics',
  },
}

/** Numeric weight per mode, derived from the profile table. */
export const MODE_WEIGHT: Record<SessionMode, number> = Object.fromEntries(
  Object.entries(MODE_PROFILES).map(([mode, p]) => [mode, p.weight]),
) as Record<SessionMode, number>
