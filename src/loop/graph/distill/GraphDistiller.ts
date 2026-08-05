import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { GraphRuntimeCatalog } from '../runtime/GraphCatalog.js'
import type { LoopGraphSpec } from '../spec/GraphTypes.js'
import { freezeLoopGraph, validateLoopGraph } from '../spec/GraphValidate.js'
import { formatGraphLintFindings, lintLoopGraph, type GraphLintFinding } from '../spec/GraphLint.js'
import type { GraphDistillExecutor, GraphDistillPhase } from './ForegroundGraphDistillExecutor.js'
import type { DistillCheckpointStore } from './DistillCheckpoint.js'
import { renderTraceOutput, type DistillTraceStore } from './DistillTrace.js'
import { structuredJsonCandidates } from './JsonEnvelope.js'
import {
  GRAPH_TRACEABILITY_SCHEMA,
  LOOP_CONSTRAINTS_SCHEMA,
  LOOP_DESIGN_SCHEMA,
  LOOP_PRECONDITIONS_SCHEMA,
  SEMANTIC_REVIEW_LAYERS,
  SEMANTIC_REVIEW_SCHEMA,
  SEMANTIC_RULE_CLASSES,
  BLOCKING_SEMANTIC_RULE_CLASSES,
  ADVISORY_SEMANTIC_RULE_CLASSES,
  isBlockingSemanticRuleClass,
  formatSemanticFinding,
  formatEnforcementLoci,
  buildGraphImplementationManifest,
  emptyLoopPreconditions,
  enforcementLocusIndex,
  hashPointerRegions,
  renderLoopBlueprintMarkdown,
  renderSemanticReviewMarkdown,
  requiresControlFlowWitness,
  staleVerdicts,
  validateConstraintLedger,
  validateControlFlowWitness,
  validateGraphTraceability,
  validateIntakeLedgerPreservation,
  validateLoopBlueprint,
  validateLoopPreconditions,
  CONTROL_FLOW_WITNESS_OUTCOMES,
  WITNESS_REQUIRED_RULE_CLASSES,
  type ConstraintVerdict,
  type ConstraintVerdictRow,
  type ControlFlowWitness,
  type GraphImplementationManifest,
  type GraphTraceabilityMap,
  type LayeredSemanticReview,
  type LoopBlueprint,
  type LoopConstraintLedger,
  type LoopPreconditions,
  type SemanticEnforcementLocus,
  type SemanticFinding,
  type SemanticRuleClass,
} from './DistillDesign.js'
import {
  deferredConstraintIds,
  formatIntakeFactsForReviewer,
  formatIntakeLedgerForArchitect,
  intakeGuidanceForIssues,
  mergeIntakePreconditions,
  type LoopIntakeRecord,
} from './DistillIntake.js'

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
  /** Human-confirmed ledger from `loop intake`, when one exists for exactly
   * this requirement text. Optional by design: forcing Intake would make
   * "change one word and re-run" expensive, and a well-specified document does
   * not need it. Its presence changes the Architect from an extractor into a
   * validator (see `buildLoopArchitectSystem`). */
  intake?: LoopIntakeRecord
}

/** Raised when a reviewer rejects a contract the human already signed off. The
 * model may not overrule an Intake ledger by re-deriving it; the question goes
 * back to the person who answered it. */
export class DistillIntakeGateError extends Error {
  readonly name = 'DistillIntakeGateError'
  constructor(readonly issues: readonly string[], readonly requirement: string) {
    super([
      'Semantic review rejected constraints that were confirmed during Intake, so Distill stopped instead of re-deriving them:',
      ...issues.map(issue => `- ${issue}`),
      `Resolve them in the source or re-run: meta-agent loop intake ${requirement}`,
    ].join('\n'))
  }
}

/** Scenario-neutral source graph embedded verbatim in the Compiler prompt.
 * Tests validate and Freeze this exact object so the example cannot drift from
 * the executable ABI. It demonstrates nesting/dataflow, not domain topology. */
export const CANONICAL_GRAPH_DISTILL_EXAMPLE: LoopGraphSpec = {
  schemaVersion: 'graph-2.0',
  id: 'bounded_iterative_loop',
  version: 1,
  goal: 'Iterate until an independent reviewer verifies the worker completion candidate.',
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
    review: {
      context: 'fresh_per_activation',
      workspace: { read: ['requirements.md'], write: [], deny: ['.git'] },
      maxConcurrency: 1,
      description: 'Read-only completion authority independent from the work session.',
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
    review: {
      type: 'agent',
      lane: 'review',
      prompt: 'Independently verify the completion candidate against the original requirements and return accepted plus concise findings. Do not perform or modify the work.',
      inputs: { candidate: { ref: '$input.candidate' } },
      outputSchema: {
        type: 'object',
        required: ['accepted', 'findings'],
        properties: {
          accepted: { type: 'boolean' },
          findings: { type: 'string' },
        },
        additionalProperties: false,
      },
      tools: ['read_file'],
      maxAttempts: 2,
      budget: { turns: 10, usd: 2, wallTimeMs: 300_000 },
    },
    done: { type: 'terminal', status: 'done', result: { ref: '$input.result' } },
    failed: { type: 'terminal', status: 'failed', result: { ref: '$input.error' } },
  },
  transitions: [
    {
      id: 'goal_reached', from: 'work', on: 'success',
      when: '$output.complete == true', priority: 100,
      to: { node: 'review', inputs: { candidate: { ref: '$output' } } },
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
    {
      id: 'completion_verified', from: 'review', on: 'success',
      when: '$output.accepted == true', priority: 100,
      to: { node: 'done', inputs: { result: { ref: '$input.candidate' } } },
    },
    {
      id: 'completion_rejected', from: 'review', on: 'success', default: true,
      to: 'work',
    },
    {
      id: 'review_failed', from: 'review', on: 'failure',
      to: { node: 'failed', inputs: { error: { ref: '$output' } } },
    },
  ],
  entrypoints: [{ id: 'start', node: 'work' }],
  limits: { maxTotalActivations: 100, maxLiveActivations: 4, maxWallTimeMs: 86_400_000, maxCostUsd: 30 },
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
  /** Optional per-run trace. Every rejected phase output, frozen graph and
   * layered verdict is persisted here, so a failed run stays diagnosable. */
  trace?: DistillTraceStore
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
  // Intake is a conversation with a human, not a compilation step: it spends
  // most of its turns on ask_user round-trips and mechanical pre-checks, so it
  // needs a much larger turn allowance than the batch phases.
  intake: {
    thinkingBudgetTokens: 8_000, maxOutputTokens: 32_768,
    maxWallTimeMs: 3_600_000, maxTurns: 60, maxBudgetUsd: 10,
  },
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
  //
  // The output ceiling is 32K rather than 16K because the verdict table scales
  // with the ledger: a real 35-constraint run has to emit a row per hard
  // constraint on top of six layers of evidence, and at 16K it returned no
  // usable verdict twice in a row and burned the attempt.
  semantic_review: {
    thinkingBudgetTokens: 0, maxOutputTokens: 32_768,
    maxWallTimeMs: 1_200_000, maxTurns: 30, maxBudgetUsd: 10,
  },
}

/** A parsed, ABI-valid graph can still need a local repair after the independent
 * semantic review. Keep that repair budget separate from mechanical lowering
 * retries: otherwise formatting/traceability retries can consume every chance
 * to fix a real source-contract discrepancy. */
const MAX_LOCAL_SEMANTIC_REPAIRS = 2
const MAX_LATE_COMPILER_RECOVERIES = 1

/**
 * Review metadata (traceability pointers, preconditions) gets its own allowance.
 *
 * The attempt counter used to charge every failure the same price, but a wrong
 * JSON pointer and a 40KB graph redesign are not the same work: the host still
 * holds the frozen, ABI-valid, lint-clean graph and the fix is a handful of
 * numbers. Measured across real runs, roughly a fifth of all compiler attempts
 * were consumed by metadata alone — budget that never reached the design. These
 * repairs are therefore granted on top of the design allowance rather than out
 * of it.
 */
const MAX_METADATA_ONLY_REPAIRS = 2

/** How many past semantic rounds to keep in front of the Compiler. Bounded so a
 * long repair chain cannot grow the prompt without limit; findings are also
 * deduplicated, so a recurring one costs nothing. */
const MAX_ACCUMULATED_SEMANTIC_ROUNDS = 4

/**
 * Carry every still-binding semantic finding, not just the newest round.
 *
 * The reviewer reports a handful of findings per round rather than enumerating
 * the whole constraint set, so a graph converges over several rounds. Replacing
 * the previous round's feedback made that convergence impossible whenever two
 * findings constrain the same mechanism: one run was told a counter reset made a
 * terminal unreachable, removed the reset, and was then told the source mandates
 * that reset — each verdict correct, jointly satisfiable, but never visible at
 * the same time. With all rounds in view the Compiler can look for the design
 * that satisfies them together instead of alternating between two horns.
 */
function formatAccumulatedSemanticErrors(
  history: readonly { attempt: number; issues: readonly string[] }[],
  lintWarnings: readonly string[],
): string[] {
  const rounds = history.slice(-MAX_ACCUMULATED_SEMANTIC_ROUNDS)
  const latest = rounds[rounds.length - 1]
  const seen = new Set<string>()
  const carried: string[] = []
  // Oldest first, so the newest findings sit closest to the instruction that
  // follows them in the prompt.
  for (const round of rounds) {
    for (const issue of round.issues) {
      if (seen.has(issue)) continue
      seen.add(issue)
      carried.push(round === latest
        ? `semantic review: ${issue}`
        : `semantic review: [compiler attempt ${round.attempt} 提出，未被撤销，仍须满足] ${issue}`)
    }
  }
  return [
    ...carried,
    ...(rounds.length > 1
      ? ['semantic review: 【累积约束】以上是本次 Distill 多轮独立复核的全部未撤销 finding，每一条都仍然有效。已经修好的不要改回去。若两条看起来互相冲突（例如一条指出某个计数重置使终态不可达、另一条指出来源强制要求该重置），那是要求你找到同时满足两者的设计，而不是在两者之间来回切换：通常保留来源强制的语义不动，改阈值、优先级，或补一条缺失的分支让另一条也成立。若你确信两条在来源语义下真的无法共存，在 taskSpec 中写明理由与取舍，不要静默丢弃其中一条。']
      : []),
    ...lintWarnings.map(warning => `semantic review context: ${warning}`),
  ]
}

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
  const architectSystemPrompt = buildLoopArchitectSystem(Boolean(source.intake))
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
        source.intake
          ? '来源的约束台账已由人在 Intake 阶段逐条确认。本阶段不重新抽取：核对台账与来源、按需**追加**你在项目中发现的新约束，然后输出 {constraints,design}。不要在本阶段输出 Graph。'
          : '读取来源并只输出 {constraints,design}。先把自然语言约束稳定为可审查的三面 Loop Blueprint，不要在本阶段输出 Graph。若缺少会改变权限、路由或安全边界的信息，使用 ask_user。',
        ...(source.intake ? [formatIntakeLedgerForArchitect(source.intake)] : []),
      ].join('\n\n'),
      systemPrompt: architectSystemPrompt,
      allowedTools: ['read_file', 'grep', 'glob', 'list_dir', 'ask_user'],
      signal,
    })
    if (architectRecord.status === 'cancelled' || signal.aborted) {
      throw new DistillInterruptedError('architect', architectRecord.error ?? abortReason(signal))
    }
    const architectTag = `architect.r${semanticRevision}.a${attempt}`
    if (architectRecord.status !== 'completed') {
      architectErrors = [`foreground architect ${architectRecord.status}: ${architectRecord.error ?? 'no terminal error detail'}`]
      await deps.trace?.event({ phase: 'architect', revision: semanticRevision, attempt, outcome: 'not_completed', issues: architectErrors })
      deps.onProgress?.({ type: 'validation_failed', phase: 'architect', attempt, issues: architectErrors })
      continue
    }
    deps.onProgress?.({ type: 'phase_completed', phase: 'architect', attempt })
    const candidate = parseArchitectOutput(architectRecord.output, architectRecord.summary)
    if (!candidate) {
      architectErrors = ['no parseable {constraints, design} from foreground architect']
      // The raw envelope is the only evidence of *why* it did not parse.
      await deps.trace?.artifact(`${architectTag}.output.txt`, renderTraceOutput(architectRecord.output))
      await deps.trace?.event({ phase: 'architect', revision: semanticRevision, attempt, outcome: 'unparseable', issues: architectErrors })
      deps.onProgress?.({ type: 'validation_failed', phase: 'architect', attempt, issues: architectErrors })
      continue
    }
    let architectureErrors: string[]
    try {
      architectureErrors = [
        ...validateConstraintLedger(candidate.constraints),
        ...validateLoopBlueprint(candidate.design, candidate.constraints),
        // Appending is welcome; restating what the human settled is not. This
        // is enforced here rather than trusted to the system prompt, because
        // the immutability of the confirmed subset is the entire reason Intake
        // is worth running.
        ...(source.intake ? validateIntakeLedgerPreservation(candidate.constraints, source.intake) : []),
      ]
    } catch (error) {
      architectureErrors = [`layered design shape could not be validated: ${error instanceof Error ? error.message : String(error)}`]
    }
    if (architectureErrors.length) {
      architectErrors = architectureErrors
      await deps.trace?.artifact(`${architectTag}.rejected.json`, JSON.stringify({ errors: architectErrors, candidate }, null, 2))
      await deps.trace?.event({ phase: 'architect', revision: semanticRevision, attempt, outcome: 'invalid', issues: architectErrors })
      deps.onProgress?.({ type: 'validation_failed', phase: 'architect', attempt, issues: architectErrors })
      continue
    }
    architecture = candidate
    await deps.trace?.artifact(`${architectTag}.accepted.json`, JSON.stringify(candidate, null, 2))
    await deps.trace?.event({ phase: 'architect', revision: semanticRevision, attempt, outcome: 'accepted' })
    await deps.checkpoint?.save(source, architecture)
  }
  if (!architecture) {
    throw new Error(`graph architect failed after ${maxAttempts} attempts:\n- ${architectErrors.join('\n- ')}${traceHint(deps.trace)}`)
  }

  // Two diagnostic pools with different lifetimes. Mechanical diagnostics
  // (ABI, traceability, lint) describe the last candidate only and are replaced
  // every attempt. Semantic-review diagnostics describe an unmet source
  // contract and stay in force until the next semantic verdict — otherwise one
  // intervening traceability typo erases the reviewer's diagnosis from the very
  // attempt that was granted to fix it.
  let mechanicalErrors: string[] = []
  let semanticErrors: string[] = []
  // Every semantic rejection in this revision, oldest first. The reviewer
  // samples a few findings per round rather than enumerating all of them, so
  // the constraint set is revealed incrementally and earlier findings stay
  // binding even after the candidate changes.
  const semanticHistory: Array<{ attempt: number; issues: string[] }> = []
  // Cross-round verdict ledger. The reviewer is stateless and re-derives its
  // conclusions from scratch, so without this the compiler chases a target that
  // moves every round while the semantic repair budget — three rounds — drains.
  // See `ConstraintVerdict`: there is deliberately no full re-review before
  // acceptance, and the cost of that choice is traced rather than hidden.
  const verdictLedger = new Map<string, ConstraintVerdict>()
  const enforcementLoci = enforcementLocusIndex(architecture.constraints)
  const hardConstraintIds = architecture.constraints.constraints
    .filter(constraint => constraint.strength === 'hard' && constraint.id)
    .map(constraint => constraint.id)
  const combinedErrors = (): string[] => [...semanticErrors, ...mechanicalErrors]
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
  const compilerAttemptCeiling = compilerAttemptLimit + MAX_LOCAL_SEMANTIC_REPAIRS
    + MAX_LATE_COMPILER_RECOVERIES + MAX_METADATA_ONLY_REPAIRS
  let localSemanticRepairs = 0
  let lateCompilerRecoveries = 0
  let metadataOnlyRepairs = 0
  for (let attempt = 1; attempt <= compilerAttemptLimit; attempt++) {
    throwIfDistillAborted(signal, 'compiler')
    deps.onProgress?.({ type: 'phase_started', phase: 'compiler', attempt, maxAttempts: compilerAttemptLimit })
    // Metadata-only recovery assumes the frozen graph has nothing left to
    // prove except metadata. While a semantic rejection is unresolved that
    // assumption is false for ANY frozen draft — the host cannot verify the
    // claimed fix actually landed in it — so locking the graph would send an
    // unverified candidate straight back to the reviewer and burn a scarce
    // semantic-repair call on it. Every attempt during semantic repair must
    // remain free to patch executable fields.
    const metadataOnlyTurn = Boolean(validatedGraphDraft) && !semanticErrors.length
    const record = await deps.executor.execute({
      phase: 'compiler',
      ...GRAPH_DISTILL_PHASE_POLICY.compiler,
      sessionKey: 'distill-compiler',
      taskDescription: [
        '【本阶段任务：Compiler / Lowering】',
        '把已经确认的约束台账与轻量 Blueprint lower 为唯一现行 Graph ABI。Blueprint 不是第二套 Graph DSL；你可自由选择节点、Lane、Workspace 合同和路由 ID，但不得重新解释、删除或弱化 hard constraint。Graph 经 graph_validate 交付，最终文本只回 {traceability,preconditions,taskSpec}。',
        formatDistillSourceIdentity(source),
        // The host must state which side currently holds the graph. Leaving this
        // implicit is what produced a metadata-only deadlock: the model's
        // persistent session still showed a graph it had frozen, while the host
        // had discarded that draft after a blocking diagnostic.
        validatedGraphDraft
          ? '【宿主持图状态】宿主当前持有上一轮 graph_validate 冻结的完整 Graph。'
          : '【宿主持图状态】宿主当前**不持有**任何 Graph（首次 lowering，或上一版因阻断级诊断被作废）。本轮必须让 graph_validate 重新返回 valid=true && frozen=true，否则你的 metadata 无处可合并。',
        ...(combinedErrors().length ? ['【上一轮 Compiler/Reviewer 诊断】', formatGraphValidationFeedback(combinedErrors(), compilerDraft?.graph)] : []),
        ...(metadataOnlyTurn ? [
          '【已冻结 Graph：宿主保留，不要重复输出】',
          '上一轮 graph_validate 已对完整 Graph 返回 valid=true/frozen=true。宿主会自动把本次元数据与该 Graph 合并；你绝不能重建、修改或重复输出 graph，也不要调用任何工具。',
          '【立即执行】只返回一个小 JSON 对象：{"traceability":{...},"preconditions":{...},"taskSpec":"..."}。traceability 必须对应已冻结 Graph 的真实 JSON pointer；若上一轮诊断指出 traceability/preconditions，局部修复它们。',
        ] : compilerDraft ? [
          '【上一版完整候选（局部修复锚点）】',
          JSON.stringify(compilerDraft),
          '保留未被诊断否定的拓扑、命名和合同；只修改诊断涉及的可执行字段及其 traceability/preconditions。修图请用 graph_patch_validate 局部 set/remove 后重新验证；最终文本回答仍然只回 {traceability,preconditions,taskSpec}，不要把整张图抄进来。',
        ] : []),
        '【约束台账】', JSON.stringify(architecture.constraints),
        '【Loop Blueprint】', JSON.stringify(architecture.design),
        metadataOnlyTurn
          ? '【立即执行】不要输出分析、Graph、Markdown 或调用工具；只返回上面指定的 metadata JSON。'
          : '【立即执行】以上合同已完整。不要输出分析、设计过程、字段清单或 Markdown；下一步必须直接调用 graph_validate，参数必须是完整且最小的 graph（不是 skeleton）。若验证失败，只按 errors、repairHints 和 patchSelectors 调用 graph_patch_validate 做局部 set/remove；Transition 必须按 @id=稳定ID 定位，禁止数字下标、整图重发或重建。验证通过（valid=true && frozen=true）后，最终 JSON 只回 {"traceability":…,"preconditions":…,"taskSpec":…}——**不要把 graph 再抄进文本回答**，宿主已从工具调用取得它。来源中的命名阶段默认映射到厚 Worker 内部步骤，不为阶段名称创建 Function。默认让唯一 Worker 直接拥有其 Workspace 文件；仅在来源要求独立提交权或多生产者共享正式写面时增加 writer。Worker 完成候选必须先到独立只读 Reviewer/确定性 Function，不能直达业务 done。',
      ].join('\n\n'),
      systemPrompt: compilerSystemPrompt,
      allowedTools: ['ask_user', 'graph_reference', 'graph_validate', 'graph_patch_validate'],
      signal,
    })
    if (record.validatedGraph) validatedGraphDraft = structuredClone(record.validatedGraph)
    if (record.status === 'cancelled' || signal.aborted) {
      throw new DistillInterruptedError('compiler', record.error ?? abortReason(signal))
    }
    const compilerTag = `compiler.r${semanticRevision}.a${attempt}`
    if (record.status !== 'completed') {
      mechanicalErrors = [`foreground compiler ${record.status}: ${record.error ?? 'no terminal error detail'}`]
      await deps.trace?.event({ phase: 'compiler', revision: semanticRevision, attempt, outcome: 'not_completed', issues: mechanicalErrors })
      deps.onProgress?.({ type: 'validation_failed', phase: 'compiler', attempt, issues: mechanicalErrors })
      continue
    }
    deps.onProgress?.({ type: 'phase_completed', phase: 'compiler', attempt })
    // Metadata recovery may reuse a retained graph only when that graph is
    // current: frozen in THIS attempt (the model's own fix candidate), or
    // carried over with no semantic rejection outstanding. Merging metadata
    // onto a stale draft during semantic repair would re-submit the rejected
    // graph to the reviewer unchanged.
    const parsed = parseGraphCompilerOutput(record.output, record.summary)
      ?? (validatedGraphDraft && (record.validatedGraph || !semanticErrors.length)
        ? parseGraphCompilerMetadata(record.output, record.summary, validatedGraphDraft)
        : null)
    if (!parsed) {
      mechanicalErrors = describeUnparsedCompilerOutput(record, Boolean(validatedGraphDraft))
      // Without the raw envelope a parse rejection is indistinguishable from
      // prose, truncation or a mis-keyed object. Keep it.
      await deps.trace?.artifact(`${compilerTag}.output.txt`, renderTraceOutput(record.output))
      if (validatedGraphDraft) await deps.trace?.artifact(`${compilerTag}.frozen-graph.json`, JSON.stringify(validatedGraphDraft, null, 2))
      await deps.trace?.event({
        phase: 'compiler', revision: semanticRevision, attempt, outcome: 'unparseable',
        hadFrozenGraph: Boolean(validatedGraphDraft), issues: mechanicalErrors,
      })
      deps.onProgress?.({ type: 'validation_failed', phase: 'compiler', attempt, issues: mechanicalErrors })
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
    // Three sources feed the launch contract, in increasing authority: what the
    // Compiler derived, what the Architect could not resolve, and what a human
    // confirmed during Intake. The last one used to be dropped entirely.
    const preconditions = mergeIntakePreconditions(
      mergeUnresolvedIntoPreconditions(parsed.preconditions ?? emptyLoopPreconditions(), architecture.constraints),
      source.intake,
    )
    // The persistent Compiler conversation can be compacted. Repeating the
    // complete candidate gives the next retry a durable local-repair anchor.
    compilerDraft = { ...parsed, preconditions }
    let errors: string[]
    let executableRepairRequired = false
    let lintWarnings: string[] = []
    let lintWarningFindings: GraphLintFinding[] = []
    try {
      const graphErrors = validateLoopGraph(parsed.graph, deps.catalog)
      // Write-surface lint: error-level findings (external write targets,
      // git without any capability) are certain failures and block Distill.
      // Warning-level findings (nested-repo reliance, precomputed booleans,
      // dead routes) may be legitimate — they are handed to the semantic
      // reviewer, which has the tools to actually verify them per case.
      //
      // Lint reads the Graph and nothing else, so ABI validity is its only
      // real precondition. It used to sit behind traceability and preconditions
      // too, which let review metadata hide an executable defect: in one run a
      // single wrong JSON pointer kept the same undeclared-workspace-write
      // hidden through four consecutive candidates, and the compiler spent
      // those attempts fixing pointers while the permission bug sat untouched.
      // Metadata errors are still reported — they just no longer suppress.
      let blockingLint: string[] = []
      if (!graphErrors.length) {
        const lint = lintLoopGraph(parsed.graph)
        blockingLint = formatGraphLintFindings(lint.filter(finding => finding.level === 'error'))
        lintWarningFindings = lint.filter(finding => finding.level === 'warning')
        lintWarnings = formatGraphLintFindings(lintWarningFindings)
      }
      executableRepairRequired = graphErrors.length > 0 || blockingLint.length > 0
      errors = [
        ...graphErrors,
        ...blockingLint,
        ...validateGraphTraceability(parsed.traceability, architecture.constraints, parsed.graph),
        ...validateLoopPreconditions(preconditions),
      ]
    } catch (error) {
      errors = [`Graph lowering shape could not be validated: ${error instanceof Error ? error.message : String(error)}`]
    }
    if (!errors.length) {
      try {
        // Distill returns the logical source graph, but it must also survive the
        // exact logical-to-physical compilation Create will perform later.
        freezeLoopGraph(parsed.graph, deps.catalog, 0)
        const manifest = buildGraphImplementationManifest(parsed.graph)
        // Executable and frozen. Persist it even if semantic review later
        // rejects it: without this the only artifact proving how close the run
        // got is destroyed a few lines below.
        await deps.trace?.artifact(`${compilerTag}.graph.json`, JSON.stringify(parsed.graph, null, 2))
        await deps.trace?.artifact(`${compilerTag}.traceability.json`, JSON.stringify(parsed.traceability, null, 2))
        await deps.trace?.event({ phase: 'compiler', revision: semanticRevision, attempt, outcome: 'frozen', lintWarnings })
        deps.onProgress?.({ type: 'validation_passed', phase: 'compiler', attempt })
        let semanticReview = skippedSemanticReview()
        if (deps.semanticReview !== false) {
          // Carry forward every verdict whose evidence has not moved, and ask
          // the reviewer only about the rest. `staleVerdicts` resolves any
          // ambiguity toward re-review, which is the only safety margin left
          // once the final full re-review was dropped.
          const stale = staleVerdicts([...verdictLedger.values()], parsed.traceability, parsed.graph)
          const carried = [...verdictLedger.values()]
            .filter(verdict => verdict.verdict === 'pass' && !stale.has(verdict.constraintId))
          const carriedIds = new Set(carried.map(verdict => verdict.constraintId))
          const reviewScope = hardConstraintIds.filter(id => !carriedIds.has(id))
          const reviewed = await reviewGraphSemantics(reviewSource, {
            ...architecture, ...parsed, manifest, preconditions, lintWarningFindings,
          }, deps, signal, attempt, {
            carried, reviewScope, loci: enforcementLoci,
            ...(source.intake ? { intake: source.intake } : {}),
          })
          semanticReview = reviewed.review
          reviewerAttempts += reviewed.attempts
          for (const verdict of carried) {
            await deps.trace?.event({
              phase: 'semantic_review', revision: semanticRevision, compilerAttempt: attempt,
              outcome: 'verdict_carried', constraintId: verdict.constraintId,
              decidedAtCompilerAttempt: verdict.decidedAtCompilerAttempt,
              evidenceHash: verdict.evidenceHash, outOfScope: verdict.outOfScope === true,
            })
          }
          await recordConstraintVerdicts(verdictLedger, semanticReview, parsed.traceability, parsed.graph, attempt, {
            loci: enforcementLoci, revision: semanticRevision, trace: deps.trace,
          })
          // The layered verdict — with its per-layer evidence pointing from
          // source locators to Graph JSON pointers — is the whole value of the
          // review. Persist it on every outcome, not just acceptance.
          const reviewTag = `review.r${semanticRevision}.c${attempt}`
          await deps.trace?.artifact(`${reviewTag}.json`, JSON.stringify(semanticReview, null, 2))
          await deps.trace?.artifact(`${reviewTag}.md`, renderSemanticReviewMarkdown(semanticReview))
          if (!semanticReview.accepted) {
            semanticHistory.push({
              attempt,
              issues: semanticReview.issues.length
                ? [...semanticReview.issues]
                : ['semantic review rejected the graph without details'],
            })
            semanticErrors = formatAccumulatedSemanticErrors(semanticHistory, lintWarnings)
            // The rejected candidate itself was mechanically clean; whatever
            // mechanical diagnostics preceded it are resolved and must not
            // dilute the semantic feedback on the next attempt.
            mechanicalErrors = []
            await deps.trace?.event({
              phase: 'semantic_review', revision: semanticRevision, compilerAttempt: attempt, outcome: 'rejected',
              failedLayers: SEMANTIC_REVIEW_LAYERS.filter(layer => semanticReview.layers[layer].status === 'fail'),
              issues: semanticReview.issues,
            })
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
              // With a human-confirmed ledger the reread is the wrong remedy
              // for the confirmed subset: re-deriving it would discard the very
              // decisions Intake exists to capture. Findings that only touch
              // entries the Architect appended are still the model's own work,
              // so those keep the original recursion.
              const confirmed = confirmedConstraintIssues(semanticReview, source.intake)
              if (confirmed.length) throw new DistillIntakeGateError(confirmed, source.requirement)
              await deps.checkpoint?.clear()
              const reviewErrors = [...semanticErrors]
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
          await deps.trace?.event({ phase: 'semantic_review', revision: semanticRevision, compilerAttempt: attempt, outcome: 'accepted' })
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
        mechanicalErrors = [error instanceof Error ? error.message : String(error)]
        await deps.trace?.event({ phase: 'compiler', revision: semanticRevision, attempt, outcome: 'freeze_failed', issues: mechanicalErrors })
        deps.onProgress?.({ type: 'validation_failed', phase: 'compiler', attempt, issues: mechanicalErrors })
        continue
      }
    }
    await deps.trace?.artifact(`${compilerTag}.rejected.json`, JSON.stringify({ errors, graph: parsed.graph, traceability: parsed.traceability }, null, 2))
    await deps.trace?.event({
      phase: 'compiler', revision: semanticRevision, attempt, outcome: 'invalid',
      executableRepairRequired, issues: errors,
    })
    if (executableRepairRequired) {
      // Metadata-only recovery is safe only when the frozen executable graph
      // itself remains acceptable. ABI or blocking graph lint needs a real
      // patch on the next Compiler attempt.
      validatedGraphDraft = undefined
    }
    // A failure that is purely review metadata does not spend design budget:
    // the executable graph is still frozen and acceptable, and only a few
    // pointers or precondition entries are wrong.
    if (!executableRepairRequired && metadataOnlyRepairs < MAX_METADATA_ONLY_REPAIRS) {
      metadataOnlyRepairs++
      compilerAttemptLimit = Math.min(compilerAttemptCeiling, compilerAttemptLimit + 1)
    }
    // Preserve one bounded repair when the first actionable diagnostic lands at
    // the current boundary; otherwise that feedback is emitted only as the fatal
    // error and can never be applied.
    //
    // This deliberately covers a metadata-only failure too. Gating the reserve
    // on executableRepairRequired inverted the priority: a wrong traceability
    // pointer is the CHEAPEST boundary failure to repair — the host still holds
    // the frozen, ABI-valid, lint-clean graph and only a few numbers are wrong —
    // yet it was the one class denied a retry. One run died on four
    // out-of-range array indices with every semantic finding already addressed.
    if (attempt >= compilerAttemptLimit && lateCompilerRecoveries < MAX_LATE_COMPILER_RECOVERIES) {
      lateCompilerRecoveries++
      compilerAttemptLimit = Math.min(compilerAttemptCeiling, attempt + 1)
    }
    mechanicalErrors = errors
    deps.onProgress?.({ type: 'validation_failed', phase: 'compiler', attempt, issues: mechanicalErrors })
  }
  throw new Error(`graph compiler failed after ${compilerAttemptLimit} attempts (bounded lowering/envelope recovery plus ${MAX_LOCAL_SEMANTIC_REPAIRS} semantic and ${MAX_LATE_COMPILER_RECOVERIES} late compiler recovery reserve):\n- ${combinedErrors().join('\n- ')}${traceHint(deps.trace)}`
    // Point at Intake only when the source is what failed. Suggesting it for a
    // wrong JSON pointer would send the user to answer questions about a
    // problem that was never theirs.
    + intakeGuidanceForIssues(combinedErrors(), source.requirement, Boolean(source.intake)))
}

/** Blocking findings that name a constraint the human confirmed during Intake. */
function confirmedConstraintIssues(review: LayeredSemanticReview, intake: LoopIntakeRecord | undefined): string[] {
  if (!intake?.approvedConstraintIds?.length) return []
  const approved = new Set(intake.approvedConstraintIds)
  const violated = new Set((review.verdicts ?? [])
    .filter(row => row.verdict === 'violated' && approved.has(row.constraintId))
    .map(row => row.constraintId))
  const named = review.issues.filter(issue => [...approved].some(id => issue.includes(id)))
  return [...new Set([
    ...named,
    ...[...violated].map(id => `constraint ${id} (confirmed during Intake) was reported as violated`),
  ])]
}

export interface SemanticReviewRound {
  /** Verdicts the host is carrying forward; the reviewer must not revisit them. */
  carried: readonly ConstraintVerdict[]
  /** Hard constraint ids this round must adjudicate. */
  reviewScope: readonly string[]
  loci: ReadonlyMap<string, SemanticEnforcementLocus>
  /** What a human already settled before compilation started. */
  intake?: LoopIntakeRecord
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
    lintWarningFindings?: readonly GraphLintFinding[]
    taskSpec: string
  },
  deps: DistillGraphDeps,
  signal: AbortSignal,
  compilerAttempt: number,
  round: SemanticReviewRound,
): Promise<{ review: LayeredSemanticReview; attempts: number }> {
  const maxReviewAttempts = 2
  let lastError = 'semantic reviewer returned no valid verdict'
  const relevantLint = formatGraphLintFindings(
    selectRelevantLintWarnings(parsed.lintWarningFindings ?? [], parsed.graph, parsed.traceability, round.reviewScope))
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
        // Derived by the host from `kind`; the reviewer may not renegotiate it.
        '【每条约束的执行落点（宿主判定，不可更改）】', formatEnforcementLoci(parsed.constraints),
        '【Loop Blueprint】', JSON.stringify(parsed.design),
        '【约束到 Graph 的 Traceability】', JSON.stringify(parsed.traceability),
        '【Kernel 机械提取的实现清单】', JSON.stringify(parsed.manifest),
        '【运行前置条件清单】', JSON.stringify(parsed.preconditions),
        ...(round.intake ? [formatIntakeFactsForReviewer(round.intake)] : []),
        formatSemanticReviewScope(round),
        ...(relevantLint.length
          ? ['【机械 Lint 提示（与本轮待裁决约束相关，供定位用）】', relevantLint.map(item => `- ${item}`).join('\n')]
          : []),
        '【编译说明】', parsed.taskSpec,
      ].join('\n\n'),
      systemPrompt: buildGraphSemanticReviewerSystem(),
      allowedTools: ['read_file', 'grep', 'glob', 'list_dir'],
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
    const parsedReview = parseLayeredSemanticReview(record.output, record.summary, {
      graph: parsed.graph,
      requiredConstraintIds: round.reviewScope,
      deferredConstraintIds: deferredConstraintIds(round.intake),
    })
    if (parsedReview) return { review: parsedReview, attempts: attempt }
    // A missing verdict row voids an otherwise complete review, and telling the
    // reviewer only "the table was incomplete" makes the retry a guess. Re-parse
    // without the coverage requirement: if that succeeds, the sole defect was
    // coverage and the host can name the exact rows that were absent.
    const withoutCoverage = parseLayeredSemanticReview(record.output, record.summary, {
      graph: parsed.graph, deferredConstraintIds: deferredConstraintIds(round.intake),
    })
    const missing = withoutCoverage
      ? round.reviewScope.filter(id => !withoutCoverage.verdicts.some(row => row.constraintId === id))
      : []
    lastError = missing.length
      ? `verdicts 缺少这些约束的裁决行：${missing.join('、')}。其余内容都是好的，不要重做分析——只把缺的行补齐后重新输出完整 JSON。`
      : `status=${record.status} error=${record.error ?? '(none)'}；`
        + `裁决必须为本轮范围内的每条 hard constraint 给出一行 verdict（缺行即作废），`
        + `satisfied 必须带真实存在且可解析的 graphRefs，out_of_scope 必须带 justification`
  }
  return { review: rejectedSemanticReview(`semantic reviewer returned no valid layered verdict after ${maxReviewAttempts} attempts; ${lastError}`), attempts: maxReviewAttempts }
}

/**
 * Tell the reviewer exactly what it is being asked to decide.
 *
 * Without this the reviewer re-derives the whole constraint set every round and
 * reports a different sample of it each time, which is indistinguishable from
 * the graph getting worse. Naming the carried set is as important as naming the
 * scope: a reviewer that re-litigates a settled constraint would reintroduce
 * the moving target the ledger exists to remove.
 */
function formatSemanticReviewScope(round: SemanticReviewRound): string {
  const lines = ['【本轮复核范围（宿主判定，不可自行扩大）】']
  if (round.carried.length) {
    lines.push(
      `以下约束在此前轮次已核验通过，且其证据区域本轮未改动，**不要重新裁决，也不要为它们产出 finding 或 verdict 行**：${round.carried.map(item => item.constraintId).join('、')}`,
    )
  }
  lines.push(round.reviewScope.length
    ? `本轮必须逐条裁决的 hard constraint：${round.reviewScope.join('、')}。verdicts 数组必须为其中**每一条**给出一行，缺行整份裁决作废。`
    : '本轮没有需要重新裁决的 hard constraint；verdicts 可以为空数组，但仍需给出各层证据。')
  const scoped = new Set(round.reviewScope)
  const loci = round.reviewScope
    .map(id => `${id}=${round.loci.get(id) ?? 'agent'}`)
    .join(' · ')
  if (loci) lines.push(`本轮范围内各约束的执行落点：${loci}`)
  if ([...scoped].some(id => round.loci.get(id) === 'graph' || round.loci.get(id) === 'reviewer')) {
    lines.push('提醒：graph / reviewer 落点的约束填 out_of_scope 会被记录并呈现给人类审阅者；只有当该约束确实不该由 Graph 层核验时才这样填，并写清理由。')
  }
  return lines.join('\n')
}

/**
 * Only hand the reviewer lint warnings it can act on this round.
 *
 * The whole warning set used to be injected with an instruction to verify every
 * item. Warnings change with the graph, so each round produced a fresh batch of
 * mandatory questions — the host was manufacturing exactly the round-to-round
 * variance the ratchet is meant to remove.
 *
 * `single-agent-terminal-authority` is dropped outright: it is also a blocking
 * semantic class, and one rule belongs in one place. Lint sees topology, the
 * reviewer judges independence; keeping both made the reviewer re-derive a
 * conclusion it was already primed with.
 */
function selectRelevantLintWarnings(
  findings: readonly GraphLintFinding[],
  graph: LoopGraphSpec,
  traceability: GraphTraceabilityMap,
  reviewScope: readonly string[],
): GraphLintFinding[] {
  const scope = new Set(reviewScope)
  const refs = (traceability?.mappings ?? [])
    .filter(mapping => scope.has(mapping.constraintId))
    .flatMap(mapping => Array.isArray(mapping.graphRefs) ? mapping.graphRefs : [])
  const anchors = new Set<string>()
  for (const pointer of refs) {
    const node = /^\/nodes\/([^/]+)/.exec(pointer)?.[1]
    if (node) {
      const decoded = node.replace(/~1/g, '/').replace(/~0/g, '~')
      anchors.add(decoded)
      const lane = (graph.nodes?.[decoded] as { lane?: unknown } | undefined)?.lane
      if (typeof lane === 'string') anchors.add(lane)
    }
    const lane = /^\/lanes\/([^/]+)/.exec(pointer)?.[1]
    if (lane) anchors.add(lane.replace(/~1/g, '/').replace(/~0/g, '~'))
  }
  return findings.filter(finding => {
    if (finding.rule === 'single-agent-terminal-authority') return false
    if (!anchors.size) return false
    return [...anchors].some(anchor => finding.at.includes(anchor))
  })
}

/**
 * Fold this round's verdicts into the ledger and surface the one escape hatch.
 *
 * `out_of_scope` on a graph- or reviewer-locus constraint is legal and
 * non-blocking by decision, so the only thing standing between it and a silent
 * pass is that it gets written down twice: into the trace for later counting,
 * and into the advisories, where a human reading the draft summary will see it.
 */
async function recordConstraintVerdicts(
  ledger: Map<string, ConstraintVerdict>,
  review: LayeredSemanticReview,
  traceability: GraphTraceabilityMap,
  graph: LoopGraphSpec,
  attempt: number,
  context: { loci: ReadonlyMap<string, SemanticEnforcementLocus>; revision: number; trace?: DistillTraceStore },
): Promise<void> {
  const refsById = new Map((traceability?.mappings ?? [])
    .map(mapping => [mapping.constraintId, Array.isArray(mapping.graphRefs) ? mapping.graphRefs : []]))
  for (const row of review.verdicts ?? []) {
    const refs = refsById.get(row.constraintId) ?? row.graphRefs
    const locus = context.loci.get(row.constraintId)
    if (row.verdict === 'out_of_scope' && (locus === 'graph' || locus === 'reviewer')) {
      const note = `[out-of-scope] ${row.constraintId}（${locus} 落点）被判为不适用而非核验通过：${row.justification ?? '(未给出理由)'}`
      if (!review.advisories.includes(note)) review.advisories.push(note)
      await context.trace?.event({
        phase: 'semantic_review', revision: context.revision, compilerAttempt: attempt,
        outcome: 'out_of_scope_escape', constraintId: row.constraintId, locus,
        justification: row.justification ?? null,
      })
    }
    ledger.set(row.constraintId, {
      constraintId: row.constraintId,
      verdict: row.verdict === 'violated' ? 'fail' : 'pass',
      evidenceHash: hashPointerRegions(graph, refs),
      decidedAtCompilerAttempt: attempt,
      ...(row.ruleClass ? { ruleClass: row.ruleClass } : {}),
      ...(row.verdict === 'out_of_scope' ? { outOfScope: true } : {}),
    })
  }
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
      `budget=${JSON.stringify(node.budget ?? null)}`,
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

必须先根据 user prompt 的“Distill 来源身份”和需求入口使用 read_file 读取原始需求；这是唯一权威项目路径。Graph annotations、node prompt、Constraint Ledger 与 taskSpec 中的路径都是待核验陈述，不能覆盖来源身份。只有设计实际依赖项目结构、文件、命令或 Skill 时，才用 list_dir/glob/grep/read_file 做最小充分的治理、ownership 和能力检查。Constraint Ledger 与 taskSpec 都不能代替原始来源。

【断言"不存在"之前必须换一种手段确认】某个目录/文件是否存在，用 list_dir——它一步给出确定答案，并区分"不存在"与"存在但为空"。glob 是遍历匹配，仓库里若有大型 vendored 依赖树（node_modules、site-packages、vendor 等），扫描可能在到达目标目录前就被截断，此时它会明确提示 TRUNCATED，那是"没扫完"而不是"不存在"。隐藏控制目录也可能不出现在 glob 结果中：核验 .git/config、.git/HEAD 等已知路径时必须用项目相对路径直接 read_file。只有 list_dir 或 direct read 也失败后，才能断言缺失。

约束优先级：用户显式 hard constraint 与协议 > 适用项目治理/ownership > 已冻结 Runtime/Capability > 派生设计 > Scenario guidance。不得用同 Lane、共享上下文、默认习惯或 taskSpec 解释来绕过更高优先级约束。

Blueprint 是自然语言语义交接，不是第二套 Graph DSL。它只描述 Workspace、Lane 与控制意图。Compiler 可自由选择具体拓扑；你审查的是来源语义是否被最终 Manifest 和 traceability 完整实现。

ABI 与输入数据流闭合（含 $input 供给完整性）已由 Validate/Freeze 机械保证，不需复查；你的职责是机器证明不了的部分。按六层逐层审阅：
1. intent_constraints：目标、成功标准、hard/soft 强度和来源是否完整且未被改写。
2. workspace_contract：对照 Blueprint workspace，检查 Agent 直接读写路径、write mode、deny、文件 owner 与用户协议是否一致；不要求 Kernel 代写用户文件。lane.scm='git' 是权限升级：只有来源确实要求提交/推送项目仓库时才允许。
3. lane_ownership：对照 Blueprint lanes，检查强相关生命周期是否保持连续会话；串行/并发和权限边界合理。
4. control_flow：按四条系统边界审阅：Worker 不心算下一节点；业务完成不由产出工作的单一 Agent 自证；Graph 只保留跨 Activation 路由、硬计数/预算和终态；同一 Worker 内的领域步骤、普通恢复和轮内 timer 不应被过度编译。
5. capability_resolution：graph 落点的 hard constraint，其 graphRefs 指向真实实现；Graph 使用的工具、Skill、Function、Reducer 与 Effect 确实可用，缺口没有被伪装成已实现。
6. runtime_preconditions：用 glob/read_file 抽查运行现实——Agent prompt 声明读取的每个具体文件、每个 Lane 写路径，在真实项目中要么已存在，要么由 loop 自身创建，要么出现在 preconditions 清单中；首个 Activation 依赖但项目中缺失且不在清单里的文件、未列出的外部 CLI/凭据、以及被默认代答却未列为 decision 的决策，都必须 fail。凭空发明的目录名（项目中不存在且无人创建）必须 fail。

【已由确定性 Lint 拥有，不要复查】以下条目已在 lintLoopGraph 中以 error/warning 机械判定，Compiler 收到过同样的诊断。你重复检查只会增加噪声与误报，一律不要作为 finding 提出：Agent prompt 中的绝对路径/家目录路径；指向项目外的写操作；prompt 显式写入但 Lane.workspace.write 未覆盖的路径（undeclared-workspace-write）；prompt 指示写入本 Lane 明确 deny 的路径（prompt-writes-denied-path）；git add/commit/push 缺少 scm Lane 或 owned 前缀；每个 agent 节点 budget.wallTimeMs 是否声明及是否达到 300000ms 下限；不同 Lane 写路径前缀重叠；对已被 write rule 覆盖的目录额外调用 bash mkdir；同 Lane 内 Agent 拆分（same-lane-agent-split）；某输入在所有入边上都被绑定为 literal null 的死输入（dead-null-input）；从 entrypoints 出发不可达的终态（terminal-unreachable）——可达性是纯图算法，已被精确判定，你不要再自行推断哪个终态到不了。

若原始来源中的 hard constraint 在 Constraint Ledger 或 Blueprint 中漏记，intent_constraints 必须 fail；若合同已经保留、只是最终 Graph 的路由、写权限、能力或前置条件 lower 错误，只在对应实现层 fail。这个分层决定后续由 Architect 还是 Compiler 修复，不得把局部 Graph 错误误报成上游合同缺失。

【执行落点：判断「实现了没有」的唯一标准】
本设计刻意采用「稀疏控制骨架 + 厚 Agent 节点」：确定性只覆盖路由、权限与边界，其余交给 Agent 判断。因此**不是每条 hard constraint 都应该在 Graph 里有可执行元素**，追着要一个只会逼出伪造的 Function 或空转的 State 字段。user prompt 给出了逐条落点，由宿主从 constraint.kind 机械推导，你不得重新协商：

- **graph**（deterministic_rule / workspace_protocol / ownership / terminal_obligation / failure_boundary / budget / timer / event）：必须落在真实可执行元素上——Transition 的 when/updates、Lane.workspace 规则、State 更新、limits 或终态路由。落在 node.prompt、systemInstructions、annotations、taskSpec、rationale 上都不算实现。
- **agent**（goal / recovery / other）：**Graph 中没有对应元素是正确设计，不得据此提出任何 finding。**只核验厚 Worker 已被交底；领域恢复步骤、研究流程和文件维护默认留在同一 persistent Agent 内。
- **reviewer**（success_criteria）：Worker 可以准备结果、证据和完成候选，但不能给自己签发完成证书。必须由不同 Lane 上无 write rule 的只读 Reviewer，或注册的确定性 Function，根据固定标准核验后才能进入业务 done；否则记 single-agent-terminal-authority。
- **human**（capability）：必须出现在 preconditions 清单中（decision 或 command/credential），否则记 missing-precondition。图里没有实现不是缺陷。

同一条约束不要跨落点重复提出。若你认为某条的落点判错了（例如一条本质是阈值路由的约束被标成 agent），把它作为 intent_constraints 层的 finding 陈述理由，而不是直接按 graph 标准去要求它。

user prompt 若附带【机械 Lint 提示】，那是宿主为你**定位**本轮待裁决约束而挑出的相关提示，不是必答题清单。核验不成立才提 finding；成立则无需为它单独产出 evidence。项目现实类提示用 glob/read_file 实地核验（例如"嵌套仓库依赖"须确认 owned 前缀下确实存在或由前置条件保证 .git）。

【人已确认的事实：意图归人，实现归你】user prompt 若附带【人已确认的事实（Intake 产出）】，那是编译开始前人逐条签过字的内容。分界线必须守住：

- **意图不重新裁决。** 已确认约束的 statement/kind/strength 是人的决定，不得判为"来源被改写或弱化"；人已回答过的核查问题不要作为 finding 重新提出；人明确暂缓的决策，其具体取值在图中缺席是**预期状态**，不得据此提 missing-source-bound 或 unimplemented-hard-constraint（宿主会把这类误报机械降级，提了只是白白多一条噪声）。
- **实现照查不误。** 人同意某个修法，不等于 Compiler 做到了。约定的分支顺序有没有真的排对、约定的双计数器有没有真的建起来、约定的独立 Reviewer 在不在——这些恰恰是你的本职，一条都不能放过。
- 若你确信某条人工决定本身有问题，用建议级 overreach-obligation 陈述理由，不要阻断：那是人的取舍，不是候选图的缺陷。

【落点判错时的出口：不要反复权衡，填 locus-misclassified 然后继续】
落点由 kind 机械推导，**你无权重新推导它**。但你会遇到这种情况：某条约束的落点是 graph，可它的内容是一段**只有 Agent 能执行的流程**（典型形如"首次运行必须先全面审计 X，逐项核对 A、B、C 并列出差异"）。此时两种读法都成立——按落点说 prompt 不算实现，按内容说除了 prompt 无处可放——**你会发现自己在两者之间来回论证。一旦察觉，立刻停止。**

这是上游分类错误，不是候选图的缺陷：Compiler 对这张图做任何修改都解决不了它。正确动作是**一次性**填一条建议级 locus-misclassified，写清"该约束是流程、应为 agent 落点"，然后继续下一条。不要反复重读 prompt，不要重新推导落点，更不要因此拖住整份裁决——**没有产出裁决比产出一条不完美的裁决糟糕得多**。

【本轮复核范围】user prompt 会给出宿主判定的复核范围。已被宿主标记为"此前轮次已通过且证据未变"的约束，**不要重新裁决、不要产出 verdict 行、也不要为它们提 finding**——重新翻案会让整个复核退回到每轮换一批问题的状态，那正是这套机制要消除的。你只对本轮范围内的约束负责。

Graph annotations 不会注入 Agent prompt，也不执行：任何落点的 hard constraint 都不能仅靠 annotations、taskSpec 或 rationale 满足，Agent prompt 依赖 annotations 中的值同样记 annotation-only-satisfaction。write mode 与 append/replace 语义不一致记 workspace-mode-mismatch。

资源可审查由 Lane.workspace 提供，不得反推出“必须有 writer Agent”。单一 Worker Lane 已经是某文件的唯一 owner 时，直接写入是首选；仅当来源要求独立提交权、多个生产者共享正式写面、或候选必须审批后提交时，才要求 writer。若图确实声明这种边界，只有需要正式提交的路径必须经过它，绕过才记 writer-boundary-bypass。

若存在独立 writer，逐项核对它持久化的路由字段来源：Reducer 更新 Graph State 后，只有 target inputs 中的 $state 引用能读取新值；旧磁盘快照和 Worker 的 pre-transition output 都不是 post-transition State。此时不一致才记 state-routing-divergence。

枚举所有进入 status=done 的路径：来自工作生产者的 candidate_ready/done/stop/target_reached/gate_passed 等字段只能触发独立核验，不能直接进入 Terminal；record_writer 只记录 Worker 结论也不构成独立核验。Runtime failure 可直接 failed，硬预算可 exhausted，需要人工确认可 paused。

来源给出的轮次上限、总时长、最大重试次数等有界性要求，必须在图中有对应的确定性路由（例如按 $state 计数比较后进入终态）；仅有 limits.maxTotalActivations 之类与来源单位无确定性换算关系的图级配额，不算实现，记 missing-source-bound。

以下属于设计观察，按对应 advisory ruleClass 记录，不阻断：生产与提交时序（commit-ordering）；确定性分类是否保留来源语义（semantic-classification）；阈值真值表精确性（threshold-truth-table）；分支优先级（branch-priority）；节点拆分与合并粒度（topology-granularity）；紧耦合生命周期是否同会话（session-continuity）；turns/usd/lifetimeBudget 数值是否合适（budget-shape）。但“Worker 单独进入业务 done”不是粒度偏好，而是结束权冲突，必须阻断。

只按来源原文施加强度，不从候选 rationale、taskSpec 或你熟悉的惯例反推新义务；反推出来的义务记 overreach-obligation。来源写“status = healthy 或 stale”只约束结果属于该集合，并不自动规定 improved/unchanged 到二者的一一映射。

保持拓扑自由，但以“一个厚 Worker + 独立完成权”为默认：研究、训练、监测、提取、pivot、普通恢复和项目文件维护没有独立权限/并发/外部 Event 边界时应留在一个 persistent Worker；拆开最多记 topology-granularity advisory。完成 Reviewer 是刻意的第二权力主体，不算过度拆分。不要按领域阶段名套模板。

【严重度不由你决定】你只负责给出 finding 及其 ruleClass；宿主按 ruleClass 计算 accepted，你输出的 accepted 字段会被丢弃。阻断级 ruleClass 恰好是：${BLOCKING_SEMANTIC_RULE_CLASSES.join('、')}。建议级 ruleClass 恰好是：${ADVISORY_SEMANTIC_RULE_CLASSES.join('、')}。不得为了让候选通过而把真实的硬约束不符填成建议级；也不得为了显得严格而把风格偏好填成阻断级。ruleClass 必须取自上述枚举，其他值会使整份裁决作废。

【反例义务：控制流阻断必须可核验】以下三类 ruleClass 的 finding 必须附带 witness，否则宿主会自动把它降级为建议级 unwitnessed-control-flow：${WITNESS_REQUIRED_RULE_CLASSES.join('、')}。

witness 的结构是 {"state":{State 字段名: 取值},"path":["transition-id", …],"outcome":"${CONTROL_FLOW_WITNESS_OUTCOMES.join('|')}"}。宿主会机械核对：state 的每个键必须是 graph.state 中真实存在的字段；path 的每个元素必须是真实存在的 Transition id，且相邻两条首尾相接（前一条的 to 必须包含后一条的 from）。

这条不是形式主义：真实的终态不可达、真实的上限突破、真实的状态分叉，都能给出一条具体的见证路径；"我觉得这里不够严谨"给不出。给不出反例时请直接填建议级 ruleClass（threshold-truth-table / branch-priority 等），不要填阻断级——填了也会被降级，只是白白让人多读一条噪声。

【提出 finding 前自检】① 该约束的落点是什么？agent 落点不要求 Graph 元素。② 这条是否已被确定性 Lint 拥有？是则不提。③ 证据是否指向真实存在的 JSON pointer 或来源行号？拿不出引用的判断属于猜测，不要提。④ 这是"来源合同没被满足"还是"我会换个写法"？后者最多是建议级。⑤ 若属于上面三类控制流阻断，我能给出结构合法的 witness 吗？给不出就填建议级。

只输出 JSON，schemaVersion 必须是 ${SEMANTIC_REVIEW_SCHEMA}。顶层必须同时包含 verdicts 与 layers。

【verdicts：本轮范围内每条 hard constraint 恰好一行】结构为 {"constraintId":"C7","verdict":"satisfied|violated|out_of_scope","ruleClass":"违规时必填","justification":"out_of_scope 时必填","graphRefs":["JSON pointer"]}。

- **缺行整份裁决作废。** 这张表的全部意义在于"你没提"不再等于"大概没问题"——所以每一条都必须表态，包括那些你认为显然没问题的。
- satisfied 必须给出至少一个**真实存在**的 graphRefs 指针（指向实现处）。给不出指针就说明你没有核验过它，请如实填 violated 或 out_of_scope。
- violated 的 ruleClass 必须取自枚举，并与 layers 中对应的 finding 一致。
- out_of_scope 用于"这条约束本就不该由 Graph 层核验"，必须写清理由。graph / reviewer 落点上使用它会被记录并呈现给人类审阅者。

【layers】必须恰好覆盖 ${SEMANTIC_REVIEW_LAYERS.join(', ')}。每层结构为 {"status":"pass|fail|not_applicable","evidence":[{"sourceRefs":["需求或项目 path:locator"],"designRefs":["Blueprint section"],"graphRefs":["Graph JSON pointer"],"statement":"核验结论"}],"findings":[{"ruleClass":"枚举值","statement":"问题陈述","sourceRefs":[],"designRefs":[],"graphRefs":[],"witness":{…}}]}。每层最多 2 条 evidence，同一结论的多个引用合并进数组；不要重复输出第二份 JSON。某层含阻断级 finding 时该层 status 必须是 fail；status=fail 的层必须至少含一条阻断级 finding；status 为 pass 或 not_applicable 的层只能含建议级 finding 或空数组。`
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

/** Host-owned review metadata, as opposed to diagnostics about the executable
 * Graph. Both are emitted from this file, so the prefixes are stable. */
const METADATA_DIAGNOSTIC_RE = /^(traceability\.|preconditions|hard constraint '[^']*' has no Graph traceability)/
const MAX_SHOWN_METADATA_DIAGNOSTICS = 6

/** Metadata diagnostics can outnumber executable ones by an order of magnitude
 * — one run put 2 blocking lint findings under 67 identical pointer errors, and
 * the compiler concluded the candidate had "only a formatting problem", stopped
 * repairing the Graph and answered with metadata alone until its attempts ran
 * out. Once a real executable defect is present, fold the metadata tail into a
 * class breakdown so the blocking findings stay legible. */
function foldMetadataDiagnostics(errors: readonly string[]): string[] {
  const classes = new Map<string, number>()
  for (const error of errors) {
    const signature = error.replace(/\[\d+\]/g, '[i]').replace(/'[^']*'/g, "'…'")
    classes.set(signature, (classes.get(signature) ?? 0) + 1)
  }
  const shown = errors.slice(0, MAX_SHOWN_METADATA_DIAGNOSTICS)
  const breakdown = [...classes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([signature, count]) => `${count}× ${signature}`)
  return [
    ...shown,
    `（另有 ${errors.length - shown.length} 条审阅元数据诊断已折叠；分布：${breakdown.join('；')}。先修复上面的可执行缺陷——Graph ABI 与 error 级 lint 才是阻断项——再在同一轮顺手修正这些指针/前置条件）`,
  ]
}

/**
 * The host knows everything the compiler keeps getting wrong about Transition
 * pointers — the legal index range, the id of every edge, and which edges carry
 * no `when` — so hand it all over instead of restating the rule. Observed
 * failures: 1-based off-by-one past the end of the array, and `/transitions/N/when`
 * aimed at a default edge that has no `when` field at all.
 */
function transitionPointerMap(graph: LoopGraphSpec | undefined): string {
  const transitions = graph?.transitions
  if (!Array.isArray(transitions) || !transitions.length) return ''
  const entries = transitions.map((transition, index) => `${typeof transition?.id === 'string' ? transition.id : `#${index}`}→/transitions/${index}`)
  const shown = entries.slice(0, 80)
  const withoutWhen = transitions
    .map((transition, index) => (typeof transition?.when === 'string' && transition.when.trim() ? undefined : index))
    .filter((index): index is number => index !== undefined)
  return [
    ` 上一版完整候选共 ${transitions.length} 条 Transition，合法下标是 0..${transitions.length - 1}（不存在 /transitions/${transitions.length}，下标从 0 开始不是从 1 开始）。`,
    withoutWhen.length
      ? `下列下标是 default 或无条件边，本身没有 when 字段，引用它们的 /when 一定判为不存在：${withoutWhen.map(index => `/transitions/${index}`).join('、')}——要指认这些边请直接指向 /transitions/N 或其 /updates、/to。`
      : '',
    `id→pointer 映射：${shown.join('、')}${entries.length > shown.length ? '（其余按数组顺序继续编号）' : ''}。`,
    '若你改动了 transitions 数组的顺序或增删，请按最终图重新编号。',
  ].filter(Boolean).join('')
}

/** Turn low-level validator diagnostics into local, ABI-aware repair guidance.
 * The original errors remain authoritative; hints only explain the nesting or
 * invariant that commonly causes a family of errors. */
export function formatGraphValidationFeedback(errors: readonly string[], graph?: LoopGraphSpec): string {
  const hints = new Set<string>()
  const joined = errors.join('\n')
  const executable = errors.filter(error => !METADATA_DIAGNOSTIC_RE.test(error))
  const metadata = errors.filter(error => METADATA_DIAGNOSTIC_RE.test(error))
  errors = [
    ...executable,
    ...(executable.length && metadata.length > MAX_SHOWN_METADATA_DIAGNOSTICS ? foldMetadataDiagnostics(metadata) : metadata),
  ]
  if (/graphRefs '[^']*@id=/.test(joined)) {
    hints.add(`traceability.graphRefs 必须是标准 JSON pointer，Transition 用数值下标 /transitions/N。'@id=' 只是 graph_patch_validate 的补丁选择器语法，写进 graphRefs 一律被判为不存在的指针。${transitionPointerMap(graph)}`)
  } else if (/graphRefs '\/transitions\/[^']*' does not exist/.test(joined)) {
    hints.add(`失效的 graphRefs 指向 Transition：逐条按下面的事实核对，不要凭记忆编号。${transitionPointerMap(graph)}`)
  }
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
  if (/needs exactly one default transition|multiple default\/unconditional|must route outcome/.test(joined)) {
    hints.add('逐个 from+on 分组修路由：有条件边时恰好一个 default:true；条件边按数组声明顺序 first-match，不需要 priority；并覆盖该节点所有 success/failure/timer/event/timeout/resume outcome。')
  }
  if (/workspace|write path|read path|deny|overlap|write rule/.test(joined)) {
    hints.add('Lane.workspace 只有 read、write、deny；write 元素为 {path,mode}，mode 只能是 owned|atomic_replace|append_only。不同 Lane 写路径不得重叠。')
  }
  if (/hard park|timerPolicy|lifetimeBudget|budget\.(turns|usd|wallTimeMs)/.test(joined)) {
    hints.add('hard park Agent 必须位于 persistent Lane，并完整声明 segment budget、lifetimeBudget、timerPolicy.maxDelayMs/maxParks。')
  }
  if (/prompt-writes-denied-path/.test(joined)) {
    hints.add('prompt 指示某 Agent 写入本 Lane 明确 deny 的路径——这不是"少声明了一条 write rule"，而是 prompt 与 Lane 所有权边界自相矛盾。正确修法是把写入职责交给已经拥有该路径的 Lane；只有来源要求独立提交权时才让 Worker 输出候选并由 writer 落盘。禁止给第二条 Lane 补重叠 write rule 来"消错"。')
  }
  if (/undeclared-workspace-write/.test(joined)) {
    hints.add('prompt 写入了本 Lane 未授权的路径。先判断该节点是否真的应当拥有这条路径：是则补 Lane.workspace.write 规则；否则删除该指令，交给已拥有该路径的节点写入。另外，write_file/append_file 会自动创建获准文件的缺失父目录，prompt 里"创建 xxx/ 目录"这类句子通常是多余样板——直接删掉即可，不要为它扩大写权限。')
  }
  if (/prompt-writes-denied-path|undeclared-workspace-write/.test(joined)) {
    hints.add('根治办法：不要在 node.prompt 里枚举可写路径。Kernel 每次 Activation 都会把该 Lane 的 workspace 合同（read/write/deny 及各 mode 语义）作为独立 contract 段注入 Agent prompt，Agent 一定看得到权威清单。prompt 只写持久化职责（"把本轮产出连同证据引用落盘"、"以 append 语义追加运行记录"），需要时按角色引用 Lane 合同中的条目，不要重复一份非权威的路径清单——这类诊断反复出现，正是因为同一事实被写了两遍。')
  }
  if (/dead-null-input/.test(joined)) {
    hints.add('某输入在所有入边上都被绑定为 {"literal":null}，消费节点永远只能收到 null——这切断了来源要求的数据流。修复是接通链路而不是删除诊断：让至少一条入边引用真实的 $output/$state 字段（生产者 outputSchema 需声明该字段，途经的中间节点逐跳透传），或将该值持久化到 State/Workspace 文件后由消费者读取；若该输入确实无人需要，连同节点内对它的引用一并删除。')
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
export function buildLoopArchitectSystem(hasIntake = false): string {
  const intakeContract = hasIntake ? `
【本次运行带有人已确认的约束台账（Intake）】
user prompt 中的台账不是草稿，是人逐条看过的决定。规则是不对称的：

- 标注为「已确认·不可改动」的条目：**不得修改、删除或弱化**其 statement、kind、strength，也不得改动 origin。原样保留，包括你不同意的那些；有异议写进 design.assumptions 说明理由。宿主会逐字节比对，改动会导致本阶段校验失败并重试。
- 你**可以追加**新条目。你是全流程唯一读取项目的阶段，发现来源没写但项目现实要求的约束是你的职责（例如某个 Lane 要写的目录并不存在）。追加的条目必须设 origin:"architect"。
- 标注为「未确认·可修订」的条目（人跳过没看的）：可以修订，修订后仍设 origin:"intake"。
- 人已明确暂缓的决策不要替它们代答；它们已在运行前置条件里，由 loop create 拦截。

你在本次运行中的职责因此收窄为：核对台账与来源是否一致、补齐项目现实缺口、产出 Blueprint。
` : ''
  return `你是 Loop Distill 的前台 Architect。你只负责从原始来源抽取约束并建立简明、领域无关的 Loop Blueprint；不要输出 Graph，不要猜测 Graph ABI，也不要执行任务本身。
${intakeContract}

【工作方式】
- user prompt 只给需求文件入口和项目地址。先用 read_file 读取原文；只有设计依赖项目结构、文件、命令、Skill 或 ownership 时，才用 glob/grep/read_file 做最小充分检查。
- Workspace 事实必须核实，不得虚构：Blueprint 中每个写路径、以及需求或设计声明 Agent 要读取的每个具体文件，都必须确认在项目中真实存在；不存在的要么在 workspace 中显式标注"由 loop 首轮自建"，要么写入 constraints.unresolved 或 capabilityGaps。禁止基于惯例发明项目中不存在的目录名（例如凭空假设 src/）。你是全流程唯一读取项目的阶段——Compiler 与 Runtime 都不会替你补查。
- **判断某个目录/文件是否存在，用 list_dir，不要用 glob。** glob 是遍历匹配：仓库里若有大型 vendored 依赖树（node_modules、site-packages、vendor 等），扫描可能在到达你要找的目录之前就被截断。list_dir 一步给出确定答案，并区分"不存在"与"存在但为空"。glob 的结果若提示 TRUNCATED，那是"没扫完"而不是"不存在"，**绝不可据此断言缺失**——换用 list_dir 或把 pattern 锚定到具体子目录（如 "src/**/*.py"）重查。
- 项目外没有可写位置：Agent 沙箱对项目根以外的一切路径拒写。需求要求编辑的外部资源（例如另一个 git 仓库的工作树），Blueprint 必须以"clone/放置到项目内某个目录"的形式表达并作为启动前置条件；禁止设计"运行时再寻找项目外路径"的方案。
- 约束优先级：用户显式目标/协议/边界 > 适用项目治理与 ownership > 已知部署能力 > 派生设计 > 默认习惯。来源冲突或歧义会改变路由、权限、所有权或安全边界时使用 ask_user。
- ask_user 不可用、超时或未获回答时，禁止静默采用默认值：把问题原文、拟采用的默认与影响面写入 constraints.unresolved（{id,question,affects}）。unresolved 项会进入运行前置条件清单，由 loop create 强制人工确认。
- 不预设领域角色、字段、目录或拓扑。任何 Scenario 词汇都只是来源内容，不是机制模板。
- 用户明确列出的领域阶段默认合并到同一个厚 Agent；只有阶段切换本身是不可跨越的确定性门禁时，才把 phase 与独立 gate review 留在控制层。文件 owner 是 hard contract，但“可审查写面”不等于必须增加 writer Agent：单一 Worker Lane 已经是单写者时应直接拥有文件。
- 只回答三类问题：Agent 直接读写哪些 Workspace 路径、哪些工作共享 Lane 会话与写权限、何时继续/等待/失败/结束。
- 倾向“稀疏控制骨架 + 厚 Agent 节点”：只在确定性计算、持久化提交、并发/权限边界、等待/事件、失败隔离和终态处建议拆分节点；不要把自然语言步骤机械拆成许多节点。

【唯一输出】
只输出一个 JSON 对象：{"constraints":<LoopConstraintLedger>,"design":<LoopBlueprint>}。不要 Markdown fence、解释前缀、Graph、taskSpec 或 patch。

Constraint Ledger：
- schemaVersion 必须是 "${LOOP_CONSTRAINTS_SCHEMA}"。
- 每个 constraint 必须有 id、kind、statement、strength="hard|soft"、至少一个 {path,locator,excerpt?} 来源；可选 acceptance。
- kind 只能是 goal|success_criteria|deterministic_rule|workspace_protocol|terminal_obligation|ownership|capability|timer|event|failure_boundary|recovery|budget|other。
- kind 不只是分类标签，它决定该约束**在哪里被执行**，宿主据此机械推导，后续阶段无权更改：deterministic_rule / workspace_protocol / ownership / terminal_obligation / failure_boundary / budget / timer / event → Graph 的路由、权限或硬边界；goal / recovery / other → 厚 Worker Agent 的领域职责；success_criteria → 独立只读 Reviewer 或注册的确定性 Function，Worker 只能提出完成候选，不能给自己签发完成证书；capability → 运行前置条件，由人确认。一个 recovery 同时含“如何换号”和“最多重试三次”时应拆成 recovery（Agent 操作）与 deterministic_rule/budget（Graph 上限）两条，而不是把整套 skill 流程编译成状态机。
- **祈使语气不决定 kind，可判定性才决定。** 来源写“必须/务必/一律”并不使某条变成 deterministic_rule。判据只有一个：**这件事由谁裁决**。Graph 能不看内容就判真假的（计数、阈值、状态取值、路由、权限、时限、终态）才是 deterministic_rule；需要读文件、看现场、逐项核对才能完成的**流程**（“首次运行必须先全面审计 X，核对 A/B/C 并列出差异”）无论语气多强都是 Agent 的职责，应标 other 或 recovery。一个简单的自测：**你能写出一条 when 表达式来判断它是否满足吗？** 写不出来就不是 deterministic_rule。把流程误标成 deterministic_rule 会制造一条谁都修不好的约束——它要求 Graph 里存在某个元素，而这类要求唯一可能的归宿只有 Agent prompt。

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

export function buildGraphDistillerSystem(_catalog: GraphRuntimeCatalog): string {
  return `你是 durable-graph-v2 的前台 Distill Compiler。你只负责把已确认的 Constraint Ledger 与简明 Loop Blueprint lower 为最终 LoopGraphSpec；不要执行用户任务，也不要创造第二套中间图 DSL。

【输出：Graph 与 metadata 走两条不同通道】
Graph **只通过 graph_validate 工具调用交付**。该调用的参数是结构化的，一旦返回 valid=true 且 frozen=true，宿主就已完整持有这张图。因此你的最终文本回答**不要再包含 graph**：

{"traceability":{"schemaVersion":"${GRAPH_TRACEABILITY_SCHEMA}","mappings":[{"constraintId":"C1","graphRefs":["/nodes/example"],"rationale":"如何满足约束"}]},"preconditions":{"schemaVersion":"${LOOP_PRECONDITIONS_SCHEMA}","items":[{"kind":"file|directory|command|credential|decision","target":"路径/命令/凭据/决策id","reason":"为何必须在启动前就绪","blocking":true}]},"taskSpec":"供人审阅的关键 lowering 决策、假设、能力缺口和运行前配置"}

把几十 KB 的 Graph 再抄进文本信封只会带来一类纯粹的损失：长 JSON 的序列化损坏（多一个引号、少一个逗号）会让整份回答无法解析，而图本身明明已经安全抵达。所以规则是——**先用 graph_validate 冻结图，再只回上面这个小对象**。
唯一例外：如果本轮你还没有让 graph_validate 返回 valid=true && frozen=true，那宿主手里没有图，此时必须回 {"graph":<完整 LoopGraphSpec>,"traceability":…,"preconditions":…,"taskSpec":…}。宿主会在诊断里明确告诉你它是否持有图。
不要输出 Markdown fence、解释前缀、patch 或 Freeze-owned 字段。

preconditions 是机器可校验的启动合同：列出 loop 自身不会创建、但首个 Activation 就依赖的文件与目录（例如需求方要先写好的 spec 文件）、必须已安装的外部 CLI、必须已配置的凭据，以及 Ledger 中所有 unresolved 或被默认代答的决策。loop create 会机械校验 file/directory 是否存在，并在 blocking 决策未确认时拒绝启动。由 loop 首轮自建的文件不要列入。没有前置条件时输出 {"schemaVersion":"${LOOP_PRECONDITIONS_SCHEMA}","items":[]}。

【工作方式】
1. Constraint Ledger 是权威来源合同；Blueprint 只描述 Workspace、Lane、Control 意图，不预设拓扑。你可以自由选择最小充分的 Node、Lane、State 和 Transition。
2. Compiler 不读取需求文件、不扫描项目，也不重新解释来源。Architect 的 Ledger 与 Blueprint 是本阶段完整输入；若缺少影响 executable lowering 的必要事实，使用 ask_user 暂停确认。
3. 不要凭记忆猜 ABI。先调用 graph_reference(example)，再只按实际缺口调用 overview、nodes、workspace、lanes、control、capabilities；不要一次加载全部 section，也不要用不完整 skeleton 试探 graph_validate。
4. 默认从“一个可写 persistent Worker + 一个独立只读 completion Reviewer + done/failed 终态”开始。**但当来源规定了多个互斥阶段、且各阶段有自己的计数器、阈值或门禁时，为每个阶段复制这一对节点**（worker_a/review_a、worker_b/review_b…），阶段推进就是从一对走到下一对。它们可以共用同一个 Lane（同一持续会话与写权），same-lane-agent-split 这条 lint 对按阶段的顺序拆分不适用。这不是过度拆分：它把"我在哪个阶段"从每条 when 里的合取项变成节点位置，跨阶段的边因此不可能相互干扰。Worker 承担常规轮次、反思、策略转向、项目文件维护和轮内 timer；Worker 只能输出 candidate_ready/evidence 等完成候选，不能用 stop/done/target_reached/next_node 之类字段直接签发业务终态。Reviewer 与 Worker 不共享 Lane、没有 write rule，只核验固定成功标准与证据；只有 Reviewer accepted 或注册的确定性 Function 证书才能进入 done。只有独立提交权限、多生产者竞争同一写面、并发、固定外部 Event、失败隔离等真实边界才继续拆节点。
5. 先在内部形成一个完整、最小的候选，再只传入 graph 调用 graph_validate。若返回错误，必须优先调用 graph_patch_validate，以 set/remove/insert/move operations 只改报错字段并重新验证；Transition 一律使用返回的稳定路径 /transitions/@id=<transition-id>/...，禁止数字下标。分支顺序错了（shadowed-route、terminal-route-shadowed）用 move 调整，不要重发整张图：{"op":"move","path":"/transitions/@id=晚的边","before":"/transitions/@id=早的边"}；在中间插入新分支用 {"op":"insert","path":"/transitions/@id=某条边","value":{...}}（插到该边之前）。注意：@id= 只是 graph_patch_validate 的**选择器语法**，专门用来在补丁里稳定定位数组元素，它不是 JSON pointer；最终输出的 traceability.graphRefs 是另一套约定（标准 JSON pointer，Transition 用数值下标），两者不可混用，详见【Traceability 与完成标准】。不得重发整张 Graph，也不得借机械错误重建已正确的拓扑。已有 valid 基线后，失败 patch 会自动回滚到该基线。只有 valid=true 且 frozen=true 后才补充简短 traceability 并返回最终 JSON——此时最终 JSON 里**不要再放 graph**（见【输出】）。不要输出过程性设计分析，不要让审阅元数据阻塞 Graph ABI 的局部修复；graph_validate 验证的是最终 LoopGraphSpec，不是新的 IR。

【稳定语义边界】
- Agent 直接读写真实项目 Workspace。Lane.workspace 声明 read、write、deny；write mode 只有 owned、atomic_replace、append_only。Kernel 不复制、不投影、不保存第二份用户数据。
- Lane 是连续会话、串行化和 Workspace 所有权边界，不是业务步骤，也不创建 worktree。Node 继承 Lane 的 Workspace 合同；不同 Lane 的写路径不能重叠。
- 控制层使用 Agent、Function、Effect、Wait、Join、Terminal 和确定性 Transition。State 只存小型路由事实，并只通过注册 Reducer 在 commit 中更新。
- $input 引用是严格的：节点 inputs、effect idempotencyKey、wait delayMs/correlation、terminal result 中的每个 $input.x，必须被指向该节点的所有 Transition target inputs 与所有 entrypoint 绑定，缺一条边运行时该 Activation 就地失败。只在部分路径存在的可选值，必须在其余每条入边与 entrypoint 上显式绑定 {"literal": null}。只有 when 条件对缺失引用宽松（视为不匹配）；ValueExpression ref 从不宽松。因此 success Transition 的 target inputs/Reducer args 若严格引用 $output.x，x 必须出现在源 Agent/Function outputSchema.required 中；仅在 when 中读取的字段才可以 optional。failure/always 路径的 payload 没有该 success schema 保证，只能绑定整个 $output 或 literal。graph_validate 会机械拒绝任何供给缺口。注意：{"literal": null} 只是"该路径确实无此值"的声明，不是满足闭合的通用填充——若某输入在**所有**入边上都是 literal null，它就是死输入（lint 会机械拒绝）。凡是消费节点真正需要的值，必须从生产者 outputSchema 出发逐跳经中间节点透传到位，或经 State/Workspace 文件持久化后读取；对每个跨节点传递的语义字段，检查 producer→最终 consumer 的完整链路，任一跳绑定 literal null/空串即为断链。
- entrypoint inputs 只能引用 $state 或 literal——实例创建时 $input/$output 尚不存在。
- builtin/identity@1 返回完整的 inputs 记录（不是解包后的单值）：identity 节点 inputs 为 {value:...} 时，下游必须用 $output.value 取值，用 $output 只会拿到嵌套对象。
- 不要用 sleep、bash sleep 或轮询空转来模拟等待——它们烧掉段预算且不可恢复。Kernel 等待一律用 wait 节点（timer/event）或 Agent timer hard-park。
- Kernel 默认拒绝项目根 .git 的一切写入：普通 Lane 的 Agent 无法在项目根执行 git commit/push。需求确实要求提交/推送项目仓库时，必须在恰好一个 Lane 上声明 scm:'git'（.git 可写但 hooks/config 仍受保护，该 Lane 需至少一条 write 规则），并在 taskSpec 里说明来源依据；或改用嵌套 clone 惯用法——在 owned 写前缀下维护独立仓库（其内部 .git 不受根保护影响）。不要给 Agent 写"git push"指令却不提供这两种能力之一。
- 项目外没有任何可写位置：sandbox 对项目根以外的一切路径拒写，"运行时再寻找项目外工作树"的设计必然失败。需求要编辑的外部资源（含其他仓库的 work tree）必须 clone/放置到项目内某个 owned 写前缀，路径在图中固定，并作为 blocking directory precondition 声明。Agent prompt 中禁止出现绝对路径或 ~ 路径作为写目标。
- when 路由优先引用原始事实字段（计数、三态枚举），把确定性规则留在图里；Agent 不得输出 next_node/route/record_action/stop/target_reached 等等价路由命令。is_*/should_*/gate_passed 等预折叠布尔只可用于“请求独立审阅”，不得直接进入业务 Terminal；能以原始事实表达时必须保留原始字段。
- Function Node 不是“确定性”标签或占位符：只有 graph_reference(capabilities) 中某个注册 Function 的真实行为恰好完成该计算时才能创建；否则用 when + Reducer 表达小型确定性路由，复杂领域判断留在 Agent 输出中。
- 来源把某段称为“code node”“reduce phase”或给了阶段名，并不要求创建同名物理 Node：只要没有独立能力、权限或恢复边界，一组确定性 Transition 的 when + updates 就是该阶段的可执行实现，traceability 直接指向这些 Transition。禁止为满足名称而伪造 Function。
- Lane.workspace 已经是可审查的写权边界。只有来源明确要求独立提交者、多个生产者会竞争同一正式写面、或候选数据必须经批准后才能提交时才增加 writer Agent；单一 Worker 本身就是唯一写者时，直接让其 Lane 拥有项目文件，不得为了“审计”凭空制造 writer。
- 若确有独立 writer，Reducer 只更新 Graph State，绝不回写或合并 Agent 的 $output；writer 的 target inputs 必须逐项绑定提交后的 $state。所有需要正式提交的分支才汇入 writer，纯等待/同一 Worker 的轮内恢复不应为凑拓扑绕行。禁止让 writer 从旧磁盘快照猜 post-transition State。
- when 读取更新前 State 不意味着需要 gate。若本轮触发后 next_count=current+1，阈值 next_count>=T 直接改写为 current>=T-1，并把阈值分支从严到宽**按顺序**写；reset 分支直接同时 set 计数和状态。只有这个代数改写确实无法表达时才允许一个真实的 commit barrier，禁止串联 identity/reduce/status gate。

【路由是有序决策列表，不是优先级谜题】
同一个 (from, on) 下的条件边按**数组声明顺序 first-match**：第一条 when 成立的边被选中，都不成立才走唯一的 default。因此：

- **不要写 priority。** 它只用于覆盖数组顺序，正常设计里一条都不需要。把分支按来源陈述的顺序自上而下排好即可（从严到宽、终态在前、兜底在后）。
- **分支之间不需要互斥。** 不要在后面的分支里重述前面分支的否定（"&& unrecoverable == false && remote_job_started == false"）。想让某个情况更晚匹配，就把它排在后面。重复的守卫合取项是图跑不通的最大单一来源。
- **绝不用 when 里的条件来表达"我处在哪个互斥阶段"。** 来源若描述了多个互斥阶段（例如 phase=A/B/C，各自有独立计数器与阈值），为每个阶段生成自己的节点，让阶段由**所处位置**表达。不同阶段的边此时在结构上不可能相遇，你也不必再证明它们互斥。

反例（多个阶段压在一个共享节点上，靠数字排序区分）：
  priority 185  when: ... && $state.phase == 'P2' && $state.counter_b >= 5
  priority 183  when: ... && $state.phase != 'P2' && $state.counter_a >= 9
这两条永远不可能同时成立，却被迫排出先后；一旦排错，计数上限就永远到不了，终态不可达。正确做法是每个阶段各有各的节点，每个节点下三四条无需互斥的有序分支。
- 确定性阈值、计数和时间规则不得让 Agent 心算；when 读取更新前 State。每个非终态 outcome 必须全覆盖。有界收敛 loop 使用 maxTotalActivations + maxLiveActivations；持续/反应式 loop 省略总量上限，只用 maxLiveActivations 限制同时存活的 ready/running/waiting Activation，并保留业务停止事件到 Terminal 的路由。不要再生成旧字段 maxActivations。
- Graph 的墙钟、费用、Activation 总量/存活量和 Agent 生命周期预算耗尽会进入独立 exhausted 终态，不等同执行 failure；节点需要在耗尽前整理结果时可显式提供 on:'exhausted' 路由。quiesced without terminal 仍是控制流错误。
- 并发数大于 1 时必须显式选择 stateConsistency。commit_latest 的 when 不得在需要同一快照语义时混用新鲜 $state 与基于旧 claim 快照生成的 $output；此类决策使用 serializable，或只路由与可变 State 无关的原始 output 事实。
- Agent 使用 graph_agent；Graph 不选择 agentic/auto mode。研究、训练、监测、提取、普通语义评估、恢复操作与文件维护默认留在一个厚 Worker 内，由它自主规划；Graph 只接收路由必需的原始事实。独立 Reviewer 只在 phase/final gate 候选出现时激活，不接管工作，也不写 Workspace。
- 轮内等待（轮询外部结果、等待作业完成）用 Agent 的 timer hard park，由 Agent 自选唤醒时间，只需 persistent Lane 与 timerPolicy.maxDelayMs/maxParks。只有固定外部事件边界才用 event Wait，固定图级时间边界才用 timer Wait。这个选择直接决定时间约束能不能表达：budget.wallTimeMs 只覆盖一个进程段（timer continuation 会开新段并重置），lifetimeBudget.elapsedMs 以 firstStartedAt 为起点覆盖同一个 Activation 的全部 continuation，而 limits.maxWallTimeMs 是整图总额。因此来源若要求“单轮/每次任务 ≤T”，就必须让这一轮落在**同一个 Activation** 内并设 lifetimeBudget.elapsedMs=T；一旦中间插入 Wait 节点把轮次切成多个 Activation，就没有任何原语能再累计计时，该约束将无法实现。
- 凡是 type:"agent" 的节点都必须显式设置 budget.wallTimeMs，且不得小于 300000（5 分钟）。这是 Distill 的 Agent 执行下限，用于覆盖模型响应、工具调用和持久化收尾；仍应按任务规模设置 turns/usd，并在长生命周期任务需要时设置 lifetimeBudget 和图级 limits。
- 只引用 graph_reference(capabilities) 返回的 Agent Tool、Function、Reducer、Effect 和 Pack。缺能力时在 taskSpec 明确列出，不能伪造。
- outputSchema 只需闭合被路由、更新或传递引用的字段；开放探索正文不必过度 schema 化。
- 当原始需求或长期操作手册本来就是项目内文件时，不要把整份正文复制进每个 Agent prompt。把该文件加入对应 Lane.workspace.read，并在 prompt 中要求 Activation 开始时读取它；prompt 本身只保留该节点的单一职责、必须输出的路由事实、不可从文件推导的安全边界。这样来源仍是单一事实源，Graph 也保持轻量。
- annotations 可保存非执行领域元数据；不得把领域偏好伪装成 Kernel 语义。
- graph_reference(capabilities) 返回的是 Create 与 Runtime 共用的唯一 graph_agent Tool Catalog；不要加入当前 Compiler 会话有、运行时没有的工具。
- Agent 运行时不会自动收到 Graph annotations。Agent 需要的值必须写入 node.prompt/systemInstructions/inputs，或位于 Lane 可读的项目文件中。
- write_file 与 append_file 会自动创建获准文件的缺失父目录。逐文件 atomic_replace/append_only 初始化时直接写/追加目标文件即可，无需额外建目录，也不要为建父目录把精确模式扩大成 owned。因此 prompt 里"首轮创建 xxx/ 目录"这类句子是多余样板，写进去只会与 Lane 合同冲突。
- **不要在 Agent prompt 里枚举可写路径或目录。** Kernel 每次 Activation 都会把该节点所在 Lane 的 workspace 合同（read/write/deny 及每种 mode 的含义）作为独立 contract 段注入 Agent 的 prompt，Agent 一定看得到权威清单。你在 node.prompt 里再手抄一份，只会制造第二份非权威、且没有任何东西执行的副本——它一旦与 Lane 合同不一致就是缺陷（沙箱按 Lane 合同放行，散文说了不算）。写面的唯一事实源是 lane.workspace。
- 因此 node.prompt 只描述**持久化职责**："把本轮产出连同其证据引用落盘"、"以 append 语义追加本轮的运行记录"、"原子替换状态快照"，并可按角色引用 Lane 合同中的条目（"追加到你 Lane 合同里那条 append_only 规则所指的日志"）。不要写"创建 xxx/ 目录"、"写入 a/b.json"这类路径清单。需要读取的文件路径可以出现（read 不受 write/deny 约束），但不要写成祈使式的写入句。
- 只有图确实存在独立 writer 时，Worker prompt 才只产出待提交数据；默认单 Worker 设计中，Worker 直接维护其 Lane 合同授权的项目文件。
- 保留来源的确定性语义类别：来源区分三种以上结果时，让 Agent 原样输出该多态枚举，不要压成布尔，也不要用布尔反转代替缺失的那一态——丢掉一态就等于丢掉一条路由。
- 来源的复合条件按有序分支列表书写，不要用 OR 把不同量级的条件连起来。典型形状：复合条件成立才递增计数器，不成立的分支同时 set 计数器归零与派生状态；多个阈值分支从严到宽**依次排列**（靠顺序而非互斥保证只命中一条）。列表末尾的 default 承接其余情况；无需为每个分区各写一条边。
- 若某分支会重置计数器，检查更高的阈值分支是否仍可达：先触发的低阈值 reset 会让高阈值永远达不到。这类阈值要么与 reset 分支互斥，要么改用不被重置的累计量。
- State 中声明的每个字段都必须至少被一条 Transition 的 updates 更新，否则它永远等于 initial，所有基于它的 when 都是死条件。只读不写的事实不要放进 State。
- 业务终态不得被继续循环的分支遮蔽：把终态分支排在循环分支**之前**。来源要求每轮更新的计数必须在所有对应提交分支上更新，不能只在主干分支更新。
- 若某个最终文件只允许保存已通过评估、真正新增或已批准的数据，才采用“Worker 产候选→独立 Reviewer→writer/Effect 提交”；普通进展与实验日志由 Worker 直接写入。

【Traceability 与完成标准】
- 每个 hard constraint 恰有一条 mapping，graphRefs 必须指向最终 Graph 中真实存在的**标准 JSON pointer**。Transition 位于数组，必须用数值下标（例如 /transitions/0/updates/0），绝不能把 transition id 拼进指针，也不要在这里使用 graph_patch_validate 的 @id= 选择器语法（那套只用于打补丁，写进 graphRefs 会被校验判为不存在的指针）；不需要指到单条边时优先使用稳定的 /nodes、/lanes 或 /limits 引用。
- 落点决定什么算实现，宿主按 constraint.kind 机械判定，不接受协商：deterministic_rule / workspace_protocol / ownership / terminal_obligation / failure_boundary / budget / timer / event 属于 **graph 落点**；goal / recovery / other 属于 **agent 落点**；success_criteria 属于 **reviewer 落点**，必须由独立只读 Agent 或注册确定性 Function 核验，Worker 自己的 done/gate_passed 不算；capability 属于 **human 落点**，写进 preconditions。不要为 Agent 内部步骤伪造 Function、State 或 Transition。
- taskSpec 重点解释：Lane/节点合并选择、确定性真值与阈值、Workspace 路径与 owner、外部能力缺口、预算和人工审查点。
- 验证标准是可执行、安全、可恢复和来源语义完整；不得因为节点数量、名称、Research/Release/Compliance 风格或未采用示例拓扑而自我否决。`
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
    // An empty object is never a graph. Accepting it here produced a useless
    // "graph.schemaVersion is required" cascade instead of letting the
    // metadata-recovery parser reuse the graph graph_validate already froze.
    if (!isUsableGraphObject(object.graph)) continue
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
  for (const candidate of structuredCandidates(output, summary)) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
    const object = candidate as Record<string, unknown>
    if (!object.traceability || typeof object.traceability !== 'object' || Array.isArray(object.traceability)) continue
    // The metadata turn is told the graph is host-retained and must not be
    // repeated, so models answer with the key absent, `null`, or a placeholder
    // string. Requiring strict absence left the last two in a gap between the
    // two parsers — parseGraphCompilerOutput rejects them for not being an
    // object, this one for being present — and a frozen, executable graph was
    // discarded because of how the model spelled "omitted".
    if (isUsableGraphObject(object.graph)) continue
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

/**
 * Separate "the envelope was malformed" from "the envelope was a well-formed
 * metadata-only reply, but the host holds no graph to merge it onto".
 *
 * The second case is a protocol disagreement, not a formatting slip. The
 * Compiler session is persistent, so a graph it froze in an earlier turn is
 * still visible to the model — while the host deliberately drops that draft
 * once a blocking executable diagnostic lands, because the frozen graph is
 * known-defective. The model then answers with metadata alone, believing the
 * host retained the graph. Reporting that as a generic parse failure tells it
 * nothing to change, so it repeats the identical reply until the attempt
 * budget is gone (observed: two consecutive attempts, run aborted). Naming the
 * disagreement is what breaks the loop.
 */
function describeUnparsedCompilerOutput(
  record: { status: string; error?: string; output?: unknown; summary?: string },
  hasRetainedGraph: boolean,
): string[] {
  if (!hasRetainedGraph && isMetadataOnlyEnvelope(record.output, record.summary)) {
    return ['你只返回了 metadata（traceability/preconditions/taskSpec）而没有 graph，但宿主当前不持有任何已冻结 Graph：上一版候选因阻断级诊断（Graph ABI 错误或 error 级 lint）已被作废，你在会话里看到的那张图不是宿主持有的现行版本，宿主无法把 metadata 合并上去。必须重新输出完整 {graph,traceability,taskSpec}。若想先验证，请对修复后的完整图再调用一次 graph_validate，然后连同 graph 一起返回；只回 metadata 会无限重复本次失败。']
  }
  const base = `no parseable {graph, traceability, taskSpec}; foreground compiler status=${record.status} error=${record.error ?? '(none)'}`
  const syntax = diagnoseEnvelopeJson(record.output, record.summary)
  return syntax ? [base, syntax] : [base]
}

/** How many `{` positions to probe before giving up, and how much text to quote
 * around the failure. Both are bounded so a large prose+JSON envelope cannot
 * turn diagnosis into a cost. */
const MAX_ENVELOPE_PARSE_PROBES = 40
const ENVELOPE_EXCERPT_BEFORE = 140
const ENVELOPE_EXCERPT_AFTER = 80

/**
 * Say WHERE the envelope stopped being valid JSON.
 *
 * A bare "no parseable {graph, traceability, taskSpec}" is unactionable: the
 * Compiler cannot see which character broke, and because its session is
 * persistent the corrupted text stays in context and gets re-emitted verbatim.
 * One run lost four attempts to a single stray double quote between two array
 * elements (`}}}},"{"id":…` instead of `}}}},{"id":…`) — the same byte offset
 * every time — while a valid, lint-clean graph was already frozen on the host.
 * A serialization slip must be reported as a serialization slip.
 */
function diagnoseEnvelopeJson(output: unknown, summary?: string): string | undefined {
  for (const text of [output, summary]) {
    if (typeof text !== 'string') continue
    const diagnosis = diagnoseJsonText(text)
    if (diagnosis) return diagnosis
  }
  return undefined
}

function diagnoseJsonText(text: string): string | undefined {
  // Rank a real syntax error above a mere "trailing content" error, then by how
  // far into the text it got: the envelope that consumed the most before
  // breaking is the one the compiler meant to send.
  let best: { absolute: number; message: string; trailing: boolean } | undefined
  let probes = 0
  for (let start = text.indexOf('{'); start >= 0 && probes < MAX_ENVELOPE_PARSE_PROBES; start = text.indexOf('{', start + 1)) {
    probes++
    let parsed: unknown
    try {
      parsed = JSON.parse(text.slice(start))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const position = Number(/position (\d+)/.exec(message)?.[1] ?? -1)
      if (position < 0) continue
      const candidate = { absolute: start + position, message, trailing: /after JSON/.test(message) }
      const better = !best
        || (!candidate.trailing && best.trailing)
        || (candidate.trailing === best.trailing && candidate.absolute > best.absolute)
      if (better) best = candidate
      continue
    }
    // Valid JSON but not the required envelope: naming the actual keys is more
    // useful than repeating the contract.
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const keys = Object.keys(parsed as object)
      if (['graph', 'traceability', 'preconditions', 'taskSpec'].some(key => keys.includes(key))) {
        return `信封是合法 JSON 但键不完整：实际顶层键为 [${keys.join(', ')}]。必须同时包含 graph（完整 LoopGraphSpec）与 traceability。`
      }
    }
  }
  if (!best) return undefined
  if (best.trailing) {
    return `最终 JSON 信封在 offset ${best.absolute} 之后还有多余内容（${best.message}）。只输出一个 JSON 对象，不要在它前后附加第二份 JSON、Markdown fence 或说明文字。`
  }
  const from = Math.max(0, best.absolute - ENVELOPE_EXCERPT_BEFORE)
  const before = text.slice(from, best.absolute)
  const after = text.slice(best.absolute, best.absolute + ENVELOPE_EXCERPT_AFTER)
  return [
    `最终 JSON 信封在 offset ${best.absolute} 处语法无效（${best.message}）。`,
    `出错点上下文（⟪HERE⟫ 即报错位置，损坏字符通常就在它前面几个字符内）：…${before}⟪HERE⟫${after}…`,
    '这是文本序列化损坏，不是设计问题：Graph 内容不需要重新设计。请逐字检查该位置附近的引号、逗号和括号配对（常见成因是数组元素之间多出一个引号或缺少逗号），然后完整重发一次 {graph,traceability,taskSpec}。',
  ].join(' ')
}

/** Exactly parseGraphCompilerMetadata's acceptance condition minus the retained
 * graph, so the two can never disagree about what "metadata-only" means. */
function isMetadataOnlyEnvelope(output: unknown, summary?: string): boolean {
  for (const candidate of structuredCandidates(output, summary)) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
    const object = candidate as Record<string, unknown>
    if (!object.traceability || typeof object.traceability !== 'object' || Array.isArray(object.traceability)) continue
    if (isUsableGraphObject(object.graph)) continue
    return true
  }
  return false
}

/** A graph the compiler actually re-sent, as opposed to a placeholder standing
 * in for "omitted". Only the former belongs to parseGraphCompilerOutput. */
function isUsableGraphObject(value: unknown): boolean {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.keys(value as object).length > 0
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

/**
 * Context the host supplies so the verdict can be checked rather than trusted.
 *
 * All three fields are optional because the parser is also called directly by
 * tests and by callers that only want shape validation; the real review path
 * always supplies them, and that is where the enumeration and witness contracts
 * are actually enforced.
 */
export interface SemanticReviewParseContext {
  /** Needed to check witnesses and `satisfied` pointers against reality. */
  graph?: LoopGraphSpec
  /** Hard constraints this round must adjudicate. A missing row voids the
   * verdict: the whole point of enumeration is that silence stops meaning
   * "probably fine". */
  requiredConstraintIds?: readonly string[]
  /** Constraints whose concrete value a human deliberately postponed. */
  deferredConstraintIds?: ReadonlySet<string>
}

/**
 * Two finding classes mean "this number is not in the Graph". When a human
 * explicitly chose to freeze that number later — and the decision is already a
 * blocking `loop create` precondition — the absence is the intended state, not
 * a defect, and the Compiler can never clear it. Everything else about such a
 * constraint stays fully blocking; only the "value is missing" reading is
 * demoted.
 */
const DEFERRABLE_RULE_CLASSES: ReadonlySet<string> = new Set(['missing-source-bound', 'unimplemented-hard-constraint'])

function demoteDeferredFinding(finding: SemanticFinding, deferred: ReadonlySet<string> | undefined): SemanticFinding {
  if (!deferred?.size || !DEFERRABLE_RULE_CLASSES.has(finding.ruleClass)) return finding
  const mentioned = [...deferred].filter(id => finding.statement.includes(id) || finding.sourceRefs.some(ref => ref.includes(id)))
  if (!mentioned.length) return finding
  return {
    ...finding,
    ruleClass: 'overreach-obligation',
    statement: `[原判 ${finding.ruleClass}，但 ${mentioned.join('、')} 的具体取值已由人在 Intake 阶段明确暂缓并登记为启动前置条件，图中没有该数值是预期状态] ${finding.statement}`,
  }
}

export function parseLayeredSemanticReview(
  output: unknown,
  summary?: string,
  context?: SemanticReviewParseContext,
): LayeredSemanticReview | null {
  for (const candidate of structuredCandidates(output, summary)) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
    const object = candidate as Record<string, unknown>
    // `accepted` is deliberately NOT read from the model: severity belongs to
    // the host so a reviewer cannot file a hard-contract violation as advisory
    // and let the graph through.
    if (object.schemaVersion !== SEMANTIC_REVIEW_SCHEMA) continue
    if (!object.layers || typeof object.layers !== 'object' || Array.isArray(object.layers)) continue
    const layers = object.layers as Record<string, unknown>
    if (Object.keys(layers).length !== SEMANTIC_REVIEW_LAYERS.length || Object.keys(layers).some(name => !SEMANTIC_REVIEW_LAYERS.includes(name as typeof SEMANTIC_REVIEW_LAYERS[number]))) continue
    const verdicts = parseConstraintVerdicts(object.verdicts, context)
    if (!verdicts) continue
    if (context?.requiredConstraintIds?.length) {
      const covered = new Set(verdicts.map(row => row.constraintId))
      if (context.requiredConstraintIds.some(id => !covered.has(id))) continue
    }
    let invalid = false
    const normalizedLayers: Record<string, unknown> = {}
    const blocking: SemanticFinding[] = []
    const advisory: SemanticFinding[] = []
    for (const name of SEMANTIC_REVIEW_LAYERS) {
      const rawLayer = layers[name]
      if (!rawLayer || typeof rawLayer !== 'object' || Array.isArray(rawLayer)) { invalid = true; break }
      const layer = rawLayer as Record<string, unknown>
      if (!['pass', 'fail', 'not_applicable'].includes(String(layer.status))) { invalid = true; break }
      if (!Array.isArray(layer.evidence) || !layer.evidence.length) { invalid = true; break }
      const declared = parseSemanticFindings(layer.findings)
      if (!declared) { invalid = true; break }
      const declaredBlocking = declared.filter(finding => isBlockingSemanticRuleClass(finding.ruleClass))
      // A `fail` layer must name what failed, and a passing layer must not
      // carry a blocking finding. Advisory findings are legal on any status —
      // that is the whole point of the split. Both checks run against what the
      // reviewer DECLARED, before the host demotes anything: an unwitnessed
      // control-flow claim is still a contract violation if it was parked on a
      // passing layer.
      if (layer.status === 'fail' && !declaredBlocking.length) { invalid = true; break }
      if (layer.status !== 'fail' && declaredBlocking.length) { invalid = true; break }
      // Deferral is checked BEFORE the witness rule. Both demote to advisory,
      // but they give different reasons, and "a human deliberately postponed
      // this value" is the accurate one — reporting "you supplied no
      // counterexample" would send the next round chasing evidence for a
      // question nobody is asking yet.
      const findings = declared
        .map(finding => demoteDeferredFinding(finding, context?.deferredConstraintIds))
        .map(finding => demoteUnwitnessedFinding(finding, context?.graph))
      const layerBlocking = findings.filter(finding => isBlockingSemanticRuleClass(finding.ruleClass))
      blocking.push(...layerBlocking)
      advisory.push(...findings.filter(finding => !isBlockingSemanticRuleClass(finding.ruleClass)))
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
      // Every blocking finding on this layer may have been demoted. The layer
      // then describes only advisory observations, so `fail` would misreport a
      // graph the host is about to accept.
      const status = layer.status === 'fail' && !layerBlocking.length ? 'pass' : layer.status
      normalizedLayers[name] = { ...layer, status, findings }
    }
    if (invalid) continue
    return {
      schemaVersion: SEMANTIC_REVIEW_SCHEMA,
      accepted: blocking.length === 0,
      verdicts,
      layers: normalizedLayers,
      issues: blocking.map(formatSemanticFinding),
      advisories: advisory.map(formatSemanticFinding),
    } as unknown as LayeredSemanticReview
  }
  return null
}

/**
 * One row per hard constraint in scope.
 *
 * `satisfied` carries a pointer obligation on purpose: the cheapest way to
 * satisfy an enumeration requirement is to answer "fine" to everything, and a
 * pointer that must resolve in the real graph is the one cost a batch answer
 * cannot pay. `out_of_scope` has no such gate by design (it is the deliberately
 * lenient path), which is precisely why every use of it on a graph- or
 * reviewer-locus constraint is traced.
 */
function parseConstraintVerdicts(value: unknown, context?: SemanticReviewParseContext): ConstraintVerdictRow[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value)) return null
  const rows: ConstraintVerdictRow[] = []
  const seen = new Set<string>()
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const item = raw as Record<string, unknown>
    if (typeof item.constraintId !== 'string' || !item.constraintId.trim()) return null
    if (seen.has(item.constraintId)) return null
    seen.add(item.constraintId)
    const verdict = item.verdict
    if (verdict !== 'satisfied' && verdict !== 'violated' && verdict !== 'out_of_scope') return null
    const graphRefs = stringArray(item.graphRefs ?? [])
    if (!graphRefs) return null
    if (verdict === 'violated'
      && (typeof item.ruleClass !== 'string' || !SEMANTIC_RULE_CLASSES.includes(item.ruleClass as SemanticRuleClass))) return null
    if (verdict === 'out_of_scope' && (typeof item.justification !== 'string' || !item.justification.trim())) return null
    if (verdict === 'satisfied') {
      if (!graphRefs.length) return null
      if (context?.graph && !graphRefs.some(pointer => jsonPointerResolves(context.graph!, pointer))) return null
    }
    rows.push({
      constraintId: item.constraintId,
      verdict,
      graphRefs,
      ...(typeof item.ruleClass === 'string' ? { ruleClass: item.ruleClass as SemanticRuleClass } : {}),
      ...(typeof item.justification === 'string' ? { justification: item.justification } : {}),
    })
  }
  return rows
}

/**
 * Blocking control-flow claims need a witness; unwitnessed ones become
 * advisory rather than disappearing.
 *
 * These classes are where the reviewer must infer a truth table from prose, and
 * they produced rejections nobody could act on. A genuine unreachable terminal
 * or exceeded bound always has a concrete path; demanding it costs a real
 * finding nothing. The observation is preserved as `unwitnessed-control-flow`
 * so the pattern stays countable in the trace instead of vanishing.
 */
function demoteUnwitnessedFinding(finding: SemanticFinding, graph?: LoopGraphSpec): SemanticFinding {
  if (!requiresControlFlowWitness(finding.ruleClass)) return finding
  const reason = witnessDefect(finding.witness, graph)
  if (!reason) return finding
  return {
    ...finding,
    ruleClass: 'unwitnessed-control-flow',
    statement: `[原判 ${finding.ruleClass}，因缺少可核验反例降级为建议] ${finding.statement}（${reason}）`,
  }
}

function witnessDefect(witness: ControlFlowWitness | undefined, graph?: LoopGraphSpec): string | undefined {
  if (!witness) return '未提供反例：需要给出一组具体的 State 赋值与触发的 Transition 序列'
  // Without a graph the host cannot check the witness, so it takes the
  // reviewer's word rather than demoting on missing information of its own.
  if (!graph) return undefined
  const errors = validateControlFlowWitness(witness, graph)
  return errors.length ? `反例不成立：${errors.join('；')}` : undefined
}

/** Findings must name a known rule class; an unrecognized one is treated as a
 * malformed verdict rather than silently dropped, so a reviewer cannot evade
 * the blocking set by inventing a class name. */
function parseSemanticFindings(value: unknown): SemanticFinding[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value)) return null
  const findings: SemanticFinding[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const item = raw as Record<string, unknown>
    if (typeof item.ruleClass !== 'string' || !SEMANTIC_RULE_CLASSES.includes(item.ruleClass as SemanticRuleClass)) return null
    if (typeof item.statement !== 'string' || !item.statement.trim()) return null
    const sourceRefs = stringArray(item.sourceRefs ?? [])
    const designRefs = stringArray(item.designRefs ?? [])
    const graphRefs = stringArray(item.graphRefs ?? [])
    if (!sourceRefs || !designRefs || !graphRefs) return null
    const witness = parseControlFlowWitness(item.witness)
    if (witness === null) return null
    findings.push({
      ruleClass: item.ruleClass as SemanticRuleClass, statement: item.statement, sourceRefs, designRefs, graphRefs,
      ...(witness ? { witness } : {}),
    })
  }
  return findings
}

/** `undefined` means absent (legal — the host demotes instead); `null` means
 * malformed, which voids the verdict like any other schema breach. */
function parseControlFlowWitness(value: unknown): ControlFlowWitness | undefined | null {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) return null
  const item = value as Record<string, unknown>
  if (!item.state || typeof item.state !== 'object' || Array.isArray(item.state)) return null
  const path = stringArray(item.path)
  if (!path || !path.length) return null
  if (typeof item.outcome !== 'string' || !CONTROL_FLOW_WITNESS_OUTCOMES.includes(item.outcome as ControlFlowWitness['outcome'])) return null
  return {
    state: item.state as ControlFlowWitness['state'],
    path,
    outcome: item.outcome as ControlFlowWitness['outcome'],
  }
}

function jsonPointerResolves(root: unknown, pointer: string): boolean {
  if (pointer === '') return true
  if (!pointer.startsWith('/')) return false
  let value: unknown = root
  for (const raw of pointer.slice(1).split('/')) {
    const part = raw.replace(/~1/g, '/').replace(/~0/g, '~')
    if (!value || typeof value !== 'object') return false
    if (Array.isArray(value) && !/^\d+$/.test(part)) return false
    if (!(part in (value as Record<string, unknown>))) return false
    value = (value as Record<string, unknown>)[part]
  }
  return true
}

/** Shared with Intake, including the unescaped-quote repair: a model quoting a
 * document inside Chinese prose breaks the envelope the same way in every
 * phase, and here it silently costs an attempt. */
function structuredCandidates(output: unknown, summary?: string): unknown[] {
  return structuredJsonCandidates(output, summary)
}

function skippedSemanticReview(): LayeredSemanticReview {
  return {
    schemaVersion: SEMANTIC_REVIEW_SCHEMA,
    accepted: true,
    verdicts: [],
    layers: Object.fromEntries(SEMANTIC_REVIEW_LAYERS.map(layer => [layer, {
      status: 'not_applicable',
      evidence: [{ sourceRefs: [], designRefs: [], graphRefs: [], statement: 'Independent semantic review was explicitly disabled by the caller.' }],
      findings: [],
    }])) as unknown as LayeredSemanticReview['layers'],
    issues: [],
    advisories: [],
  }
}

/** A reviewer that never produced a valid verdict is not evidence that the
 * graph is sound, so synthesize a blocking finding rather than accepting. */
function rejectedSemanticReview(issue: string): LayeredSemanticReview {
  const review = skippedSemanticReview()
  // `skippedSemanticReview` states that review was disabled by the caller.
  // That is false here — it ran and failed — and the sentence lands verbatim in
  // loop.semantic-review.md, telling a reader the one thing that did not happen.
  for (const layer of SEMANTIC_REVIEW_LAYERS) {
    review.layers[layer].evidence = [{
      sourceRefs: [], designRefs: [], graphRefs: [],
      statement: 'Independent semantic review ran but returned no usable verdict; this layer was never adjudicated.',
    }]
  }
  const finding: SemanticFinding = {
    ruleClass: 'fabricated-capability', statement: issue, sourceRefs: [], designRefs: [], graphRefs: [],
  }
  review.accepted = false
  review.layers.capability_resolution = {
    status: 'fail',
    evidence: [{ sourceRefs: [], designRefs: [], graphRefs: [], statement: issue }],
    findings: [finding],
  }
  review.issues = [formatSemanticFinding(finding)]
  review.advisories = []
  return review
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every(item => typeof item === 'string') ? value as string[] : null
}

function abortReason(signal: AbortSignal): string {
  return signal.reason instanceof Error ? signal.reason.message : String(signal.reason ?? 'cancelled')
}

/** A fatal Distill error is the one message the user is guaranteed to read;
 * point it at the per-attempt evidence instead of ending the trail there. */
function traceHint(trace: DistillTraceStore | undefined): string {
  return trace ? `\nPer-attempt outputs, frozen graphs and reviewer verdicts: ${trace.dir}` : ''
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

