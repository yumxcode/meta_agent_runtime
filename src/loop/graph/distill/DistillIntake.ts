import { readFile, rename, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { distillSourceIdentity, type DistillCheckpointSource } from './DistillCheckpoint.js'
import { describeJsonDefect, structuredJsonCandidates } from './JsonEnvelope.js'
import {
  BLOCKING_SEMANTIC_RULE_CLASSES,
  LOOP_CONSTRAINTS_SCHEMA,
  LOOP_PRECONDITIONS_SCHEMA,
  deriveEnforcementLocus,
  emptyLoopPreconditions,
  validateConstraintLedger,
  validateLoopPreconditions,
  type LoopConstraintLedger,
  type LoopPreconditions,
} from './DistillDesign.js'

export const LOOP_INTAKE_SCHEMA = 'loop-intake-1.0' as const
export const LOOP_INTAKE_FILE = 'loop.intake.json'
/** Verbatim model envelope, written before parsing. It is the only copy of the
 * human's answers, so it must survive any formatting failure. */
export const LOOP_INTAKE_RAW_FILE = 'loop.intake.raw.txt'

/**
 * Human-in-the-loop intake, run before Distill.
 *
 * Some rejections are unfixable by construction. "At most 20 effective
 * candidate rounds" has no deterministic conversion to an Activation count
 * unless someone says what an effective round is; a completion claim cannot be
 * verified against a standard nobody wrote down; a file the first Activation
 * reads either exists or it does not. The Compiler cannot repair any of these,
 * because the missing information was never in the system — yet today they are
 * only discovered several Compiler attempts in, by which point the semantic
 * repair budget is gone.
 *
 * Intake front-loads exactly those gaps, and its output is the Constraint
 * Ledger itself rather than nicer prose. Prose in, prose out would let the
 * Architect re-interpret whatever the human just settled; a ledger carries the
 * decision that actually matters — `kind`, from which the enforcement locus is
 * mechanically derived — through to the stage that consumes it.
 */
export interface LoopIntakeProbe {
  /** The blocking class this probe was derived from. Keeping the link lets the
   * trace answer "which probes actually prevent failures". */
  ruleClass: typeof BLOCKING_SEMANTIC_RULE_CLASSES[number]
  question: string
  /** Result of the mechanical pre-check, when the probe has one. Probes are
   * meant to ask only about real gaps; asking about a file that is plainly
   * present is how a questionnaire loses its audience. */
  precheck?: { kind: 'file' | 'command' | 'capability' | 'source-scan'; target: string; found: boolean }
  status: 'answered' | 'deferred' | 'not_applicable'
  answer?: string
  /** Constraint ids this answer shaped. */
  affects: string[]
}

export interface LoopIntakeDeferral {
  id: string
  question: string
  assumedDefault: string
  affects: string[]
}

export interface LoopIntakeRecord {
  schemaVersion: typeof LOOP_INTAKE_SCHEMA
  /** Same shape and same invalidation rule as the Architect checkpoint. */
  source: { requirement: string; projectDir: string; sha256: string }
  constraints: LoopConstraintLedger
  /** Ids whose `kind`/`strength`/`statement` the human confirmed. Entries the
   * human skipped are still `origin: 'intake'` but remain editable, so the two
   * sets overlap without being equal. */
  approvedConstraintIds: string[]
  preconditions: LoopPreconditions
  probes: LoopIntakeProbe[]
  deferred: LoopIntakeDeferral[]
  completedAt: number
}

/**
 * Probe bank, reverse-derived from the blocking rule classes.
 *
 * An open-ended "find problems with this document" interview would just move
 * the reviewer's sampling variance earlier in the pipeline. The set of things
 * that will actually block is already a closed enum, so the questionnaire is
 * derived from it: every probe here corresponds to a class that can stop a
 * Distill run, and classes with no source-side remedy are deliberately absent.
 */
export const INTAKE_PROBE_BANK: ReadonlyArray<{
  ruleClass: typeof BLOCKING_SEMANTIC_RULE_CLASSES[number]
  question: string
  precheckKind?: LoopIntakeProbe['precheck'] extends infer T ? T extends { kind: infer K } ? K : never : never
}> = [
  {
    ruleClass: 'missing-source-bound',
    question: '来源中出现的每个数量上限或时间上限（"最多 N 轮"、"不超过 T 小时"）：一个单位对应什么可观测事件？它与一次 Activation 如何换算？没有换算关系的上限在图里无法实现。',
    precheckKind: 'source-scan',
  },
  {
    ruleClass: 'single-agent-terminal-authority',
    question: '谁有权判定"完成"？核验用的固定标准是什么？做工作的 Agent 自己声称完成不能作数，必须有独立只读 Reviewer 或确定性 Function。',
  },
  {
    ruleClass: 'missing-precondition',
    question: '首个 Activation 就要读取的文件、必须已安装的外部命令、必须已配置的凭据分别有哪些？loop 自己会创建的不算。',
    precheckKind: 'file',
  },
  {
    ruleClass: 'fabricated-capability',
    question: '这个 loop 需要的能力（Function、Effect、Skill、外部工具）运行时是否已注册？缺失的能力必须在启动前置条件里说明，不能在图里假装已实现。',
    precheckKind: 'capability',
  },
  {
    ruleClass: 'unbriefed-agent-constraint',
    question: '需要靠判断而非规则完成的事项，交给哪个角色？该角色需要读到什么才能做出这个判断？',
  },
  {
    ruleClass: 'writer-boundary-bypass',
    question: '最终产物文件有哪些？每个文件由谁写？是追加（append）还是整体替换？是否存在多个生产者竞争同一个写面？',
  },
  {
    ruleClass: 'unbounded-or-unreachable-control',
    question: '这个 loop 在什么条件下应当停止？失败时应当怎么处理？哪些情况需要人工介入而不是自动继续？',
  },
  {
    ruleClass: 'constraint-weakened',
    question: '以下条目被标记为 hard（不可协商）约束，请逐条确认强度与分类是否正确。',
  },
]

/**
 * Blocking classes whose remedy lives in the source document rather than in the
 * Graph. Only these justify pointing a failed run at Intake — suggesting it for
 * a wrong JSON pointer would waste the user's time on a Compiler problem.
 */
const SOURCE_SIDE_RULE_CLASSES: ReadonlySet<string> = new Set([
  'missing-source-bound',
  'missing-precondition',
  'fabricated-capability',
  'single-agent-terminal-authority',
  'unbriefed-agent-constraint',
])

/**
 * Post-failure guidance. Intake is optional by design — forcing it would make
 * "fix one word and re-run" expensive — so the pipeline earns its use by
 * offering it precisely when the source, not the lowering, is what failed.
 */
export function intakeGuidanceForIssues(issues: readonly string[], requirement: string, hasIntake: boolean): string {
  if (hasIntake) return ''
  const matched = issues.filter(issue => [...SOURCE_SIDE_RULE_CLASSES].some(ruleClass => issue.includes(`[${ruleClass}]`)))
  if (!matched.length) return ''
  return `\n这 ${matched.length} 条阻断属于来源信息缺失，Compiler 无法自行修复（需要补充的是需求本身，不是图）。`
    + `\n建议先运行：meta-agent loop intake ${requirement}`
}

export function emptyLoopIntakeRecord(source: LoopIntakeRecord['source']): LoopIntakeRecord {
  return {
    schemaVersion: LOOP_INTAKE_SCHEMA,
    source,
    constraints: { schemaVersion: LOOP_CONSTRAINTS_SCHEMA, goal: '', constraints: [] },
    approvedConstraintIds: [],
    preconditions: emptyLoopPreconditions(),
    probes: [],
    deferred: [],
    completedAt: 0,
  }
}

export function validateLoopIntakeRecord(value: LoopIntakeRecord): string[] {
  const errors: string[] = []
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['intake must be an object']
  if (value.schemaVersion !== LOOP_INTAKE_SCHEMA) errors.push(`intake.schemaVersion must be '${LOOP_INTAKE_SCHEMA}'`)
  if (!value.source || typeof value.source.sha256 !== 'string' || !value.source.sha256) errors.push('intake.source.sha256 must be present')
  errors.push(...validateConstraintLedger(value.constraints).map(error => `intake.${error}`))
  errors.push(...validateLoopPreconditions(value.preconditions).map(error => `intake.${error}`))
  if (!Array.isArray(value.approvedConstraintIds)) errors.push('intake.approvedConstraintIds must be an array')
  else {
    const known = new Set((value.constraints?.constraints ?? []).map(item => item?.id))
    for (const id of value.approvedConstraintIds) {
      if (!known.has(id)) errors.push(`intake.approvedConstraintIds references unknown constraint '${id}'`)
    }
  }
  if (!Array.isArray(value.probes)) errors.push('intake.probes must be an array')
  if (!Array.isArray(value.deferred)) errors.push('intake.deferred must be an array')
  // Every entry the human touched must be labelled, or the Architect's
  // immutability check silently degrades to a no-op.
  for (const [index, constraint] of (value.constraints?.constraints ?? []).entries()) {
    if (constraint?.origin !== 'intake') errors.push(`intake.constraints.constraints[${index}].origin must be 'intake'`)
  }
  return errors
}

/** Compact, reviewable rendering of the confirmed ledger for the Architect. */
export function formatIntakeLedgerForArchitect(intake: LoopIntakeRecord): string {
  const approved = new Set(intake.approvedConstraintIds)
  const rows = intake.constraints.constraints.map(constraint => {
    const lock = approved.has(constraint.id) ? '已确认·不可改动' : '未确认·可修订'
    return `- ${constraint.id} [${constraint.kind} → ${deriveEnforcementLocus(constraint.kind)}] (${constraint.strength}, ${lock}) ${constraint.statement}`
  })
  return [
    '【已由人确认的约束台账（Intake 产出）】',
    `goal: ${intake.constraints.goal}`,
    ...rows,
    ...(intake.deferred.length
      ? ['【人明确暂缓的决策（已进入运行前置条件，不要替它们代答）】',
        ...intake.deferred.map(item => `- ${item.id}: ${item.question}（拟用默认：${item.assumedDefault}）`)]
      : []),
  ].join('\n')
}

export interface LoopIntakeStore {
  load(source: DistillCheckpointSource): Promise<LoopIntakeRecord | null>
  save(source: DistillCheckpointSource, value: Omit<LoopIntakeRecord, 'schemaVersion' | 'source' | 'completedAt'>): Promise<LoopIntakeRecord>
  readonly path: string
}

/** `loop.intake.json` beside the other Distill artifacts. */
export function createFileLoopIntakeStore(projectDir: string): LoopIntakeStore {
  const path = resolve(projectDir, LOOP_INTAKE_FILE)
  return {
    path,
    async load(source) {
      const current = await distillSourceIdentity(source).catch(() => null)
      if (!current) return null
      try {
        const parsed = JSON.parse(await readFile(path, 'utf8')) as LoopIntakeRecord
        if (validateLoopIntakeRecord(parsed).length) return null
        // A requirement edit invalidates the human's confirmations outright.
        // Silently compiling against a stale intake would be worse than having
        // none at all, because the artifact would claim human sign-off.
        if (parsed.source.sha256 !== current.sha256 || parsed.source.requirement !== current.requirement) return null
        return parsed
      } catch {
        return null
      }
    },
    async save(source, value) {
      const identity = await distillSourceIdentity(source)
      const record: LoopIntakeRecord = {
        schemaVersion: LOOP_INTAKE_SCHEMA,
        source: identity,
        constraints: structuredClone(value.constraints),
        approvedConstraintIds: [...value.approvedConstraintIds],
        preconditions: structuredClone(value.preconditions),
        probes: structuredClone(value.probes),
        deferred: structuredClone(value.deferred),
        completedAt: Date.now(),
      }
      const temporary = `${path}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`
      await writeFile(temporary, JSON.stringify(record, null, 2), 'utf8')
      await rename(temporary, path)
      return record
    },
  }
}

export function buildLoopIntakeSystem(): string {
  return `你是 Loop Distill 的 Intake 主持人。你与人一起，把一份自然语言 Loop 需求变成一份**人已逐条确认的约束台账**。你不设计 Graph，不写代码，也不执行需求本身。

【为什么需要这一步】
后续 Distill 有一组固定的阻断项，其中一部分**无论 Compiler 怎么改都修不好**，因为缺的信息根本不在文档里：一个没有换算关系的轮次上限、一个没写核验标准的完成条件、一个项目里并不存在的输入文件。这些只有人能补。你的职责是在任何 Graph 存在之前把它们问出来。

【工作方式】
1. 先用 read_file 读取需求原文；再用 glob/grep/read_file 对项目做最小充分的核查。
2. **先机械预检，再提问。** 文件是否存在、命令是否可用、能力是否注册——先自己查。只问真正查不出答案的问题。把已经查清的事实直接写进台账，不要拿它去占用人的注意力。
3. 用 ask_user 逐条提问，一次一个主题，给出你的推荐答案和它的后果。人可以回答，也可以明确暂缓。
4. 人选择暂缓时，不要静默采用默认值：记入 deferred，它会进入运行前置条件，由 loop create 在启动前再拦一次。

【kind 的确认是本阶段最重要的产出】
kind 不是分类标签，它机械决定该约束**在哪里被执行**，后续阶段无权更改：
- deterministic_rule / workspace_protocol / ownership / terminal_obligation / failure_boundary / budget / timer / event → **Graph**：必须落在路由、权限或硬边界上。
- goal / recovery / other → **厚 Worker Agent**：Graph 里没有对应元素才是正确设计。
- success_criteria → **独立 Reviewer**：做工作的 Agent 不能给自己签发完成证书。
- capability → **人**：进入启动前置条件。

向人呈现时要说人话，例如「C7『每轮必须记录到 progress.md』→ 由 Graph 的 Lane 写规则强制」，让人只判断这句话对不对，而不是去理解枚举值。标错 kind 会在后面制造一条谁都修不好的问题。

【JSON 字符串里不要出现半角双引号】
这是本阶段唯一真实发生过的失败：你在中文叙述里引用文档原文时写了半角 " …… "，没有转义，整份信封就此解析失败——而它里面装着刚刚问出来的一整场对话。引用原文请用中文引号「」或“”，或者直接改述。这条比下面任何一条格式要求都重要。

【唯一输出】
只输出一个 JSON 对象，不要 Markdown fence、解释前缀或 Graph。**下面是确切形状，不要自己发明更贴合领域的结构**：

{
  "constraints": {
    "schemaVersion": "${LOOP_CONSTRAINTS_SCHEMA}",
    "goal": "来源中的总目标",
    "constraints": [
      {"id":"C1","kind":"budget","statement":"约束原文或精确改述","strength":"hard","origin":"intake",
       "sources":[{"path":"loop.md","locator":"L152"}],"acceptance":["可观测的验收条件"]}
    ]
  },
  "approvedConstraintIds": ["C1"],
  "preconditions": {
    "schemaVersion": "${LOOP_PRECONDITIONS_SCHEMA}",
    "items": [
      {"kind":"file","target":"data/motion.npz","reason":"首个 Activation 就要读取","blocking":true},
      {"kind":"directory","target":"humanoid/","reason":"改造 PPO 基线的代码目录","blocking":true},
      {"kind":"command","target":"mujoco","reason":"回放与 Sim2Sim 验证","blocking":true},
      {"kind":"credential","target":"account-pool","reason":"远端训练换号","blocking":true},
      {"kind":"decision","target":"DEF-THRESHOLDS","reason":"阈值待首次正式训练前冻结","blocking":true}
    ]
  },
  "probes": [
    {"ruleClass":"missing-precondition","question":"问过的问题",
     "precheck":{"kind":"file","target":"humanoid/","found":false},
     "status":"answered","answer":"人的回答","affects":["C1"]}
  ],
  "deferred": [
    {"id":"DEF-THRESHOLDS","question":"暂缓的问题","assumedDefault":"无默认值，训练前冻结","affects":["C1"]}
  ]
}

- **preconditions 是扁平的 items 数组**，不是按 paths / commands / credentials 分组的对象。kind 只能是 file|directory|command|credential|decision，target 必须是项目相对路径、命令名、凭据名或决策 id。
- 每条 constraint 的 origin 必须是 "intake"；kind 只能取 goal|success_criteria|deterministic_rule|workspace_protocol|terminal_obligation|ownership|capability|timer|event|failure_boundary|recovery|budget|other。
- approvedConstraintIds 只列出人**明确确认过** kind 与 strength 的 id。人没看过或跳过的不要列进去——列进去会让后续阶段无法修正你的错误。
- probes[].status 只能是 answered|deferred|not_applicable（不要用 resolved）；precheck 是对象 {kind,target,found}，kind 取 file|command|capability|source-scan。
- probes[].ruleClass 必须取自：${BLOCKING_SEMANTIC_RULE_CLASSES.join('、')}。
- deferred 里的每个 id 都应同时作为一条 kind:"decision" 出现在 preconditions.items 中。`
}

export type ParsedIntake = Omit<LoopIntakeRecord, 'schemaVersion' | 'source' | 'completedAt'>

/**
 * Parsing an Intake envelope is not like parsing the other phases.
 *
 * The Architect and the Compiler can be re-run for the price of a model call.
 * An Intake envelope has a human conversation baked into it — every answer the
 * person just gave — so returning a bare `null` and letting the caller die
 * throws away the single most expensive artifact in the pipeline. This returns
 * a diagnosis instead, so the caller can repair, retry, or at minimum tell the
 * user precisely what to fix in the raw output it kept.
 */
export function parseIntakeOutput(output: unknown, summary?: string): ParsedIntake | null {
  return parseIntakeEnvelope(output, summary).record ?? null
}

export function parseIntakeEnvelope(output: unknown, summary?: string): { record?: ParsedIntake; diagnosis: string } {
  let sawObjectWithoutConstraints = false
  for (const candidate of structuredJsonCandidates(output, summary)) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
    const object = candidate as Record<string, unknown>
    if (!object.constraints || typeof object.constraints !== 'object' || Array.isArray(object.constraints)) {
      sawObjectWithoutConstraints = true
      continue
    }
    const constraints = object.constraints as LoopConstraintLedger
    // The model is asked for `origin: 'intake'`, but the host owns the label:
    // it is what makes the immutability check meaningful, so it is stamped
    // rather than trusted.
    for (const constraint of constraints.constraints ?? []) if (constraint) constraint.origin = 'intake'
    return {
      record: {
        constraints,
        approvedConstraintIds: Array.isArray(object.approvedConstraintIds)
          ? object.approvedConstraintIds.filter((id): id is string => typeof id === 'string')
          : [],
        preconditions: normalizeIntakePreconditions(object.preconditions),
        probes: normalizeIntakeProbes(object.probes),
        deferred: Array.isArray(object.deferred) ? object.deferred as LoopIntakeDeferral[] : [],
      },
      diagnosis: '',
    }
  }
  // A structural miss outranks a JSON-level one. When a well-formed object did
  // arrive, "the envelope has no constraints ledger" is the actionable fact;
  // reporting a generic parse complaint would send the reader hunting for a
  // syntax error that is not there.
  if (sawObjectWithoutConstraints) {
    return { diagnosis: '找到了 JSON 对象，但顶层缺少 constraints 键（约束台账是本阶段的一等产物，不能省略）' }
  }
  return { diagnosis: describeJsonDefect(output, summary) ?? '输出中没有找到任何 JSON 对象' }
}

/**
 * Accept the domain-shaped precondition object models keep inventing.
 *
 * The prompt used to name `LoopPreconditions` without showing it, and models
 * reliably produced a richer, more natural grouping —
 * `{paths, commands, credentials, deferredDecisions}` — instead of the flat
 * `items` list. That is a good-faith reading of an under-specified contract,
 * and rejecting it costs the whole session. The prompt now shows the shape,
 * and this maps the variant rather than punishing it.
 */
export function normalizeIntakePreconditions(value: unknown): LoopPreconditions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyLoopPreconditions()
  const object = value as Record<string, unknown>
  if (Array.isArray(object.items)) {
    return { schemaVersion: LOOP_PRECONDITIONS_SCHEMA, items: object.items as LoopPreconditions['items'] }
  }
  const items: LoopPreconditions['items'] = []
  for (const raw of asArray(object.paths)) {
    const path = raw as { path?: unknown; target?: unknown; mustExist?: unknown; note?: unknown; reason?: unknown }
    const target = text(path.path) ?? text(path.target)
    if (!target) continue
    items.push({
      // A trailing separator is the only signal available here, and guessing
      // wrong only changes which mechanical existence check runs.
      kind: /[/\\]$/.test(target) ? 'directory' : 'file',
      target: target.replace(/^\.\//, ''),
      reason: text(path.note) ?? text(path.reason) ?? 'declared during Intake',
      blocking: path.mustExist !== false,
    })
  }
  for (const raw of asArray(object.commands)) {
    const command = raw as { name?: unknown; target?: unknown; note?: unknown; reason?: unknown; mustBeInstalled?: unknown }
    const target = text(command.name) ?? text(command.target)
    if (!target) continue
    items.push({ kind: 'command', target, reason: text(command.note) ?? text(command.reason) ?? 'declared during Intake', blocking: command.mustBeInstalled !== false })
  }
  for (const raw of asArray(object.credentials)) {
    const credential = raw as { name?: unknown; target?: unknown; note?: unknown; reason?: unknown; mustBeConfigured?: unknown }
    const target = text(credential.name) ?? text(credential.target)
    if (!target) continue
    items.push({ kind: 'credential', target, reason: text(credential.note) ?? text(credential.reason) ?? 'declared during Intake', blocking: credential.mustBeConfigured !== false })
  }
  for (const raw of [...asArray(object.deferredDecisions), ...asArray(object.decisions)]) {
    const decision = raw as { id?: unknown; target?: unknown; description?: unknown; question?: unknown; reason?: unknown }
    const target = text(decision.id) ?? text(decision.target)
    if (!target) continue
    items.push({ kind: 'decision', target, reason: text(decision.description) ?? text(decision.question) ?? text(decision.reason) ?? 'deferred during Intake', blocking: true })
  }
  return { schemaVersion: LOOP_PRECONDITIONS_SCHEMA, items }
}

/**
 * Probes are diagnostic metadata, not contract, so they are normalised rather
 * than validated. `status: 'resolved'` and a prose `precheck` are both obvious
 * intent; failing an Intake over them would trade a real human conversation for
 * a vocabulary mismatch in a field nothing executes.
 */
export function normalizeIntakeProbes(value: unknown): LoopIntakeProbe[] {
  return asArray(value).map(raw => {
    const probe = raw as Record<string, unknown>
    const status = String(probe.status ?? 'answered')
    const precheck = probe.precheck
    return {
      ruleClass: probe.ruleClass as LoopIntakeProbe['ruleClass'],
      question: text(probe.question) ?? '',
      ...(precheck && typeof precheck === 'object' && !Array.isArray(precheck)
        ? { precheck: precheck as LoopIntakeProbe['precheck'] }
        : text(precheck)
          ? { precheck: { kind: 'source-scan' as const, target: text(precheck)!.slice(0, 200), found: true } }
          : {}),
      status: status === 'deferred' ? 'deferred' : status === 'not_applicable' ? 'not_applicable' : 'answered',
      ...(text(probe.answer) ? { answer: text(probe.answer)! } : {}),
      affects: asArray(probe.affects).filter((item): item is string => typeof item === 'string'),
    }
  })
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}
