/**
 * ModeDetector — four-layer heuristic mode classification.
 *
 * Layer 1: Explicit hint (zero cost)
 *   If the caller passed mode !== 'auto', return immediately.
 *
 * Layer 2: Prompt heuristics (zero cost, synchronous)
 *   Priority order (highest → lowest):
 *     0. ROBOTICS_ALWAYS — robotics-domain imperative patterns (ROS, SLAM,
 *        gait, manipulation, sim-to-real, RL-for-robots). Override everything.
 *     A. CAMPAIGN_ALWAYS — inherent action patterns that are unambiguously
 *        "run a campaign now" (parameter sweep, background execution, etc.).
 *        These override even a DIRECT_OPENER.
 *     B. DIRECT_OPENER — prompt starts with explain / what-is / review / etc.
 *        Overrides passive campaign vocabulary (Pareto, design space…) because
 *        the user is asking about those concepts, not invoking them.
 *     C. CAMPAIGN_ACTION — action verb (run / compute / launch / 做 / 优化…)
 *        combined with campaign vocabulary anywhere in the prompt.
 *     D. CAMPAIGN_VOCAB — campaign vocabulary without any action verb.
 *        Last resort before the short-question heuristic.
 *     E. Short question (≤ 120 chars, no newlines) → DIRECT.
 *     F. Default → AGENTIC.
 *
 * Layer 3: Environment signals (one async disk read, ~0.1 ms)
 *   Active campaigns on disk → minimum AGENTIC so campaign context is
 *   injected when the user asks about campaign status mid-conversation.
 *
 * Note on Chinese text:
 *   \b word-boundary anchors do NOT work for CJK characters (all CJK chars
 *   are \W, so \b never fires around them). All Chinese patterns use plain
 *   substring matching with no \b.
 */

import Anthropic from '@anthropic-ai/sdk'
import type {
  DetectionConfidence,
  ModeDetectionResult,
  ModeSignal,
  SessionMode,
  SessionModeHint,
} from './types.js'
import { MODE_WEIGHT } from './types.js'
import { CampaignStateStore } from '../campaign/index.js'

// ── Shared timeout utility (Fix #6) ──────────────────────────────────────────

/** Race a promise against a hard timeout; rejects if the timeout fires first. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms} ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

// ── LLM classification ────────────────────────────────────────────────────────
//
// One-shot Haiku call: ~300–500 ms, ~$0.00012 per detection, fires once per
// session. Falls back to heuristic on any error or timeout.

const LLM_DETECTION_MODEL = 'claude-haiku-4-5-20251001'

const LLM_SYSTEM_PROMPT = `\
You are a routing classifier for an engineering AI assistant that has four execution modes.

direct   — The user is asking a question, requesting an explanation, doing a code
           review, or any single-turn conversational request. No tools or background
           computation are needed.

agentic  — The user wants to run a calculation, use tools, query results, or complete
           a multi-step engineering task. Does NOT involve launching a new
           Design-of-Experiments campaign.

campaign — The user explicitly wants to LAUNCH a new Design-of-Experiments (DOE)
           study, parameter sweep, Pareto optimisation, or multi-fidelity evaluation
           campaign. Background workers will run for minutes to hours.

robotics — The user is developing robot algorithms or working on robotics tasks:
  hardware testing, ROS/ROS2 integration, trajectory planning, SLAM, locomotion,
  manipulation, sim-to-real, or deploying algorithms to physical robots.
  Enables multi-agent orchestration and an experience store.

Key distinctions:
- Asking ABOUT campaign concepts (Pareto, DOE phases, fidelity) → direct
- Querying past results or provenance records → agentic
- LAUNCHING a new sweep, optimisation, or DOE → campaign
- A single tool call (one calculation) → agentic, never campaign

Examples:
User: What is the Nusselt number?
Mode: direct

User: Explain the difference between L0 and L1 fidelity.
Mode: direct

User: 帕累托前沿是什么意思？
Mode: direct

User: Explain how the DOE phases work.
Mode: direct

User: Review my Reynolds number calculation — does this look right?
Mode: direct

User: Calculate the drag force on a 0.1 m cylinder at 20 m/s.
Mode: agentic

User: What were the results of the last computation?
Mode: agentic

User: Get me the provenance record for prov-abc123.
Mode: agentic

User: Run the heat transfer simulation for my pipe geometry.
Mode: agentic

User: 计算一下这个翼型在5度攻角下的升阻比。
Mode: agentic

User: Run a DOE on my heat exchanger — vary diameter 0.05–0.2 m and flow rate 1–10 L/s.
Mode: campaign

User: Launch a parameter sweep: temperature 200–400 °C, pressure 1–5 bar, 3 levels each.
Mode: campaign

User: Optimise the wing for minimum drag and maximum lift across the design space.
Mode: campaign

User: 我需要对电池容量（3–5 Ah）和温度（20–40 °C）做参数扫描。
Mode: campaign

User: Start an L0 evaluation campaign for the turbine blade designs.
Mode: campaign

User: 我要开发四足机器人自适应步态算法
Mode: robotics

User: 搜索SLAM论文然后设计实验验证
Mode: robotics

User: 在仿真中测试MPC轨迹追踪
Mode: robotics

User: 实现RL机械臂抓取并部署到ROS2
Mode: robotics

User: 给我解释CPG步态生成器原理
Mode: direct

User: 计算这个关节的最大扭矩
Mode: agentic

Reply with exactly one word: direct, agentic, campaign, or robotics.`

const VALID_MODES = new Set<string>(['direct', 'agentic', 'campaign', 'robotics'])

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Short prompts without newlines are almost always conversational questions. */
function isShortQuestion(prompt: string): boolean {
  return prompt.trim().length <= 120 && !prompt.includes('\n')
}

function firstMatch(
  prompt: string,
  patterns: Array<{ pattern: RegExp; label: string }>,
  mode: SessionMode,
): ModeSignal | null {
  for (const { pattern, label } of patterns) {
    if (pattern.test(prompt)) return { mode, label }
  }
  return null
}

function allMatches(
  prompt: string,
  patterns: Array<{ pattern: RegExp; label: string }>,
  mode: SessionMode,
): ModeSignal[] {
  const out: ModeSignal[] = []
  for (const { pattern, label } of patterns) {
    if (pattern.test(prompt)) out.push({ mode, label })
  }
  return out
}

// ── Tier 0: ROBOTICS_ALWAYS ───────────────────────────────────────────────────
//
// These patterns are inherently robotics-domain imperative signals. They fire
// before CAMPAIGN_ALWAYS and override everything including DIRECT_OPENERs.

const ROBOTICS_ALWAYS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bROS2?\b|roslaunch|rclpy|roscpp/i, label: 'ROS/ROS2 framework' },
  { pattern: /\bSLAM\b|建图定位|激光雷达建图|lidar.{0,8}mapp/i, label: 'SLAM / mapping' },
  { pattern: /步态|gait|locomotion|trajectory.{0,15}robot|机器人.{0,10}轨迹|运动规划/i, label: 'robot motion / gait' },
  { pattern: /机械臂|robotic.?arm|manipulat|end.?effector|抓取算法/i, label: 'robotic arm / manipulation' },
  { pattern: /(?:强化学习|reinforcement.?learning|\bRL\b).{0,30}(?:robot|机器人|硬件|deploy)/i, label: 'RL for robotics' },
  { pattern: /sim.?to.?real|仿真.{0,10}实物|sim2real/i, label: 'sim-to-real' },
  { pattern: /(?:开发|实现|部署|设计实验|验证).{0,30}(?:机器人|robot|四足|六轴|无人机|\bUAV\b|\bdrone\b)/i, label: 'robot algo dev action' },
]

// ── Tier A: CAMPAIGN_ALWAYS ───────────────────────────────────────────────────
//
// These patterns are inherently imperative — they describe an action being
// performed, not a concept being discussed. They override DIRECT_OPENERs.
// No \b used — patterns are specific enough without word-boundary anchors.

const CAMPAIGN_ALWAYS: Array<{ pattern: RegExp; label: string }> = [
  {
    // "parameter sweep" / "参数扫描" are the action itself
    pattern: /参数扫描|parameter.?sweep|grid.?search|扫描优化/i,
    label: 'parameter sweep (inherent action)',
  },
  {
    // Background / parallel execution is always a campaign act
    pattern: /后台运行|background.{0,8}run|run.{0,8}background|并行评估|parallel.{0,8}eval/i,
    label: 'background / parallel execution',
  },
  {
    // Sampling design points is a DOE campaign action
    pattern: /采样.{0,20}设计点|sample.{0,20}design.?point/i,
    label: 'sampling design points',
  },
  {
    // Multi-objective optimization (with 优化/optimization) is a campaign act
    pattern: /多目标优化|multi.?objective.{0,20}optim/i,
    label: 'multi-objective optimization (action)',
  },
  {
    // Running a specific fidelity level
    pattern: /L[012].{0,15}(?:评估|evaluation|fidelity|仿真)/i,
    label: 'L0/L1/L2 fidelity evaluation',
  },
  {
    // Explicit action + DOE/campaign
    pattern: /(?:run|launch|start|execute|做|启动|运行|跑).{0,30}(?:DOE|campaign|实验设计|优化活动)/i,
    label: 'action verb + DOE/campaign',
  },
  {
    // DOE/campaign + explicit action (reverse order)
    pattern: /(?:DOE|campaign|实验设计).{0,30}(?:run|launch|start|执行|启动|运行|跑)/i,
    label: 'DOE/campaign + action verb',
  },
  {
    // "需要" / "want" / "我要" + strong campaign vocab (intent declaration)
    pattern: /(?:我|please).{0,8}(?:需要|want|要).{0,30}(?:参数扫描|DOE|多目标|设计空间|采样)/i,
    label: '"need/want" + campaign action keyword',
  },
]

// ── Tier B: DIRECT_OPENER ─────────────────────────────────────────────────────
//
// Anchored at start-of-string. Signals explanatory intent.
// These override CAMPAIGN_VOCAB but NOT CAMPAIGN_ALWAYS.

const DIRECT_OPENERS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /^(?:解释|请解释|帮我解释|explain\b)/i,  label: '"explain" opener' },
  { pattern: /^(?:什么是|告诉我什么|what\s+is\b|what's\b)/i, label: '"what is" opener' },
  { pattern: /^(?:怎么理解|如何理解|how\s+(?:do|does|should|can)\s+\w+\s+understand)/i, label: '"how to understand" opener' },
  { pattern: /^(?:帮我看|帮我 review|code review\b|review\b)/i, label: '"review" opener' },
  { pattern: /^(?:总结|帮我总结|summarize\b|summarise\b)/i, label: '"summarize" opener' },
  { pattern: /^(?:讨论|我们讨论|discuss\b|let'?s discuss\b)/i, label: '"discuss" opener' },
  { pattern: /^(?:分析|帮我分析|analyse?\b|walk me through\b)/i, label: '"analyze" opener' },
  { pattern: /^(?:介绍|请介绍|tell me about\b|describe\b)/i, label: '"introduce/describe" opener' },
  { pattern: /^(?:比较|对比|compare\b|contrast\b)/i, label: '"compare" opener' },
]

// ── Tier C + D: ACTION verbs + CAMPAIGN vocab ─────────────────────────────────
//
// Tier C: action verb anywhere + campaign vocab anywhere → CAMPAIGN_ACTION
// Tier D: campaign vocab without action → CAMPAIGN_VOCAB (overrideable by DIRECT_OPENER)

const ACTION_VERB_RE_COMBINED = new RegExp(
  '(?:' +
    '\\b(?:run|launch|start|execute|compute|calculate|generate|sample|sweep|optimize|do|begin|build|create)\\b' +
    '|运行|启动|执行|计算|生成|采样|优化|做|跑|建立|创建' +
  ')',
  'i',
)

const CAMPAIGN_VOCAB_RE = new RegExp(
  '(?:' +
    '\\bDOE\\b|\\bpareto\\b|\\bcampaign\\b|\\bfidelity\\b' +
    '|design.?space|design.?point|design.?variable' +
    '|设计空间|设计点|设计变量|帕累托|多目标|保真度|实验设计' +
  ')',
  'i',
)

// Specific strong vocab patterns for Tier D (no action required)
const CAMPAIGN_VOCAB_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bpareto\b|帕累托/i,                   label: 'Pareto (contextual)' },
  { pattern: /\bDOE\b|实验设计/i,                    label: 'DOE (contextual)' },
  { pattern: /design.?space|设计空间/i,              label: 'design space (contextual)' },
  { pattern: /multi.?objective|多目标/i,             label: 'multi-objective (contextual)' },
  { pattern: /\bfidelity\b|保真度/i,                 label: 'fidelity (contextual)' },
  { pattern: /design.?(?:point|variable)|设计(?:点|变量)/, label: 'design point/variable (contextual)' },
]

// ── ModeDetector ──────────────────────────────────────────────────────────────

export class ModeDetector {
  /**
   * Full async detect — layers 1–3 including the env disk check.
   *
   * When `client` is provided, Layer 2 uses a one-shot Haiku call instead of
   * regex heuristics. This costs ~300–500 ms and ~$0.00012 per session, and
   * handles every edge case (language, intent, domain vocabulary) that the
   * heuristics cannot. Falls back to heuristics automatically on any error.
   *
   * Without `client`, behaviour is unchanged from the previous heuristic-only
   * implementation.
   */
  static async detect(
    prompt: string,
    hint: SessionModeHint = 'auto',
    hasTools = false,
    client?: Anthropic,
  ): Promise<ModeDetectionResult> {
    // Layer 1: explicit — bypass everything
    if (hint !== 'auto') {
      return {
        mode: hint,
        confidence: 'explicit',
        signals: [{ mode: hint, label: `caller set mode="${hint}" explicitly` }],
      }
    }

    // Layer 2: LLM classification (preferred) or heuristic fallback
    const classification = client
      ? await ModeDetector._detectWithLLM(prompt, hasTools, client)
      : ModeDetector.detectSync(prompt, 'auto', hasTools)

    // Layer 3: environment — active campaigns bump DIRECT → AGENTIC
    if (classification.mode === 'direct') {
      const hasActiveCampaigns = await ModeDetector._hasActiveCampaigns()
      if (hasActiveCampaigns) {
        return {
          mode: 'agentic',
          confidence: 'env',
          signals: [
            ...classification.signals,
            { mode: 'agentic', label: 'active campaigns on disk → bumped from direct to agentic' },
          ],
        }
      }
    }

    return classification
  }

  /**
   * One-shot Haiku classification. Returns a result with confidence='llm'.
   * On any error (network, timeout, unexpected output) silently falls back
   * to the heuristic path so the session always proceeds.
   */
  private static async _detectWithLLM(
    prompt: string,
    hasTools: boolean,
    client: Anthropic,
  ): Promise<ModeDetectionResult> {
    try {
      // 5 s timeout: routing is on the critical path to the first API call.
      // A network partition or rate-limit backoff should not stall session
      // start for 600 s (SDK default).  Falls back to heuristics on timeout
      // (Fix #6).
      const msg = await withTimeout(
        client.messages.create({
          model: LLM_DETECTION_MODEL,
          max_tokens: 10,
          system: LLM_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: prompt }],
        }),
        5_000,
      )

      const raw = msg.content[0]?.type === 'text'
        ? msg.content[0].text.trim().toLowerCase()
        : ''

      // Gracefully handle unexpected model output by defaulting to 'agentic'
      const llmMode: SessionMode = VALID_MODES.has(raw)
        ? raw as SessionMode
        : 'agentic'

      // hasTools → minimum agentic (consistent with heuristic path rule)
      const mode: SessionMode =
        hasTools && llmMode === 'direct' ? 'agentic' : llmMode

      return {
        mode,
        confidence: 'llm',
        signals: [{ mode, label: `Haiku classified as "${llmMode}"${mode !== llmMode ? ' → raised to agentic (tools registered)' : ''}` }],
      }
    } catch {
      // Network error, timeout, rate limit — fall through to heuristics
      return ModeDetector.detectSync(prompt, 'auto', hasTools)
    }
  }

  /**
   * Synchronous detect — layers 1 and 2 only (no disk I/O).
   */
  static detectSync(
    prompt: string,
    hint: SessionModeHint = 'auto',
    hasTools = false,
  ): ModeDetectionResult {
    // Layer 1: explicit
    if (hint !== 'auto') {
      return {
        mode: hint,
        confidence: 'explicit',
        signals: [{ mode: hint, label: `caller set mode="${hint}" explicitly` }],
      }
    }

    // Tools pre-registered → at least AGENTIC (tracked as a signal but won't
    // prevent CAMPAIGN/ROBOTICS detection below)
    const toolSignal: ModeSignal | null = hasTools
      ? { mode: 'agentic', label: 'tools pre-registered → minimum agentic' }
      : null

    // ── Tier 0: ROBOTICS_ALWAYS ──────────────────────────────────────────────
    const roboticsSignal = firstMatch(prompt, ROBOTICS_ALWAYS, 'robotics')
    if (roboticsSignal) {
      return { mode: 'robotics', confidence: 'heuristic', signals: [roboticsSignal, ...(toolSignal ? [toolSignal] : [])] }
    }

    // ── Tier A: CAMPAIGN_ALWAYS ─────────────────────────────────────────────
    const alwaysSignal = firstMatch(prompt, CAMPAIGN_ALWAYS, 'campaign')
    if (alwaysSignal) {
      return {
        mode: 'campaign',
        confidence: 'heuristic',
        signals: [alwaysSignal, ...(toolSignal ? [toolSignal] : [])],
      }
    }

    // ── Tier B: DIRECT_OPENER ───────────────────────────────────────────────
    // Check opener before action+vocab (explanatory intent dominates passive vocab)
    const opener = firstMatch(prompt, DIRECT_OPENERS, 'direct')

    // ── Tier C: CAMPAIGN_ACTION (action verb + vocab, only if no opener) ────
    if (!opener) {
      const hasAction = ACTION_VERB_RE_COMBINED.test(prompt)
      const hasVocab  = CAMPAIGN_VOCAB_RE.test(prompt)
      if (hasAction && hasVocab) {
        return {
          mode: 'campaign',
          confidence: 'heuristic',
          signals: [
            { mode: 'campaign', label: 'action verb + campaign vocabulary' },
            ...(toolSignal ? [toolSignal] : []),
          ],
        }
      }
    }

    // ── Tier B result: opener wins over contextual vocab ────────────────────
    if (opener) {
      // If opener present, return DIRECT (CAMPAIGN_VOCAB cannot override opener)
      return {
        mode: 'direct',
        confidence: 'heuristic',
        signals: [opener, ...(toolSignal ? [toolSignal] : [])],
      }
    }

    // ── Tier D: CAMPAIGN_VOCAB only (no action, no opener) ──────────────────
    if (!hasTools) {
      const vocabSignals = allMatches(prompt, CAMPAIGN_VOCAB_PATTERNS, 'campaign')
      if (vocabSignals.length > 0) {
        return { mode: 'campaign', confidence: 'heuristic', signals: vocabSignals }
      }
    }

    // ── Tier E: Short question → DIRECT ────────────────────────────────────
    if (!hasTools && isShortQuestion(prompt)) {
      return {
        mode: 'direct',
        confidence: 'heuristic',
        signals: [{ mode: 'direct', label: 'short question (≤120 chars)' }],
      }
    }

    // ── Tier F: Default ─────────────────────────────────────────────────────
    return {
      mode: 'agentic',
      confidence: 'default',
      signals: [
        { mode: 'agentic', label: 'no signals matched → default agentic' },
        ...(toolSignal ? [toolSignal] : []),
      ],
    }
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  /**
   * Check for genuinely active campaigns by reading disk state directly.
   *
   * Intentionally bypasses MetaAgentContextStore (the context file cache)
   * because that file is only refreshed when CampaignMonitor completes a
   * phase — it can lag hours behind reality for abandoned campaigns.
   *
   * Calling CampaignStateStore.listActive() instead:
   *   • Triggers zombie auto-expiry for stale campaigns (marks them FAILED)
   *   • Returns accurate count without relying on a potentially stale file
   *   • Cost: one readdir + N small JSON reads — acceptable for the once-per-
   *     session first-submit path; ~1–5 ms for typical campaign counts
   */
  private static async _hasActiveCampaigns(): Promise<boolean> {
    try {
      const active = await CampaignStateStore.listActive()
      return active.length > 0
    } catch {
      return false
    }
  }
}
