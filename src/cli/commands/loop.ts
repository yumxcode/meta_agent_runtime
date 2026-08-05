/**
 * cli/commands/loop — the durable graph runtime (`meta-agent loop …`).
 *
 * Compiles a natural-language requirement into a graph, runs the distill
 * session with its foreground reporter, and dispatches the loop subcommands.
 *
 * Extracted from cli/index.ts.
 */
import * as readline from 'node:readline'
import { createInterface } from 'node:readline'
import { resolve } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import {
  runLoopCli, runLoopScheduler, createDefaultGraphRuntimeCatalog, loadGraphCapabilityPacks,
  createGraphDistillTools,
  ForegroundGraphDistillExecutor, MetaAgentGraphAgentExecutor, reviseLoopGraph,
  readDistillArtifacts, writeDistillArtifacts, resolveIntakePickup,
  freezeLoopGraph, validateLoopGraph, lintLoopGraph, formatGraphLintFindings,
  type GraphDistillModelRequest, type GraphDistillPhase, type GraphDistillProgressEvent,
  type DistillGraphResult, type GraphRuntimeCatalog, type GraphProgressEvent, type LoopGraphSpec,
} from '../../loop/index.js'
import { SessionRouter } from '../../routing/SessionRouter.js'
import { createStandardTools } from '../../tools/index.js'
import { RuntimeEnv } from '../../infra/env/RuntimeEnv.js'
import { getModelProtocol, resolveProvider } from '../../providers/registry.js'
import { formatLocalClock, formatLocalTimestamp } from '../../loop/localTime.js'
import { bold, cyan, dim, gray, green, red, yellow, isTTY, terminalText } from '../term.js'
import { askQuestion } from '../prompts.js'
import { makeRouter } from '../router.js'
import { streamPrompt } from '../stream.js'
import { ensureMcpServerInstructions } from '../mcpInstructions.js'
import { assertApiKeyConfigured, resolveExplicitApiKey } from '../keys.js'
import { buildLoopCliOptions, type CliOptions } from '../args.js'
import { MetaAgentSession } from '../../core/MetaAgentSession.js'
import { SubAgentBridge } from '../../subagent/SubAgentBridge.js'
import { loadModelConfig } from '../../core/config/ConfigService.js'
import { sanitizeTerminalPreview } from '../terminalSanitizer.js'
import { referencesDistillTrace } from '../distillTraceGuard.js'
import type { MetaAgentConfig } from '../../core/config.js'
import { detectSensitiveOp, confirmToolCall } from '../guards.js'

// ── Loop runtime (v2, L2) ─────────────────────────────────────────────────────

/**
 * Dispatch `meta-agent loop <cmd>` and `meta-agent loop-scheduler`.
 *
 * Pure-code graph subcommands run directly. `tick`, `distill`, and the
 * scheduler may spawn Agent nodes, so they prewarm an `auto` backend
 * (unattended base = autonomy jail + workspace confinement for spawned seats)
 * and hand its SubAgentBridge to the loop runtime.
 */
export async function runLoopCommand(opts: CliOptions): Promise<void> {
  const { name, args: rawLoopArgs } = opts.loopCommand!
  const projectDir = resolve(opts.workspace ?? process.cwd())
  const graphOptions = extractRepeatedOption(rawLoopArgs, '--graph-pack')
  // `--json` is a global flag before the `loop` token, while the loop operator
  // commands also accept it locally. Forward the global form so both
  // `meta-agent --json loop inspect …` and `meta-agent loop inspect … --json`
  // have the same machine-readable contract.
  const args = opts.json && !graphOptions.args.includes('--json')
    ? [...graphOptions.args, '--json']
    : graphOptions.args
  const graphCatalog = createDefaultGraphRuntimeCatalog()
  if (graphOptions.plugins.length > 0) {
    await loadGraphCapabilityPacks({
      modulePaths: graphOptions.plugins.map(path => resolve(projectDir, path)),
      target: graphCatalog,
      registry: graphCatalog.packs,
      allowedRoots: [projectDir],
    })
  }
  // One concrete graph_agent capability set must govern the whole lifecycle.
  // Distill used to validate against the interactive Agentic toolset while
  // Create used DEFAULT_GRAPH_AGENT_TOOLS and Tick registered Auto tools. That
  // allowed a graph to be reported as validated and then rejected by the very
  // next `loop create` command. DEFAULT_GRAPH_AGENT_TOOLS is the single
  // canonical graph_agent catalog (docs, library default, tests); here we only
  // verify it against the tools the unattended runtime actually provides, so a
  // graph frozen by this CLI validates identically from every other entrypoint.
  // Session-only conveniences (sleep, todo_write, …) stay out of the catalog:
  // durable waiting belongs to wait nodes and agent timer hard-park.
  const graphAgentTools = await createStandardTools({
    system: { cwd: projectDir, mode: 'agentic', planModeRef: { active: false } },
    network: { webFetch: { maxResultSizeChars: 8_000 } },
    mode: 'auto',
  })
  const runtimeToolNames = new Set(graphAgentTools.map(tool => tool.name))
  const unavailableCatalogTools = [...graphCatalog.agentTools].filter(name => !runtimeToolNames.has(name))
  if (unavailableCatalogTools.length) {
    console.error(`warning: graph_agent catalog tools unavailable in this runtime were removed: ${unavailableCatalogTools.join(', ')}`)
    graphCatalog.agentTools = new Set([...graphCatalog.agentTools].filter(name => runtimeToolNames.has(name)))
  }
  const sub = args[0]
  // Intake runs on the same foreground executor as Distill: same tools, same
  // session plumbing, same reporter. Only the phase and the artifact differ.
  const isIntake = name === 'loop' && sub === 'intake'
  const isDistill = name === 'loop' && (sub === 'distill' || sub === 'distill-graph' || isIntake)
  const runLifecycle = (sub === 'resume' || sub === 'recover') && args.includes('--run')
  const needsGraphAgent = name === 'loop-scheduler' || sub === 'tick' || runLifecycle
  const modelConfig = loadModelConfig({ projectDir })
  const configuredProviderId = resolveProvider({
    apiKey: modelConfig.apiKey ?? opts.apiKey,
    baseURL: modelConfig.baseURL ?? opts.baseUrl,
    model: modelConfig.mainModel ?? opts.model,
  }).provider

  if (!isDistill && !needsGraphAgent) {
    // create / list / inspect / lifecycle — deterministic, no LLM.
    console.log(await runLoopCli(args, { projectDir, graphCatalog, providerId: configuredProviderId }))
    return
  }

  assertApiKeyConfigured(opts)
  const abort = new AbortController()
  process.once('SIGINT', () => abort.abort(new Error('process received SIGINT')))
  process.once('SIGTERM', () => abort.abort(new Error('process received SIGTERM')))

  if (isDistill) {
    const interactiveDistill = Boolean(process.stdin.isTTY && isTTY && !opts.json && !args.includes('--non-interactive'))
    const distillRl = interactiveDistill ? createInterface({ input: process.stdin, output: process.stdout }) : undefined
    const standardTools = await createStandardTools({
      system: { cwd: projectDir, mode: 'agentic', planModeRef: { active: false } },
      network: { webFetch: { maxResultSizeChars: 8_000 } },
      mode: 'agentic',
    })
    let validatedGraphThisCall: LoopGraphSpec | undefined
    const distillTools = createGraphDistillTools(graphCatalog, {
      onValidatedGraph: graph => { validatedGraphThisCall = graph },
    })
    const toolsByName = new Map([...standardTools, ...distillTools].map(tool => [tool.name, tool]))
    const reporter = createForegroundDistillReporter()
    const distillExecutor = new ForegroundGraphDistillExecutor({
      createSession: request => {
        const session = new MetaAgentSession(foregroundDistillConfig(opts, projectDir, request, distillRl))
        for (const toolName of request.allowedTools) {
          const tool = toolsByName.get(toolName)
          if (!tool) throw new Error(`foreground Distill tool '${toolName}' is unavailable`)
          session.registerTool(tool)
        }
        return session
      },
      runSession: async (session, request) => {
        validatedGraphThisCall = undefined
        const rendered = await streamPrompt({
          submit: prompt => session.submit(prompt),
          steer: text => session.steer(text),
          getEstimatedCost: () => session.getEstimatedCost(),
          mode: 'agentic',
        }, request.taskDescription, opts.json, opts.showThinking,
        undefined, undefined, false, true)
        // A phase that argued with itself until it was cut off produced no
        // envelope. Report it as a retryable failure with the reason, rather
        // than letting the caller puzzle over an empty result.
        if (rendered.degenerateLoop) return {
          status: 'failed', output: rendered.text || undefined,
          error: rendered.degenerateLoop, validatedGraph: validatedGraphThisCall,
        }
        if (request.signal.aborted) return {
          status: 'cancelled', output: rendered.text || undefined, error: 'Distill interrupted',
          validatedGraph: validatedGraphThisCall,
        }
        const terminal = rendered.result
        if (!terminal) return {
          status: 'failed', output: rendered.text || undefined,
          error: 'agentic Distill session ended without a terminal result', validatedGraph: validatedGraphThisCall,
        }
        const output = rendered.text.trim() || terminal.result
        return terminal.subtype === 'success' && !terminal.isError
          ? { status: 'completed', output, summary: terminal.result, validatedGraph: validatedGraphThisCall }
          : {
              status: 'failed', output: output || undefined,
              error: terminal.errors?.join('; ') || `agentic Distill session ended with ${terminal.subtype}`,
              validatedGraph: validatedGraphThisCall,
            }
      },
    })
    try {
      console.log(await runLoopCli(args, {
        projectDir,
        distillExecutor,
        signal: abort.signal,
        graphCatalog,
        onDistillProgress: reporter.onProgress,
        onDistillNotice: notice => console.log(`${dim('[distill]')} ${notice}`),
      }))
      // The follow-up revision loop reads the Distill artifacts, which an
      // Intake run never produces — it ends at loop.intake.json by design.
      if (interactiveDistill && distillRl && !isIntake) {
        await runDistillSession({
          args, projectDir, executor: distillExecutor, graphCatalog,
          signal: abort.signal, reporter, rl: distillRl,
        })
      }
    } finally {
      await distillExecutor.dispose()
      distillRl?.close()
    }
    return
  }

  await ensureMcpServerInstructions()
  const router = makeRouter(
    // Preserve loopCommand: makeRouter uses it to mark the durable Graph Kernel
    // as aggregate child-budget owner. Clearing it here silently reinstates the
    // auto session's default $10 bridge cap.
    { ...opts, mode: 'auto', modeExplicit: true, workspace: projectDir, prompt: null },
    undefined, undefined, undefined, undefined, undefined, undefined,
  )
  // Register the standard tool set into the backend so spawned Graph Agent
  // seats can resolve read_file/grep/glob/bash/etc. — without this
  // the bridge's tool registry is empty and every seat fails "No tools resolved".
  for (const tool of graphAgentTools) router.registerTool(tool)
  const stamp = (): string => formatLocalClock(Date.now())
  try {
    const warmed = await router.prewarmBackend()
    if (!warmed) throw new Error('could not create the loop backend (auto mode)')
    const dispatcher = SubAgentBridge.getBridge(router.getSessionId())
    if (!dispatcher) throw new Error('loop backend produced no sub-agent dispatcher')
    const providerConfig = router.getProviderConfig()
    const providerId = resolveProvider(providerConfig).provider
    const graphAgent = new MetaAgentGraphAgentExecutor(dispatcher, undefined, { providerId })
    const onGraphProgress = createGraphProgressReporter()

    if (name === 'loop-scheduler') {
      const schedulerNumber = (flag: string, fallback: number): number => {
        const index = args.indexOf(flag)
        if (index < 0) return fallback
        const value = Number(args[index + 1])
        if (!Number.isFinite(value) || value < 0) throw new Error(`${flag} requires a non-negative number`)
        return value
      }
      console.log(`${dim(`[loop ${stamp()}]`)} scheduler start (workspace ${projectDir})`)
      const result = await runLoopScheduler({
        graphAgent, projectDir, signal: abort.signal, graphCatalog, onGraphProgress,
        pollMs: schedulerNumber('--poll-ms', 2_000),
        idleExitMs: schedulerNumber('--idle-exit-ms', 60_000),
        maxConcurrentGraphs: schedulerNumber('--max-concurrent-graphs', 4),
        // Without onTick, per-wake errors from tickOnce (outcomes[].error) are
        // silently dropped in scheduler mode — `loop tick` prints them, so the
        // daemon must too, or spawn failures become invisible.
        onTick: tick => {
          for (const o of tick.outcomes) {
            if (o.error) console.log(`${dim(`[loop ${stamp()}]`)} ${red('✗')} ${o.loopId}: ${o.error}`)
          }
        },
      })
      console.log(`${dim(`[loop ${stamp()}]`)} scheduler exit (${result.exitReason}); ` +
        `${result.graphTicksRun} graph tick(s) over ${result.ticks} poll(s).`)
    } else {
      console.log(await runLoopCli(args, {
        projectDir,
        dispatcher,
        graphAgent,
        signal: abort.signal,
        graphCatalog,
        onGraphProgress,
        providerId,
      }))
    }
  } finally {
    await router.dispose().catch(() => undefined)
  }
}

function createGraphProgressReporter(): (event: GraphProgressEvent) => void {
  return event => {
    const time = formatLocalClock(event.at)
    const loopId = event.instanceId.length > 18 ? `${event.instanceId.slice(0, 15)}…` : event.instanceId
    const prefix = dim(`[${time}] [${loopId}/${event.nodeId} a${event.attempt}:s${event.segment}]`)
    const detail = (value: string): string => terminalText(value.replace(/\s+/g, ' ').trim().slice(0, 300))
    if (event.type === 'phase_started') {
      const verb = event.resumed ? '恢复' : '开始'
      const reason = event.resumeReason ? `；此前挂起原因：${detail(event.resumeReason)}` : ''
      console.log(`${prefix} ${cyan('▶')} ${verb}：${detail(event.phase)}${reason}`)
      return
    }
    if (event.type === 'phase_completed') {
      const usage = event.usage
        ? dim(`  turns=${event.usage.turns} cost=$${event.usage.costUsd.toFixed(4)}`)
        : ''
      const marker = event.outcome === 'failure' ? red('✗') : green('✓')
      console.log(`${prefix} ${marker} 结束（${detail(event.outcome)}）：${detail(event.summary)}${usage}`)
      return
    }
    if (event.type === 'phase_retrying') {
      const timing = event.wakeAt ? `；${formatLocalTimestamp(event.wakeAt)} 后重试` : '；等待重新调度'
      console.log(`${prefix} ${yellow('↻')} ${event.replay ? '重放' : '重试'}：${detail(event.reason)}${timing}`)
      return
    }
    if (event.type === 'phase_parked') {
      const target = event.wakeAt
        ? `至 ${formatLocalTimestamp(event.wakeAt)}`
        : event.eventName ? `等待事件 ${detail(event.eventName)}` : '等待恢复'
      console.log(`${prefix} ${yellow('⏸')} 挂起${target}：${detail(event.reason)}`)
      return
    }
    if (event.type === 'phase_blocked') {
      const usage = event.usage
        ? dim(`  turns=${event.usage.turns} cost=$${event.usage.costUsd.toFixed(4)}`)
        : ''
      console.log(`${prefix} ${yellow('⏸')} 基础设施阻塞，实例已暂停并保留重放点：${detail(event.reason)}${usage}`)
      return
    }
    console.log(`${prefix} ${red('✗')} 终止：${detail(event.reason)}`)
  }
}

async function runDistillSession(options: {
  args: string[]
  projectDir: string
  executor: ForegroundGraphDistillExecutor
  graphCatalog: GraphRuntimeCatalog
  signal: AbortSignal
  reporter: ReturnType<typeof createForegroundDistillReporter>
  rl: readline.Interface
}): Promise<void> {
  const requirementArg = distillRequirementArg(options.args)
  if (!requirementArg) throw new Error('interactive Distill lost the requirement document path')
  const outArg = loopOptionValue(options.args, '--out') ?? 'loop.graph.json'
  // The follow-up turns recompile from the Architect down, so they need the
  // same human-confirmed ledger the initial run used. Omitting it here let a
  // revision silently drop back to extraction mode and rewrite constraints the
  // person had already signed off on.
  const pickup = await resolveIntakePickup(options.projectDir, requirementArg, options.args.includes('--no-intake'))
  const source = {
    requirement: requirementArg, projectDir: options.projectDir,
    ...(pickup.record ? { intake: pickup.record } : {}),
  }
  let current: DistillGraphResult = await readDistillArtifacts(options.projectDir, outArg)
  const feedback: string[] = []
  console.log(`\n${bold(green('Distill session'))}`)
  printDistillDraft(current, outArg)
  console.log(dim('检查已生成文件；有问题就直接输入补充或纠正，当前 turn 验证通过后会覆盖草图；/show 查看摘要；/reload 载入手工编辑；/validate 重新校验；/exit 结束。'))
  while (!options.signal.aborted) {
    const line = await questionLine(options.rl, `${bold(cyan('distill'))} › `)
    if (line === null) break
    const input = line.trim()
    if (!input) continue
    if (input === '/quit' || input === '/exit') {
      console.log(`${dim(`Distill exited; current files remain on disk. Next: meta-agent loop create ${outArg}`)}`)
      return
    }
    if (input === '/show') {
      printDistillDraft(current, outArg)
      continue
    }
    if (input === '/reload') {
      try {
        current = await readDistillArtifacts(options.projectDir, outArg)
        console.log(`${green('✓')} Reloaded ${outArg} from disk.`)
        printDistillDraft(current, outArg)
      } catch (error) {
        console.log(`${red('✗')} Could not reload the draft: ${sanitizeTerminalPreview(error instanceof Error ? error.message : String(error), 300)}`)
      }
      continue
    }
    if (input === '/validate') {
      try {
        const errors = validateLoopGraph(current.graph, options.graphCatalog)
        if (errors.length) {
          console.log(`${yellow('⚠')} ${errors.length} validation issue(s):`)
          for (const error of errors) console.log(`  ${dim('·')} ${sanitizeTerminalPreview(error, 300)}`)
        } else {
          freezeLoopGraph(current.graph, options.graphCatalog, 0)
          console.log(`${green('✓')} Structural and Freeze validation passed.`)
          const lint = formatGraphLintFindings(lintLoopGraph(current.graph))
          if (lint.length) {
            console.log(`${yellow('⚠')} ${lint.length} lint finding(s) — Distill 会阻断这些，请修复后再 create:`)
            for (const finding of lint) console.log(`  ${dim('·')} ${sanitizeTerminalPreview(finding, 300)}`)
          }
        }
      } catch (error) {
        console.log(`${red('✗')} Freeze validation failed: ${sanitizeTerminalPreview(error instanceof Error ? error.message : String(error), 400)}`)
      }
      continue
    }

    console.log(`${dim('[distill]')} continuing the same compiler conversation…`)
    try {
      const nextFeedback = [...feedback, input]
      const revised = await reviseLoopGraph(source, current, nextFeedback.map((item, index) => `${index + 1}. ${item}`).join('\n'), {
        executor: options.executor,
        catalog: options.graphCatalog,
        signal: options.signal,
        onProgress: options.reporter.onProgress,
      })
      feedback.push(input)
      current = revised
      await writeDistillArtifacts(options.projectDir, outArg, revised)
      console.log(`${green('✓')} Updated ${outArg}, loop.design.md, and loop.semantic-review.md`)
      printDistillDraft(current, outArg)
    } catch (error) {
      console.log(`${red('✗')} Revision was not applied; current draft is unchanged.`)
      console.log(`  ${sanitizeTerminalPreview(error instanceof Error ? error.message : String(error), 500)}`)
    }
  }
}

function printDistillDraft(result: Pick<DistillGraphResult, 'graph' | 'taskSpec' | 'constraints' | 'semanticReview'>, out: string): void {
  const graph = result.graph
  const workspaceWrites = Object.values(graph.lanes).reduce((sum, lane) => sum + (lane.workspace.write?.length ?? 0), 0)
  console.log(`${bold('draft')} ${out}  graph=${graph.id}@v${graph.version}  constraints=${result.constraints.constraints.length}  nodes=${Object.keys(graph.nodes).length}  transitions=${graph.transitions.length}  lanes=${Object.keys(graph.lanes).length}  workspace-writes=${workspaceWrites}  review=${result.semanticReview.accepted ? 'accepted' : 'rejected'}`)
  // Advisory findings are recorded rather than blocking, so the draft summary
  // is the one place a human sees them without opening the review artifact.
  for (const advisory of result.semanticReview.advisories ?? []) console.log(`${yellow('advisory:')} ${sanitizeTerminalPreview(advisory, 300)}`)
  if (result.taskSpec.trim()) console.log(`${dim('compiler note:')}\n${result.taskSpec.trim()}`)
}

function distillRequirementArg(args: readonly string[]): string | undefined {
  for (let index = 1; index < args.length; index++) {
    const value = args[index]!
    if (value === '--out') { index++; continue }
    if (value === '--non-interactive') continue
    if (!value.startsWith('--')) return value
  }
  return undefined
}

function loopOptionValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

function questionLine(rl: readline.Interface, prompt: string): Promise<string | null> {
  return new Promise(resolveLine => {
    let settled = false
    const finish = (value: string | null): void => {
      if (settled) return
      settled = true
      rl.removeListener('close', onClose)
      resolveLine(value)
    }
    const onClose = (): void => finish(null)
    rl.once('close', onClose)
    rl.question(prompt, answer => finish(answer))
  })
}

function foregroundDistillConfig(
  opts: CliOptions,
  projectDir: string,
  request: GraphDistillModelRequest,
  rl?: readline.Interface,
): MetaAgentConfig {
  const allowed = new Set(request.allowedTools)
  const config: MetaAgentConfig = {
    projectDir,
    promptMode: 'agentic',
    externalPromptAssembly: true,
    skipMemoryRecall: true,
    systemPrompt: request.systemPrompt,
    maxTurns: request.maxTurns,
    maxBudgetUsd: opts.maxBudgetUsd ?? request.maxBudgetUsd,
    ...(request.thinkingBudgetTokens === undefined
      ? {}
      : { thinkingConfig: request.thinkingBudgetTokens === 0
          ? { type: 'disabled' as const }
          : { type: 'enabled' as const, budgetTokens: request.thinkingBudgetTokens } }),
    ...(request.maxOutputTokens === undefined ? {} : { maxTokens: request.maxOutputTokens }),
    // A structured compiler response must fit in its phase budget. Kernel's
    // normal 64k escalation/recovery would defeat that bound and can turn a
    // simple lowering into a many-minute runaway generation.
    recoverMaxOutputTokens: false,
    debugMode: opts.debug,
    beforeToolCall: async (toolName, input) => {
      if (!allowed.has(toolName)) {
        return { action: 'deny', reason: `foreground Distill does not allow tool '${toolName}'` }
      }
      // Architect and Reviewer hold read_file/grep/glob over the whole
      // workspace, and `.loop/distill/` now holds this run's own checkpoint and
      // per-attempt trace (glob's SKIP_DIRS does not cover it). Reading that is
      // never source material: it would let a phase anchor on an earlier
      // attempt's rejected graph or on a previous reviewer verdict — turning
      // the deliberately independent review into an accidental, non-repeatable
      // form of state. Host bookkeeping stays out of every phase's evidence.
      if (referencesDistillTrace(input)) {
        return { action: 'deny', reason: "'.loop/distill' holds this run's own Distill bookkeeping; it is not source evidence. Read the requirement entry and project files instead." }
      }
      return { action: 'allow' }
    },
  }
  if (rl && !opts.json && isTTY) {
    config.askUser = async (question: string, options?: string[], signal?: AbortSignal) => {
      const choices = options ?? []
      process.stdout.write(`\n${cyan('❓')}  ${bold('Distill 需要你的输入')}\n${terminalText(question)}\n`)
      try {
        if (choices.length > 0) {
          process.stdout.write(choices.map((choice, index) => `  ${green(String(index + 1))}. ${terminalText(choice)}`).join('\n') + '\n\n')
          const answer = await askQuestion(rl, `请选择 [1-${choices.length}] 或直接输入回答: `, signal)
          const selected = Number.parseInt(answer, 10)
          if (Number.isInteger(selected) && selected >= 1 && selected <= choices.length) return choices[selected - 1]!
          return answer
        }
        return await askQuestion(rl, '你的回答 > ', signal)
      } catch (error) {
        process.stdout.write(`${yellow('⚠')} 输入等待已取消（超时或中断），Distill 会把该问题记入 unresolved。\n`)
        throw error
      }
    }
  }
  const apiKey = resolveExplicitApiKey(opts)
  if (apiKey) config.apiKey = apiKey
  if (opts.baseUrl) config.baseURL = opts.baseUrl
  if (opts.model) config.model = opts.model
  if (opts.fallbackModel) config.fallbackModel = opts.fallbackModel
  return config
}

function createForegroundDistillReporter(): {
  onProgress(event: GraphDistillProgressEvent): void
} {
  const phaseLabel = (phase: GraphDistillPhase): string =>
    phase === 'intake' ? 'intake'
      : phase === 'architect' ? 'architect'
        : phase === 'compiler' ? 'compiler' : 'reviewer'
  return {
    onProgress(event): void {
      if (event.type === 'checkpoint_resumed') {
        console.log(`${green('✓')} ${dim('[distill]')} resumed validated Architect checkpoint`)
      } else if (event.type === 'phase_started') {
        const attempt = event.phase !== 'semantic_review' ? ` attempt ${event.attempt}/${event.maxAttempts}` : ''
        console.log(`${dim('[distill]')} ${phaseLabel(event.phase)}${attempt} started on agentic session`)
      } else if (event.type === 'phase_completed') {
        console.log(`${dim('[distill]')} ${phaseLabel(event.phase)} response received`)
      } else if (event.type === 'validation_passed') {
        console.log(`${green('✓')} ${dim('[distill]')} structural and Freeze validation passed`)
      } else if (event.type === 'validation_failed') {
        console.log(`${yellow('⚠')} ${dim('[distill]')} ${phaseLabel(event.phase)} output rejected with ${event.issues.length} issue(s)`)
        for (const issue of event.issues.slice(0, 8)) console.log(`  ${dim('·')} ${sanitizeTerminalPreview(issue, 240)}`)
      } else if (event.type === 'semantic_review_accepted') {
        console.log(`${green('✓')} ${dim('[distill]')} semantic review accepted`)
      } else {
        console.log(`${yellow('⚠')} ${dim('[distill]')} semantic review rejected`)
        for (const issue of event.issues.slice(0, 8)) console.log(`  ${dim('·')} ${sanitizeTerminalPreview(issue, 240)}`)
      }
    },
  }
}

function extractRepeatedOption(
  args: readonly string[],
  name: string,
): { args: string[]; plugins: string[] } {
  const kept: string[] = []
  const plugins: string[] = []
  for (let index = 0; index < args.length; index++) {
    if (args[index] !== name) {
      kept.push(args[index]!)
      continue
    }
    const value = args[++index]
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a module specifier`)
    plugins.push(value)
  }
  return { args: kept, plugins }
}

