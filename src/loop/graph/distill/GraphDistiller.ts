import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { GraphRuntimeCatalog } from '../runtime/GraphCatalog.js'
import type { LoopGraphSpec } from '../spec/GraphTypes.js'
import { freezeLoopGraph, validateLoopGraph } from '../spec/GraphValidate.js'
import { formatGraphLintFindings, lintLoopGraph } from '../spec/GraphLint.js'
import type { GraphDistillExecutor, GraphDistillPhase } from './ForegroundGraphDistillExecutor.js'
import type { DistillCheckpointStore } from './DistillCheckpoint.js'
import {
  GRAPH_TRACEABILITY_SCHEMA,
  LOOP_CONSTRAINTS_SCHEMA,
  LOOP_DESIGN_SCHEMA,
  LOOP_PRECONDITIONS_SCHEMA,
  SEMANTIC_REVIEW_LAYERS,
  SEMANTIC_REVIEW_SCHEMA,
  buildGraphImplementationManifest,
  emptyLoopPreconditions,
  renderLoopBlueprintMarkdown,
  renderSemanticReviewMarkdown,
  validateConstraintLedger,
  validateGraphTraceability,
  validateLoopBlueprint,
  validateLoopPreconditions,
  type GraphImplementationManifest,
  type GraphTraceabilityMap,
  type LayeredSemanticReview,
  type LoopBlueprint,
  type LoopConstraintLedger,
  type LoopPreconditions,
} from './DistillDesign.js'

export interface DistillGraphResult {
  constraints: LoopConstraintLedger
  design: LoopBlueprint
  graph: LoopGraphSpec
  traceability: GraphTraceabilityMap
  manifest: GraphImplementationManifest
  preconditions: LoopPreconditions
  semanticReview: LayeredSemanticReview
  designMarkdown: string
  semanticReviewMarkdown: string
  taskSpec: string
  attempts: number
  phaseAttempts?: { architect: number; compiler: number; reviewer: number }
}

export class DistillInterruptedError extends Error {
  readonly name = 'DistillInterruptedError'
  constructor(readonly phase: GraphDistillPhase, reason: string) {
    super(`Distill interrupted during ${phase}: ${reason}`)
  }
}

export const DISTILL_ARTIFACT_FILES = {
  constraints: 'loop.constraints.json',
  design: 'loop.design.json',
  designMarkdown: 'loop.design.md',
  traceability: 'loop.graph.traceability.json',
  manifest: 'loop.graph.manifest.json',
  preconditions: 'loop.preconditions.json',
  semanticReview: 'loop.semantic-review.json',
  semanticReviewMarkdown: 'loop.semantic-review.md',
  taskSpec: 'loop.graph.review.md',
} as const

export async function writeDistillArtifacts(projectDir: string, graphFile: string, result: DistillGraphResult): Promise<void> {
  const artifacts = new Map<string, string>([
    [resolve(projectDir, graphFile), JSON.stringify(result.graph, null, 2)],
    [resolve(projectDir, DISTILL_ARTIFACT_FILES.constraints), JSON.stringify(result.constraints, null, 2)],
    [resolve(projectDir, DISTILL_ARTIFACT_FILES.design), JSON.stringify(result.design, null, 2)],
    [resolve(projectDir, DISTILL_ARTIFACT_FILES.designMarkdown), result.designMarkdown],
    [resolve(projectDir, DISTILL_ARTIFACT_FILES.traceability), JSON.stringify(result.traceability, null, 2)],
    [resolve(projectDir, DISTILL_ARTIFACT_FILES.manifest), JSON.stringify(result.manifest, null, 2)],
    [resolve(projectDir, DISTILL_ARTIFACT_FILES.preconditions), JSON.stringify(result.preconditions, null, 2)],
    [resolve(projectDir, DISTILL_ARTIFACT_FILES.semanticReview), JSON.stringify(result.semanticReview, null, 2)],
    [resolve(projectDir, DISTILL_ARTIFACT_FILES.semanticReviewMarkdown), result.semanticReviewMarkdown],
    [resolve(projectDir, DISTILL_ARTIFACT_FILES.taskSpec), result.taskSpec],
  ])
  for (const [path, content] of artifacts) await atomicWrite(path, content)
}

export async function readDistillArtifacts(projectDir: string, graphFile: string): Promise<DistillGraphResult> {
  const readJson = async <T>(path: string): Promise<T> => JSON.parse(await readFile(resolve(projectDir, path), 'utf8')) as T
  const [graph, constraints, design, traceability, manifest, semanticReview] = await Promise.all([
    readJson<LoopGraphSpec>(graphFile),
    readJson<LoopConstraintLedger>(DISTILL_ARTIFACT_FILES.constraints),
    readJson<LoopBlueprint>(DISTILL_ARTIFACT_FILES.design),
    readJson<GraphTraceabilityMap>(DISTILL_ARTIFACT_FILES.traceability),
    readJson<GraphImplementationManifest>(DISTILL_ARTIFACT_FILES.manifest),
    readJson<LayeredSemanticReview>(DISTILL_ARTIFACT_FILES.semanticReview),
  ])
  // Older drafts predate the preconditions artifact; treat absence as empty.
  const preconditions = await readJson<LoopPreconditions>(DISTILL_ARTIFACT_FILES.preconditions).catch(() => emptyLoopPreconditions())
  const taskSpec = await readFile(resolve(projectDir, DISTILL_ARTIFACT_FILES.taskSpec), 'utf8').catch(() => '')
  return {
    graph, constraints, design, traceability, manifest, preconditions, semanticReview, taskSpec, attempts: 1,
    designMarkdown: renderLoopBlueprintMarkdown(constraints, design),
    semanticReviewMarkdown: renderSemanticReviewMarkdown(semanticReview),
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`
  await writeFile(temporary, content, 'utf8')
  await rename(temporary, path)
}

/** Filesystem entrypoint for a Distill session. The host supplies only the
 * requirement reference and workspace identity; the Compiler must use its
 * read-only tools to discover the actual requirement and relevant project state. */
export interface DistillSource {
  requirement: string
  projectDir: string
}

/** Scenario-neutral source graph embedded verbatim in the Compiler prompt.
 * Tests validate and Freeze this exact object so the example cannot drift from
 * the executable ABI. It demonstrates nesting/dataflow, not domain topology. */
export const CANONICAL_GRAPH_DISTILL_EXAMPLE: LoopGraphSpec = {
  schemaVersion: 'graph-2.0',
  id: 'bounded_iterative_loop',
  version: 1,
  goal: 'Iterate until the semantic worker reports completion, otherwise fail cleanly.',
  state: {
    iteration: {
      type: { type: 'integer', minimum: 0 },
      initial: 0,
      description: 'Number of committed iterations.',
    },
  },
  lanes: {
    work: {
      context: 'persistent',
      workspace: { read: ['requirements.md'], write: [], deny: ['.git'] },
      maxConcurrency: 1,
      description: 'One continuous semantic work context.',
    },
  },
  nodes: {
    work: {
      type: 'agent',
      lane: 'work',
      prompt: 'Perform one bounded iteration and report whether the goal is complete.',
      inputs: { iteration: { ref: '$state.iteration' } },
      outputSchema: {
        type: 'object',
        required: ['complete'],
        properties: {
          complete: { type: 'boolean' },
        },
        additionalProperties: false,
      },
      tools: ['read_file'],
      maxAttempts: 3,
      budget: { turns: 20, usd: 10, wallTimeMs: 600_000 },
    },
    done: { type: 'terminal', status: 'done', result: { ref: '$input.result' } },
    failed: { type: 'terminal', status: 'failed', result: { ref: '$input.error' } },
  },
  transitions: [
    {
      id: 'goal_reached', from: 'work', on: 'success',
      when: '$output.complete == true', priority: 100,
      to: { node: 'done', inputs: { result: { ref: '$output' } } },
    },
    {
      id: 'continue_work', from: 'work', on: 'success', default: true,
      updates: [{ target: 'iteration', reducer: 'builtin/increment@1' }],
      to: 'work',
    },
    {
      id: 'work_failed', from: 'work', on: 'failure',
      to: { node: 'failed', inputs: { error: { ref: '$output' } } },
    },
  ],
  entrypoints: [{ id: 'start', node: 'work' }],
  limits: { maxActivations: 100, maxWallTimeMs: 86_400_000, maxCostUsd: 20 },
  concurrency: { maxActivations: 1, maxPerNode: 1, stateConsistency: 'commit_latest' },
}

export interface DistillGraphDeps {
  executor: GraphDistillExecutor
  catalog: GraphRuntimeCatalog
  signal?: AbortSignal
  maxAttempts?: number
  /** Independent intent-equivalence review; enabled by default. */
  semanticReview?: boolean
  /** Optional durable Architect checkpoint. Compiler repair never rewrites it. */
  checkpoint?: DistillCheckpointStore
  onProgress?: (event: GraphDistillProgressEvent) => void
}

/** Distill compiles a small executable control skeleton. These limits constrain
 * the compiler/reviewer sessions only; they do not reduce the planning room of
 * Agent nodes in the resulting Graph. */
export const GRAPH_DISTILL_PHASE_POLICY: Record<GraphDistillPhase, {
  thinkingBudgetTokens: number
  maxOutputTokens: number
  maxWallTimeMs: number
  maxTurns: number
  maxBudgetUsd: number
}> = {
  architect: {
    thinkingBudgetTokens: 12_000, maxOutputTokens: 32_768,
    maxWallTimeMs: 1_200_000, maxTurns: 30, maxBudgetUsd: 10,
  },
  // Lowering is schema-directed and has graph_reference/graph_validate as its
  // observable scratchpad. Extended thinking encouraged provider-dependent,
  // unreviewable over-design in real Distill runs, so keep it off here.
  compiler: {
    thinkingBudgetTokens: 0, maxOutputTokens: 49_152,
    maxWallTimeMs: 1_200_000, maxTurns: 30, maxBudgetUsd: 10,
  },
  // Review is an evidence-directed acceptance gate, not another design pass.
  // Extended thinking repeatedly consumed the entire wall window without a
  // verdict on real projects, so keep the contract bounded and output-focused.
  semantic_review: {
    thinkingBudgetTokens: 0, maxOutputTokens: 16_384,
    maxWallTimeMs: 1_200_000, maxTurns: 30, maxBudgetUsd: 10,
  },
}

/** A parsed, ABI-valid graph can still need a local repair after the independent
 * semantic review. Keep that repair budget separate from mechanical lowering
 * retries: otherwise formatting/traceability retries can consume every chance
 * to fix a real source-contract discrepancy. */
const MAX_LOCAL_SEMANTIC_REPAIRS = 2
const MAX_LATE_COMPILER_RECOVERIES = 1

export type GraphDistillProgressEvent =
  | { type: 'checkpoint_resumed'; phase: 'architect' }
  | { type: 'phase_started'; phase: GraphDistillPhase; attempt: number; maxAttempts: number }
  | { type: 'phase_completed'; phase: GraphDistillPhase; attempt: number }
  | { type: 'validation_passed'; phase: 'compiler'; attempt: number }
  | { type: 'validation_failed'; phase: 'architect' | 'compiler'; attempt: number; issues: string[] }
  | { type: 'semantic_review_accepted'; attempt: number }
  | { type: 'semantic_review_rejected'; attempt: number; issues: string[] }

export async function distillLoopGraph(source: DistillSource, deps: DistillGraphDeps): Promise<DistillGraphResult> {
  return compileLoopGraph(source, deps, (attempt, lastErrors) => [
    attempt > 1 ? `上一次 Blueprint、Graph lowering、Freeze 或语义复核失败。重新核对来源并修订：\n${formatArchitectValidationFeedback(lastErrors)}` : '',
    formatDistillSource(source),
  ].filter(Boolean).join('\n\n'))
}

/** Apply a user's follow-up constraints in the same foreground compiler conversation.
 * The full current draft is repeated as a durable anchor so compaction or a
 * caller restart cannot make the revision depend on hidden chat state. */
export async function reviseLoopGraph(
  source: DistillSource,
  current: Pick<DistillGraphResult, 'graph' | 'taskSpec'> & Partial<Pick<DistillGraphResult, 'constraints' | 'design' | 'traceability' | 'manifest'>>,
  reviewFeedback: string,
  deps: DistillGraphDeps,
): Promise<DistillGraphResult> {
  const reviewSource = [
    formatDistillSource(source),
    '【用户在后续 Distill turn 中新增的约束与意见】',
    reviewFeedback,
  ].join('\n\n')
  return compileLoopGraph(source, { ...deps, checkpoint: undefined }, (attempt, lastErrors) => [
    '【后续 Distill turn】',
    '用户检查了已落盘的上一版 Blueprint 与 Graph，并给出了补充或纠正。先更新约束台账和 Blueprint；不要直接给旧 Graph 打补丁。',
    attempt > 1 ? `上一次修订仍未通过校验。先在 Blueprint 中逐项修复：\n${formatArchitectValidationFeedback(lastErrors)}` : '',
    formatDistillSource(source),
    ...(current.constraints ? ['【当前约束台账】', JSON.stringify(current.constraints)] : []),
    ...(current.design ? ['【当前 Loop Blueprint】', JSON.stringify(current.design)] : []),
    '【当前 Graph 草图】', JSON.stringify(current.graph),
    '【当前编译说明】', current.taskSpec,
    '【用户累计补充与纠正】', reviewFeedback,
  ].filter(Boolean).join('\n\n'), reviewSource)
}

async function compileLoopGraph(
  source: DistillSource,
  deps: DistillGraphDeps,
  buildTask: (attempt: number, lastErrors: string[]) => string,
  reviewSource = formatDistillSource(source),
  semanticRevision = 0,
): Promise<DistillGraphResult> {
  const maxAttempts = deps.maxAttempts ?? 3
  const signal = deps.signal ?? new AbortController().signal
  const architectSystemPrompt = buildLoopArchitectSystem()
  const compilerSystemPrompt = buildGraphDistillerSystem(deps.catalog)
  let architecture: { constraints: LoopConstraintLedger; design: LoopBlueprint } | undefined
  let architectErrors: string[] = []
  let architectAttempts = 0

  const checkpoint = await deps.checkpoint?.load(source)
  if (checkpoint) {
    const checkpointErrors = [
      ...validateConstraintLedger(checkpoint.constraints),
      ...validateLoopBlueprint(checkpoint.design, checkpoint.constraints),
    ]
    if (!checkpointErrors.length) {
      architecture = { constraints: checkpoint.constraints, design: checkpoint.design }
      deps.onProgress?.({ type: 'checkpoint_resumed', phase: 'architect' })
    }
  }

  // Architect and Compiler have independent retry budgets. Once the semantic
  // contract is valid, a Graph ABI/lowering failure must not regenerate it.
  for (let attempt = 1; attempt <= maxAttempts && !architecture; attempt++) {
    architectAttempts = attempt
    throwIfDistillAborted(signal, 'architect')
    deps.onProgress?.({ type: 'phase_started', phase: 'architect', attempt, maxAttempts })
    const architectRecord = await deps.executor.execute({
      phase: 'architect',
      ...GRAPH_DISTILL_PHASE_POLICY.architect,
      sessionKey: 'distill-architect',
      taskDescription: [
        buildTask(attempt, architectErrors),
        '【本阶段任务：Architect】',
        '读取来源并只输出 {constraints,design}。先把自然语言约束稳定为可审查的三面 Loop Blueprint，不要在本阶段输出 Graph。若缺少会改变权限、路由或安全边界的信息，使用 ask_user。',
      ].join('\n\n'),
      systemPrompt: architectSystemPrompt,
      allowedTools: ['read_file', 'grep', 'glob', 'ask_user'],
      signal,
    })
    if (architectRecord.status === 'cancelled' || signal.aborted) {
      throw new DistillInterruptedError('architect', architectRecord.error ?? abortReason(signal))
    }
    if (architectRecord.status !== 'completed') {
      architectErrors = [`foreground architect ${architectRecord.status}: ${architectRecord.error ?? 'no terminal error detail'}`]
      deps.onProgress?.({ type: 'validation_failed', phase: 'architect', attempt, issues: architectErrors })
      continue
    }
    deps.onProgress?.({ type: 'phase_completed', phase: 'architect', attempt })
    const candidate = parseArchitectOutput(architectRecord.output, architectRecord.summary)
    if (!candidate) {
      architectErrors = ['no parseable {constraints, design} from foreground architect']
      deps.onProgress?.({ type: 'validation_failed', phase: 'architect', attempt, issues: architectErrors })
      continue
    }
    let architectureErrors: string[]
    try {
      architectureErrors = [
        ...validateConstraintLedger(candidate.constraints),
        ...validateLoopBlueprint(candidate.design, candidate.constraints),
      ]
    } catch (error) {
      architectureErrors = [`layered design shape could not be validated: ${error instanceof Error ? error.message : String(error)}`]
    }
    if (architectureErrors.length) {
      architectErrors = architectureErrors
      deps.onProgress?.({ type: 'validation_failed', phase: 'architect', attempt, issues: architectErrors })
      continue
    }
    architecture = candidate
    await deps.checkpoint?.save(source, architecture)
  }
  if (!architecture) {
    throw new Error(`graph architect failed after ${maxAttempts} attempts:\n- ${architectErrors.join('\n- ')}`)
  }

  let compilerErrors: string[] = []
  let compilerDraft: {
    graph: LoopGraphSpec
    traceability: GraphTraceabilityMap
    taskSpec: string
    preconditions: LoopPreconditions
  } | undefined
  let validatedGraphDraft: LoopGraphSpec | undefined
  let reviewerAttempts = 0
  // The initial envelope also covers validator/format recovery. A semantic
  // rejection then reserves its own bounded local-repair calls dynamically;
  // otherwise late mechanical retries can consume the advertised allowance.
  let compilerAttemptLimit = maxAttempts + MAX_LOCAL_SEMANTIC_REPAIRS
  const compilerAttemptCeiling = compilerAttemptLimit + MAX_LOCAL_SEMANTIC_REPAIRS + MAX_LATE_COMPILER_RECOVERIES
  let localSemanticRepairs = 0
  let lateCompilerRecoveries = 0
  for (let attempt = 1; attempt <= compilerAttemptLimit; attempt++) {
    throwIfDistillAborted(signal, 'compiler')
    deps.onProgress?.({ type: 'phase_started', phase: 'compiler', attempt, maxAttempts: compilerAttemptLimit })
    const record = await deps.executor.execute({
      phase: 'compiler',
      ...GRAPH_DISTILL_PHASE_POLICY.compiler,
      sessionKey: 'distill-compiler',
      taskDescription: [
        '【本阶段任务：Compiler / Lowering】',
        '把已经确认的约束台账与轻量 Blueprint lower 为唯一现行 Graph ABI。Blueprint 不是第二套 Graph DSL；你可自由选择节点、Lane、Workspace 合同和路由 ID，但不得重新解释、删除或弱化 hard constraint。只输出 {graph,traceability,taskSpec}。',
        formatDistillSourceIdentity(source),
        ...(compilerErrors.length ? ['【上一轮 Compiler/Reviewer 诊断】', formatGraphValidationFeedback(compilerErrors)] : []),
        ...(validatedGraphDraft ? [
          '【已冻结 Graph：宿主保留，不要重复输出】',
          '上一轮 graph_validate 已对完整 Graph 返回 valid=true/frozen=true。宿主会自动把本次元数据与该 Graph 合并；你绝不能重建、修改或重复输出 graph，也不要调用任何工具。',
          '【立即执行】只返回一个小 JSON 对象：{"traceability":{...},"preconditions":{...},"taskSpec":"..."}。traceability 必须对应已冻结 Graph 的真实 JSON pointer；若上一轮诊断指出 traceability/preconditions，局部修复它们。',
        ] : compilerDraft ? [
          '【上一版完整候选（局部修复锚点）】',
          JSON.stringify(compilerDraft),
          '保留未被诊断否定的拓扑、命名和合同；只修改诊断涉及的可执行字段及其 traceability/preconditions。最终仍返回完整对象，不要返回 patch。',
        ] : []),
        '【约束台账】', JSON.stringify(architecture.constraints),
        '【Loop Blueprint】', JSON.stringify(architecture.design),
        validatedGraphDraft
          ? '【立即执行】不要输出分析、Graph、Markdown 或调用工具；只返回上面指定的 metadata JSON。'
          : '【立即执行】以上合同已完整。不要输出分析、设计过程、字段清单或 Markdown；下一步必须直接调用 graph_validate，参数必须是完整且最小的 graph（不是 skeleton）。若验证失败，只按 errors、repairHints 和 patchSelectors 调用 graph_patch_validate 做局部 set/remove；Transition 必须按 @id=稳定ID 定位，禁止数字下标、整图重发或重建。验证通过后立即返回最终 JSON。来源中的命名阶段默认映射到厚 Agent 内部步骤或 Transition+Reducer，不为阶段名称创建 Function。若存在唯一文件 writer：工作 Agent 的出边直接用 current>=T-1 等条件同时更新 next counter/status 后进入 writer，writer 再按 $state 路由；bootstrap/error/report/pivot 提交都复用该 writer，不得增加 identity/status gate 或第二写者。',
      ].join('\n\n'),
      systemPrompt: compilerSystemPrompt,
      allowedTools: ['ask_user', 'graph_reference', 'graph_validate', 'graph_patch_validate'],
      signal,
    })
    if (record.validatedGraph) validatedGraphDraft = structuredClone(record.validatedGraph)
    if (record.status === 'cancelled' || signal.aborted) {
      throw new DistillInterruptedError('compiler', record.error ?? abortReason(signal))
    }
    if (record.status !== 'completed') {
      compilerErrors = [`foreground compiler ${record.status}: ${record.error ?? 'no terminal error detail'}`]
      deps.onProgress?.({ type: 'validation_failed', phase: 'compiler', attempt, issues: compilerErrors })
      continue
    }
    deps.onProgress?.({ type: 'phase_completed', phase: 'compiler', attempt })
    const parsed = parseGraphCompilerOutput(record.output, record.summary)
      ?? (validatedGraphDraft
        ? parseGraphCompilerMetadata(record.output, record.summary, validatedGraphDraft)
        : null)
    if (!parsed) {
      compilerErrors = [`no parseable {graph, traceability, taskSpec}; foreground compiler status=${record.status} error=${record.error ?? '(none)'}`]
      deps.onProgress?.({ type: 'validation_failed', phase: 'compiler', attempt, issues: compilerErrors })
      // The foreground tool may have frozen a valid graph before the model's
      // final, oversized envelope is truncated or malformed. One compact
      // metadata-only turn is enough to recover it and should not be denied
      // merely because earlier envelope retries reached the current boundary.
      if (validatedGraphDraft && attempt >= compilerAttemptLimit && lateCompilerRecoveries < MAX_LATE_COMPILER_RECOVERIES) {
        lateCompilerRecoveries++
        compilerAttemptLimit = Math.min(compilerAttemptCeiling, attempt + 1)
      }
      continue
    }
    const preconditions = mergeUnresolvedIntoPreconditions(parsed.preconditions ?? emptyLoopPreconditions(), architecture.constraints)
    // The persistent Compiler conversation can be compacted. Repeating the
    // complete candidate gives the next retry a durable local-repair anchor.
    compilerDraft = { ...parsed, preconditions }
    let errors: string[]
    let executableRepairRequired = false
    let lintWarnings: string[] = []
    try {
      const graphErrors = validateLoopGraph(parsed.graph, deps.catalog)
      executableRepairRequired = graphErrors.length > 0
      errors = [
        ...graphErrors,
        ...validateGraphTraceability(parsed.traceability, architecture.constraints, parsed.graph),
        ...validateLoopPreconditions(preconditions),
      ]
      // Write-surface lint: error-level findings (external write targets,
      // git without any capability) are certain failures and block Distill.
      // Warning-level findings (nested-repo reliance, precomputed booleans,
      // dead routes) may be legitimate — they are handed to the semantic
      // reviewer, which has the tools to actually verify them per case.
      if (!errors.length) {
        const lint = lintLoopGraph(parsed.graph)
        const blockingLint = lint.filter(finding => finding.level === 'error')
        executableRepairRequired = blockingLint.length > 0
        errors = formatGraphLintFindings(blockingLint)
        lintWarnings = formatGraphLintFindings(lint.filter(finding => finding.level === 'warning'))
      }
    } catch (error) {
      errors = [`Graph lowering shape could not be validated: ${error instanceof Error ? error.message : String(error)}`]
    }
    if (!errors.length) {
      try {
        // Distill returns the logical source graph, but it must also survive the
        // exact logical-to-physical compilation Create will perform later.
        freezeLoopGraph(parsed.graph, deps.catalog, 0)
        const manifest = buildGraphImplementationManifest(parsed.graph)
        deps.onProgress?.({ type: 'validation_passed', phase: 'compiler', attempt })
        let semanticReview = skippedSemanticReview()
        if (deps.semanticReview !== false) {
          const reviewed = await reviewGraphSemantics(reviewSource, {
            ...architecture, ...parsed, manifest, preconditions, lintWarnings,
          }, deps, signal, attempt)
          semanticReview = reviewed.review
          reviewerAttempts += reviewed.attempts
          if (!semanticReview.accepted) {
            const semanticErrors = semanticReview.issues.length
              ? semanticReview.issues.map(issue => `semantic review: ${issue}`)
              : ['semantic review rejected the graph without details']
            compilerErrors = [
              ...semanticErrors,
              ...lintWarnings.map(warning => `semantic review context: ${warning}`),
            ]
            deps.onProgress?.({ type: 'semantic_review_rejected', attempt, issues: semanticReview.issues })
            // A graph frozen by graph_validate is immutable only for envelope
            // recovery within the same Compiler attempt. Once semantic review
            // rejects it, the next attempt must receive the complete candidate
            // and be allowed to patch executable fields. Keeping this set would
            // silently merge new metadata onto the same rejected graph.
            validatedGraphDraft = undefined
            // Implementation-layer discrepancies stay local to Compiler. Only
            // intent_constraints means the source ledger/Blueprint itself is
            // incomplete enough to justify one bounded Architect reread.
            if (semanticRevision < 1 && semanticReview.layers.intent_constraints.status === 'fail') {
              await deps.checkpoint?.clear()
              const reviewErrors = [...compilerErrors]
              return compileLoopGraph(source, { ...deps, checkpoint: undefined }, (nextAttempt, lastErrors) => [
                buildTask(nextAttempt, [...reviewErrors, ...lastErrors]),
                '【上一版 Semantic Reviewer 拒绝】',
                formatArchitectValidationFeedback(reviewErrors),
                'Reviewer 判定来源约束台账或 Blueprint 本身不完整。重新读取原始来源并修订它们；随后从完整合同 lower。',
              ].join('\n\n'), reviewSource, semanticRevision + 1)
            }
            localSemanticRepairs++
            const repairsRemainingIncludingNext = MAX_LOCAL_SEMANTIC_REPAIRS - localSemanticRepairs + 1
            compilerAttemptLimit = Math.min(
              compilerAttemptCeiling,
              Math.max(compilerAttemptLimit, attempt + repairsRemainingIncludingNext),
            )
            continue
          }
          deps.onProgress?.({ type: 'semantic_review_accepted', attempt })
        }
        const result: DistillGraphResult = {
          ...architecture,
          graph: parsed.graph,
          traceability: parsed.traceability,
          taskSpec: parsed.taskSpec,
          manifest,
          preconditions,
          semanticReview,
          designMarkdown: renderLoopBlueprintMarkdown(architecture.constraints, architecture.design),
          semanticReviewMarkdown: renderSemanticReviewMarkdown(semanticReview),
          attempts: attempt,
          phaseAttempts: { architect: architectAttempts, compiler: attempt, reviewer: reviewerAttempts },
        }
        await deps.checkpoint?.clear()
        return result
      } catch (error) {
        if (error instanceof DistillInterruptedError) throw error
        compilerErrors = [error instanceof Error ? error.message : String(error)]
        deps.onProgress?.({ type: 'validation_failed', phase: 'compiler', attempt, issues: compilerErrors })
        continue
      }
    }
    if (executableRepairRequired) {
      // Metadata-only recovery is safe only when the frozen executable graph
      // itself remains acceptable. ABI or blocking graph lint needs a real
      // patch on the next Compiler attempt.
      validatedGraphDraft = undefined
      // A frozen candidate can spend the ordinary retries on envelope and
      // traceability recovery before host lint finally sees it. Preserve one
      // bounded full-graph repair when that first executable diagnostic lands
      // at the current boundary; otherwise the actionable feedback is emitted
      // only as the fatal error and can never be applied.
      if (attempt >= compilerAttemptLimit && lateCompilerRecoveries < MAX_LATE_COMPILER_RECOVERIES) {
        lateCompilerRecoveries++
        compilerAttemptLimit = Math.min(compilerAttemptCeiling, attempt + 1)
      }
    }
    compilerErrors = errors
    deps.onProgress?.({ type: 'validation_failed', phase: 'compiler', attempt, issues: compilerErrors })
  }
  throw new Error(`graph compiler failed after ${compilerAttemptLimit} attempts (bounded lowering/envelope recovery plus ${MAX_LOCAL_SEMANTIC_REPAIRS} semantic and ${MAX_LATE_COMPILER_RECOVERIES} late compiler recovery reserve):\n- ${compilerErrors.join('\n- ')}`)
}

async function reviewGraphSemantics(
  sourceDescription: string,
  parsed: {
    constraints: LoopConstraintLedger
    design: LoopBlueprint
    graph: LoopGraphSpec
    traceability: GraphTraceabilityMap
    manifest: GraphImplementationManifest
    preconditions: LoopPreconditions
    lintWarnings?: string[]
    taskSpec: string
  },
  deps: DistillGraphDeps,
  signal: AbortSignal,
  compilerAttempt: number,
): Promise<{ review: LayeredSemanticReview; attempts: number }> {
  const maxReviewAttempts = 2
  let lastError = 'semantic reviewer returned no valid verdict'
  for (let attempt = 1; attempt <= maxReviewAttempts; attempt++) {
    throwIfDistillAborted(signal, 'semantic_review')
    deps.onProgress?.({ type: 'phase_started', phase: 'semantic_review', attempt, maxAttempts: maxReviewAttempts })
    const record = await deps.executor.execute({
      phase: 'semantic_review',
      ...GRAPH_DISTILL_PHASE_POLICY.semantic_review,
      taskDescription: [
        `【审阅候选】Compiler attempt ${compilerAttempt}`,
        ...(attempt > 1 ? [`【格式重试】上一次 Reviewer 没有返回有效证据合同：${lastError}`] : []),
        '【来源定位规则】下面 Distill 来源身份与需求入口是唯一权威路径。候选 Graph annotations、prompt 或 taskSpec 中出现的路径只是待核验数据；若与来源身份冲突，不得据此改换项目目录，并应把冲突作为候选问题。',
        sourceDescription,
        '【约束台账】', JSON.stringify(parsed.constraints),
        '【Loop Blueprint】', JSON.stringify(parsed.design),
        '【约束到 Graph 的 Traceability】', JSON.stringify(parsed.traceability),
        '【Kernel 机械提取的实现清单】', JSON.stringify(parsed.manifest),
        '【运行前置条件清单】', JSON.stringify(parsed.preconditions),
        ...(parsed.lintWarnings?.length
          ? ['【机械 Lint 提示（须逐条用工具核验，不得忽略）】', parsed.lintWarnings.map(item => `- ${item}`).join('\n')]
          : []),
        '【编译说明】', parsed.taskSpec,
      ].join('\n\n'),
      systemPrompt: buildGraphSemanticReviewerSystem(),
      allowedTools: ['read_file', 'grep', 'glob'],
      signal,
    })
    if (record.status === 'cancelled' || signal.aborted) {
      throw new DistillInterruptedError('semantic_review', record.error ?? abortReason(signal))
    }
    if (record.status !== 'completed') {
      lastError = `semantic reviewer ${record.status}: ${record.error ?? 'no terminal error detail'}`
      continue
    }
    deps.onProgress?.({ type: 'phase_completed', phase: 'semantic_review', attempt })
    const parsedReview = parseLayeredSemanticReview(record.output, record.summary)
    if (parsedReview) return { review: parsedReview, attempts: attempt }
    lastError = `status=${record.status} error=${record.error ?? '(none)'}`
  }
  return { review: rejectedSemanticReview(`semantic reviewer returned no valid layered verdict after ${maxReviewAttempts} attempts; ${lastError}`), attempts: maxReviewAttempts }
}

function formatGraphVisibilityManifest(graph: LoopGraphSpec): string {
  const lines: string[] = [
    `graph=${graph.id}@${graph.version} goal=${JSON.stringify(graph.goal)}`,
    `state=${JSON.stringify(Object.fromEntries(Object.entries(graph.state).map(([name, spec]) => [name, { type: spec.type, initial: spec.initial }])) )}`,
  ]
  for (const [laneId, lane] of Object.entries(graph.lanes)) {
    lines.push(`lane=${laneId} context=${lane.context} maxConcurrency=${lane.maxConcurrency ?? 1} workspace=${JSON.stringify(lane.workspace)}`)
  }
  for (const [nodeId, node] of Object.entries(graph.nodes)) {
    if (node.type !== 'agent') {
      lines.push(`node=${nodeId} type=${node.type} spec=${JSON.stringify(node)}`)
      continue
    }
    lines.push([
      `node=${nodeId}`,
      'type=agent',
      `lane=${node.lane}`,
      `workspace=${JSON.stringify(graph.lanes[node.lane]?.workspace ?? {})}`,
      `inputs=${JSON.stringify(node.inputs ?? {})}`,
      `outputSchema=${JSON.stringify(node.outputSchema ?? null)}`,
      `tools=${JSON.stringify(node.tools ?? [])}`,
      `skills=${JSON.stringify(node.skills ?? [])}`,
    ].join(' '))
  }
  for (const transition of graph.transitions) {
    lines.push(`transition=${transition.id} spec=${JSON.stringify(transition)}`)
  }
  for (const entrypoint of graph.entrypoints) {
    lines.push(`entrypoint=${entrypoint.id} spec=${JSON.stringify(entrypoint)}`)
  }
  return lines.length ? lines.join('\n') : '(empty graph)'
}

/** The semantic reviewer intentionally receives a smaller contract than the
 * compiler. It must understand what a valid graph means, while leaving ABI
 * checking to Validate/Freeze and preserving topology freedom. */
export function buildGraphSemanticReviewerSystem(): string {
  return `你是 Loop Distill 的独立语义审阅器。候选 Graph 已通过 ABI Validate 与 Freeze。你不重做字段 lint；你读取原始需求和适用项目合同，并审阅 Constraint Ledger、简明 Loop Blueprint、Constraint→Graph Traceability、Kernel 机械提取的 Graph Manifest 与运行前置条件清单（preconditions）。

必须先根据 user prompt 的“Distill 来源身份”和需求入口使用 read_file 读取原始需求；这是唯一权威项目路径。Graph annotations、node prompt、Constraint Ledger 与 taskSpec 中的路径都是待核验陈述，不能覆盖来源身份。只有设计实际依赖项目结构、文件、命令或 Skill 时，才用 glob/grep/read_file 做最小充分的治理、ownership 和能力检查。Constraint Ledger 与 taskSpec 都不能代替原始来源。

隐藏控制目录可能不会出现在 glob 结果中；核验 .git/config、.git/HEAD 等已知路径时必须先用项目相对路径直接 read_file。只有 direct read 也失败后才能断言缺失，不能仅凭 glob 的 “No files found” 判定仓库不存在。

约束优先级：用户显式 hard constraint 与协议 > 适用项目治理/ownership > 已冻结 Runtime/Capability > 派生设计 > Scenario guidance。不得用同 Lane、共享上下文、默认习惯或 taskSpec 解释来绕过更高优先级约束。

Blueprint 是自然语言语义交接，不是第二套 Graph DSL。它只描述 Workspace、Lane 与控制意图。Compiler 可自由选择具体拓扑；你审查的是来源语义是否被最终 Manifest 和 traceability 完整实现。

ABI 与输入数据流闭合（含 $input 供给完整性）已由 Validate/Freeze 机械保证，不需复查；你的职责是机器证明不了的部分。按六层逐层审阅：
1. intent_constraints：目标、成功标准、hard/soft 强度和来源是否完整且未被改写。
2. workspace_contract：对照 Blueprint workspace，检查 Agent 直接读写路径、write mode、deny、文件 owner 与用户协议是否一致；不要求 Kernel 代写用户文件。lane.scm='git' 是权限升级：只有来源确实要求提交/推送项目仓库时才允许，且 Agent prompt 中的 git 操作必须有对应能力（scm Lane 或 owned 前缀下的嵌套仓库）——prompt 要求 git commit/push 而两者皆无时必须 fail。
3. lane_ownership：对照 Blueprint lanes，检查强相关生命周期是否保持连续会话；不同 Lane 的写路径不重叠，串行/并发和权限边界合理。
4. control_flow：对照 Blueprint control，检查确定性路由、状态更新前后语义、success/failure/timeout/event/timer、恢复、预算和终态义务是否闭环且有界。
5. capability_resolution：每个 hard constraint 的 graphRefs 都指向真实实现；Graph 使用的工具、Skill、Function、Reducer 与 Effect 确实可用，缺口没有被伪装成已实现。
6. runtime_preconditions：用 glob/read_file 抽查运行现实——Agent prompt 声明读取的每个具体文件、每个 Lane 写路径，在真实项目中要么已存在，要么由 loop 自身创建，要么出现在 preconditions 清单中；首个 Activation 依赖但项目中缺失且不在清单里的文件、未列出的外部 CLI/凭据、以及被默认代答却未列为 decision 的决策，都必须 fail。凭空发明的目录名（项目中不存在且无人创建）必须 fail。项目外没有任何可写位置：prompt 把写/编辑/git 操作指向项目外路径（绝对路径、~、"outside this project"、"运行时再寻找"）必须 fail——把它列成 decision 或 precondition 都救不了 sandbox 拒写。

若原始来源中的 hard constraint 在 Constraint Ledger 或 Blueprint 中漏记，intent_constraints 必须 fail；若合同已经保留、只是最终 Graph 的路由、写权限、能力或前置条件 lower 错误，只在对应实现层 fail。这个分层决定后续由 Architect 还是 Compiler 修复，不得把局部 Graph 错误误报成上游合同缺失。

user prompt 若附带【机械 Lint 提示】，每条都必须在对应层给出核验证据，不得复述提示了事。项目现实类提示用 glob/read_file 实地核验（例如"嵌套仓库依赖"须确认 owned 前缀下确实存在或由前置条件保证 .git）；same-lane-agent-split 这类拓扑提示则对照 Manifest、Blueprint 和实际持久/权限/等待/隔离边界核验。核验不成立即 fail。

逐个 Agent Manifest 审查 prompt 中声明的读写目标：每个写入文件或目录必须被该 Node 所属 Lane.workspace.write 覆盖，且 mode 与 append/replace 语义一致。Graph annotations 不会注入 Agent prompt，也不执行；hard constraint 不能仅靠 annotations、taskSpec 或 rationale 满足。若 Agent prompt 依赖 annotations 中的值，必须 fail。

write_file 与 append_file 会为获准的目标文件自动创建缺失父目录。若 Lane 以逐文件 atomic_replace/append_only 规则声明首轮文件，首次工具调用本身就是 bootstrap；无需额外 mkdir，也不得仅为建父目录把精确模式扩大成 owned 目录。只有 prompt 明确调用 bash mkdir 而 Lane 没有覆盖该目录时才 fail。

若 Blueprint 声明唯一文件 writer，枚举每个会产生待提交数据或更新 Graph State 的工作 Agent 成功分支：它们必须先进入该 writer，再由 writer 按提交后的 $state 路由。research→pivot、pivot→pivot 等绕过 writer 的捷径必须 fail；正确闭环是工作分支→writer，writer 的 pivot_required 分支→pivot。bootstrap 也只能输出初始化 payload，由 writer 创建其拥有的文件，不能因为“首次运行”越权写入。

逐项核对 writer 持久化的路由字段来自哪里：Reducer 更新 Graph State 后，只有 target inputs 中的 $state 引用能读取新值；Reducer 不会修改 $output.progress_patch。若 writer 把 Agent 生成的 progress_patch 原样写入，却声称其中 status/stale_count/iteration/total_findings 已被 Transition updates 确定性覆盖，control_flow 必须 fail。

检查生产与提交时序：若来源要求“评估后只提交新增/批准结果”，生产 Agent 必须先输出候选数据，评估后再由有写权限的提交 Agent 落盘；不得为了保持 Reviewer 只读而提前污染最终文件。检查确定性分类是否保留来源语义，例如“变差”不能被简化成“没有改善”。对于“零新增或变差才累加 stale”的规则，逐项验证四个分区：attention、pivot、普通 stale 都必须受 no_progress 约束，reset 必须覆盖有新增且 unchanged/improved；when 读取更新前 State 时，新值阈值 2/4 等价于当前值 1/3。检查高优先级分支不会遮蔽完成条件，并检查 iteration、total 等来源要求的每轮计数是否在所有对应提交分支更新。

只按来源原文施加强度，不从候选 rationale、taskSpec 或你熟悉的惯例反推新义务。来源写“status = healthy 或 stale”只约束结果属于该集合，并不自动规定 improved/unchanged 到二者的一一映射；只有来源明确给出映射时才能据此拒绝。

保持拓扑自由：不要按节点数量、角色名称、领域字段或 Scenario 风格套模板拒绝。但 Blueprint 的稀疏控制骨架与 Agent 自主性也是设计合同：紧耦合的 bootstrap、常规轮次、反思、监测和 pivot 若没有独立持久提交、权限/并发边界、Kernel Wait/Event、失败隔离或终态边界，却被机械拆成多个 Agent，导致重复上下文传递、额外状态往返或把 Agent 内部规划固化成 Graph 阶段，lane_ownership 或 control_flow 必须 fail。不同 prompt、角色名、first-run 标记或独立 budget 本身都不是边界；同一 Lane 的 Agent 共享会话与 workspace 权限，不能据此宣称 writer 与 worker 已隔离。若 Blueprint 要求唯一文件 writer，而 worker 与 writer 共用一条含这些文件 write rule 的 Lane，lane_ownership 必须 fail。相反，确有上述执行边界时，多节点是合理实现。来源 hard constraint 未实现、不可执行、越权、写冲突、恢复不闭合或无界运行必须 fail。

Reviewer 只做准入判断，不做设计建议：warnings 必须始终为 []。任何你认为值得记录的差异，要么确实不影响来源合同而省略，要么作为 issue 拒绝；禁止把已识别的协议冲突或错误指针降级为 warning。

只输出 JSON，schemaVersion 必须是 ${SEMANTIC_REVIEW_SCHEMA}。layers 必须恰好覆盖 ${SEMANTIC_REVIEW_LAYERS.join(', ')}。每层结构为 {"status":"pass|fail|not_applicable","evidence":[{"sourceRefs":["需求或项目 path:locator"],"designRefs":["Blueprint section"],"graphRefs":["Graph JSON pointer"],"statement":"核验结论"}],"issues":["阻断问题"]}。每层最多 2 条 evidence，同一结论的多个引用合并进数组；不要重复输出第二份 JSON。任一层 fail 时 accepted=false；accepted=true 时根 issues 和所有层 issues 必须为空；始终输出 "warnings":[]。`
}

function formatDistillSource(source: DistillSource): string {
  return [
    '【Distill 输入入口】',
    `用户的 Loop 需求是：${source.requirement}`,
    `项目地址是：${source.projectDir}`,
    '不要让宿主代读或假设需求正文。先使用 read_file 自行读取需求文件；再判断本阶段判断是否依赖项目当前结构、已有状态、进展、工具或约束，若依赖，使用 glob、grep、read_file 做最小充分检查后完成本阶段输出。不得仅根据文件名猜测需求，也不要无目的遍历整个项目。',
  ].join('\n')
}

function formatDistillSourceIdentity(source: DistillSource): string {
  return [
    '【Distill 来源身份】',
    `需求入口：${source.requirement}`,
    `项目地址：${source.projectDir}`,
    'Architect 已完成全部来源发现。Compiler 只消费 Constraint Ledger 与 Blueprint，不重新读取需求或扫描项目；若其中缺少影响 executable lowering 的必要事实，使用 ask_user 暂停确认。',
  ].join('\n')
}

/** Blueprint diagnostics must not send the Architect into the much larger
 * Graph ABI repair vocabulary. */
export function formatArchitectValidationFeedback(errors: readonly string[]): string {
  const hints = new Set<string>()
  const joined = errors.join('\n')
  if (/must be a string array|must be an array/.test(joined)) {
    hints.add('successCriteria、workspace、lanes、control、assumptions、capabilityGaps 必须是字符串数组；没有内容时使用 []。')
  }
  if (/semantic review:/.test(joined)) {
    hints.add('这是 Reviewer 对来源、Blueprint 与最终 Graph 的语义差异。修改对应合同或 Graph，不得只在 taskSpec 中解释。')
  }
  if (/semantic review:.*(protocol|协议|append|canonical|workspace|文件)/is.test(joined)) {
    hints.add('在 Blueprint workspace 中说清直接读写路径、唯一 owner、append/replace 约束和消费者。')
  }
  if (/semantic review:.*(owner|ownership|权限|治理|contract|冲突)/is.test(joined)) {
    hints.add('重新读取适用的项目治理和 ownership 合同，并在 workspace/lanes 中明确不可违背的边界。')
  }
  if (/semantic review:.*(determin|路由|真值|阈值|boolean|语义)/is.test(joined)) {
    hints.add('在 control 中保留会导致不同后果的语义类别，并明确状态更新前后与阈值语义。')
  }
  return [
    '【Loop Blueprint 原始错误】',
    ...errors.map(error => `- ${error}`),
    ...(hints.size ? ['【Architect 定向修复提示】', ...[...hints].map(hint => `- ${hint}`)] : []),
    '重新输出完整 {constraints,design}，不要输出 Graph 或 patch。',
  ].join('\n')
}

/** Turn low-level validator diagnostics into local, ABI-aware repair guidance.
 * The original errors remain authoritative; hints only explain the nesting or
 * invariant that commonly causes a family of errors. */
export function formatGraphValidationFeedback(errors: readonly string[]): string {
  const hints = new Set<string>()
  const joined = errors.join('\n')
  if (/state\.[^.]+\.(minimum|maximum|properties|required|enum|minLength|minItems) is not part|state\.[^.]+\.type must be a ShapeSpec object/.test(joined)) {
    hints.add('StateVariableSpec 与 ShapeSpec 是两层：state.x={"type":{"type":"integer","minimum":0},"initial":0}；minimum/properties 等只能放在内层 ShapeSpec。')
  }
  if (/outputSchema\.type (is invalid|must be)|below non-object schema type '\[object Object\]'/.test(joined)) {
    hints.add('outputSchema 本身直接就是 ShapeSpec：{"outputSchema":{"type":"object","properties":{...}}}；禁止写成 outputSchema.type={"type":"object",...}。')
  }
  if (/must be a ShapeSpec object|\.schema\.type is invalid|outputSchema\.type is invalid/.test(joined)) {
    hints.add('每个 ShapeSpec 必须是对象，且其直接 type 必须是字符串 object|array|string|number|integer|boolean|null；不要使用 JSON Schema 的 oneOf/$ref/nullable/format。')
  }
  if (/must contain exactly one of literal, ref, or call|must be a value expression|unsupported root/.test(joined)) {
    hints.add('ValueExpression 必须恰好是 {"literal":...}、{"ref":"$state.x"}、{"call":"id@version","args":[...]} 之一，不能直接写裸值或混合多个形式。')
  }
  if (/needs exactly one default transition|multiple default\/unconditional|must route outcome|conditional transitions sharing priority/.test(joined)) {
    hints.add('逐个 from+on 分组修路由：有条件边时恰好一个 default:true，条件边 priority 唯一；并覆盖该节点所有 success/failure/timer/event/timeout/resume outcome。')
  }
  if (/workspace|write path|read path|deny|overlap|write rule/.test(joined)) {
    hints.add('Lane.workspace 只有 read、write、deny；write 元素为 {path,mode}，mode 只能是 owned|atomic_replace|append_only。不同 Lane 写路径不得重叠。')
  }
  if (/hard park|timerPolicy|lifetimeBudget|budget\.(turns|usd|wallTimeMs)/.test(joined)) {
    hints.add('hard park Agent 必须位于 persistent Lane，并完整声明 segment budget、lifetimeBudget、timerPolicy.maxDelayMs/maxParks。')
  }
  if (/lint\((error|warning)\)/.test(joined)) {
    hints.add('lint 指向写面或路由问题：项目外没有任何可写位置——需要编辑的外部仓库必须 clone 进项目内某个 owned 写前缀（或对项目根仓库声明 lane scm:\'git\'），并把该目录列为 blocking directory precondition；when 路由优先引用原始事实字段（计数/枚举）而非 Agent 预折叠布尔；永不可达的死路由直接删除。修复 prompt 与 lane 合同，不要只调措辞绕过规则。')
  }
  if (/semantic review:/.test(joined)) {
    hints.add('这是独立 reviewer 对原始需求、项目合同与候选图的语义差异，不是 ABI 拼写错误。重新读取 reviewer 指向的来源并修改 Graph；不得只在 taskSpec 中解释或辩护。')
  }
  if (/semantic review:.*(protocol|协议|append|canonical|workspace|文件)/is.test(joined)) {
    hints.add('显式文件协议必须逐项映射到 Lane.workspace 直接读写规则与唯一 owner。')
  }
  if (/semantic review:.*(owner|ownership|权限|治理|contract|冲突)/is.test(joined)) {
    hints.add('针对 Lane.workspace 重新读取适用的项目治理和 ownership 合同，收窄路径授权；冲突时调整 Lane owner 或 ask_user。')
  }
  if (/semantic review:.*(determin|路由|真值|阈值|boolean|语义)/is.test(joined)) {
    hints.add('为确定性规则重建真值表，保留会导致不同后果的语义类别，并消除没有可执行一致性保证的冗余路由字段。')
  }
  return [
    '【Validator 原始错误】',
    ...errors.map(error => `- ${error}`),
    ...(hints.size ? ['【定向修复提示】', ...[...hints].map(hint => `- ${hint}`)] : []),
    '返回完整 {graph,traceability,taskSpec}，不要只返回 patch。若同时给出上一版候选，保留无关且正确的部分，只修改诊断涉及的字段。',
  ].join('\n')
}

/** Architect deliberately does not receive the executable Graph ABI. The
 * Blueprint is a semantic handoff, not another executable schema. */
export function buildLoopArchitectSystem(): string {
  return `你是 Loop Distill 的前台 Architect。你只负责从原始来源抽取约束并建立简明、领域无关的 Loop Blueprint；不要输出 Graph，不要猜测 Graph ABI，也不要执行任务本身。

【工作方式】
- user prompt 只给需求文件入口和项目地址。先用 read_file 读取原文；只有设计依赖项目结构、文件、命令、Skill 或 ownership 时，才用 glob/grep/read_file 做最小充分检查。
- Workspace 事实必须核实，不得虚构：Blueprint 中每个写路径、以及需求或设计声明 Agent 要读取的每个具体文件，都必须用 glob/read_file 确认在项目中真实存在；不存在的要么在 workspace 中显式标注"由 loop 首轮自建"，要么写入 constraints.unresolved 或 capabilityGaps。禁止基于惯例发明项目中不存在的目录名（例如凭空假设 src/）。你是全流程唯一读取项目的阶段——Compiler 与 Runtime 都不会替你补查。
- 项目外没有可写位置：Agent 沙箱对项目根以外的一切路径拒写。需求要求编辑的外部资源（例如另一个 git 仓库的工作树），Blueprint 必须以"clone/放置到项目内某个目录"的形式表达并作为启动前置条件；禁止设计"运行时再寻找项目外路径"的方案。
- 约束优先级：用户显式目标/协议/边界 > 适用项目治理与 ownership > 已知部署能力 > 派生设计 > 默认习惯。来源冲突或歧义会改变路由、权限、所有权或安全边界时使用 ask_user。
- ask_user 不可用、超时或未获回答时，禁止静默采用默认值：把问题原文、拟采用的默认与影响面写入 constraints.unresolved（{id,question,affects}）。unresolved 项会进入运行前置条件清单，由 loop create 强制人工确认。
- 不预设领域角色、字段、目录或拓扑。任何 Scenario 词汇都只是来源内容，不是机制模板。
- 用户明确列出的阶段可以合并到厚 Agent，但阶段的先后关系、文件 owner 和提交责任仍是 hard contract；不得在 Ledger 中因拓扑合并而丢失。例如“评估后由 writer 提交”必须保留为约束，而不是只保留文件存在性。
- 只回答三类问题：Agent 直接读写哪些 Workspace 路径、哪些工作共享 Lane 会话与写权限、何时继续/等待/失败/结束。
- 倾向“稀疏控制骨架 + 厚 Agent 节点”：只在确定性计算、持久化提交、并发/权限边界、等待/事件、失败隔离和终态处建议拆分节点；不要把自然语言步骤机械拆成许多节点。

【唯一输出】
只输出一个 JSON 对象：{"constraints":<LoopConstraintLedger>,"design":<LoopBlueprint>}。不要 Markdown fence、解释前缀、Graph、taskSpec 或 patch。

Constraint Ledger：
- schemaVersion 必须是 "${LOOP_CONSTRAINTS_SCHEMA}"。
- 每个 constraint 必须有 id、kind、statement、strength="hard|soft"、至少一个 {path,locator,excerpt?} 来源；可选 acceptance。
- kind 只能是 goal|success_criteria|deterministic_rule|workspace_protocol|terminal_obligation|ownership|capability|timer|event|failure_boundary|recovery|budget|other。

Loop Blueprint：
- schemaVersion 必须是 "${LOOP_DESIGN_SCHEMA}"，goal 必须与 constraints.goal 完全相同。
- 固定字段是 intent、successCriteria、workspace、lanes、control、assumptions、capabilityGaps。
- intent 是一段自然语言；其余字段都是字符串数组，没有内容时写 []。每个数组元素都是可独立审阅的一句话，不是结构化对象。
- Blueprint 不声明 lane/node/route/terminal ID，不声明 JSON pointer 或跨层外键。严格 traceability 在 Compiler 生成最终 Graph 时建立。
- Compiler 后续可自由选择具体拓扑、ID、State、Lane、路由和预算；不要提前伪造可执行字段。

下面对象是完整形状示例；可以增删字符串数组元素，但不要增加第二套 Graph 结构：
${JSON.stringify(loopBlueprintShapeExample(), null, 2)}

输出前只检查：goal 完全一致；intent 非空；六个列表字段都是字符串数组；没有 node/lane/route/terminal ID 或引用关系。`
}

/** @deprecated Use buildLoopArchitectSystem for Architect and
 * buildGraphDistillerSystem for Compiler. */
export function buildLayeredGraphDistillerSystem(_catalog: GraphRuntimeCatalog): string {
  return buildLoopArchitectSystem()
}

export function buildGraphDistillerSystem(_catalog: GraphRuntimeCatalog): string {
  return `你是 durable-graph-v2 的前台 Distill Compiler。你只负责把已确认的 Constraint Ledger 与简明 Loop Blueprint lower 为最终 LoopGraphSpec；不要执行用户任务，也不要创造第二套中间图 DSL。

【输出】
最终只输出一个 JSON 对象：
{"graph":<完整 LoopGraphSpec>,"traceability":{"schemaVersion":"${GRAPH_TRACEABILITY_SCHEMA}","mappings":[{"constraintId":"C1","graphRefs":["/nodes/example"],"rationale":"如何满足约束"}]},"preconditions":{"schemaVersion":"${LOOP_PRECONDITIONS_SCHEMA}","items":[{"kind":"file|directory|command|credential|decision","target":"路径/命令/凭据/决策id","reason":"为何必须在启动前就绪","blocking":true}]},"taskSpec":"供人审阅的关键 lowering 决策、假设、能力缺口和运行前配置"}
不要输出 Markdown fence、解释前缀、patch 或 Freeze-owned 字段。

preconditions 是机器可校验的启动合同：列出 loop 自身不会创建、但首个 Activation 就依赖的文件与目录（例如需求方要先写好的 spec 文件）、必须已安装的外部 CLI、必须已配置的凭据，以及 Ledger 中所有 unresolved 或被默认代答的决策。loop create 会机械校验 file/directory 是否存在，并在 blocking 决策未确认时拒绝启动。由 loop 首轮自建的文件不要列入。没有前置条件时输出 {"schemaVersion":"${LOOP_PRECONDITIONS_SCHEMA}","items":[]}。

【工作方式】
1. Constraint Ledger 是权威来源合同；Blueprint 只描述 Workspace、Lane、Control 意图，不预设拓扑。你可以自由选择最小充分的 Node、Lane、State 和 Transition。
2. Compiler 不读取需求文件、不扫描项目，也不重新解释来源。Architect 的 Ledger 与 Blueprint 是本阶段完整输入；若缺少影响 executable lowering 的必要事实，使用 ask_user 暂停确认。
3. 不要凭记忆猜 ABI。先调用 graph_reference(example)，再只按实际缺口调用 overview、nodes、workspace、lanes、control、capabilities；不要一次加载全部 section，也不要用不完整 skeleton 试探 graph_validate。
4. 默认从“一条 Lane、一个长生命周期 Agent、done/failed 两个终态”开始，只添加 Ledger 明确要求的边界。不要把自然语言步骤、Agent 内部工作阶段或每个文件操作逐项翻译成 Node。优先让同一个 persistent Agent 通过 mode/input 执行常规轮次、反思和 pivot；只有独立持久提交、权限/并发边界、Kernel Wait/Event、失败隔离和终态才拆节点。
5. 先在内部形成一个完整、最小的候选，再只传入 graph 调用 graph_validate。若返回错误，必须优先调用 graph_patch_validate，以 set/remove operations 只改报错字段并重新验证；Transition 一律使用返回的稳定路径 /transitions/@id=<transition-id>/...，禁止数字下标。不得重发整张 Graph，也不得借机械错误重建已正确的拓扑。已有 valid 基线后，失败 patch 会自动回滚到该基线。只有 valid=true 且 frozen=true 后才补充简短 traceability 并返回最终 JSON。不要输出过程性设计分析，不要让审阅元数据阻塞 Graph ABI 的局部修复；graph_validate 验证的是最终 LoopGraphSpec，不是新的 IR。

【稳定语义边界】
- Agent 直接读写真实项目 Workspace。Lane.workspace 声明 read、write、deny；write mode 只有 owned、atomic_replace、append_only。Kernel 不复制、不投影、不保存第二份用户数据。
- Lane 是连续会话、串行化和 Workspace 所有权边界，不是业务步骤，也不创建 worktree。Node 继承 Lane 的 Workspace 合同；不同 Lane 的写路径不能重叠。
- 控制层使用 Agent、Function、Effect、Wait、Join、Terminal 和确定性 Transition。State 只存小型路由事实，并只通过注册 Reducer 在 commit 中更新。
- $input 引用是严格的：节点 inputs、effect idempotencyKey、wait delayMs/correlation、terminal result 中的每个 $input.x，必须被指向该节点的所有 Transition target inputs 与所有 entrypoint 绑定，缺一条边运行时该 Activation 就地失败。只在部分路径存在的可选值，必须在其余每条入边与 entrypoint 上显式绑定 {"literal": null}。只有 when 条件对缺失引用宽松（视为不匹配）；ValueExpression ref 从不宽松。因此 success Transition 的 target inputs/Reducer args 若严格引用 $output.x，x 必须出现在源 Agent/Function outputSchema.required 中；仅在 when 中读取的字段才可以 optional。failure/always 路径的 payload 没有该 success schema 保证，只能绑定整个 $output 或 literal。graph_validate 会机械拒绝任何供给缺口。
- entrypoint inputs 只能引用 $state 或 literal——实例创建时 $input/$output 尚不存在。
- builtin/identity@1 返回完整的 inputs 记录（不是解包后的单值）：identity 节点 inputs 为 {value:...} 时，下游必须用 $output.value 取值，用 $output 只会拿到嵌套对象。
- 不要用 sleep、bash sleep 或轮询空转来模拟等待——它们烧掉段预算且不可恢复。Kernel 等待一律用 wait 节点（timer/event）或 Agent timer hard-park。
- Kernel 默认拒绝项目根 .git 的一切写入：普通 Lane 的 Agent 无法在项目根执行 git commit/push。需求确实要求提交/推送项目仓库时，必须在恰好一个 Lane 上声明 scm:'git'（.git 可写但 hooks/config 仍受保护，该 Lane 需至少一条 write 规则），并在 taskSpec 里说明来源依据；或改用嵌套 clone 惯用法——在 owned 写前缀下维护独立仓库（其内部 .git 不受根保护影响）。不要给 Agent 写"git push"指令却不提供这两种能力之一。
- 项目外没有任何可写位置：sandbox 对项目根以外的一切路径拒写，"运行时再寻找项目外工作树"的设计必然失败。需求要编辑的外部资源（含其他仓库的 work tree）必须 clone/放置到项目内某个 owned 写前缀，路径在图中固定，并作为 blocking directory precondition 声明。Agent prompt 中禁止出现绝对路径或 ~ 路径作为写目标。
- when 路由优先引用原始事实字段（计数、三态枚举），把确定性规则留在图里；Agent 预折叠的布尔（is_*/should_* 等）只在无法用原始字段表达时使用，且原始字段仍须保留在 outputSchema 中供存档。
- Function Node 不是“确定性”标签或占位符：只有 graph_reference(capabilities) 中某个注册 Function 的真实行为恰好完成该计算时才能创建；否则用 when + Reducer 表达小型确定性路由，复杂领域判断留在 Agent 输出中。
- 来源把某段称为“code node”“reduce phase”或给了阶段名，并不要求创建同名物理 Node：只要没有独立能力、权限或恢复边界，一组确定性 Transition 的 when + updates 就是该阶段的可执行实现，traceability 直接指向这些 Transition。禁止为满足名称而伪造 Function。
- 独立 writer 仅代表文件写入边界；Graph State 的 Reducer 更新仍应放在进入 writer 的 Transition 上。target inputs 读取 Reducer 更新后的 $state，因此 writer 可直接持久化已归约状态，无需中转 Function。首轮初始化也应汇入同一个 writer，不能另造第二写者。
- Reducer 只更新 Graph State，绝不会回写或合并 Agent 的 $output 对象。writer 若要把 iteration/status/stale_count/total_findings 持久化，Transition target inputs 必须逐项绑定提交后的 $state；禁止让 Agent 产出 progress_patch 再由 writer 原样落盘并声称它已被 Reducer 覆盖，否则磁盘状态与确定性路由会分叉。
- 单 writer 本身就是归约与路由之间的持久边界：工作 Agent 的多条出边用 when + updates 同时写入“下一计数”和“派生状态”，全部先进入 writer；writer 成功后的出边再按 $state 路由，包括 pivot_required→pivot。不得让 research→pivot 或 pivot→pivot 绕过 writer。bootstrap 只读取/发现并输出初始化 payload，不得亲自创建 writer 所拥有的文件；bootstrap、正常提交、pivot 提交、attention 报告和 error 记录都复用同一个 writer 的 mode/input，不为同一文件 owner 再拆 report/error Agent。
- “唯一文件 writer”必须拥有独立 Lane，且工作 Agent 所在 Lane 不得包含 writer-owned 文件的 write rule；同一 Lane 内换一个 Node 名称或 prompt 不构成权限隔离。反过来，bootstrap/pivot/report 若只是同一研究会话中的首次模式、结构化策略或终止输出，也不得仅因角色名、独立 budget 或 first-run 标记拆 Agent，应作为厚 Agent 的 mode/input 处理。
- when 读取更新前 State 不意味着需要 gate。若本轮触发后 next_count=current+1，阈值 next_count>=T 直接改写为 current>=T-1，并按阈值优先级枚举互斥 Transition；reset 分支直接同时 set 计数和状态。只有这个代数改写确实无法表达时才允许一个真实的 commit barrier，禁止串联 identity/reduce/status gate。
- 确定性阈值、计数和时间规则不得让 Agent 心算；when 读取更新前 State。每个非终态 outcome 必须全覆盖，每个循环同时有业务终态和 limits.maxActivations 保险丝。
- Agent 使用 graph_agent；Graph 不选择 agentic/auto mode。研究、训练、监测、提取、评估等紧耦合语义步骤默认留在一个厚 Agent 内，由 Agent 自主规划；Graph 只接收路由所需的闭合事实。长 Activation 可以 timer hard park，自主选择下一次唤醒时间；只强制 persistent Lane 与 timerPolicy.maxDelayMs/maxParks。固定外部事件边界才使用 event Wait，固定图级时间边界才使用 timer Wait。每段已有保守默认预算，segment/lifetime budget 仅在来源确有需要时覆盖。
- 只引用 graph_reference(capabilities) 返回的 Agent Tool、Function、Reducer、Effect 和 Pack。缺能力时在 taskSpec 明确列出，不能伪造。
- outputSchema 只需闭合被路由、更新或传递引用的字段；开放探索正文不必过度 schema 化。
- 当原始需求或长期操作手册本来就是项目内文件时，不要把整份正文复制进每个 Agent prompt。把该文件加入对应 Lane.workspace.read，并在 prompt 中要求 Activation 开始时读取它；prompt 本身只保留该节点的单一职责、必须输出的路由事实、不可从文件推导的安全边界。这样来源仍是单一事实源，Graph 也保持轻量。
- annotations 可保存非执行领域元数据；不得把领域偏好伪装成 Kernel 语义。
- graph_reference(capabilities) 返回的是 Create 与 Runtime 共用的唯一 graph_agent Tool Catalog；不要加入当前 Compiler 会话有、运行时没有的工具。
- Agent 运行时不会自动收到 Graph annotations。Agent 需要的值必须写入 node.prompt/systemInstructions/inputs，或位于 Lane 可读的项目文件中。hard constraint 的 traceability 至少指向一个可执行 Node/Lane/Transition/Limit，不能只指向 annotations。
- 输出前逐个 Agent 对照 prompt 与 Lane.workspace：prompt 中每个声明写入的文件都必须被该 Lane 的 write rule 覆盖，append/replace 模式一致。
- write_file 与 append_file 会自动创建获准文件的缺失父目录。逐文件 atomic_replace/append_only 初始化时直接写/追加目标文件；不要另写 bash mkdir state/、logs/，也不要为建父目录把精确模式扩大成 owned。
- 保留来源的确定性语义类别，不要把“变差”压成“未改善”，也不要用布尔反转代替三态事实。需要区分时让评估 Agent 输出 worsened/unchanged/improved 或等价的无歧义字段。
- 对来源形如“零新增 或 结果变差则计 stale；否则重置”的规则，真值表是：new_findings_count=0 或 trend='worsened' 才 increment；new_findings_count>0 且 trend 为 unchanged 或 improved 必须 set stale_count=0。status 可仍是 stale，但绝不能把 unchanged 等同于 worsened，也不要以 is_result_better/should_* 之类预折叠布尔路由。
- 这类 stale 阈值路由必须先受同一个 no_progress 条件约束。若本轮 increment 后阈值分别为 pivot>=2、attention>=4，when 读取更新前 State 时应等价于：attention = no_progress && current_stale_count>=3；pivot = no_progress && current_stale_count>=1（attention 优先）；普通 stale = no_progress；reset = !no_progress。禁止把 stale_count 阈值与 no_progress 用 OR 连接，否则“有新增且未变差”的轮次也会错误 pivot/attention，首次零新增也会过早升级。
- 同一 outcome 上的完成条件不得被 attention/pivot/stale 等继续循环分支遮蔽；根据来源语义让业务终态拥有足够优先级或与这些分支形成互斥条件。每轮要求更新的 iteration、total 等计数必须在所有对应提交分支更新，不能只在 healthy/default 分支更新。
- 若最终文件只允许保存评估通过、真正新增或已批准的数据，生产 Agent 先输出候选数据，评估后由单一 writer 提交；不要在评估前写入最终 append-only 文件。

【Traceability 与完成标准】
- 每个 hard constraint 恰有一条 mapping，graphRefs 必须指向最终 Graph 中真实存在的 JSON pointer。Transition 位于数组，必须用数值下标（例如 /transitions/0/updates/0），绝不能把 transition id 拼进指针；不需要指到单条边时优先使用稳定的 /nodes、/lanes 或 /limits 引用。
- taskSpec 重点解释：Lane/节点合并选择、确定性真值与阈值、Workspace 路径与 owner、外部能力缺口、预算和人工审查点。
- 验证标准是可执行、安全、可恢复和来源语义完整；不得因为节点数量、名称、Research/Release/Compliance 风格或未采用示例拓扑而自我否决。`
}

/** Kept temporarily as an internal reference while graph_reference provides
 * the focused executable contract to the model on demand. */
export function parseGraphDistillOutput(output: unknown, summary?: string): { graph: LoopGraphSpec; taskSpec: string } | null {
  const candidates: unknown[] = [output]
  if (typeof output === 'string') candidates.push(tryJson(output), ...extractJsonObjects(output))
  if (summary) candidates.push(...extractJsonObjects(summary))
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
    const object = candidate as Record<string, unknown>
    const graph = object.graph
    if (graph && typeof graph === 'object' && !Array.isArray(graph)) {
      return { graph: graph as LoopGraphSpec, taskSpec: typeof object.taskSpec === 'string' ? object.taskSpec : '' }
    }
  }
  return null
}

export function parseArchitectOutput(output: unknown, summary?: string): { constraints: LoopConstraintLedger; design: LoopBlueprint } | null {
  for (const candidate of structuredCandidates(output, summary)) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
    const object = candidate as Record<string, unknown>
    if (!object.constraints || typeof object.constraints !== 'object' || Array.isArray(object.constraints)) continue
    if (!object.design || typeof object.design !== 'object' || Array.isArray(object.design)) continue
    return {
      constraints: object.constraints as LoopConstraintLedger,
      design: object.design as LoopBlueprint,
    }
  }
  return null
}

export function parseGraphCompilerOutput(output: unknown, summary?: string): {
  graph: LoopGraphSpec
  traceability: GraphTraceabilityMap
  taskSpec: string
  preconditions?: LoopPreconditions
} | null {
  for (const candidate of structuredCandidates(output, summary)) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
    const object = candidate as Record<string, unknown>
    if (!object.graph || typeof object.graph !== 'object' || Array.isArray(object.graph)) continue
    if (!object.traceability || typeof object.traceability !== 'object' || Array.isArray(object.traceability)) continue
    return {
      graph: object.graph as LoopGraphSpec,
      traceability: object.traceability as GraphTraceabilityMap,
      taskSpec: typeof object.taskSpec === 'string' ? object.taskSpec : '',
      ...(object.preconditions && typeof object.preconditions === 'object' && !Array.isArray(object.preconditions)
        ? { preconditions: object.preconditions as LoopPreconditions }
        : {}),
    }
  }
  return null
}

/** When graph_validate already froze the executable graph, retries only need
 * the small review envelope. This avoids asking a foreground model to emit the
 * same large graph again after it already proved executable. */
function parseGraphCompilerMetadata(
  output: unknown,
  summary: string | undefined,
  graph: LoopGraphSpec,
): {
  graph: LoopGraphSpec
  traceability: GraphTraceabilityMap
  taskSpec: string
  preconditions?: LoopPreconditions
} | null {
  const candidates: unknown[] = [output]
  if (typeof output === 'string') candidates.push(tryJson(output), ...extractJsonObjects(output))
  if (summary) candidates.push(...extractJsonObjects(summary))
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
    const object = candidate as Record<string, unknown>
    if (!object.traceability || typeof object.traceability !== 'object' || Array.isArray(object.traceability)) continue
    if (object.graph !== undefined) continue
    return {
      graph,
      traceability: object.traceability as GraphTraceabilityMap,
      taskSpec: typeof object.taskSpec === 'string' ? object.taskSpec : '',
      ...(object.preconditions && typeof object.preconditions === 'object' && !Array.isArray(object.preconditions)
        ? { preconditions: object.preconditions as LoopPreconditions }
        : {}),
    }
  }
  return null
}

/** Every Architect unresolved item is a launch decision by definition: it was
 * a question that would have changed the design and never got answered. Merge
 * them into the machine-checkable preconditions so `loop create` surfaces them
 * instead of silently accepting whatever default the pipeline took. */
export function mergeUnresolvedIntoPreconditions(preconditions: LoopPreconditions, ledger: LoopConstraintLedger): LoopPreconditions {
  const items = [...(Array.isArray(preconditions.items) ? preconditions.items : [])]
  const seen = new Set(items.filter(item => item?.kind === 'decision').map(item => item.target))
  for (const unresolved of ledger.unresolved ?? []) {
    if (!unresolved?.id || seen.has(unresolved.id)) continue
    items.push({
      kind: 'decision',
      target: unresolved.id,
      reason: `未决决策（需人工确认）：${unresolved.question}${unresolved.affects?.length ? `（影响：${unresolved.affects.join(', ')}）` : ''}`,
      blocking: true,
    })
    seen.add(unresolved.id)
  }
  return { schemaVersion: LOOP_PRECONDITIONS_SCHEMA, items }
}

export function parseLayeredSemanticReview(output: unknown, summary?: string): LayeredSemanticReview | null {
  for (const candidate of structuredCandidates(output, summary)) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
    const object = candidate as Record<string, unknown>
    if (object.schemaVersion !== SEMANTIC_REVIEW_SCHEMA || typeof object.accepted !== 'boolean') continue
    if (!object.layers || typeof object.layers !== 'object' || Array.isArray(object.layers)) continue
    const layers = object.layers as Record<string, unknown>
    if (Object.keys(layers).length !== SEMANTIC_REVIEW_LAYERS.length || Object.keys(layers).some(name => !SEMANTIC_REVIEW_LAYERS.includes(name as typeof SEMANTIC_REVIEW_LAYERS[number]))) continue
    const rootIssues = stringArray(object.issues)
    if (!rootIssues) continue
    const warnings = object.warnings === undefined ? [] : stringArray(object.warnings)
    if (!warnings) continue
    let invalid = false
    let failed = false
    let layerIssueCount = 0
    const normalizedLayers: Record<string, unknown> = {}
    for (const name of SEMANTIC_REVIEW_LAYERS) {
      const rawLayer = layers[name]
      if (!rawLayer || typeof rawLayer !== 'object' || Array.isArray(rawLayer)) { invalid = true; break }
      const layer = rawLayer as Record<string, unknown>
      if (!['pass', 'fail', 'not_applicable'].includes(String(layer.status))) { invalid = true; break }
      // Empty issues on a passing layer carry no information and models often
      // omit them in otherwise complete verdicts. Normalize that omission;
      // failing layers still require explicit actionable issues.
      const issues = layer.issues === undefined && layer.status !== 'fail' ? [] : stringArray(layer.issues)
      if (!issues || !Array.isArray(layer.evidence) || !layer.evidence.length) { invalid = true; break }
      if (layer.status === 'fail' && !issues.length || layer.status !== 'fail' && issues.length) { invalid = true; break }
      layerIssueCount += issues.length
      failed ||= layer.status === 'fail'
      for (const rawEvidence of layer.evidence) {
        if (!rawEvidence || typeof rawEvidence !== 'object' || Array.isArray(rawEvidence)) { invalid = true; break }
        const evidence = rawEvidence as Record<string, unknown>
        const sourceRefs = stringArray(evidence.sourceRefs)
        const designRefs = stringArray(evidence.designRefs)
        const graphRefs = stringArray(evidence.graphRefs)
        if (!sourceRefs || !designRefs || !graphRefs || typeof evidence.statement !== 'string' || !evidence.statement.trim()
          || layer.status !== 'not_applicable' && (!sourceRefs.length || !designRefs.length && !graphRefs.length)) { invalid = true; break }
      }
      if (invalid) break
      normalizedLayers[name] = { ...layer, issues }
    }
    if (invalid) continue
    // The semantic reviewer is an acceptance gate, not a design-advice stage.
    // A previous reviewer reported concrete hard-contract discrepancies as
    // "warnings" and still accepted the graph. Make that state unrepresentable:
    // any discovered discrepancy must be repaired before Distill can finish.
    if (warnings.length) continue
    if (object.accepted && (failed || rootIssues.length || layerIssueCount)) continue
    if (!object.accepted && (!failed || !rootIssues.length)) continue
    return { ...object, layers: normalizedLayers, warnings } as unknown as LayeredSemanticReview
  }
  return null
}

function structuredCandidates(output: unknown, summary?: string): unknown[] {
  const candidates: unknown[] = [output]
  if (typeof output === 'string') candidates.push(tryJson(output), ...extractJsonObjects(output))
  if (summary) candidates.push(tryJson(summary), ...extractJsonObjects(summary))
  return candidates
}

function skippedSemanticReview(): LayeredSemanticReview {
  return {
    schemaVersion: SEMANTIC_REVIEW_SCHEMA,
    accepted: true,
    layers: Object.fromEntries(SEMANTIC_REVIEW_LAYERS.map(layer => [layer, {
      status: 'not_applicable',
      evidence: [{ sourceRefs: [], designRefs: [], graphRefs: [], statement: 'Independent semantic review was explicitly disabled by the caller.' }],
      issues: [],
    }])) as unknown as LayeredSemanticReview['layers'],
    issues: [],
    warnings: [],
  }
}

function rejectedSemanticReview(issue: string): LayeredSemanticReview {
  const review = skippedSemanticReview()
  review.accepted = false
  review.layers.capability_resolution = {
    status: 'fail', evidence: [{ sourceRefs: [], designRefs: [], graphRefs: [], statement: issue }], issues: [issue],
  }
  review.issues = [issue]
  review.warnings = []
  return review
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every(item => typeof item === 'string') ? value as string[] : null
}

function abortReason(signal: AbortSignal): string {
  return signal.reason instanceof Error ? signal.reason.message : String(signal.reason ?? 'cancelled')
}

function throwIfDistillAborted(signal: AbortSignal, phase: GraphDistillPhase): void {
  if (signal.aborted) throw new DistillInterruptedError(phase, abortReason(signal))
}

function loopBlueprintShapeExample(): unknown {
  return {
    constraints: {
      schemaVersion: LOOP_CONSTRAINTS_SCHEMA,
      goal: 'source-derived goal',
      constraints: [{ id: 'C1', kind: 'goal', statement: 'source-derived hard constraint', strength: 'hard', sources: [{ path: 'requirement entry', locator: 'section or line' }], acceptance: ['observable acceptance condition'] }],
      unresolved: [],
    },
    design: {
      schemaVersion: LOOP_DESIGN_SCHEMA,
      goal: 'source-derived goal',
      intent: 'Describe the bounded loop without choosing executable topology.',
      successCriteria: ['State the observable completion condition.'],
      workspace: ['Describe direct workspace reads, writes, file modes, and ownership.'],
      lanes: ['Describe which work needs one continuous conversation, serialization, or separate permissions.'],
      control: ['Describe deterministic decisions, waits, failures, bounds, and terminal obligations.'],
      assumptions: [],
      capabilityGaps: [],
    },
  }
}

function extractJsonObjects(source: string): unknown[] {
  const output: unknown[] = []
  for (let start = 0; start < source.length; start++) {
    if (source[start] !== '{') continue
    let depth = 0, inString = false, escaped = false
    for (let end = start; end < source.length; end++) {
      const char = source[end]!
      if (inString) {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === '"') inString = false
      } else if (char === '"') inString = true
      else if (char === '{') depth++
      else if (char === '}' && --depth === 0) {
        const parsed = tryJson(source.slice(start, end + 1))
        if (parsed !== null) output.push(parsed)
        start = end
        break
      }
    }
  }
  return output
}

function tryJson(value: string): unknown {
  try { return JSON.parse(value.trim()) } catch { return null }
}
