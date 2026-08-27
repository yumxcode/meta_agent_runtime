import { createInterface } from 'node:readline'
import { parseArgs } from 'node:util'
import { loadModelConfig } from '../../core/config/ConfigService.js'
import { readTrajectoryPreservingUnknown } from '../../trajectory/reader.js'
import { trajectoryFile } from '../../trajectory/paths.js'
import {
  ACCEPTANCE_VERDICTS,
  KernelTaskCaseReviewer,
  ReviewerStore,
  listTaskCaseDescriptors,
  loadTaskCase,
  reduceTrajectoryLine,
  runTaskReviews,
  summariseAcceptance,
  type AcceptanceStatus,
  type AcceptanceVerdict,
  type LearningProposal,
  type TaskCase,
  type TaskReview,
  type TaskReviewerProgressEvent,
} from '../../reviewer/index.js'
import type { CliOptions } from '../args.js'
import { assertApiKeyConfigured } from '../keys.js'
import { askQuestion } from '../prompts.js'
import { bold, cyan, dim, green, red, yellow } from '../term.js'

type ProposalStatus = LearningProposal['status']

interface ParsedReviewerArgs {
  command: string
  positionals: string[]
  json: boolean
  all: boolean
  limit: number
  maxCases: number
  maxTurnsPerCase: number
  maxBudgetUsd: number
  force: boolean
  trajectory?: string
  since?: number
  status?: ProposalStatus
  note?: string
  reason?: string
}

export async function runReviewerCommand(opts: CliOptions): Promise<void> {
  const parsed = parseReviewerArgs(opts.loopCommand?.args ?? [], opts.json)
  const store = new ReviewerStore()
  switch (parsed.command) {
    case 'run': {
      assertApiKeyConfigured(opts)
      const file = loadModelConfig({ projectDir: opts.workspace })
      const reviewer = new KernelTaskCaseReviewer({
        apiKey: file.apiKey ?? opts.apiKey,
        baseURL: file.baseURL ?? opts.baseUrl,
        model: file.mainModel ?? opts.model,
        flashModel: file.flashModel,
        compactModel: file.compactModel,
        fallbackModel: file.fallbackModel,
        projectDir: opts.workspace,
        debugMode: opts.debug,
      })
      const result = await runTaskReviews({
        reviewer,
        scope: {
          all: parsed.all,
          ...(!parsed.all ? { limit: parsed.limit } : {}),
          ...(parsed.trajectory ? { trajectoryId: parsed.trajectory } : {}),
          ...(opts.workspace ? { workspace: opts.workspace } : {}),
          ...(parsed.since !== undefined ? { since: parsed.since } : {}),
          maxCases: parsed.maxCases,
          maxTurnsPerCase: parsed.maxTurnsPerCase,
          maxBudgetUsd: opts.maxBudgetUsd ?? parsed.maxBudgetUsd,
          force: parsed.force,
        },
        ...(!parsed.json ? { onProgress: printReviewerProgress } : {}),
      })
      if (parsed.json) console.log(JSON.stringify(result.manifest, null, 2))
      else {
        const stats = result.manifest.stats
        console.log(
          `${green('Reviewer 任务复盘完成')}：${stats.casesAnalyzed}/${stats.casesSelected} 个 TaskCase，` +
          `${stats.trajectoriesIncluded} 条轨迹，${stats.kernelTurns} 个 Kernel turn，` +
          `${stats.toolCalls} 次证据工具调用，${stats.proposalsGenerated} 条新提案。`,
        )
        console.log(dim(`本次成本 $${stats.costUsd.toFixed(4)}；生成 ${result.taskReviews.length} 份完整 TaskReview。`))
        if (stats.casesUnchanged > 0) console.log(dim(`增量跳过 ${stats.casesUnchanged} 个未变化 TaskCase。`))
        if (stats.proposalsDeduplicated > 0) console.log(dim(`去重 ${stats.proposalsDeduplicated} 条已有提案。`))
        if (stats.qualityRejections > 0) console.log(yellow(`${stats.qualityRejections} 条模型提案未通过质量门槛。`))
        if (stats.analysisErrors > 0) console.log(yellow(`${stats.analysisErrors} 个 TaskCase 分析失败，已记录在运行报告中。`))
        for (const review of result.taskReviews) {
          console.log(`${cyan(review.id)}  ${review.outcome.verdict}  ${review.task.goal.slice(0, 80)}`)
        }
        console.log(dim('当前仅生成 LearningProposal；人工批准前不会产生 ExperienceCandidate。'))
        console.log(`查看复盘列表：${cyan('meta-agent reviewer reports')}`)
        for (const review of result.taskReviews) {
          console.log(`查看完整复盘：${cyan(`meta-agent reviewer report ${review.id}`)}`)
        }
        if (stats.proposalsGenerated > 0) console.log(`审核高价值提案：${cyan('meta-agent reviewer review')}`)
      }
      return
    }
    case 'reports': {
      const reviews = (await store.listTaskReviews()).slice(0, parsed.limit)
      if (parsed.json) console.log(JSON.stringify({ taskReviews: reviews }, null, 2))
      else printTaskReviewList(reviews)
      return
    }
    case 'report': {
      const id = parsed.positionals[0]
      if (!id) throw new Error('reviewer report requires a TaskReview id')
      const review = await store.getTaskReview(id)
      if (!review) throw new Error(`unknown task review '${id}'`)
      if (parsed.json) console.log(JSON.stringify(review, null, 2))
      else printTaskReview(review)
      return
    }
    case 'list': {
      const proposals = (await store.listProposals(parsed.status)).slice(0, parsed.limit)
      if (parsed.json) console.log(JSON.stringify({ proposals }, null, 2))
      else printProposalList(proposals)
      return
    }
    case 'show': {
      const proposal = await requireProposal(store, requireProposalId(parsed))
      if (parsed.json) console.log(JSON.stringify(proposal, null, 2))
      else await printProposal(proposal, store)
      return
    }
    case 'review': {
      if (!process.stdin.isTTY || !process.stdout.isTTY || parsed.json) {
        throw new Error('reviewer review requires an interactive terminal; use reviewer approve/reject for explicit decisions')
      }
      const pending = (await store.listProposals('pending')).slice(0, parsed.limit)
      if (pending.length === 0) {
        console.log(dim('暂无待审核的 LearningProposal。'))
        return
      }
      const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
      let approved = 0
      let rejected = 0
      try {
        console.log(`${bold('任务复盘经验人工审核')} ${dim(`(${pending.length} 条)`)}\n`)
        for (const proposal of pending) {
          await printProposal(proposal, store)
          const answer = (await askQuestion(rl, '决定 [y=批准 / n=拒绝 / s=跳过 / q=退出]: ')).toLowerCase()
          if (answer === 'q' || answer === 'quit') break
          if (answer === 'y' || answer === 'yes') {
            const candidate = await store.approveProposal(proposal.id)
            approved++
            console.log(green(`✓ 已批准并生成 ${candidate.id}\n`))
          } else if (answer === 'n' || answer === 'no') {
            await store.rejectProposal(proposal.id)
            rejected++
            console.log(red('× 已拒绝；未生成 ExperienceCandidate。\n'))
          } else {
            console.log(dim('已跳过，提案仍为 pending。\n'))
          }
        }
      } finally {
        rl.close()
      }
      console.log(`审核结束：${approved} 条批准，${rejected} 条拒绝。`)
      return
    }
    case 'rate': {
      await runRateCommand(store, parsed)
      return
    }
    case 'ratings': {
      const statuses = await loadAcceptanceStatuses(store)
      if (parsed.json) {
        console.log(JSON.stringify({
          summary: summariseAcceptance(statuses),
          ratings: statuses,
        }, null, 2))
        return
      }
      const summary = summariseAcceptance(statuses)
      if (summary.rated === 0) {
        console.log(dim('尚无人工验收记录。运行 `meta-agent reviewer rate` 开始标注。'))
        return
      }
      console.log(`${bold('人工验收 (T3)')}  已标注 ${summary.rated} 条，可用作 ground truth ${summary.usable} 条`)
      for (const verdict of ACCEPTANCE_VERDICTS) {
        console.log(`  ${verdict.padEnd(24)}${summary.byVerdict[verdict]}`)
      }
      if (summary.stale > 0) {
        console.log(yellow(`  ${summary.stale} 条已过期：case 在标注后又有新内容，标签不再描述当前 case`))
      }
      return
    }
    case 'approve': {
      const candidate = await store.approveProposal(requireProposalId(parsed), parsed.note)
      if (parsed.json) console.log(JSON.stringify(candidate, null, 2))
      else console.log(green(`已批准；ExperienceCandidate: ${candidate.id}`))
      return
    }
    case 'reject': {
      const proposal = await store.rejectProposal(requireProposalId(parsed), parsed.reason ?? parsed.note)
      if (parsed.json) console.log(JSON.stringify(proposal, null, 2))
      else console.log(red(`已拒绝 ${proposal.id}；未生成 ExperienceCandidate。`))
      return
    }
    case 'candidates': {
      const candidates = (await store.listCandidates()).slice(0, parsed.limit)
      if (parsed.json) console.log(JSON.stringify({ candidates }, null, 2))
      else if (candidates.length === 0) console.log(dim('暂无人工批准的 ExperienceCandidate。'))
      else for (const item of candidates) {
        console.log(`${item.id}  ${item.category.padEnd(18)}  ${item.title}`)
      }
      return
    }
    default:
      throw new Error(reviewerUsage())
  }
}

function parseReviewerArgs(args: string[], inheritedJson: boolean): ParsedReviewerArgs {
  const parsed = parseArgs({
    args,
    options: {
      json: { type: 'boolean', short: 'j', default: false },
      all: { type: 'boolean', default: false },
      limit: { type: 'string', default: '20' },
      'max-cases': { type: 'string', default: '20' },
      'max-turns-per-case': { type: 'string', default: '12' },
      'max-budget-usd': { type: 'string', default: '5' },
      // Accepted during migration; it now caps TaskCases rather than side-call windows.
      'max-windows': { type: 'string' },
      force: { type: 'boolean', default: false },
      trajectory: { type: 'string' },
      since: { type: 'string' },
      status: { type: 'string' },
      note: { type: 'string' },
      reason: { type: 'string' },
    },
    strict: true,
    allowPositionals: true,
  })
  const [command = 'list', ...positionals] = parsed.positionals
  const limit = Number(parsed.values.limit)
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('--limit must be a positive integer')
  const maxCases = Number(parsed.values['max-windows'] ?? parsed.values['max-cases'])
  if (!Number.isSafeInteger(maxCases) || maxCases < 1) throw new Error('--max-cases must be a positive integer')
  const maxTurnsPerCase = Number(parsed.values['max-turns-per-case'])
  if (!Number.isSafeInteger(maxTurnsPerCase) || maxTurnsPerCase < 1) {
    throw new Error('--max-turns-per-case must be a positive integer')
  }
  const maxBudgetUsd = Number(parsed.values['max-budget-usd'])
  if (!Number.isFinite(maxBudgetUsd) || maxBudgetUsd <= 0) throw new Error('--max-budget-usd must be positive')
  const status = parseStatus(parsed.values.status)
  return {
    command,
    positionals,
    json: inheritedJson || parsed.values.json === true,
    all: parsed.values.all === true,
    limit,
    maxCases,
    maxTurnsPerCase,
    maxBudgetUsd,
    force: parsed.values.force === true,
    ...(parsed.values.trajectory ? { trajectory: parsed.values.trajectory } : {}),
    ...(parsed.values.since ? { since: parseSince(parsed.values.since) } : {}),
    ...(status ? { status } : {}),
    ...(parsed.values.note ? { note: parsed.values.note } : {}),
    ...(parsed.values.reason ? { reason: parsed.values.reason } : {}),
  }
}

function parseStatus(value: string | undefined): ProposalStatus | undefined {
  if (value === undefined) return undefined
  if (value === 'pending' || value === 'approved' || value === 'rejected') return value
  throw new Error("--status must be 'pending', 'approved', or 'rejected'")
}

function parseSince(value: string): number {
  const relative = /^(\d+)([hdw])$/i.exec(value)
  if (relative) {
    const amount = Number(relative[1])
    const unitMs = relative[2]!.toLowerCase() === 'h'
      ? 60 * 60 * 1_000
      : relative[2]!.toLowerCase() === 'd'
        ? 24 * 60 * 60 * 1_000
        : 7 * 24 * 60 * 60 * 1_000
    return Date.now() - amount * unitMs
  }
  if (/^\d{10,13}$/.test(value)) {
    const numeric = Number(value)
    return value.length === 10 ? numeric * 1_000 : numeric
  }
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) throw new Error('--since must be ISO date, epoch timestamp, or a duration such as 24h/7d/2w')
  return parsed
}

function requireProposalId(parsed: ParsedReviewerArgs): string {
  const id = parsed.positionals[0]
  if (!id) throw new Error(`reviewer ${parsed.command} requires a proposal id`)
  return id
}

async function requireProposal(store: ReviewerStore, id: string): Promise<LearningProposal> {
  const proposal = await store.getProposal(id)
  if (!proposal) throw new Error(`unknown learning proposal '${id}'`)
  return proposal
}

function printProposalList(proposals: readonly LearningProposal[]): void {
  if (proposals.length === 0) {
    console.log(dim('暂无 LearningProposal。'))
    return
  }
  for (const item of proposals) {
    console.log(`${item.id}  ${item.status.padEnd(8)}  ${item.experienceDraft.category.padEnd(18)}  ${item.experienceDraft.title}`)
  }
}

async function printProposal(proposal: LearningProposal, store?: ReviewerStore): Promise<void> {
  const draft = proposal.experienceDraft
  const moment = proposal.moment
  const taskReview = proposal.source.taskReviewId && store
    ? await store.getTaskReview(proposal.source.taskReviewId).catch(() => null)
    : null
  const finding = taskReview
    ? (taskReview.schemaVersion === 'task-review-2.0'
        ? taskReview.methodologyFindings
        : taskReview.findings).find(item => item.id === proposal.source.findingId)
    : undefined
  console.log(
    `\n${'─'.repeat(72)}\n` +
    `${bold(draft.title)} ${dim(`[${draft.category}]`)} ${statusText(proposal.status)}\n` +
    `${dim('提案:')} ${proposal.id}\n` +
    `${dim('触发:')} ${proposal.source.trigger} / ${proposal.source.trajectoryIds.join(', ')}\n` +
    (taskReview
      ? `${dim('任务判定:')} ${taskReview.outcome.verdict}；可靠性 ${taskReview.assessment.reliability.rating}；` +
        `稳定性 ${taskReview.assessment.stability.rating}；有效性 ${taskReview.assessment.effectiveness.rating}\n`
      : '') +
    (finding
      ? `${dim('重要性:')} ${finding.significance} / ${finding.category} — ${finding.expectedImpact}\n`
      : '') +
    `${dim('情境:')} ${draft.applicability.context}\n` +
    `${dim('线索:')} ${draft.applicability.cues.join('；')}\n` +
    `${dim('不适用:')} ${draft.applicability.excludes.join('；')}\n` +
    `${dim('建议变化:')} ${draft.policyDelta.recommendedAction}\n` +
    `${dim('作用机制:')} ${draft.mechanism}\n` +
    `${dim('验证:')} ${draft.verification.checks.join('；')}\n` +
    `${dim('当时动作:')} ${moment.action}\n` +
    `${dim('观察结果:')} ${moment.observedOutcome}\n` +
    (moment.feedback ? `${dim('反馈:')} ${moment.feedback}\n` : '') +
    (moment.correction ? `${dim('修正:')} ${moment.correction}\n` : ''),
  )
  console.log(dim('原始证据（已脱敏）:'))
  for (const preview of await loadEvidencePreviews(proposal)) console.log(`  ${preview}`)
  console.log(`${'─'.repeat(72)}\n`)
}

// ── Human acceptance (T3) ────────────────────────────────────────────────────

/** Single keystroke → verdict. `u` is offered as prominently as the rest. */
const VERDICT_KEYS: Record<string, AcceptanceVerdict> = {
  y: 'completed',
  c: 'completed_with_concerns',
  n: 'not_completed',
  u: 'unclear',
}

async function loadAcceptanceStatuses(store: ReviewerStore): Promise<AcceptanceStatus[]> {
  const recorded = await store.acceptance.list()
  if (recorded.length === 0) return []

  // Staleness is decided against the case as it stands now, so a label made on
  // a shorter case is not silently counted as describing the longer one.
  const descriptors = await listTaskCaseDescriptors({ all: true })
  const byCaseId = new Map(descriptors.map(descriptor => [descriptor.caseId, descriptor]))

  const statuses: AcceptanceStatus[] = []
  for (const acceptance of recorded) {
    const descriptor = byCaseId.get(acceptance.caseId)
    if (!descriptor) {
      // The trajectory is gone. The judgement stood at the time, but nothing
      // can confirm it still applies.
      statuses.push({ acceptance, stale: true })
      continue
    }
    const loaded = await loadTaskCase(descriptor)
    const current = 'inputHash' in loaded ? loaded.inputHash : undefined
    statuses.push({ acceptance, stale: current === undefined || current !== acceptance.ratedInputHash })
  }
  return statuses
}

/**
 * Walk unrated TaskCases and record one coarse verdict each.
 *
 * Deliberately shows only what the rater needs to answer "did this do what I
 * asked?" — the task summary and how each run ended. Showing the full
 * trajectory would invite them to reconstruct criteria from what happened,
 * which is the retrospective-fitting failure this label exists to avoid.
 */
async function runRateCommand(store: ReviewerStore, parsed: ParsedReviewerArgs): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || parsed.json) {
    throw new Error('reviewer rate requires an interactive terminal')
  }

  const rated = await store.acceptance.ratedCaseIds()
  const descriptors = (await listTaskCaseDescriptors({ all: parsed.all, limit: parsed.limit }))
    .filter(descriptor => parsed.force || !rated.has(descriptor.caseId))

  if (descriptors.length === 0) {
    console.log(dim(rated.size > 0
      ? '所有 TaskCase 均已标注。加 --force 可重新标注。'
      : '没有可标注的 TaskCase。'))
    return
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
  let recorded = 0
  try {
    console.log(`${bold('人工验收标注')} ${dim(`(${descriptors.length} 条待标注)`)}`)
    console.log(dim('只需回答「这件事有没有按我的要求做完」。判断不了就选 u —— 猜测会污染 ground truth。\n'))

    for (const descriptor of descriptors) {
      const loaded = await loadTaskCase(descriptor)
      if (!('inputHash' in loaded)) {
        console.log(dim(`跳过 ${descriptor.caseId}：${loaded.reason}\n`))
        continue
      }

      printCaseForRating(loaded)
      const answer = (await askQuestion(rl,
        '判定 [y=完成 / c=完成但有保留 / n=未完成 / u=说不好 / s=跳过 / q=退出]: ')).trim().toLowerCase()
      if (answer === 'q') break
      if (answer === 's' || answer === '') {
        console.log(dim('已跳过。\n'))
        continue
      }
      const verdict = VERDICT_KEYS[answer]
      if (!verdict) {
        console.log(yellow('无法识别的输入，已跳过。\n'))
        continue
      }

      const note = verdict === 'completed_with_concerns' || verdict === 'not_completed'
        ? (await askQuestion(rl, '备注（可留空）: ')).trim()
        : ''

      await store.acceptance.record({
        schemaVersion: 'human-acceptance-1.0',
        caseId: loaded.id,
        rootTrajectoryId: loaded.rootTrajectoryId,
        verdict,
        ratedInputHash: loaded.inputHash,
        ratedAt: Date.now(),
        ...(note ? { note } : {}),
        agentClaimedSuccess: caseClaimedSuccess(loaded),
      })
      recorded += 1
      console.log(green(`✓ 已记录 ${verdict}\n`))
    }
  } finally {
    rl.close()
  }
  console.log(`标注结束：本次记录 ${recorded} 条。`)
}

function printCaseForRating(taskCase: TaskCase): void {
  console.log(`${cyan(taskCase.id)}  ${dim(new Date(taskCase.lastActivity).toISOString())}`)
  console.log(`  ${bold('任务')}: ${taskCase.taskSummary.slice(0, 400)}`)
  console.log(`  ${dim('规模')}: ${taskCase.metrics.runs} runs · ${taskCase.metrics.toolCalls} 工具调用 · ` +
    `${taskCase.metrics.toolErrors} 错误 · $${taskCase.metrics.totalCostUsd.toFixed(2)}`)
  const outcomes = taskCase.members
    .flatMap(member => member.entry.lastOutcome ? [member.entry.lastOutcome] : [])
  if (outcomes.length > 0) console.log(`  ${dim('结束状态')}: ${outcomes.join(', ')}`)
}

/**
 * Whether the agent itself claimed the task finished.
 *
 * This is `executor_self_report`, T0 — recorded here only so the human verdict
 * has something to be compared against when false-success is computed.
 */
function caseClaimedSuccess(taskCase: TaskCase): boolean {
  return taskCase.members.some(member => member.entry.lastOutcome === 'success')
}

function printTaskReviewList(reviews: readonly TaskReview[]): void {
  if (reviews.length === 0) {
    console.log(dim('暂无 TaskReview。'))
    return
  }
  for (const review of reviews) {
    const audit = review.schemaVersion === 'task-review-2.0'
      ? [
          review.processAudit.pathQuality.verdict,
          review.processAudit.successCriteriaQuality.verdict,
          review.processAudit.completionIntegrity.verdict,
          review.processAudit.longHorizonControl.verdict,
        ].join('/')
      : [
          review.assessment.effectiveness.rating,
          review.assessment.reliability.rating,
          review.assessment.stability.rating,
          review.assessment.efficiency.rating,
        ].join('/')
    console.log(`${review.id}  ${review.outcome.verdict.padEnd(7)}  ${audit}  ${review.task.goal.slice(0, 90)}`)
  }
}

function printTaskReview(review: TaskReview): void {
  console.log(`\n${bold(review.task.goal)}\n`)
  console.log(`${dim('TaskReview:')} ${review.id}`)
  console.log(`${dim('TaskCase:')} ${review.caseId} / ${review.trajectoryIds.length} trajectories`)
  console.log(`${dim('结果:')} ${review.outcome.verdict} — ${review.outcome.summary}`)
  console.log(
    `${dim('评估:')} effectiveness=${review.assessment.effectiveness.rating}, ` +
    `reliability=${review.assessment.reliability.rating}, stability=${review.assessment.stability.rating}, ` +
    `efficiency=${review.assessment.efficiency.rating}`,
  )
  console.log(`\n${bold('成功标准')}`)
  for (const criterion of review.outcome.criteria) {
    console.log(`- [${criterion.status}] ${criterion.criterion}：${criterion.rationale}`)
  }
  if (review.schemaVersion === 'task-review-2.0') {
    const audit = review.processAudit
    console.log(`\n${bold('实际解决路径')}`)
    console.log(audit.solutionPath.summary)
    for (const [index, phase] of audit.solutionPath.phases.entries()) {
      console.log(`${index + 1}. ${phase.phase}：${phase.strategy}`)
      console.log(`   目标：${phase.objective}`)
      console.log(`   结果：${phase.outcome}`)
    }

    console.log(`\n${bold('过程审计')}`)
    printAuditLine('路径质量', audit.pathQuality.verdict, audit.pathQuality.rationale)
    printStringItems('更优路径', audit.pathQuality.betterPath)
    printAuditLine('指标设定', audit.successCriteriaQuality.verdict, audit.successCriteriaQuality.rationale)
    printStringItems('缺失指标', audit.successCriteriaQuality.missingCriteria)
    printStringItems('误导指标', audit.successCriteriaQuality.misleadingCriteria)
    printAuditLine('完成诚信', audit.completionIntegrity.verdict, audit.completionIntegrity.rationale)
    printStringItems('无证据声明', audit.completionIntegrity.unsupportedClaims)
    printStringItems('未解决事项', audit.completionIntegrity.unresolvedIssues)
    printAuditLine('信息充分性', audit.informationAdequacy.verdict, audit.informationAdequacy.rationale)
    printStringItems('未向 Agent 提供', audit.informationAdequacy.notAvailableToAgent)
    printStringItems('可获取但未主动查找', audit.informationAdequacy.availableButNotSought)
    printStringItems('Reviewer 盲区', audit.informationAdequacy.reviewerVisibilityGaps)
    printAuditLine('长周期控制', audit.longHorizonControl.verdict, audit.longHorizonControl.rationale)
    printStringItems('连续性机制', audit.longHorizonControl.continuityMechanisms)
    for (const issue of audit.longHorizonControl.issues) {
      console.log(`  - ${issue.type} [${issue.status}]：${issue.summary}`)
    }

    console.log(`\n${bold('方法论 Finding')}`)
    if (review.methodologyFindings.length === 0) console.log(dim('无。'))
    for (const finding of review.methodologyFindings) {
      console.log(`- [${finding.significance}/${finding.category}/${finding.abstractionLevel}] ${finding.summary}`)
      console.log(`  机制：${finding.mechanism}`)
      console.log(`  建议：${finding.recommendation}`)
    }
  } else {
    console.log(`\n${bold('旧版关键 Finding')}`)
    if (review.findings.length === 0) console.log(dim('无。'))
    for (const finding of review.findings) {
      console.log(`- [${finding.significance}/${finding.category}] ${finding.summary}`)
      console.log(`  建议：${finding.recommendation}`)
    }
  }
  console.log(`\n${dim(`关联 LearningProposal: ${review.proposalIds.length ? review.proposalIds.join(', ') : '无'}`)}\n`)
}

function printAuditLine(label: string, verdict: string, rationale: string): void {
  console.log(`- ${label} [${verdict}]：${rationale}`)
}

function printStringItems(label: string, items: readonly string[]): void {
  if (items.length > 0) console.log(`  ${label}：${items.join('；')}`)
}

async function loadEvidencePreviews(proposal: LearningProposal): Promise<string[]> {
  const byTrajectory = new Map<string, Awaited<ReturnType<typeof readTrajectoryPreservingUnknown>>>()
  const previews: string[] = []
  for (const ref of proposal.moment.evidence) {
    let lines = byTrajectory.get(ref.trajectoryId)
    if (!lines) {
      try {
        lines = await readTrajectoryPreservingUnknown(trajectoryFile(ref.trajectoryId))
        byTrajectory.set(ref.trajectoryId, lines)
      } catch (error) {
        previews.push(`#${ref.ordinal}:${ref.role} [unavailable: ${error instanceof Error ? error.message : String(error)}]`)
        continue
      }
    }
    const line = lines.find(item => item.ordinal === ref.ordinal)
    if (!line) {
      previews.push(`#${ref.ordinal}:${ref.role} [missing]`)
      continue
    }
    const reduced = reduceTrajectoryLine(line)
    previews.push(`#${ref.ordinal}:${ref.role} [${reduced.itemType}] ${reduced.text}`)
  }
  return previews
}

function statusText(status: ProposalStatus): string {
  if (status === 'approved') return green('[approved]')
  if (status === 'rejected') return red('[rejected]')
  return yellow('[pending]')
}

function reviewerUsage(): string {
  return [
    'Usage:',
    '  meta-agent reviewer run [--all|--limit N] [--trajectory ID] [--since 7d]',
    '    [--max-cases N] [--max-turns-per-case N] [--max-budget-usd N] [--force]',
    '    --force: reanalyze completed TaskCases only when they have no LearningProposal',
    '  meta-agent reviewer reports [--limit N] [--json]',
    '  meta-agent reviewer report <taskReviewId> [--json]',
    '  meta-agent reviewer list [--status pending|approved|rejected] [--limit N] [--json]',
    '  meta-agent reviewer show <proposalId> [--json]',
    '  meta-agent reviewer review [--limit N]',
    '  meta-agent reviewer approve <proposalId> [--note text]',
    '  meta-agent reviewer reject <proposalId> [--reason text]',
    '  meta-agent reviewer candidates [--limit N] [--json]',
    '  meta-agent reviewer rate [--all] [--limit N] [--force]',
    '    label whether each task was actually completed (human acceptance, T3)',
    '  meta-agent reviewer ratings [--json]',
  ].join('\n')
}

function printReviewerProgress(event: TaskReviewerProgressEvent): void {
  if (event.phase === 'start') {
    process.stderr.write(
      `[reviewer] ${event.cases} TaskCases / ${event.trajectories} trajectories; ` +
      `case budget ${event.maxCases}; USD budget $${event.maxBudgetUsd.toFixed(2)}\n`,
    )
  } else if (event.phase === 'case') {
    process.stderr.write(`[reviewer] case ${event.index}/${event.total} ${event.caseId} (${event.trajectories} trajectories)\n`)
  } else if (event.phase === 'recovery') {
    process.stderr.write(`[reviewer] recovered prior analysis ${event.sourceRunId} (${event.caseId})\n`)
  } else if (event.phase === 'session') {
    process.stderr.write(`[reviewer] Kernel ReviewerSession ${event.session}/${event.maxCases} for ${event.caseId}\n`)
  } else if (event.event.type === 'tool_call') {
    process.stderr.write(`[reviewer] evidence tool ${event.event.toolName ?? 'unknown'} (${event.caseId})\n`)
  } else if (event.event.type === 'compact') {
    process.stderr.write(`[reviewer] compacting analysis context (${event.caseId})\n`)
  } else {
    process.stderr.write(`[reviewer] API retry ${event.event.attempt ?? '?'} (${event.caseId})\n`)
  }
}
