/**
 * QueryAnalyzer — flash-model based query intent analysis.
 *
 * Analyzes the user's prompt before each turn to determine:
 *   - Which robotics domains are relevant
 *   - Whether real hardware execution is likely
 *   - Risk level (drives safety limit pre-loading)
 *   - Keywords to pre-fetch failure records from ExperienceStore
 *   - Broad intent classification (debug / deploy / experiment / etc.)
 *
 * Uses a FlashModel side-call (3 s timeout) for semantic understanding.
 * Falls back to heuristic keyword analysis on timeout/failure.
 *
 * Results are cached by query content hash, so identical follow-up prompts
 * incur zero additional latency.
 */
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
  "riskLevel": "low" | "medium" | "high",
  "searchKeywords": string[],
  "intent": "debug" | "deploy" | "experiment" | "calibrate" | "query" | "plan"
}

Field rules:
- domains: subset of [motion_planning, perception, manipulation, locomotion, navigation, simulation, hardware_interface, deployment, calibration, general]. Include ALL that apply.
- hasHardware: true if query mentions deploying to real robot, real hardware, physical test, actual execution, "on the robot", "run on", enabling motors, ROS deployment commands.
- hasSimulation: true if query mentions simulation, sim, virtual, gazebo, mujoco, pybullet, isaac, test environment.
- riskLevel: "high" if hasHardware=true OR query mentions joint motion, velocity/torque/force commands, gripper, power on/off; "medium" if experiment with unknown outcome; "low" otherwise.
- searchKeywords: 3-6 specific technical terms (algorithm names, component names, error types). NOT generic words like "robot", "test", "run", "check".
- intent: "debug" = diagnosing existing issue; "deploy" = running on real hardware; "experiment" = running new sim or algorithm test; "calibrate" = tuning parameters; "query" = asking a question; "plan" = planning future steps.`;
// ─────────────────────────────────────────────────────────────────────────────
// Heuristic fallback
// ─────────────────────────────────────────────────────────────────────────────
const HW_KEYWORDS = [
    'real robot', 'deploy', 'physical', 'hardware', 'on the robot',
    'ros2 run', 'ros run', 'launch', 'enable motor', 'power on', 'actual',
];
const HIGH_RISK_KEYWORDS = [
    'velocity', 'torque', 'force', 'joint', 'gripper', 'motor', 'actuator',
    'move', 'command', 'execute', 'deploy',
];
const DOMAIN_KEYWORDS = {
    motion_planning: ['trajectory', 'path planning', 'motion', 'planner', 'rrt', 'prm', 'ompl'],
    perception: ['camera', 'lidar', 'point cloud', 'detection', 'yolo', 'slam', 'mapping'],
    manipulation: ['grasp', 'pick', 'place', 'gripper', 'arm', 'end effector', 'manipulation'],
    locomotion: ['walk', 'gait', 'locomotion', 'leg', 'quadruped', 'bipedal', 'balance'],
    navigation: ['navigate', 'map', 'localization', 'amcl', 'costmap', 'nav2', 'move_base'],
    calibration: ['calibrat', 'tune', 'pid', 'gain', 'parameter', 'offset', 'imu'],
    hardware_interface: ['joint', 'motor', 'actuator', 'sensor', 'interface', 'driver', 'can bus'],
    deployment: ['deploy', 'launch', 'ros2', 'systemd', 'docker', 'real robot'],
    simulation: ['sim', 'gazebo', 'mujoco', 'pybullet', 'isaac', 'virtual', 'simulated'],
};
function heuristicFallback(query) {
    const lower = query.toLowerCase();
    const words = lower.split(/\s+/);
    const hasHardware = HW_KEYWORDS.some(kw => lower.includes(kw));
    const hasSimulation = ['sim', 'gazebo', 'mujoco', 'pybullet', 'virtual'].some(kw => lower.includes(kw));
    const riskLevel = hasHardware ? 'high' :
        HIGH_RISK_KEYWORDS.some(kw => lower.includes(kw)) ? 'medium' : 'low';
    const domains = [];
    for (const [domain, kws] of Object.entries(DOMAIN_KEYWORDS)) {
        if (kws.some(kw => lower.includes(kw))) {
            domains.push(domain);
        }
    }
    if (domains.length === 0)
        domains.push('general');
    const searchKeywords = words
        .filter(w => w.length > 4 && !['robot', 'test', 'with', 'that', 'this', 'from', 'will'].includes(w))
        .slice(0, 6);
    const intent = lower.includes('debug') || lower.includes('error') || lower.includes('why') ? 'debug' :
        lower.includes('deploy') || lower.includes('launch') || hasHardware ? 'deploy' :
            lower.includes('calibrat') || lower.includes('tune') ? 'calibrate' :
                lower.includes('plan') ? 'plan' :
                    lower.includes('experiment') || lower.includes('test') ? 'experiment' : 'query';
    return { domains, hasHardware, hasSimulation, riskLevel, searchKeywords, intent };
}
// ─────────────────────────────────────────────────────────────────────────────
// QueryAnalyzer
// ─────────────────────────────────────────────────────────────────────────────
/** Simple djb2-style hash for cache keys (not cryptographic). */
function hashish(text) {
    let h = 5381;
    for (let i = 0; i < Math.min(text.length, 300); i++) {
        h = (h * 33) ^ text.charCodeAt(i);
    }
    return (h >>> 0).toString(36);
}
const VALID_DOMAINS = new Set([
    'motion_planning', 'perception', 'manipulation', 'locomotion', 'navigation',
    'simulation', 'hardware_interface', 'deployment', 'calibration', 'general',
]);
function isValidIntent(value) {
    return ['debug', 'deploy', 'experiment', 'calibrate', 'query', 'plan'].includes(value);
}
function parseFlashResponse(raw) {
    try {
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (!jsonMatch)
            return null;
        const parsed = JSON.parse(jsonMatch[0]);
        const domains = Array.isArray(parsed['domains'])
            ? parsed['domains'].filter((d) => VALID_DOMAINS.has(d))
            : ['general'];
        const riskLevel = ['low', 'medium', 'high'].includes(parsed['riskLevel'])
            ? parsed['riskLevel']
            : 'medium';
        const intent = isValidIntent(parsed['intent']) ? parsed['intent'] : 'query';
        const searchKeywords = Array.isArray(parsed['searchKeywords'])
            ? parsed['searchKeywords'].filter((k) => typeof k === 'string').slice(0, 8)
            : [];
        return {
            domains: domains.length > 0 ? domains : ['general'],
            hasHardware: Boolean(parsed['hasHardware']),
            hasSimulation: Boolean(parsed['hasSimulation']),
            riskLevel,
            searchKeywords,
            intent,
        };
    }
    catch {
        return null;
    }
}
export class QueryAnalyzer {
    flash;
    constructor(flash) {
        this.flash = flash;
    }
    /**
     * Analyze a user query to determine what context should be pre-loaded.
     *
     * Always returns a valid QueryIntent — falls back to heuristics if the
     * flash model call times out or returns unparseable output.
     */
    async analyze(query) {
        const trimmed = query.trim();
        if (!trimmed)
            return heuristicFallback('');
        const cacheKey = `qa:${hashish(trimmed)}`;
        const raw = await this.flash.query({
            system: ANALYSIS_SYSTEM,
            user: trimmed.slice(0, 800),
            maxTokens: 250,
            timeoutMs: 3_000,
            cacheKey,
        });
        if (raw) {
            const parsed = parseFlashResponse(raw);
            if (parsed)
                return parsed;
        }
        // Fallback: heuristic analysis (never fails)
        return heuristicFallback(trimmed);
    }
}
//# sourceMappingURL=QueryAnalyzer.js.map