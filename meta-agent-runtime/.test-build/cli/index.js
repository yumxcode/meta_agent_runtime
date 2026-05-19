/**
 * meta-agent CLI
 *
 * Usage:
 *   meta-agent [options] [prompt]
 *
 * Interactive REPL (no prompt given):
 *   meta-agent
 *   meta-agent --mode agentic
 *
 * Single-turn (prompt given):
 *   meta-agent "what is Pareto optimality?"
 *   meta-agent --mode campaign "run a DOE sweep"
 *
 * Options:
 *   -m, --mode <mode>       Session mode: auto|direct|agentic|campaign (default: auto)
 *   -k, --api-key <key>     API key (or ANTHROPIC_API_KEY / DEEPSEEK_API_KEY env var)
 *       --model <model>     Model override (default: auto-detected from provider)
 *   -s, --system <prompt>   Custom system prompt
 *   -j, --json              Output raw JSON events (for piping)
 *   -v, --version           Show version
 *   -h, --help              Show help
 */
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline';
import { resolve, join } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { SessionRouter } from '../routing/SessionRouter.js';
import { HardwareProfile } from '../robotics/HardwareProfile.js';
import { ExperienceStore } from '../robotics/ExperienceStore.js';
import { SessionStore } from '../core/SessionStore.js';
import { resolveTemplate } from './hardwareTemplate.js';
// ── Version ───────────────────────────────────────────────────────────────────
const VERSION = '0.1.0';
// ── ANSI colour helpers ───────────────────────────────────────────────────────
const isTTY = process.stdout.isTTY;
const c = {
    reset: isTTY ? '\x1b[0m' : '',
    bold: isTTY ? '\x1b[1m' : '',
    dim: isTTY ? '\x1b[2m' : '',
    cyan: isTTY ? '\x1b[36m' : '',
    green: isTTY ? '\x1b[32m' : '',
    yellow: isTTY ? '\x1b[33m' : '',
    blue: isTTY ? '\x1b[34m' : '',
    magenta: isTTY ? '\x1b[35m' : '',
    red: isTTY ? '\x1b[31m' : '',
    gray: isTTY ? '\x1b[90m' : '',
};
const dim = (s) => `${c.dim}${s}${c.reset}`;
const bold = (s) => `${c.bold}${s}${c.reset}`;
const cyan = (s) => `${c.cyan}${s}${c.reset}`;
const green = (s) => `${c.green}${s}${c.reset}`;
const gray = (s) => `${c.gray}${s}${c.reset}`;
const red = (s) => `${c.red}${s}${c.reset}`;
const yellow = (s) => `${c.yellow}${s}${c.reset}`;
// ── Help text ─────────────────────────────────────────────────────────────────
function printHelp() {
    console.log(`
${bold('meta-agent')} — Engineering agent runtime CLI  ${dim(`v${VERSION}`)}

${bold('USAGE')}
  meta-agent [options] [prompt]

${bold('MODES')}
  ${cyan('auto')}       Detect mode from prompt context (default)
  ${cyan('direct')}     Single Q&A turn, no tool loop
  ${cyan('agentic')}    Full tool-use loop
  ${cyan('campaign')}   DOE / multi-objective optimisation campaign
  ${cyan('robotics')}   Robotics session — ExperienceStore + workflow + hardware profiles

${bold('OPTIONS')}
  -m, --mode <mode>       Session mode: auto|direct|agentic|campaign|robotics
  -w, --workspace <dir>   Working directory — agent ONLY operates within this folder
  -k, --api-key <key>     API key (or set DEEPSEEK_API_KEY / ANTHROPIC_API_KEY env var)
  -b, --base-url <url>    API base URL (default: auto-detected from key)
      --model <model>   Model override (default: deepseek-v4-flash)
  -s, --system <text>   Custom system prompt
  -t, --max-turns <n>   Max agentic turns per message (default: unlimited)
  -r, --resume <id>     Resume a previous session by ID (or "last" for most recent)
  -d, --debug           Debug mode: log full prompts + responses to stderr each turn
  -j, --json            Output raw JSON events
  -v, --version         Print version
  -h, --help            Show this help

${bold('INTERACTIVE COMMANDS')}
  /mode                 Show current session mode
  /workspace            Show current workspace directory
  /hardware             Show bound hardware profile (robotics mode)
  /hardware select      Re-run hardware profile selection wizard
  /usage                Show token usage & estimated cost
  /sessions             List saved sessions; pick one to resume
  /experience           Show pending experience queue (robotics mode)
  /experience review    Interactively review & commit pending experiences
  /clear                Start a new session (same workspace/hardware)
  /exit  or  Ctrl+D     Quit

${bold('ENVIRONMENT VARIABLES')}
  DEEPSEEK_API_KEY      DeepSeek API key  ${dim('← default provider')}
  ANTHROPIC_API_KEY     Anthropic API key
  QWEN_API_KEY          Qwen API key

  Priority: DEEPSEEK_API_KEY > QWEN_API_KEY > ANTHROPIC_API_KEY

${bold('EXAMPLES')}
  ${gray('# Set key once, then use freely')}
  export DEEPSEEK_API_KEY="sk-..."
  meta-agent

  ${gray('# Single-turn question (uses deepseek-v4-flash by default)')}
  meta-agent "解释一下 Pareto 最优"

  ${gray('# Heavier reasoning — switch to R1')}
  meta-agent --model deepseek-v4-pro "run a DOE sweep over x=[0,10], y=[0,5]"

  ${gray('# Campaign mode')}
  meta-agent --mode campaign "做参数扫描，找 Pareto 前沿"

  ${gray('# Robotics mode')}
  meta-agent --mode robotics "帮我调 PID 参数"

  ${gray('# One-shot with explicit key + base URL')}
  meta-agent -k sk-... -b https://api.deepseek.com/anthropic "什么是 LHS 采样？"

  ${gray('# 指定工作目录（推荐！限制 agent 只能操作该目录）')}
  meta-agent --workspace ~/projects/my-robot
  meta-agent -w ~/projects/my-robot --mode agentic "重构代码结构"
`);
}
function parseCliArgs() {
    let parsed;
    try {
        parsed = parseArgs({
            args: process.argv.slice(2),
            options: {
                mode: { type: 'string', short: 'm', default: 'auto' },
                workspace: { type: 'string', short: 'w' },
                'api-key': { type: 'string', short: 'k' },
                'base-url': { type: 'string', short: 'b' },
                model: { type: 'string' },
                system: { type: 'string', short: 's' },
                'max-turns': { type: 'string', short: 't' },
                resume: { type: 'string', short: 'r' },
                debug: { type: 'boolean', short: 'd', default: false },
                json: { type: 'boolean', short: 'j', default: false },
                version: { type: 'boolean', short: 'v', default: false },
                help: { type: 'boolean', short: 'h', default: false },
            },
            allowPositionals: true,
        });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(red(`Error: ${msg}`));
        process.exit(1);
    }
    if (parsed.values['help']) {
        printHelp();
        process.exit(0);
    }
    if (parsed.values['version']) {
        console.log(`meta-agent v${VERSION}`);
        process.exit(0);
    }
    const rawMode = parsed.values['mode'].toLowerCase();
    const validModes = ['auto', 'direct', 'agentic', 'campaign', 'robotics'];
    if (!validModes.includes(rawMode)) {
        console.error(red(`Error: unknown mode "${rawMode}". Valid: ${validModes.join(', ')}`));
        process.exit(1);
    }
    const promptParts = parsed.positionals;
    const rawWorkspace = parsed.values['workspace'];
    let workspace;
    if (rawWorkspace) {
        workspace = resolve(rawWorkspace);
        if (!existsSync(workspace) || !statSync(workspace).isDirectory()) {
            console.error(red(`Error: workspace "${workspace}" does not exist or is not a directory.`));
            process.exit(1);
        }
    }
    const rawMaxTurns = parsed.values['max-turns'];
    let maxTurns;
    if (rawMaxTurns) {
        if (rawMaxTurns.toLowerCase() === 'infinity' || rawMaxTurns === '∞') {
            maxTurns = Infinity;
        }
        else {
            maxTurns = parseInt(rawMaxTurns, 10);
            if (isNaN(maxTurns) || maxTurns < 1) {
                console.error(red(`Error: --max-turns must be a positive integer or "infinity" (got "${rawMaxTurns}")`));
                process.exit(1);
            }
        }
    }
    return {
        mode: rawMode === 'auto' ? 'auto' : rawMode,
        workspace,
        hardwareId: undefined, // set later via interactive selection
        apiKey: parsed.values['api-key'],
        baseUrl: parsed.values['base-url'],
        model: parsed.values['model'],
        system: parsed.values['system'],
        json: parsed.values['json'],
        debug: parsed.values['debug'],
        prompt: promptParts.length > 0 ? promptParts.join(' ') : null,
        maxTurns,
        resume: parsed.values['resume'],
    };
}
// ── Helpers ───────────────────────────────────────────────────────────────────
/** Strip surrounding quotes and non-ASCII chars that break HTTP headers */
function sanitizeKey(key) {
    // Remove Unicode curly quotes, regular quotes, and leading/trailing whitespace
    return key.replace(/^[“”‘’"'\s]+|[“”‘’"'\s]+$/g, '');
}
/**
 * Sanitize and validate a single key string.
 * Returns the cleaned key, or exits the process on invalid characters.
 */
function validateKey(raw, label) {
    const clean = sanitizeKey(raw);
    if (clean !== raw) {
        console.warn(yellow(`⚠  ${label} 含有首尾引号/空白，已自动清除。`));
    }
    for (let i = 0; i < clean.length; i++) {
        if (clean.charCodeAt(i) > 255) {
            console.error(red(`Error: ${label} 包含无效字符（位置 ${i}, ` +
                `U+${clean.charCodeAt(i).toString(16).toUpperCase()}）。` +
                `请重新导出 API key，不要包含引号。`));
            process.exit(1);
        }
    }
    return clean;
}
/**
 * Sanitize all provider API key env vars in-place so detectProvider()
 * reads clean values without routing interference.
 * Also handles the explicit --api-key CLI flag.
 *
 * Rule: env-var keys stay in process.env — detectProvider() reads them
 * directly for correct provider + baseURL selection.
 * Only an explicit --api-key flag is forwarded as cfg.apiKey.
 */
function sanitizeEnvKeys() {
    for (const k of ['DEEPSEEK_API_KEY', 'ANTHROPIC_API_KEY', 'QWEN_API_KEY']) {
        const raw = process.env[k];
        if (raw)
            process.env[k] = validateKey(raw, k);
    }
}
/**
 * Return an explicit --api-key value for cfg.apiKey injection.
 * Returns undefined when the key came only from env vars — in that case
 * detectProvider() will pick up the correct provider and baseURL automatically.
 */
function resolveExplicitApiKey(opts) {
    if (!opts.apiKey)
        return undefined;
    return validateKey(opts.apiKey, '--api-key');
}
// ── Workspace helpers ─────────────────────────────────────────────────────────
/** Prompt the user to confirm or enter a working directory (interactive only) */
async function confirmWorkspace(suggested) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolveP => {
        process.stdout.write(`\n${yellow('⚠  工作目录未指定')}\n` +
            `Agent 将只能在指定目录内读写文件。\n\n` +
            `${dim('当前目录:')} ${cyan(suggested)}\n` +
            `直接回车确认，或输入其他路径: `);
        rl.once('line', line => {
            rl.close();
            const input = line.trim();
            if (!input) {
                resolveP(suggested);
                return;
            }
            const abs = resolve(input);
            if (!existsSync(abs) || !statSync(abs).isDirectory()) {
                console.error(red(`路径不存在或不是目录: ${abs}`));
                process.exit(1);
            }
            resolveP(abs);
        });
    });
}
/** Build the workspace constraint block injected into system prompt */
function buildWorkspaceSystemPrompt(workspace) {
    return [
        `## 工作目录约束 (WORKSPACE CONSTRAINT)`,
        ``,
        `你的工作目录被严格限定为：`,
        `  ${workspace}`,
        ``,
        `**强制规则：**`,
        `- 所有文件读写、创建、删除操作必须在此目录内进行`,
        `- 禁止访问或修改此目录以外的任何文件`,
        `- 禁止使用绝对路径指向此目录以外的位置`,
        `- 禁止使用 "../" 等方式跳出工作目录`,
        `- 如需操作当前目录外的文件，必须明确告知用户并请求确认`,
        ``,
        `违反以上规则被视为高危操作，必须拒绝执行。`,
    ].join('\n');
}
// ── Hardware profile helpers ──────────────────────────────────────────────────
/** Ask the user a question and return their answer */
async function askQuestion(rl, question) {
    return new Promise(resolve => {
        rl.question(question, answer => resolve(answer.trim()));
    });
}
/**
 * Interactively select or create a hardware profile for a robotics session.
 * Loads the active ProfileTemplate (project → global → default).
 * Returns the profile name that was selected/created, plus formatted text for prompt injection.
 *
 * @param existingRl - Pass the REPL's readline interface when calling from inside the REPL
 *   loop so we never have two readline instances sharing stdin simultaneously.  When omitted
 *   (e.g. the initial call before the loop starts) a new interface is created and closed.
 */
async function selectHardwareProfile(hp, projectDir, existingRl) {
    const [profiles, template] = await Promise.all([
        hp.list(),
        resolveTemplate(projectDir),
    ]);
    // Re-use the caller's readline interface if provided — creating a second interface
    // on the same stdin while one is already active causes both to fight over input and
    // the wizard exits immediately without reading any keystrokes.
    const ownRl = existingRl == null;
    const rl = existingRl ?? createInterface({ input: process.stdin, output: process.stdout });
    try {
        if (profiles.length === 0) {
            // No profiles — must create one
            console.log(`\n${yellow('⚠  暂无硬件配置文件')}\n` +
                `robotics 模式需要绑定一个硬件配置。\n` +
                `请填写以下信息创建第一个配置（* 为必填，其余直接回车跳过）：\n`);
            return createHardwareProfile(rl, hp, template);
        }
        if (profiles.length === 1) {
            // Single profile — auto-select with confirmation
            const name = profiles[0];
            const profileText = await hp.formatForPrompt(name);
            console.log(`\n${dim('检测到唯一硬件配置:')} ${cyan(name)}`);
            const confirm = await askQuestion(rl, `使用此配置？[Y/n] `);
            if (confirm.toLowerCase() === 'n') {
                // Offer to create a new one instead
                const createNew = await askQuestion(rl, `新建一个配置？[y/N] `);
                if (createNew.toLowerCase() === 'y') {
                    return createHardwareProfile(rl, hp, template);
                }
                console.log(dim('已跳过，将在无硬件约束下运行。'));
                return { name: '', profileText: '' };
            }
            console.log(green(`✓ 已绑定硬件配置: ${name}\n`));
            return { name, profileText };
        }
        // Multiple profiles — show numbered list
        console.log(`\n${bold('选择此会话使用的硬件配置:')}\n`);
        profiles.forEach((name, i) => {
            console.log(`  ${cyan(String(i + 1))}.  ${name}`);
        });
        console.log(`  ${cyan(String(profiles.length + 1))}.  ${dim('新建配置')}`);
        console.log(`  ${cyan('0')}.  ${dim('跳过（不绑定硬件）')}\n`);
        const answer = await askQuestion(rl, `请输入序号 [0-${profiles.length + 1}]: `);
        const idx = parseInt(answer, 10);
        if (idx === 0 || isNaN(idx)) {
            console.log(dim('\n已跳过硬件绑定。\n'));
            return { name: '', profileText: '' };
        }
        if (idx === profiles.length + 1) {
            return createHardwareProfile(rl, hp, template);
        }
        if (idx >= 1 && idx <= profiles.length) {
            const name = profiles[idx - 1];
            const profileText = await hp.formatForPrompt(name);
            console.log(green(`\n✓ 已绑定硬件配置: ${name}\n`));
            return { name, profileText };
        }
        console.log(yellow('无效输入，跳过硬件绑定。'));
        return { name: '', profileText: '' };
    }
    finally {
        // Only close if we created the interface ourselves
        if (ownRl)
            rl.close();
    }
}
/**
 * Guided wizard to create a new HardwareProfileData and persist it.
 * Uses a ProfileTemplate so field prompts, defaults and presets are configurable.
 * Returns name + formatted text.
 */
async function createHardwareProfile(rl, hp, template) {
    console.log(`\n${bold('新建硬件配置')} ${dim('(* 必填，直接回车使用括号内默认值)')}\n`);
    // ── Step 1: optional preset selection ──────────────────────────────────────
    const presets = template.presets ?? [];
    let presetDefaults = {};
    if (presets.length > 0) {
        console.log(`${dim('可选预设（选择后自动填充字段，仍可逐项覆盖）:')}\n`);
        presets.forEach((p, i) => console.log(`  ${cyan(String(i + 1))}.  ${p.label}`));
        // Always show an explicit "custom" option so it's clear you can type freely
        const customIdx = presets.length + 1;
        console.log(`  ${cyan(String(customIdx))}.  ${dim('自定义（手动填写所有字段）')}`);
        console.log();
        const choice = await askQuestion(rl, `选择预设 [1-${customIdx}，回车跳过]: `);
        const idx = parseInt(choice, 10);
        if (!isNaN(idx) && idx >= 1 && idx <= presets.length) {
            presetDefaults = presets[idx - 1].defaults;
            console.log(dim(`\n已载入预设「${presets[idx - 1].label}」，可逐字段覆盖。\n`));
        }
        else if (!isNaN(idx) && idx === customIdx) {
            console.log(dim('\n自定义模式：请逐字段手动填写。\n'));
            // presetDefaults stays empty — all fields filled from scratch
        }
        // else Enter / invalid → no preset, manual fill (same as custom)
    }
    // ── Step 2: field-by-field input driven by template ────────────────────────
    const collected = { ...presetDefaults };
    for (const field of template.fields) {
        const type = field.type ?? 'text';
        const required = field.required ?? false;
        const presetVal = presetDefaults[field.key];
        if (type === 'kv') {
            // key:value pairs, blank to finish
            const existing = presetVal ?? {};
            const kv = { ...existing };
            if (Object.keys(existing).length > 0) {
                console.log(dim(`  ${field.label} (已预填，继续添加或直接回车结束):`));
                for (const [k, v] of Object.entries(existing)) {
                    console.log(dim(`    ${k}: ${v}`));
                }
            }
            else {
                const hint = field.hint ? ` (${dim(field.hint)})` : '';
                console.log(dim(`  ${field.label}${hint}:`));
            }
            for (;;) {
                const entry = await askQuestion(rl, `    > `);
                if (!entry)
                    break;
                const colonIdx = entry.indexOf(':');
                if (colonIdx < 1) {
                    console.log(yellow('    格式应为 key:value，已跳过'));
                    continue;
                }
                kv[entry.slice(0, colonIdx).trim()] = entry.slice(colonIdx + 1).trim();
            }
            if (Object.keys(kv).length === 0)
                kv['limit'] = 'unset';
            collected[field.key] = kv;
        }
        else if (type === 'csv') {
            const hint = field.hint ? ` (${dim(field.hint)})` : '';
            const prefix = required ? `${red('*')} ` : '  ';
            const raw = await askQuestion(rl, `${prefix}${field.label}${hint}: `);
            const arr = raw ? raw.split(',').map(s => s.trim()).filter(Boolean) : [];
            collected[field.key] = arr.length > 0 ? arr : undefined;
        }
        else {
            // plain text — show preset default in brackets if available
            const defVal = typeof presetVal === 'string' ? presetVal : (field.default ?? '');
            const bracket = defVal ? ` ${dim(`[${defVal}]`)}` : '';
            const hint = field.hint && !defVal ? ` ${dim(`(如 ${field.hint})`)}` : '';
            const prefix = required ? `${red('*')} ` : '  ';
            let value;
            for (;;) {
                value = await askQuestion(rl, `${prefix}${field.label}${hint}${bracket}: `);
                if (!value && defVal) {
                    value = defVal;
                    break;
                }
                if (!value && required) {
                    console.log(yellow(`    「${field.label}」为必填项，不能为空`));
                    continue;
                }
                break;
            }
            collected[field.key] = value || undefined;
        }
    }
    // ── Step 3: validate name ───────────────────────────────────────────────────
    const name = collected['name'];
    if (!name) {
        console.log(yellow('\n名称为空，跳过硬件绑定。\n'));
        return { name: '', profileText: '' };
    }
    // ── Step 4: build & persist ─────────────────────────────────────────────────
    await hp.write({
        name,
        platform: collected['platform'] || 'unknown',
        compute: collected['compute'] || 'unknown',
        os: collected['os'] || undefined,
        actuators: collected['actuators'] || undefined,
        sensors: collected['sensors'] || undefined,
        safetyLimits: collected['safetyLimits'] ?? { limit: 'unset' },
        knownIssues: collected['knownIssues'] || undefined,
        notes: buildExtraNotes(collected, template),
    });
    console.log(green(`\n✓ 硬件配置 "${name}" 已保存并绑定到本会话。\n`));
    const profileText = await hp.formatForPrompt(name);
    return { name, profileText };
}
/**
 * Any fields in the template that aren't native HardwareProfileData keys
 * are serialised as "key: value" lines and appended to notes.
 */
const NATIVE_KEYS = new Set([
    'name', 'platform', 'compute', 'os', 'actuators', 'sensors', 'safetyLimits', 'knownIssues', 'notes',
]);
function buildExtraNotes(collected, template) {
    const baseNotes = collected['notes'] ?? '';
    const extras = [];
    for (const field of template.fields) {
        if (NATIVE_KEYS.has(field.key))
            continue;
        const v = collected[field.key];
        if (v !== undefined && v !== '' && v !== null) {
            extras.push(`${field.label}: ${Array.isArray(v) ? v.join(', ') : String(v)}`);
        }
    }
    const combined = [baseNotes, ...extras].filter(Boolean).join('\n');
    return combined || undefined;
}
/** Build the hardware profile block for injection into the system prompt */
function buildHardwareSystemPrompt(profileText) {
    return [
        `## 当前会话硬件配置 (HARDWARE PROFILE — SESSION-BOUND)`,
        ``,
        `以下硬件规格在本会话中固定，所有代码、参数、安全建议须以此为准：`,
        ``,
        profileText,
        ``,
        `**重要：** 本会话仅操作上述硬件，不得假设其他硬件特性。`,
    ].join('\n');
}
const SENSITIVE_PATTERNS = [
    { pattern: /\bpip3?\s+(install|uninstall)\b/i, label: 'pip install/uninstall' },
    { pattern: /\bconda\s+(install|remove|env\s+remove)\b/i, label: 'conda install/remove' },
    { pattern: /\bnpm\s+(install|uninstall|publish|ci)\b/i, label: 'npm install/uninstall' },
    { pattern: /\byarn\s+(add|remove|publish)\b/i, label: 'yarn add/remove' },
    { pattern: /\bpnpm\s+(install|uninstall|publish|add|remove)\b/i, label: 'pnpm install/remove' },
    { pattern: /\brm\s+(?:.*\s+)?-[rRf]{1,3}[\s-]/, label: 'recursive/force delete (rm)' },
    { pattern: /\brm\s+-[rRf]/, label: 'recursive/force delete (rm)' },
    { pattern: /\bgit\s+push\b/, label: 'git push' },
    { pattern: /\bgit\s+branch\b.*-[dD]\b/, label: 'git branch delete' },
    { pattern: /\bgit\s+tag\b.*-[dD]\b/, label: 'git tag delete' },
    { pattern: /\bgit\s+reset\s+--hard\b/, label: 'git reset --hard' },
    { pattern: /\bsudo\b/, label: 'sudo' },
    { pattern: /\bcurl\b.*\|\s*(ba)?sh\b/, label: 'curl pipe to shell' },
    { pattern: /\bwget\b.*\|\s*(ba)?sh\b/, label: 'wget pipe to shell' },
];
/**
 * Check if a tool call should trigger the interactive guard.
 * Returns the matched label, or null if no sensitive pattern matched.
 *
 * Also catches workspace boundary violations: if `workspace` is set and the
 * bash command contains an absolute path that escapes the workspace root,
 * it is flagged as a sensitive op so the user can decide.
 */
function detectSensitiveOp(toolName, input, workspace) {
    if (toolName !== 'bash')
        return null;
    const cmd = String(input['command'] ?? '');
    for (const { pattern, label } of SENSITIVE_PATTERNS) {
        if (pattern.test(cmd))
            return label;
    }
    // Workspace boundary check: absolute paths that escape the workspace root
    if (workspace) {
        const absPathPattern = /(?:^|\s|['"])(\/([\w.\-]+\/)+[\w.\-]*)/g;
        let m;
        while ((m = absPathPattern.exec(cmd)) !== null) {
            const p = m[1];
            if (!p.startsWith(workspace) && !p.startsWith('/tmp') && !p.startsWith('/dev')) {
                return `工作目录外路径 (${p.slice(0, 60)})`;
            }
        }
    }
    return null;
}
/**
 * Interactive three-option dialog for sensitive tool calls.
 *
 * Uses the existing REPL readline interface so there is never more than
 * one readline instance competing for stdin.
 *
 * Returns BeforeToolCallResult that MetaAgentSession will act on.
 */
async function confirmToolCall(rl, toolName, input, opLabel) {
    const cmd = String(input['command'] ?? JSON.stringify(input)).slice(0, 240);
    process.stdout.write(`\n${yellow('⚠')}  ${bold('检测到敏感操作')} ${dim(`[${opLabel}]`)}\n` +
        `${dim('命令预览:')} ${cyan(cmd)}\n\n` +
        `  ${green('1')}. ${bold('允许')}         — 执行此操作\n` +
        `  ${red('2')}. ${bold('拒绝')}         — 跳过，让 AI 换个方式\n` +
        `  ${cyan('3')}. ${bold('告诉 AI 怎么做')} — 提供替代指导，AI 将按你的说明重新规划\n\n`);
    const choice = await askQuestion(rl, `请选择 [1/2/3，回车默认允许]: `);
    if (choice.trim() === '2') {
        process.stdout.write(`${dim('已拒绝。AI 将尝试其他方式。')}\n`);
        return { action: 'deny', reason: '用户手动拒绝了此操作。' };
    }
    if (choice.trim() === '3') {
        process.stdout.write(`\n${dim('请输入替代指导，例如：')}\n` +
            `${dim('  "conda x1 环境中已有所需包，请用 conda run -n x1 python3 ..."')}\n` +
            `${dim('  "不要 pip install，直接 import，模块已全局安装"')}\n\n`);
        const instructions = await askQuestion(rl, `你的指导 > `);
        if (instructions.trim()) {
            process.stdout.write(`\n${dim('已记录。AI 将按你的指导重新规划。')}\n`);
            return { action: 'redirect', instructions: instructions.trim() };
        }
        // Empty → fall through to allow
        process.stdout.write(`${dim('指导为空，视为允许。')}\n`);
    }
    process.stdout.write(`${dim('已允许执行。')}\n`);
    return { action: 'allow' };
}
// ── Router factory ────────────────────────────────────────────────────────────
function makeRouter(opts, hardwareProfileText, rl, initialMessages) {
    const cfg = {};
    // Only forward explicit --api-key; env-var keys are read by detectProvider() itself
    // so it can correctly select the provider's baseURL (DeepSeek / Qwen / Anthropic).
    const apiKey = resolveExplicitApiKey(opts);
    if (apiKey)
        cfg.apiKey = apiKey;
    if (opts.baseUrl)
        cfg.baseURL = opts.baseUrl;
    if (opts.model)
        cfg.model = opts.model;
    if (opts.mode !== 'auto')
        cfg.mode = opts.mode;
    // Apply maxTurns: explicit flag wins; otherwise unlimited
    cfg.maxTurns = opts.maxTurns ?? Infinity;
    // Debug mode
    if (opts.debug)
        cfg.debugMode = true;
    // Session resume: pre-load conversation history
    if (initialMessages && initialMessages.length > 0) {
        cfg.initialMessages = initialMessages;
    }
    // Build composite system prompt: workspace constraint + hardware profile + user system
    const workspaceBlock = opts.workspace ? buildWorkspaceSystemPrompt(opts.workspace) : '';
    const hardwareBlock = hardwareProfileText ? buildHardwareSystemPrompt(hardwareProfileText) : '';
    const userSystem = opts.system ?? '';
    const composed = [workspaceBlock, hardwareBlock, userSystem].filter(Boolean).join('\n\n');
    if (composed)
        cfg.systemPrompt = composed;
    // Change process cwd to workspace so relative paths work correctly
    if (opts.workspace) {
        try {
            process.chdir(opts.workspace);
        }
        catch { /* ignore */ }
    }
    // Register interactive tool guard — only in interactive TTY sessions.
    // Uses the REPL's existing readline interface so stdin is never double-owned.
    if (rl && !opts.json && isTTY) {
        const workspace = opts.workspace;
        cfg.beforeToolCall = async (toolName, input) => {
            const opLabel = detectSensitiveOp(toolName, input, workspace);
            if (!opLabel)
                return { action: 'allow' };
            return confirmToolCall(rl, toolName, input, opLabel);
        };
    }
    return new SessionRouter(cfg);
}
// ── Experience summary side-call ──────────────────────────────────────────────
//
// Calls the LLM in a completely isolated session (no tools, no history) to
// summarise newly proposed experience entries and guide the user toward review.
//
// This mirrors the compact side-call pattern: a fresh Anthropic client,
// client.messages.stream() with the summary task as system prompt, nothing
// written into the main session's message history.
const EXPERIENCE_SUMMARY_SYSTEM = `你是一个精炼知识的助理。
用户的 AI agent 刚刚在本轮任务中提议了若干条新的"经验条目"，尚未提交到共享知识库，需要人工审核。
你的任务：
1. 简洁地概括这些经验的核心价值与适用场景（每条一两句）
2. 判断哪些条目结论足够明确、值得提交，哪些可能还不成熟
3. 提醒用户运行 /experience review 进行逐条审核，自行决定是否提交
不要重复原始数据，只做价值判断和行动引导。回复保持简短（100-200字）。`;
/**
 * Fire a one-shot LLM call to explain newly proposed experience entries.
 * Uses the same provider/apiKey as the main session but a completely separate
 * Anthropic client instance — the response is streamed to stdout only and
 * NEVER appended to the main session's message history.
 *
 * Falls back silently if no client is available or the call fails.
 */
async function streamExperienceSummary(router, entries) {
    // Prefer the existing side-call client (already has correct timeout/retries).
    // Fall back to building our own from the provider config.
    let client = router.getSideCallClient();
    if (!client) {
        const { apiKey, baseURL } = router.getProviderConfig();
        if (!apiKey)
            return; // no key at all — silently skip
        client = new (await import('@anthropic-ai/sdk')).default({
            apiKey,
            baseURL,
            timeout: 8_000,
            maxRetries: 1,
        });
    }
    // Build a concise JSON summary of the entries for the LLM
    const entrySummaries = entries.map((e, i) => {
        const inp = e.input;
        return {
            index: i + 1,
            title: inp['title'] ?? '(untitled)',
            domain: inp['domain'] ?? 'general',
            success: inp['success'] ?? true,
            problem: String(inp['problem'] ?? '').slice(0, 200),
            solution: String(inp['solution'] ?? '').slice(0, 200),
        };
    });
    const userMessage = `新提议的经验条目（共 ${entries.length} 条）：\n\n` +
        JSON.stringify(entrySummaries, null, 2);
    try {
        const { model } = router.getProviderConfig();
        // Use the fastest/cheapest model available for this side-call
        const sideModel = model.includes('claude') ? 'claude-haiku-4-5-20251001' : model;
        const stream = await client.messages.stream({
            model: sideModel,
            max_tokens: 512,
            system: EXPERIENCE_SUMMARY_SYSTEM,
            messages: [{ role: 'user', content: userMessage }],
        });
        process.stdout.write(`\n${dim('─── 经验提议摘要 (side-call) ───────────────────────────────────')}\n`);
        for await (const event of stream) {
            if (event.type === 'content_block_delta' &&
                event.delta.type === 'text_delta') {
                process.stdout.write(event.delta.text);
            }
        }
        process.stdout.write(`\n${dim('─────────────────────────────────────────────────────────────')}\n\n`);
    }
    catch { /* best-effort — side-call failure must never crash the REPL */ }
}
// ── Stream a single prompt ────────────────────────────────────────────────────
async function streamPrompt(router, prompt, jsonMode) {
    const gen = router.submit(prompt);
    let hasText = false;
    try {
        for await (const event of gen) {
            if (jsonMode) {
                console.log(JSON.stringify(event));
                continue;
            }
            switch (event.type) {
                case 'text': {
                    if (!hasText) {
                        process.stdout.write('\n');
                        hasText = true;
                    }
                    process.stdout.write(event.text);
                    break;
                }
                case 'tool_use': {
                    process.stdout.write(`\n${dim('⚙')}  ${cyan(event.toolName)} ${gray(JSON.stringify(event.toolInput).slice(0, 80))}\n`);
                    break;
                }
                case 'tool_result': {
                    const preview = String(event.content ?? '').slice(0, 120);
                    process.stdout.write(`   ${dim('→')} ${gray(preview)}${preview.length >= 120 ? gray('…') : ''}\n`);
                    break;
                }
                case 'api_retry': {
                    process.stdout.write(`\n${yellow('⚠')}  retrying (attempt ${event.attempt}/${event.maxRetries}, delay ${event.retryDelayMs}ms)\n`);
                    break;
                }
                case 'result': {
                    if (hasText)
                        process.stdout.write('\n');
                    // Show explicit warnings for non-success result subtypes so the user
                    // is never silently left wondering why the agent stopped.
                    if (event.subtype === 'error_max_turns') {
                        process.stdout.write(`\n${yellow('⚠')}  ${yellow('已达到本轮最大步数上限。')} ` +
                            `${dim('继续输入以接着分析，或用 --max-turns <n> 提高上限（默认无限制）。')}\n`);
                    }
                    else if (event.subtype === 'error_max_budget') {
                        process.stdout.write(`\n${yellow('⚠')}  ${yellow('已超出 token 预算上限。')} ` +
                            `${dim('任务已提前终止。可继续输入或拆分为更小的子任务。')}\n`);
                    }
                    else if (event.subtype === 'error_during_execution') {
                        process.stdout.write(`\n${red('✗')}  ${red('执行过程中发生错误。')} ` +
                            `${dim('请检查以上输出，调整指令后重试。')}\n`);
                    }
                    const usage = event.usage;
                    const cost = router.getEstimatedCost();
                    const mode = router.mode ?? 'auto';
                    const modeTag = mode === 'campaign' ? cyan(mode)
                        : mode === 'agentic' ? green(mode)
                            : mode === 'robotics' ? `${c.magenta}${mode}${c.reset}`
                                : gray(mode);
                    process.stdout.write(`\n${gray('─'.repeat(56))}\n` +
                        `${modeTag}  ` +
                        `${gray(`in:${usage.inputTokens} out:${usage.outputTokens}`)}  ` +
                        `${gray(`$${cost.toFixed(4)}`)}\n`);
                    break;
                }
            }
        }
    }
    catch (err) {
        if (err?.code === 'ERR_STREAM_PREMATURE_CLOSE')
            return;
        throw err;
    }
}
// ── Session resume picker ─────────────────────────────────────────────────────
/**
 * Show the last N sessions and let the user choose one to resume.
 * Returns the loaded ConversationMessage[] (empty if user declines).
 */
async function runSessionPicker(rl) {
    const sessions = await SessionStore.listSessions(8);
    if (sessions.length === 0)
        return null;
    console.log(`\n${bold('历史会话:')} ${dim('(选择一个以继续上次对话)')}\n`);
    sessions.forEach((s, i) => {
        const ago = formatAge(Date.now() - s.lastActivity);
        const preview = s.firstPrompt.slice(0, 60);
        console.log(`  ${cyan(String(i + 1))}. ${bold(s.mode.padEnd(10))} ` +
            `${dim(ago.padEnd(12))} ${dim(`[${s.messageCount} 条]`)}  ${preview}`);
    });
    console.log(`  ${cyan('0')}.  ${dim('新建会话')}\n`);
    const choice = await askQuestion(rl, `请选择 [0-${sessions.length}，回车新建]: `);
    const idx = parseInt(choice, 10);
    if (!choice.trim() || idx === 0 || isNaN(idx) || idx < 1 || idx > sessions.length) {
        return null;
    }
    const selected = sessions[idx - 1];
    console.log(`\n${dim('加载历史会话...')}\n`);
    const messages = await SessionStore.loadHistory(selected.sessionId);
    if (messages.length === 0) {
        console.log(yellow('⚠  找不到历史记录，将新建会话。\n'));
        return null;
    }
    console.log(green(`✓ 已加载 ${messages.length} 条历史消息，继续上次 ${selected.mode} 模式会话。\n`));
    return { sessionId: selected.sessionId, messages };
}
function formatAge(ms) {
    const s = Math.floor(ms / 1000);
    if (s < 60)
        return `${s}秒前`;
    const m = Math.floor(s / 60);
    if (m < 60)
        return `${m}分钟前`;
    const h = Math.floor(m / 60);
    if (h < 24)
        return `${h}小时前`;
    return `${Math.floor(h / 24)}天前`;
}
// ── Experience review ─────────────────────────────────────────────────────────
/**
 * Interactive review of pending experience entries.
 * Shows each entry in turn; user can approve (y), discard (n), or skip (s).
 * Returns the count of committed entries.
 */
async function reviewPendingExperiences(rl, pending, store) {
    const entries = [...pending.list()];
    if (entries.length === 0) {
        console.log(dim('\n暂无待审经验条目。\n'));
        return 0;
    }
    console.log(`\n${bold('经验审核')} ${dim(`(${entries.length} 条待审)`)}\n` +
        `${dim('每条经验由 AI 在本次会话中提议，需要你审核后才会写入共享知识库。')}\n`);
    let committed = 0;
    for (const entry of entries) {
        const input = entry.input;
        const title = String(input['title'] ?? '(无标题)');
        const problem = String(input['problem'] ?? '').slice(0, 200);
        const solution = String(input['solution'] ?? '').slice(0, 200);
        const success = Boolean(input['success']);
        const domain = String(input['domain'] ?? 'general');
        const tags = input['tags']?.join(', ') ?? '';
        console.log(`\n${'─'.repeat(60)}\n` +
            `${bold(title)} ${dim(`[${domain}]`)} ${success ? green('✅ 成功') : red('❌ 失败')}\n` +
            `${dim('问题:')} ${problem}\n` +
            `${dim('方案:')} ${solution}\n` +
            (tags ? `${dim('标签:')} ${tags}\n` : '') +
            `${'─'.repeat(60)}\n`);
        const choice = await askQuestion(rl, `提交 [y=是 / n=丢弃 / s=跳过]: `);
        if (choice.toLowerCase() === 'y' || choice.toLowerCase() === 'yes') {
            const id = await pending.commit(entry.pendingId, store);
            if (id) {
                console.log(green(`  ✓ 已提交 (ID: ${id})`));
                committed++;
            }
            else {
                console.log(red('  ✗ 提交失败'));
            }
        }
        else if (choice.toLowerCase() === 'n') {
            pending.remove(entry.pendingId);
            console.log(dim('  已丢弃'));
        }
        else {
            console.log(dim('  已跳过 (保留在待审队列)'));
        }
    }
    const remaining = pending.count;
    if (committed > 0 || remaining > 0) {
        console.log(`\n${green(`✓ 已提交 ${committed} 条`)}` +
            (remaining > 0 ? `  ${yellow(`剩余 ${remaining} 条待审`)}` : '') +
            '\n');
    }
    return committed;
}
// ── Interactive REPL ──────────────────────────────────────────────────────────
async function runRepl(opts) {
    // ── Workspace confirmation (REPL only, single-turn skips for scripting) ──
    if (!opts.json && isTTY) {
        if (!opts.workspace) {
            opts.workspace = await confirmWorkspace(process.cwd());
        }
        console.log(green(`✓ 工作目录: ${opts.workspace}\n`));
    }
    else if (!opts.workspace) {
        // Non-TTY / json mode: default to cwd silently
        opts.workspace = process.cwd();
    }
    // ── Hardware profile selection (robotics mode only) ───────────────────────
    let hardwareProfileText = '';
    if (opts.mode === 'robotics' && !opts.json && isTTY) {
        const hp = new HardwareProfile();
        const selected = await selectHardwareProfile(hp, opts.workspace);
        opts.hardwareId = selected.name || undefined;
        hardwareProfileText = selected.profileText;
    }
    if (!opts.json) {
        const debugDir = opts.debug
            ? join(homedir(), '.meta-agent', 'debug', '<sessionId>')
            : '';
        console.log(`${bold('meta-agent')}  ${dim(`v${VERSION}`)}\n` +
            `Mode: ${cyan(opts.mode === 'auto' ? 'auto-detect' : opts.mode)}` +
            (opts.hardwareId ? `  ${dim('hw:')} ${cyan(opts.hardwareId)}` : '') +
            (opts.debug ? `  ${yellow('[DEBUG]')}` : '') +
            `  ${dim('(type /help for commands, Ctrl+D to quit)')}\n`);
        if (opts.debug) {
            console.log(`${yellow('⚙  调试模式已启用')} — 每轮 LLM 完整输入/输出写入：\n` +
                `   ${cyan(debugDir)}\n` +
                `   ${dim('(<sessionId> 在首次提交后确定)')}\n`);
        }
    }
    // Create rl BEFORE router so makeRouter can capture it in beforeToolCall.
    // The guard hook uses this interface; creating it later would mean the first
    // router is built without a guard (before the first `/clear`).
    const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: `\n${bold(cyan('you'))} › `,
        terminal: isTTY,
        historySize: 100,
    });
    // ── Session resume ────────────────────────────────────────────────────────
    let resumedMessages = [];
    if (!opts.json && isTTY) {
        if (opts.resume) {
            // Explicit --resume <id> or --resume last
            let targetId = opts.resume;
            if (targetId === 'last') {
                const sessions = await SessionStore.listSessions(1);
                targetId = sessions[0]?.sessionId ?? '';
            }
            if (targetId) {
                resumedMessages = await SessionStore.loadHistory(targetId);
                if (resumedMessages.length > 0) {
                    console.log(green(`✓ 已恢复会话 ${targetId.slice(0, 8)}… (${resumedMessages.length} 条历史)\n`));
                }
                else {
                    console.log(yellow(`⚠  找不到会话 ${targetId}，将新建会话。\n`));
                }
            }
        }
        else {
            // Auto-show session picker if recent sessions exist
            const sessions = await SessionStore.listSessions(1);
            if (sessions.length > 0) {
                const resumed = await runSessionPicker(rl);
                if (resumed)
                    resumedMessages = resumed.messages;
            }
        }
    }
    let router = makeRouter(opts, hardwareProfileText || undefined, rl, resumedMessages.length > 0 ? resumedMessages : undefined);
    let interrupted = false;
    // Track how many messages we've already saved so append writes only new ones.
    let savedMessageCount = resumedMessages.length;
    // Track whether the real debug dir has been printed (becomes known after first submit)
    let debugDirShown = false;
    // Handle Ctrl+C: first press interrupts, second exits
    let ctrlCPressed = false;
    rl.on('SIGINT', () => {
        if (ctrlCPressed) {
            rl.close();
            process.exit(0);
        }
        ctrlCPressed = true;
        router.interrupt();
        interrupted = true;
        process.stdout.write(`\n${yellow('Interrupted')} ${dim('(press Ctrl+C again to exit)')}\n`);
        setTimeout(() => { ctrlCPressed = false; }, 2000);
        rl.prompt();
    });
    rl.on('close', () => {
        if (!opts.json) {
            // Remind user if there are uncommitted experience entries
            const pending = router.getPendingExperiences();
            const pendingCount = pending?.count ?? 0;
            if (pendingCount > 0) {
                console.log(`\n${yellow(`⏸  ${pendingCount} 条经验待审核`)} — ` +
                    `${dim('下次启动后可用 /experience review 提交，或本次重启后使用 --resume last 恢复会话再审核。')}\n`);
            }
            console.log(`\n${dim('Goodbye.')}\n`);
        }
        process.exit(0);
    });
    // ── Process-level cleanup handlers ───────────────────────────────────────
    // Called on graceful shutdown (SIGTERM) or unhandled crashes.
    // We await router.dispose() so RoboticsSession can cancel sub-agents,
    // stop heartbeat timers, and purge git worktrees before the process exits.
    // `router` is a `let` so the handlers always see the current router even
    // after `/clear` or `/hardware select` rebuilt it.
    const disposeAndExit = async (code, err) => {
        if (err)
            console.error(`\n${red('Fatal:')} ${err instanceof Error ? err.message : String(err)}\n`);
        try {
            await router.dispose();
        }
        catch { /* best-effort */ }
        try {
            rl.close();
        }
        catch { /* best-effort */ }
        process.exit(code);
    };
    process.once('SIGTERM', () => { void disposeAndExit(0); });
    process.once('uncaughtException', (e) => { void disposeAndExit(1, e); });
    process.once('unhandledRejection', (e) => { void disposeAndExit(1, e); });
    rl.prompt();
    for await (const line of rl) {
        const input = line.trim();
        if (!input) {
            rl.prompt();
            continue;
        }
        // ── Built-in slash commands ──
        if (input.startsWith('/')) {
            const cmd = input.split(/\s+/)[0].toLowerCase();
            switch (cmd) {
                case '/exit':
                case '/quit':
                    rl.close();
                    return;
                case '/mode':
                    console.log(`\nSession mode: ${cyan(router.mode ?? 'not yet determined')}\n`);
                    break;
                case '/workspace':
                    console.log(`\nWorkspace: ${cyan(opts.workspace ?? '(unset — no file restrictions)')}\n`);
                    break;
                case '/hardware': {
                    const subCmd = input.split(/\s+/).slice(1).join(' ').toLowerCase();
                    if (subCmd === 'select') {
                        // /hardware select — re-run hardware selection wizard
                        if (opts.mode !== 'robotics') {
                            console.log(`\n${yellow('硬件选择仅在 robotics 模式下可用。')}\n`);
                        }
                        else {
                            const hp = new HardwareProfile();
                            const selected = await selectHardwareProfile(hp, opts.workspace, rl);
                            opts.hardwareId = selected.name || undefined;
                            hardwareProfileText = selected.profileText;
                            // Rebuild router with the new hardware binding (keeps same workspace/key/model)
                            router = makeRouter(opts, hardwareProfileText || undefined, rl);
                            console.log(green('\n✓ 硬件配置已更新，新会话已启动。\n'));
                        }
                    }
                    else {
                        // /hardware — show current binding
                        if (opts.hardwareId) {
                            const hp = new HardwareProfile();
                            const text = await hp.formatForPrompt(opts.hardwareId);
                            console.log(`\n${text}\n`);
                        }
                        else if (opts.mode === 'robotics') {
                            console.log(`\n${yellow('未绑定硬件配置。')} 使用 ${cyan('/hardware select')} 选择。\n`);
                        }
                        else {
                            console.log(`\n${dim('硬件配置仅在 robotics 模式下可用。')}\n`);
                        }
                    }
                    break;
                }
                case '/usage': {
                    const u = router.getUsage();
                    const cost = router.getEstimatedCost();
                    console.log(`\nTokens — in: ${u.inputTokens}  out: ${u.outputTokens}  ` +
                        `cache_read: ${u.cacheReadInputTokens ?? 0}\n` +
                        `Estimated cost: $${cost.toFixed(5)}\n`);
                    break;
                }
                case '/sessions': {
                    const sessions = await SessionStore.listSessions(8);
                    if (sessions.length === 0) {
                        console.log(dim('\n暂无历史会话。\n'));
                    }
                    else {
                        console.log(`\n${bold('历史会话:')} ${dim('(输入序号加载并继续上次对话)')}\n`);
                        sessions.forEach((s, i) => {
                            const ago = formatAge(Date.now() - s.lastActivity);
                            const preview = s.firstPrompt.slice(0, 60);
                            console.log(`  ${cyan(String(i + 1))}. ${bold(s.mode.padEnd(10))} ` +
                                `${dim(ago.padEnd(12))} ${dim(`[${s.messageCount} 条]`)}  ${preview}`);
                        });
                        console.log(`  ${cyan('0')}.  ${dim('取消')}\n`);
                        const choice = await askQuestion(rl, `请选择 [0-${sessions.length}，回车取消]: `);
                        const idx = parseInt(choice, 10);
                        if (choice.trim() && idx >= 1 && idx <= sessions.length) {
                            const selected = sessions[idx - 1];
                            console.log(dim('\n加载历史会话...\n'));
                            const messages = await SessionStore.loadHistory(selected.sessionId);
                            if (messages.length === 0) {
                                console.log(yellow('⚠  找不到历史记录。\n'));
                            }
                            else {
                                console.log(green(`✓ 已加载 ${messages.length} 条历史消息，继续 ${selected.mode} 模式。\n`));
                                router = makeRouter(opts, hardwareProfileText || undefined, rl, messages);
                                savedMessageCount = messages.length;
                            }
                        }
                    }
                    break;
                }
                case '/experience': {
                    const subCmd = input.split(/\s+/).slice(1).join(' ').toLowerCase();
                    const pending = router.getPendingExperiences();
                    if (subCmd === 'review') {
                        if (!pending) {
                            console.log(yellow('\n/experience review 仅在 robotics 模式下可用。\n'));
                        }
                        else {
                            const store = new ExperienceStore();
                            await reviewPendingExperiences(rl, pending, store);
                        }
                    }
                    else {
                        const count = pending?.count ?? 0;
                        if (count > 0) {
                            console.log(`\n${yellow(`⏸  ${count} 条经验待审核`)} — 使用 ${cyan('/experience review')} 审核提交\n`);
                        }
                        else {
                            console.log(`\n${dim('暂无待审经验。')}\n`);
                        }
                    }
                    break;
                }
                case '/clear':
                    router = makeRouter(opts, undefined, rl);
                    savedMessageCount = 0;
                    console.log(green('\nNew session started.\n'));
                    break;
                case '/help':
                    printHelp();
                    break;
                default:
                    console.log(`\n${yellow('Unknown command:')} ${cmd}  ${dim('(try /help)')}\n`);
            }
            rl.prompt();
            continue;
        }
        // ── Normal prompt ──
        interrupted = false;
        // ── Auto-mode hardware check (BEFORE streaming) ───────────────────────────
        // Run mode detection ahead of the first LLM call so we can prompt for a
        // hardware profile before the AI responds — ensuring the first turn already
        // has hardware context in the system prompt.
        // primeMode() is a no-op after the first submit(), so this only fires once.
        if (opts.mode === 'auto' && !opts.hardwareId && !opts.json && isTTY) {
            const primed = await router.primeMode(input);
            if (primed === 'robotics') {
                console.log(`\n${c.magenta}robotics${c.reset} 模式已激活。` +
                    `在继续之前，请绑定一个硬件配置。\n`);
                const hp = new HardwareProfile();
                const selected = await selectHardwareProfile(hp, opts.workspace, rl);
                opts.hardwareId = selected.name || undefined;
                hardwareProfileText = selected.profileText;
                // Lock mode so the new router skips re-detection (no second Haiku call)
                opts.mode = 'robotics';
                router = makeRouter(opts, hardwareProfileText || undefined, rl);
                if (opts.hardwareId) {
                    console.log(green(`✓ 硬件配置 "${opts.hardwareId}" 已绑定。\n`));
                }
            }
        }
        // Snapshot pending experience count before this turn so we can detect new additions
        const pendingCountBefore = router.getPendingExperiences()?.count ?? 0;
        try {
            await streamPrompt(router, input, opts.json);
        }
        catch (err) {
            if (!interrupted) {
                const msg = err instanceof Error ? err.message : String(err);
                console.error(`\n${red('Error:')} ${msg}\n`);
            }
        }
        // ── Show real debug dir once we have a sessionId ──────────────────────────
        if (opts.debug && !debugDirShown) {
            const sid = router.getSessionId();
            if (sid) {
                const realDir = join(homedir(), '.meta-agent', 'debug', sid);
                console.log(`\n${dim('调试日志目录:')} ${cyan(realDir)}\n`);
                debugDirShown = true;
            }
        }
        // ── LLM-guided experience review when new entries appear ─────────────────
        // If the AI proposed new experiences during this turn, fire a side-call to
        // summarise them and guide the user.  The side-call uses a completely separate
        // Anthropic client instance — it does NOT touch the main session's message
        // history (same pattern as compact's side-call).
        if (!interrupted && !opts.json) {
            const pending = router.getPendingExperiences();
            const pendingCountAfter = pending?.count ?? 0;
            const newCount = pendingCountAfter - pendingCountBefore;
            if (newCount > 0 && pending) {
                const newEntries = pending.list().slice(-newCount);
                void streamExperienceSummary(router, newEntries);
            }
        }
        // ── Persist session after each turn ──────────────────────────────────────
        // Append only the new messages (since savedMessageCount) so the file grows
        // incrementally rather than being rewritten on every turn.
        if (!opts.json) {
            try {
                const sessionId = router.getSessionId();
                if (sessionId) {
                    const messages = router.getMessages();
                    if (messages.length > savedMessageCount) {
                        const firstUserMsg = messages.find(m => m.role === 'user');
                        const firstPromptText = firstUserMsg
                            ? (typeof firstUserMsg.content === 'string'
                                ? firstUserMsg.content
                                : JSON.stringify(firstUserMsg.content)).slice(0, 80)
                            : input.slice(0, 80);
                        await SessionStore.append(sessionId, {
                            mode: router.mode ?? (opts.mode === 'auto' ? 'direct' : opts.mode),
                            startTime: Date.now(),
                            lastActivity: Date.now(),
                            messageCount: messages.length,
                            firstPrompt: firstPromptText,
                            workspace: opts.workspace,
                        }, messages, savedMessageCount);
                        savedMessageCount = messages.length;
                    }
                }
            }
            catch { /* session save is best-effort — never crash the REPL */ }
        }
        rl.prompt();
    }
}
// ── Single-turn mode ──────────────────────────────────────────────────────────
async function runSingleTurn(opts) {
    const router = makeRouter(opts);
    try {
        await streamPrompt(router, opts.prompt, opts.json);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(red(`Error: ${msg}`));
        process.exit(1);
    }
}
// ── Entry point ───────────────────────────────────────────────────────────────
async function main() {
    // Sanitize env-var API keys once so detectProvider() receives clean values
    sanitizeEnvKeys();
    const opts = parseCliArgs();
    if (opts.prompt !== null) {
        await runSingleTurn(opts);
    }
    else {
        await runRepl(opts);
    }
}
main().catch(err => {
    console.error(red(`Fatal: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
});
//# sourceMappingURL=index.js.map