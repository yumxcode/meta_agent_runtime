/**
 * QueryAnalyzer — flash-model based query intent analysis.
 *
 * Analyzes the user's prompt before each turn to determine:
 *   - Which robotics domains are relevant
 *   - Whether real hardware execution / simulation is likely
 *   - Keywords to pre-fetch failure records from ExperienceStore
 *   - Broad intent classification (debug / deploy / experiment / etc.)
 *
 * Uses a FlashModel side-call for semantic understanding, but NEVER blocks the
 * caller on it: analyze() waits at most `waitBudgetMs` (default 5s) and then
 * returns the heuristic keyword analysis for the current turn. The flash request
 * continues in the background (bounded by QUERY_ANALYSIS_TIMEOUT_MS) only to
 * populate the cache for an identical resubmit — it can never stall the agent's
 * first tool call, even when the provider is slow or the network jitters.
 *
 * Falls back to heuristic keyword analysis on timeout/failure too.
 *
 * Results are cached by query content hash, so identical follow-up prompts
 * incur zero additional latency.
 */

import type { FlashClient } from '../core/flash/FlashClient.js'
import type { RoboticsDomain } from '../robotics/types.js'

// ─────────────────────────────────────────────────────────────────────────────
// QueryIntent
// ─────────────────────────────────────────────────────────────────────────────

export interface QueryIntent {
  /** Robotics domains likely relevant to this query */
  domains: RoboticsDomain[]
  /** True if the query likely involves real hardware execution */
  hasHardware: boolean
  /** True if the query likely involves simulation only */
  hasSimulation: boolean
  /** Keywords to use for ExperienceStore failure pre-fetch */
  searchKeywords: string[]
  /** Broad intent classification */
  intent: 'debug' | 'deploy' | 'experiment' | 'calibrate' | 'query' | 'plan'
}

// ─────────────────────────────────────────────────────────────────────────────
// Flash model system prompt
// ─────────────────────────────────────────────────────────────────────────────

const ANALYSIS_SYSTEM = `\
You analyze a robotics engineering agent's user query to pre-load relevant context.

Output a single JSON object, no markdown, no explanation:
{
  "domains": string[],
  "hasHardware": boolean,
  "hasSimulation": boolean,
  "searchKeywords": string[],
  "intent": "debug" | "deploy" | "experiment" | "calibrate" | "query" | "plan"
}

Field rules:
- domains: subset of [motion_planning, perception, manipulation, locomotion, navigation, simulation, hardware_interface, deployment, calibration, general]. Include ALL that apply.
- hasHardware: true if query mentions deploying to real robot, real hardware, physical test, actual execution, "on the robot", "run on", enabling motors, ROS deployment commands.
- hasSimulation: true if query mentions simulation, sim, virtual, gazebo, mujoco, pybullet, isaac, test environment.
- searchKeywords: 3-6 specific technical terms (algorithm names, component names, error types). NOT generic words like "robot", "test", "run", "check".
- intent: "debug" = diagnosing existing issue; "deploy" = running on real hardware; "experiment" = running new sim or algorithm test; "calibrate" = tuning parameters; "query" = asking a question; "plan" = planning future steps.`

/** Output cap for the intent JSON. Drives the derived request timeout below. */
const QUERY_ANALYSIS_MAX_TOKENS = 250

/**
 * Default soft cap on how long analyze() will WAIT for the flash result before
 * returning the heuristic fallback for the current turn.
 *
 * THIS is the bound that protects the turn, and it is the only one that needs
 * to be tight. The request's own abort timeout is deliberately NOT tightened to
 * match (see the note in analyze()).
 */
const QUERY_ANALYSIS_WAIT_BUDGET_MS = 5_000

// ─────────────────────────────────────────────────────────────────────────────
// Heuristic fallback
// ─────────────────────────────────────────────────────────────────────────────

// Keyword tables are bilingual (English + Chinese) so the heuristic fallback
// stays useful when the user works in Chinese and the flash side-call is slow.
// Matching is substring-based (lower.includes), which works for CJK directly.

const HW_KEYWORDS = [
  // English
  'real robot', 'deploy', 'physical', 'hardware', 'on the robot',
  'ros2 run', 'ros run', 'launch', 'enable motor', 'power on', 'actual',
  // Chinese
  '真机', '实机', '实物', '真实机器人', '上机', '上电', '硬件', '实车', '使能', '部署到',
]

const SIM_KEYWORDS = [
  'sim', 'gazebo', 'mujoco', 'pybullet', 'isaac', 'virtual', 'simulated',
  '仿真', '虚拟', '模拟',
]

/**
 * Domain tables carry more weight than "a nicer fallback" now: IntentScheduler
 * uses heuristic domains as its CHANGE DETECTOR, so a domain the table cannot
 * name is a topic switch the scheduler cannot see.
 *
 * The gaps below were found by running three real user messages through the
 * heuristic — all three returned `general`:
 *   "把 MPC 的求解频率提到 200Hz 然后在真机上跑一遍"
 *      → motion_planning had rrt/prm/ompl but no mpc/lqr/wbc/control at all,
 *        and `真机` lived only in HW_KEYWORDS (which drives hasHardware), never
 *        in deployment's domain table.
 *   "好像报错了，查看下"        → genuinely domain-less; still `general`, correctly.
 *   "…验证重定向的结果"         → retargeting/motion; `重定向` was absent.
 *
 * Substring matching means short latin entries must stay specific: 'arm' would
 * match 'alarm', 'can' would match 'cannot'. Entries here are either ≥4 chars,
 * word-like enough to be safe in context, or CJK.
 */
const DOMAIN_KEYWORDS: Partial<Record<RoboticsDomain, string[]>> = {
  motion_planning:    ['trajectory', 'path planning', 'motion', 'planner', 'rrt', 'prm', 'ompl',
                       // Optimal / model-predictive control is the single most
                       // common vocabulary in this domain and was entirely absent.
                       'mpc', 'lqr', 'ilqr', 'ddp', 'wbc', 'whole-body', 'trajopt',
                       'controller', 'control loop', 'retarget',
                       '轨迹', '路径规划', '运动规划', '规划', '控制器', '模型预测', '最优控制',
                       '重定向', '全身控制'],
  perception:         ['camera', 'lidar', 'point cloud', 'detection', 'yolo', 'slam', 'mapping',
                       'depth', 'stereo', 'segmentation', 'odometry', 'vio',
                       '相机', '摄像头', '激光雷达', '点云', '检测', '识别', '建图', '感知',
                       '深度图', '里程计', '分割'],
  manipulation:       ['grasp', 'pick', 'place', 'gripper', 'end effector', 'manipulation',
                       'ik ', 'inverse kinematics', 'wrench',
                       '抓取', '夹爪', '机械臂', '末端', '操作', '逆运动学', '力控'],
  locomotion:         ['walk', 'gait', 'locomotion', 'quadruped', 'bipedal', 'balance',
                       'footstep', 'stance', 'swing',
                       '行走', '步态', '四足', '双足', '平衡', '腿足', '落足', '支撑相'],
  navigation:         ['navigate', 'localization', 'amcl', 'costmap', 'nav2', 'move_base',
                       'waypoint', 'global plan', 'local plan',
                       '导航', '定位', '地图', '代价地图', '避障', '路点'],
  calibration:        ['calibrat', 'tune', 'pid', 'gain', 'parameter', 'offset', 'imu',
                       'bias', 'extrinsic', 'intrinsic', 'drift',
                       '标定', '校准', '调参', '参数', '增益', '偏置', '整定', '零偏', '外参', '内参', '漂移'],
  hardware_interface: ['joint', 'motor', 'actuator', 'sensor', 'interface', 'driver', 'can bus',
                       'canbus', 'ethercat', 'encoder', 'torque limit', 'firmware', 'gpio',
                       '关节', '电机', '驱动', '传感器', '接口', '总线', '舵机', '编码器', '固件', '力矩上限'],
  deployment:         ['deploy', 'launch', 'ros2', 'systemd', 'docker', 'real robot',
                       'on the robot', 'onboard', 'cross-compile', 'rollout',
                       '部署', '上线', '发布', '启动', '真机', '实机', '实车', '上机', '上电', '板载'],
  simulation:         ['sim', 'gazebo', 'mujoco', 'pybullet', 'isaac', 'virtual', 'simulated',
                       'sim2real', 'rollout in sim', 'domain randomization',
                       '仿真', '虚拟', '模拟', '物理引擎', '域随机化'],
}

// Noise words that should not become search keywords (bilingual).
const KEYWORD_STOPWORDS = new Set([
  'robot', 'test', 'with', 'that', 'this', 'from', 'will', 'have', 'the', 'and',
  '机器人', '怎么', '如何', '为什么', '为啥', '这个', '那个', '可以', '需要',
  '一下', '请问', '帮我', '现在', '然后', '问题',
])

/**
 * A keyword carries enough signal to substring-match stored experience text if
 * it has ≥3 latin/digit chars OR ≥2 CJK chars — Chinese technical terms
 * (步态 / 标定 / 力矩 / 抓取) are very often exactly two characters.
 */
function isUsableKeyword(kw: string): boolean {
  if (KEYWORD_STOPWORDS.has(kw)) return false
  if (kw.length >= 3) return true
  return kw.length === 2 && /[一-鿿]/.test(kw)
}

/**
 * Language-agnostic keyword extraction for the heuristic fallback.
 *
 * Chinese has no spaces, so splitting on whitespace would collapse the whole
 * query into one useless token. Instead we pull:
 *   - latin/digit runs (algorithm / component names — mpc, slam, pid, nav2), and
 *   - overlapping 2-grams over each contiguous CJK run (步态调试 → 步态, 态调, 调试),
 * which substring-match stored experiences far better than the raw sentence.
 * Latin tokens are emitted first so high-signal acronyms survive the cap.
 */
function extractKeywords(lower: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const push = (kw: string) => {
    if (seen.has(kw) || !isUsableKeyword(kw)) return
    seen.add(kw)
    out.push(kw)
  }

  for (const m of lower.matchAll(/[a-z0-9_]+/g)) push(m[0])

  for (const run of lower.matchAll(/[一-鿿]+/g)) {
    const s = run[0]
    if (s.length === 2) { push(s); continue }
    for (let i = 0; i + 2 <= s.length; i++) push(s.slice(i, i + 2))
  }

  return out.slice(0, 8)
}

/**
 * Pure, local, zero-cost intent extraction.
 *
 * Exported because IntentScheduler needs it for two jobs beyond being a
 * fallback: it supplies the per-TURN fields (searchKeywords / intent) on turns
 * that do not refresh, and its `domains` output is the change detector that
 * decides when a refresh is warranted at all.
 */
export function heuristicIntent(query: string): QueryIntent {
  return heuristicFallback(query)
}

function heuristicFallback(query: string): QueryIntent {
  const lower = query.toLowerCase()
  const has = (...needles: string[]) => needles.some(n => lower.includes(n))

  const hasHardware = HW_KEYWORDS.some(kw => lower.includes(kw))
  const hasSimulation = SIM_KEYWORDS.some(kw => lower.includes(kw))

  const domains: RoboticsDomain[] = []
  for (const [domain, kws] of Object.entries(DOMAIN_KEYWORDS)) {
    if (kws!.some(kw => lower.includes(kw))) {
      domains.push(domain as RoboticsDomain)
    }
  }
  if (domains.length === 0) domains.push('general')

  const searchKeywords = extractKeywords(lower)

  const intent: QueryIntent['intent'] =
    has('debug', 'error', 'why', '调试', '报错', '错误', '为什么', '为啥', '故障', '异常', '排查', '崩溃') ? 'debug' :
    has('deploy', 'launch', '部署', '上线', '发布', '真机', '上机') || hasHardware ? 'deploy' :
    has('calibrat', 'tune', '标定', '校准', '调参', '整定') ? 'calibrate' :
    has('plan', '计划', '方案', '步骤', '接下来') ? 'plan' :
    has('experiment', 'test', '实验', '测试', '试验', '验证') ? 'experiment' : 'query'

  return { domains, hasHardware, hasSimulation, searchKeywords, intent }
}

// ─────────────────────────────────────────────────────────────────────────────
// QueryAnalyzer
// ─────────────────────────────────────────────────────────────────────────────

/** Simple djb2-style hash for cache keys (not cryptographic). */
function hashish(text: string): string {
  let h = 5381
  for (let i = 0; i < Math.min(text.length, 300); i++) {
    h = (h * 33) ^ text.charCodeAt(i)
  }
  return (h >>> 0).toString(36)
}

const VALID_DOMAINS = new Set<string>([
  'motion_planning', 'perception', 'manipulation', 'locomotion', 'navigation',
  'simulation', 'hardware_interface', 'deployment', 'calibration', 'general',
])

function isValidIntent(value: unknown): value is QueryIntent['intent'] {
  return ['debug', 'deploy', 'experiment', 'calibrate', 'query', 'plan'].includes(value as string)
}

function parseFlashResponse(raw: string): QueryIntent | null {
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return null
    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>

    const domains = Array.isArray(parsed['domains'])
      ? (parsed['domains'] as unknown[]).filter((d): d is RoboticsDomain => VALID_DOMAINS.has(d as string))
      : ['general' as RoboticsDomain]

    const intent = isValidIntent(parsed['intent']) ? parsed['intent'] : 'query'

    const searchKeywords = Array.isArray(parsed['searchKeywords'])
      ? (parsed['searchKeywords'] as unknown[]).filter((k): k is string => typeof k === 'string').slice(0, 8)
      : []

    return {
      domains: domains.length > 0 ? domains : ['general'],
      hasHardware: Boolean(parsed['hasHardware']),
      hasSimulation: Boolean(parsed['hasSimulation']),
      searchKeywords,
      intent,
    }
  } catch {
    return null
  }
}

export interface QueryAnalyzerOptions {
  /**
   * Max time analyze() will WAIT for the flash side-call before returning the
   * heuristic fallback for the current turn. Defaults to
   * QUERY_ANALYSIS_WAIT_BUDGET_MS. Exposed mainly so tests can shrink it.
   */
  waitBudgetMs?: number
}

export class QueryAnalyzer {
  private readonly waitBudgetMs: number

  constructor(private readonly flash: FlashClient, opts: QueryAnalyzerOptions = {}) {
    this.waitBudgetMs = opts.waitBudgetMs ?? QUERY_ANALYSIS_WAIT_BUDGET_MS
  }

  /**
   * Analyze a user query to determine what context should be pre-loaded.
   *
   * Always returns a valid QueryIntent — and always within `waitBudgetMs`. The
   * flash side-call races a soft deadline: if flash answers in time its parsed
   * intent is used, otherwise the heuristic fallback is returned for this turn
   * and the flash request is left to finish in the background (bounded by
   * QUERY_ANALYSIS_TIMEOUT_MS) solely to warm the cache for an identical
   * resubmit. This keeps the agent's first tool call off the flash latency path.
   */
  async analyze(query: string): Promise<QueryIntent> {
    const trimmed = query.trim()
    if (!trimmed) return heuristicFallback('')

    const cacheKey = `qa:${hashish(trimmed)}`

    // Kick off the flash analysis. flash.query catches its own errors/timeouts
    // and resolves to null, so this promise never rejects. We do NOT await it
    // directly — it races the wait budget below. When it loses the race it keeps
    // running in the background and populates the cache via cacheKey.
    //
    // No explicit timeoutMs: the request gets the standard DERIVED budget
    // (flashTimeoutMs(250) ≈ 42s with the default flashTtftMs of 30s).
    //
    // It used to hard-code 8s, on the reasoning that a request which lost the
    // race should not "linger burning tokens". That was 5.3× tighter than this
    // codebase's own latency model — the default first-token budget alone is
    // 30s — so on any provider that is not unusually fast the call was designed
    // to fail. Two consequences, both observed in robotics mode:
    //   • it timed out ~3s after the turn had already moved on, and the failure
    //     warning printed into the middle of the streaming response;
    //   • flash therefore NEVER won the race, so intent analysis was silently
    //     degraded to keyword heuristics on every single turn.
    // The 8s bought nothing either way: the wait budget above already
    // guarantees the turn is never blocked, and 250 output tokens is not a cost
    // worth defending against.
    const flashPromise: Promise<QueryIntent | null> = this.flash
      .query({
        system: ANALYSIS_SYSTEM,
        user: trimmed.slice(0, 800),
        maxTokens: QUERY_ANALYSIS_MAX_TOKENS,
        cacheKey,
        // Losing the race is the normal, expected outcome on a slow provider —
        // report it as an aggregate, never as a per-turn warning.
        speculative: true,
        label: 'query-intent-analysis',
      })
      .then(raw => (raw ? parseFlashResponse(raw) : null))
      .catch(() => null)

    // Soft deadline: resolves to null after the wait budget. unref() so a
    // pending timer never keeps the process alive.
    let budgetTimer: ReturnType<typeof setTimeout> | undefined
    const budget = new Promise<null>(resolve => {
      budgetTimer = setTimeout(() => resolve(null), this.waitBudgetMs)
      budgetTimer.unref?.()
    })

    try {
      const winner = await Promise.race([flashPromise, budget])
      // winner is the parsed flash intent only when flash both won the race AND
      // produced a parseable result; every other path falls back to heuristics.
      return winner ?? heuristicFallback(trimmed)
    } finally {
      if (budgetTimer) clearTimeout(budgetTimer)
    }
  }
}
