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

/**
 * Hard cap on the underlying flash request (abort). Kept short so a request that
 * loses the wait-budget race below does not linger for minutes burning tokens on
 * a result the current turn has already moved past.
 */
const QUERY_ANALYSIS_TIMEOUT_MS = 8_000

/**
 * Default soft cap on how long analyze() will WAIT for the flash result before
 * returning the heuristic fallback for the current turn. Decoupled from the
 * request's own abort timeout so the caller is bounded regardless of whether the
 * provider honors the abort signal.
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

const DOMAIN_KEYWORDS: Partial<Record<RoboticsDomain, string[]>> = {
  motion_planning:    ['trajectory', 'path planning', 'motion', 'planner', 'rrt', 'prm', 'ompl',
                       '轨迹', '路径规划', '运动规划', '规划'],
  perception:         ['camera', 'lidar', 'point cloud', 'detection', 'yolo', 'slam', 'mapping',
                       '相机', '摄像头', '激光雷达', '点云', '检测', '识别', '建图', '感知'],
  manipulation:       ['grasp', 'pick', 'place', 'gripper', 'arm', 'end effector', 'manipulation',
                       '抓取', '夹爪', '机械臂', '末端', '操作'],
  locomotion:         ['walk', 'gait', 'locomotion', 'leg', 'quadruped', 'bipedal', 'balance',
                       '行走', '步态', '四足', '双足', '平衡', '腿足'],
  navigation:         ['navigate', 'map', 'localization', 'amcl', 'costmap', 'nav2', 'move_base',
                       '导航', '定位', '地图', '代价地图', '避障'],
  calibration:        ['calibrat', 'tune', 'pid', 'gain', 'parameter', 'offset', 'imu',
                       '标定', '校准', '调参', '参数', '增益', '偏置', '整定'],
  hardware_interface: ['joint', 'motor', 'actuator', 'sensor', 'interface', 'driver', 'can bus',
                       '关节', '电机', '驱动', '传感器', '接口', '总线', '舵机'],
  deployment:         ['deploy', 'launch', 'ros2', 'systemd', 'docker', 'real robot',
                       '部署', '上线', '发布', '启动'],
  simulation:         ['sim', 'gazebo', 'mujoco', 'pybullet', 'isaac', 'virtual', 'simulated',
                       '仿真', '虚拟', '模拟', '物理引擎'],
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
    const flashPromise: Promise<QueryIntent | null> = this.flash
      .query({
        system: ANALYSIS_SYSTEM,
        user: trimmed.slice(0, 800),
        maxTokens: 250,
        timeoutMs: QUERY_ANALYSIS_TIMEOUT_MS,
        cacheKey,
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
