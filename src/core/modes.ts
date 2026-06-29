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

export type SessionMode = 'agentic' | 'auto' | 'simple_auto' | 'campaign' | 'robotics' | 'auto-orch'

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
      '- **边界约束**：文件系统的读、写、编辑、删除限定在工作区边界内；对**工作区之外文件**的读/写/删/编辑会被系统直接拒绝。联网（web 搜索/抓取、拉取、下载）与 git 操作（`git pull` 拉取、`git push` 推送，HTTP 与 SSH 两种方式均受支持）已在授权范围内，可直接执行，无需逐次请求确认。\n' +
      '- **训练与验证策略**：深度学习 / 强化学习等算法训练**不在本地进行**，应尝试调用外部训练环境；本地仅核验语法与单元测试（test），不在本地跑真实训练。\n' +
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

  // simple_auto is a stripped-down sibling of auto for SIMPLE, short unattended
  // tasks: same autonomy jail (auto-approve writes inside the workspace, locked
  // workspace, denied tools) and the same goal-oriented loop, but WITHOUT the
  // heavyweight self-supervision machinery — no durable checkpoints, no drift
  // (course-correction) gate, and no independent completion-verify gate. Those
  // gates are simply left unwired by the backend factory for this mode (the
  // kernel loop already no-ops each one when its config hook is absent). Equal
  // weight to agentic/auto so an explicit selection is never clobbered.
  simple_auto: {
    weight: 1,
    identityLine:
      '你是 Meta-Agent，一个自主运行的工程 Agent，专注于目标的达成与任务的解决。' +
      '你会在工作区边界内持续自主推进，直到目标达成或遇到真正的阻塞才停下，' +
      '并在结束时清晰交代已完成与未完成的部分。',
    currentModeText:
      'SIMPLE-AUTO — 轻量无人值守自主执行模式：面向简单、短链路任务，多轮工具调用已启用。\n' +
      '- **授权范围**：对**项目工作路径内**的写入、编辑、删除、替换等操作（含不可逆操作）你已获明确授权，无需逐次请求确认，直接执行即可。\n' +
      '- **边界约束**：文件系统的读、写、编辑、删除限定在工作区边界内；对**工作区之外文件**的读/写/删/编辑会被系统直接拒绝。联网（web 搜索/抓取、拉取、下载）与 git 操作（`git pull` 拉取、`git push` 推送，HTTP 与 SSH 两种方式均受支持）已在授权范围内，可直接执行，无需逐次请求确认。\n' +
      '- **训练与验证策略**：深度学习 / 强化学习等算法训练**不在本地进行**，应尝试调用外部训练环境；本地仅核验语法与单元测试（test），不在本地跑真实训练。\n' +
      '- **持续推进**：可自行判定的小决策直接做，不要为此停下等待；持续推进直到目标达成或遇到真正的阻塞。\n' +
      '- **轻量模式**：本模式不启用检查点、航向校正与独立完成度审核——请专注于直接、高效地完成简单任务；若任务变复杂或高风险，建议改用 AUTO 模式。\n' +
      '- **终止与总结**：完成或受阻时，给出简洁总结——已完成、未完成、阻塞原因与建议的下一步。',
    compactProfile: 'simple_auto',
    agenticOverrides: {
      promptMode: 'simple_auto',
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

  // auto-orch is auto's autonomous + jailed executor PLUS an orchestration layer:
  // an AI-authored plan graph (C) of executor/role nodes, and intra-turn phase
  // hooks (B). Same weight/jail/autonomy as auto (it is a flavour, not heavier);
  // the orchestration wiring is additive and lives outside the permission cage.
  'auto-orch': {
    weight: 1,
    identityLine:
      '你是 Meta-Agent，一个自主运行且具备自我编排能力的工程 Agent，专注于目标的达成与复杂任务的拆解执行。' +
      '面对一个复杂目标，你会先规划出由多个子 Agent（执行者与审查角色，如校验、航向、复核）组成的协作流程，' +
      '在工作区边界内持续自主推进，并在结束时清晰交代已完成与未完成的部分。',
    currentModeText:
      'AUTO-ORCH — 无人值守自主编排模式：在 AUTO 的全部授权与边界约束之上，额外启用多 Agent 编排。\n' +
      '- **授权与边界**：与 AUTO 一致 —— 工作区内文件的读/写/删/改、联网及 git 操作（`git pull` 拉取、`git push` 推送，HTTP 与 SSH 均支持）均已获授权，无需逐次确认；仅对**工作区之外文件**的读/写/删/编辑会被系统直接拒绝。\n' +
      '- **训练与验证策略**：与 AUTO 一致 —— 深度学习 / 强化学习训练不在本地进行，尝试调用外部训练环境；本地仅核验语法与单元测试（test）。\n' +
      '- **自主编排**：面对复杂任务，可将其拆分为子任务并编排多个子 Agent 并行/串行执行；可为关键节点挂载审查角色（校验完成度、检查航向、复核产出）。\n' +
      '- **编排即数据**：编排方案是一张受校验与硬上限约束的计划图，由固定引擎解释执行，而非自由代码；非法或越界的编排会被拒绝并回退到默认自主循环。\n' +
      '- **进展留痕**：及时使用 `todo_write` / `progress_note` / `artifacts_register` 记录分解、进度与关键产出，用于航向检查与会话恢复。\n' +
      '- **终止与总结**：完成或受阻时给出简洁总结——已完成、未完成、阻塞原因与建议的下一步。',
    compactProfile: 'auto-orch',
    agenticOverrides: {
      promptMode: 'auto-orch',
      autonomy: {
        autoApproveInWorkspace: true,
        lockWorkspace: true,
        deniedTools: AUTO_DENIED_TOOL_NAMES,
      },
    },
  },
}

/** Modes that run unattended inside the auto workspace jail. */
export function isAutonomousMode(
  mode: SessionMode | string | null | undefined,
): mode is 'auto' | 'auto-orch' | 'simple_auto' {
  return mode === 'auto' || mode === 'auto-orch' || mode === 'simple_auto'
}

/** Numeric weight per mode, derived from the profile table. */
export const MODE_WEIGHT: Record<SessionMode, number> = Object.fromEntries(
  Object.entries(MODE_PROFILES).map(([mode, p]) => [mode, p.weight]),
) as Record<SessionMode, number>
