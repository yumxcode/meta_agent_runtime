/**
 * cli/commands/team — the robotics multi-unit team board.
 *
 * Rendering of the board / log / goals views, the planner side-call, the entry
 * guide, and the `/team …` subcommand dispatcher.
 *
 * Extracted from cli/index.ts.
 */
import * as readline from 'node:readline'
import { SessionRouter } from '../../routing/SessionRouter.js'
import {
  TEAM_PLANNER_SYSTEM,
  buildTeamPlannerUserMessage,
  parseTeamPlannerPlan,
  type TeamPlannerPlan,
  type TeamPlannerSnapshot,
} from '../../robotics/team/TeamPlanner.js'
import type { TeamWatcherEvent } from '../../robotics/team/TeamWatcher.js'
import type { TeamState, TeamTask, TeamTaskKind } from '../../robotics/team/TeamStore.js'
import { isStaleClaim } from '../../robotics/team/TeamStore.js'
import { executePlan } from '../teamPlannerExecutor.js'
import { getModelProtocol } from '../../providers/registry.js'
import { formatLocalTimestamp } from '../../loop/localTime.js'
import { bold, cyan, dim, gray, green, red, yellow, isTTY, terminalText } from '../term.js'
import { askQuestion } from '../prompts.js'
import type { CliOptions } from '../args.js'

export type TeamCliController = NonNullable<ReturnType<SessionRouter['getRoboticsTeamController']>>

// ── Robotics team mode CLI ───────────────────────────────────────────────────


function relAgo(iso?: string): string {
  if (!iso) return ''
  const ms = Date.now() - Date.parse(iso)
  if (Number.isNaN(ms) || ms < 0) return ''
  const m = Math.floor(ms / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export function formatTeamState(state: TeamState | null | undefined): string {
  if (!state) return `\n${dim('Team mode 尚未初始化。使用 /team init 创建模板。')}\n`

  const owned = state.tasks.filter(t => t.ownerUnit && t.status !== 'done')
  const paused = state.tasks.filter(t => t.status === 'paused')
  const open = state.tasks.filter(t => !t.ownerUnit && t.status === 'open')
  const done = state.tasks.filter(t => t.status === 'done')

  const lines: string[] = ['', bold('Team Mode (v2.0 — 协作日志)')]
  lines.push(state.github ? `${dim('GitHub:')} ${cyan(terminalText(state.github))}` : `${dim('GitHub:')} ${dim('(not set)')}`)
  lines.push(`${dim('Updated:')} ${terminalText(state.updatedAt)}`)
  lines.push('')

  lines.push(bold('Goals'))
  if (state.goals.length === 0) lines.push(`  ${dim('none')}`)
  else state.goals.forEach(g => lines.push(`  - ${terminalText(g)}`))
  lines.push('')

  lines.push(bold('进行中（锁定）'))
  if (owned.length === 0) {
    lines.push(`  ${dim('none')}`)
  } else {
    for (const t of owned) {
      const stale = isStaleClaim(t)
      const marker = stale ? yellow('⚠') : '🔒'
      const claim = t.claimedAt ? ` ${dim(`claimed ${relAgo(t.claimedAt)}`)}` : ''
      lines.push(`  ${marker} ${cyan(terminalText(t.id))} ${terminalText(t.title)} · ${terminalText(t.ownerUnit)}${claim} · ${dim(`${t.attempts.length} attempts`)}`)
    }
  }
  lines.push('')

  if (paused.length > 0) {
    lines.push(bold('暂停'))
    for (const t of paused) {
      const owner = t.ownerUnit ? ` · ${terminalText(t.ownerUnit)}` : ''
      lines.push(`  - ${cyan(terminalText(t.id))} ${terminalText(t.title)}${owner} · ${dim(`${t.attempts.length} attempts`)}`)
    }
    lines.push('')
  }

  lines.push(bold('待领'))
  if (open.length === 0) lines.push(`  ${dim('none')}`)
  else open.forEach(t => lines.push(`  - ${cyan(terminalText(t.id))} ${terminalText(t.title)}`))
  lines.push('')

  if (done.length > 0) {
    lines.push(bold('已完成'))
    for (const t of done.slice(-5)) {
      lines.push(`  - ${dim(terminalText(t.id))} ${dim(terminalText(t.title))} ${dim(`(${t.attempts.length} attempts)`)}`)
    }
    lines.push('')
  }

  if (state.units.length > 0) {
    lines.push(bold('Units'))
    for (const u of state.units) {
      const cur = u.currentTask ? ` task=${terminalText(u.currentTask)}` : ''
      lines.push(`  - ${cyan(terminalText(u.id))} ${dim(terminalText(u.status))} last=${relAgo(u.lastSeen)}${cur}`)
    }
    lines.push('')
  }

  return `${lines.join('\n')}\n`
}

export function formatTeamLog(state: TeamState | null | undefined, limit = 8): string {
  if (!state) return ''
  type Row = { at: string; taskId: string; title: string; unit: string; direction: string; outcome: string; ref?: string }
  const rows: Row[] = []
  for (const t of state.tasks) {
    for (const a of t.attempts) rows.push({ at: a.at, taskId: t.id, title: t.title, unit: a.unit, direction: a.direction, outcome: a.outcome, ref: a.ref })
  }
  rows.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
  if (rows.length === 0) return `${bold('Recent attempts')}\n  ${dim('none — 使用 /team note 追加')}\n`
  const lines: string[] = [bold(`Recent attempts (latest ${Math.min(limit, rows.length)})`)]
  for (const r of rows.slice(0, limit)) {
    lines.push(`  - ${dim(relAgo(r.at))} ${cyan(terminalText(r.taskId))} ${terminalText(r.unit)}`)
    lines.push(`      ${dim('方向:')} ${terminalText(r.direction)}`)
    lines.push(`      ${dim('结果:')} ${terminalText(r.outcome)}`)
    if (r.ref) lines.push(`      ${dim('ref:')} ${terminalText(r.ref)}`)
  }
  return `${lines.join('\n')}\n`
}

export function formatTeamWatcherEvents(events: TeamWatcherEvent[] | undefined): string {
  if (!events || events.length === 0) return ''
  const lines = ['', bold('Watcher'), ...events.slice(-5).map(e => `  - ${dim(terminalText(e.at))} ${terminalText(e.message)}`), '']
  return `${lines.join('\n')}\n`
}

export function teamEventKey(event: TeamWatcherEvent): string {
  return `${event.at}|${event.message}`
}

async function buildTeamPlannerSnapshot(controller: TeamCliController): Promise<TeamPlannerSnapshot> {
  const state = await controller.teamStatus?.().catch(() => null) ?? null
  const recentAttempts: unknown[] = []
  if (state) {
    type R = { at: string; taskId: string; unit: string; direction: string; outcome: string; ref?: string }
    const rows: R[] = []
    for (const t of state.tasks) {
      for (const a of t.attempts) rows.push({ at: a.at, taskId: t.id, unit: a.unit, direction: a.direction, outcome: a.outcome, ref: a.ref })
    }
    rows.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    recentAttempts.push(...rows.slice(0, 12))
  }
  return {
    state,
    recentAttempts,
    events: controller.teamWatcherEvents?.() ?? [],
  }
}

async function callTeamPlanner(router: SessionRouter, input: string, snapshot: TeamPlannerSnapshot): Promise<TeamPlannerPlan | null> {
  try {
    const { apiKey, baseURL, flashModel } = router.getProviderConfig()
    if (!apiKey) return null

    if (getModelProtocol(flashModel, baseURL) === 'openai') {
      const OpenAI = (await import('openai')).default
      const client = new OpenAI({ apiKey, baseURL: baseURL ?? 'https://api.deepseek.com', maxRetries: 1, timeout: 30_000 })
      const message = await client.chat.completions.create({
        model:      flashModel,
        max_tokens: 900,
        messages: [
          { role: 'system', content: TEAM_PLANNER_SYSTEM },
          { role: 'user', content: buildTeamPlannerUserMessage(input, snapshot) },
        ],
      })
      return parseTeamPlannerPlan(message.choices[0]?.message?.content ?? '')
    }

    let client = router.getSideCallClient()
    if (!client) {
      client = new (await import('@anthropic-ai/sdk')).default({
        apiKey,
        baseURL,
        timeout:    30_000,
        maxRetries: 1,
      })
    }

    const message = await client.messages.create({
      model:      flashModel,
      max_tokens: 900,
      system:     TEAM_PLANNER_SYSTEM,
      messages:   [{ role: 'user', content: buildTeamPlannerUserMessage(input, snapshot) }],
    })
    const text = message.content
      .map(block => block.type === 'text' ? block.text : '')
      .join('')
      .trim()
    return parseTeamPlannerPlan(text)
  } catch {
    // Side-call failure (network error, rate limit, SDK init error) must never
    // crash the REPL — return null so the caller falls back to no-plan mode.
    return null
  }
}

export async function runTeamEntryGuide(
  router: SessionRouter,
  opts: CliOptions,
  rl: readline.Interface,
  setInteractiveActive?: (v: boolean) => void,
): Promise<void> {
  const controller = await getTeamController(router, opts)
  if (!controller) return

  // Block team-reminder stdout output while we're in an interactive prompt chain.
  // Without this guard the 45-second timer fires mid-readline and garbles the input line.
  setInteractiveActive?.(true)
  try {
    await _runTeamEntryGuideInner(controller, router, opts, rl)
  } finally {
    setInteractiveActive?.(false)
  }
}

async function _runTeamEntryGuideInner(
  controller: TeamCliController,
  router: SessionRouter,
  _opts: CliOptions,
  rl: readline.Interface,
): Promise<void> {
  // Initialise / join — no path-based guidance, just basic onboarding.
  let state: TeamState | null | undefined = await controller.teamStatus?.()
  if (!state) {
    const answer = await askQuestion(rl, `尚未初始化 team/ 模板。现在初始化并加入？[Y/n] `)
    if (/^(n|no|否)$/i.test(answer.trim())) return
    try {
      state = await controller.teamJoin?.()
    } catch (err) {
      // GitHub is the team SSOT — when origin isn't a GitHub remote we must
      // ask for the repo URL explicitly before any team state is created.
      if ((err as Error)?.name !== 'TeamGithubRequiredError') throw err
      console.log(yellow('\nteam 模式以 GitHub 仓库为唯一事实源（未能从 origin 自动检测到 GitHub 地址）。'))
      const url = (await askQuestion(rl, `请输入 GitHub 仓库地址（如 https://github.com/org/repo，回车取消）: `)).trim()
      if (!url) { console.log(dim('已取消 team 初始化。')); return }
      state = await controller.teamJoin?.(url)
    }
    console.log(green('\n✓ team 已初始化并加入。'))
    // Entry guide already holds setInteractiveActive — don't toggle it here.
    await offerTeamPush(controller, _opts, rl, undefined)
  } else {
    // unitId is exposed via controller indirectly; for simplicity treat absence
    // as "not joined" only when there are zero units (otherwise the watcher's
    // sync will refresh presence on the next tick anyway).
    if (state.units.length === 0) {
      const answer = await askQuestion(rl, `当前还没有 unit。现在加入？[Y/n] `)
      if (!/^(n|no|否)$/i.test(answer.trim())) {
        state = await controller.teamJoin?.(state.github)
        console.log(green('\n✓ 已加入 team。'))
        await offerTeamPush(controller, _opts, rl, undefined)
      }
    }
  }

  // Refresh remote state first (fetch bounded by the 10-min cooldown) so the
  // board reflects teammates' latest takes/notes before we display it.
  await controller.teamWatcherPoll?.().catch(() => undefined)
  state = await controller.teamStatus?.() ?? state

  // Show the board + recent attempts — the primary collaboration view.
  console.log(formatTeamState(state))
  console.log(formatTeamLog(state))

  // Ask the planner for natural-language guidance.  Any concrete actions it
  // proposes go through executePlan() which prompts for confirmation.
  const snapshot = await buildTeamPlannerSnapshot(controller)
  const plan = await callTeamPlanner(
    router,
    '用户输入 /team，进入协作入口。请只给出当前可做之事的简短中文建议（30 字内），可选地提议读取类动作；任何修改 team 状态的动作必须 requiresConfirmation=true。',
    snapshot,
  )
  if (plan?.guidance || plan?.summary) {
    console.log(`\n${bold('Team Guide')}`)
    if (plan.summary) console.log(`${dim('判断:')} ${terminalText(plan.summary)}`)
    if (plan.guidance) console.log(`${dim('建议:')} ${terminalText(plan.guidance)}`)
  }
  if (plan?.risk === 'blocked') {
    console.log(red(`\n⚠ Planner 判断存在阻塞，已跳过任何写入建议。`))
  } else if (plan && plan.actions.length > 0) {
    await executePlan(controller, plan, q => askQuestion(rl, q), {
      onAction: (action, status, detail) => {
        const tag = status === 'done' ? green('✓') : status === 'failed' ? red('✗') : status === 'skipped' ? yellow('-') : dim('→')
        const note = detail ? ` ${dim(terminalText(detail))}` : ''
        console.log(`  ${tag} ${terminalText(action.type)}${action.taskId ? ` ${cyan(terminalText(action.taskId))}` : ''}${note}`)
      },
    })
  }

  // Optional context boundary if there's prior conversation in this session
  // and the user has just taken a task during this entry guide.
  const afterState = await controller.teamStatus?.()
  const claimedTaskId = afterState?.tasks.find(t => t.ownerUnit && t.status !== 'done')?.id ?? null
  if (claimedTaskId && router.getMessages().length > 0) {
    const msgCount = router.getMessages().length
    console.log(`\n${bold('检测到历史对话')} ${dim(`（本 session 共 ${msgCount} 条消息）`)}`)
    console.log(`这些对话与 ${cyan(claimedTaskId)} 是什么关系？`)
    console.log(`  ${cyan('1')}. 是该任务的起源背景`)
    console.log(`  ${cyan('2')}. 与该任务无关`)
    const bChoice = await askQuestion(rl, `请选择 [1/2，回车=1]: `)
    const bMode: 'background' | 'unrelated' = bChoice.trim() === '2' ? 'unrelated' : 'background'
    await controller.teamSetContextBoundary?.(bMode, claimedTaskId)
    console.log(dim(`  ✓ ${bMode === 'background' ? '已标记为任务背景' : '已设置边界'}。`))
  }

  console.log(dim('\n协作命令：/team take <id>、/team note <id> ... 、/team drop、/team done、/team steal <id> [reason]。\n'))
}

function nextTeamTaskId(tasks: TeamTask[]): string {
  const nums = tasks
    .map(task => task.id.match(/^TASK-(\d+)$/)?.[1])
    .filter((n): n is string => Boolean(n))
    .map(n => Number.parseInt(n, 10))
    .filter(Number.isFinite)
  const next = nums.length > 0 ? Math.max(...nums) + 1 : 1
  return `TASK-${String(next).padStart(3, '0')}`
}

/**
 * Parse `/team note <task-id> "<direction>" :: "<outcome>" [@ref]`.
 *
 * Accepts both with and without quotes.  The `::` separator distinguishes
 * direction from outcome.  An optional trailing `@ref` becomes the artifact
 * pointer.
 *
 * Examples:
 *   note TASK-001 "试 ResNet" :: "失败，real -2%"
 *   note TASK-001 试用更大学习率 :: 成功 step 稳定性 +12% @ wandb.ai/run-3f2
 */
function parseTeamNoteArgs(text: string): { taskId: string; direction: string; outcome: string; ref?: string } | null {
  const trimmed = text.trim()
  const taskMatch = trimmed.match(/^(TASK-[A-Z0-9._-]+)\s+(.+)$/i)
  if (!taskMatch) return null
  const taskId = taskMatch[1]!.toUpperCase()
  let body = (taskMatch[2] ?? '').trim()

  // Strip trailing "@ref"
  let ref: string | undefined
  const refMatch = body.match(/\s+@\s*(\S+(?:\s+\S+)*)$/)
  if (refMatch) {
    ref = refMatch[1]!.trim()
    body = body.slice(0, refMatch.index).trim()
  }

  // Split on "::" separator
  const sepIdx = body.indexOf('::')
  if (sepIdx < 0) return null
  const direction = body.slice(0, sepIdx).trim().replace(/^['"]|['"]$/g, '')
  const outcome   = body.slice(sepIdx + 2).trim().replace(/^['"]|['"]$/g, '')
  if (!direction || !outcome) return null
  return { taskId, direction, outcome, ref }
}

export async function getTeamController(router: SessionRouter, opts: CliOptions): Promise<TeamCliController | null> {
  if (opts.mode !== 'robotics' && router.mode !== 'robotics') {
    console.log(`\n${yellow('/team 仅在 robotics mode 中可用。')} 使用 ${cyan('--mode robotics')} 启动后再执行。\n`)
    return null
  }
  await router.ensureReady('/team command')
  const controller = router.getRoboticsTeamController()
  if (!controller) {
    console.log(`\n${yellow('无法初始化 robotics team controller。')}\n`)
    return null
  }
  return controller
}

/**
 * After init/join (when the board is brand-new or presence changed), offer to
 * publish immediately — in the initialisation flow this is almost always the
 * next step, so asking beats hinting. Falls back to the passive hint in
 * non-interactive contexts or when the user declines.
 */
export async function offerTeamPush(
  controller: TeamCliController,
  opts: CliOptions,
  rl?: readline.Interface,
  setInteractiveActive?: (v: boolean) => void,
): Promise<void> {
  try {
    const s = await controller.teamPublishState?.()
    if (!s) return
    if (!s.isGitRepo) {
      console.log(dim('  （当前项目不是 git 仓库，team 状态暂无法发布到 GitHub。）'))
      return
    }
    if (s.dirty.length === 0 && s.unpushedCommits === 0) return
    if (!rl || opts.json || !isTTY) {
      await printTeamPublishHint(controller)
      return
    }
    setInteractiveActive?.(true)
    let answer: string
    try {
      answer = await askQuestion(rl, `  现在发布到 GitHub（仅 commit + push team/ 目录）？[Y/n] `)
    } finally {
      setInteractiveActive?.(false)
    }
    if (/^(n|no|否)$/i.test(answer.trim())) {
      await printTeamPublishHint(controller)
      return
    }
    process.stdout.write(dim('  正在发布 team/ 变更…'))
    const result = await controller.teamPush?.()
    process.stdout.write('\r')
    if (result?.pushed) {
      console.log(green(`  ✓ ${result.message}`) + dim('  队友执行 /team pull 后可见。'))
    } else {
      console.log(yellow(`  ⚠ ${result?.message ?? 'push 失败'}`) + dim('  可稍后用 /team push 重试。'))
    }
  } catch { /* advisory only — never block the init/join flow */ }
}

/** Print a one-line hint when local team/ changes haven't been pushed yet. */
export async function printTeamPublishHint(controller: TeamCliController): Promise<void> {
  try {
    const s = await controller.teamPublishState?.()
    if (!s || !s.isGitRepo) return
    if (s.dirty.length > 0 || s.unpushedCommits > 0) {
      console.log(
        dim(`  ⇡ 本地 team/ 有未发布变更（未提交=${s.dirty.length}, 未推送 commit=${s.unpushedCommits}）— 运行 `) +
        cyan('/team push') + dim(' 发布给队友。'),
      )
    }
  } catch { /* advisory only */ }
}

export async function handleTeamCommand(
  input: string,
  router: SessionRouter,
  opts: CliOptions,
  rl?: readline.Interface,
  setInteractiveActive?: (v: boolean) => void,
): Promise<void> {
  const controller = await getTeamController(router, opts)
  if (!controller) return

  const [, rawSub = '', ...rest] = input.split(/\s+/)
  if (!rawSub) {
    if (!opts.json && isTTY) {
      if (rl) await runTeamEntryGuide(router, opts, rl, setInteractiveActive)
      else {
        const state = await controller.teamStatus?.()
        console.log(formatTeamState(state))
        console.log(formatTeamLog(state))
      }
    } else {
      const state = await controller.teamStatus?.()
      console.log(formatTeamState(state))
      console.log(formatTeamLog(state))
    }
    return
  }
  const sub = rawSub.toLowerCase()
  const arg = rest.join(' ').trim() || undefined

  try {
    switch (sub) {
      case 'init': {
        const state = await controller.teamInit?.(arg)
        console.log(green('\n✓ team 模板已初始化。') + dim('  文件位于 team/，team.json 为唯一事实源（SSOT: GitHub）。'))
        console.log(formatTeamState(state))
        await offerTeamPush(controller, opts, rl, setInteractiveActive)
        break
      }
      case 'join': {
        // /team join [github] [--as 张三]
        const asIdx = rest.findIndex(t => t === '--as')
        const human = asIdx >= 0 ? rest.slice(asIdx + 1).join(' ').trim() || undefined : undefined
        const githubArg = (asIdx >= 0 ? rest.slice(0, asIdx) : rest).join(' ').trim() || undefined
        const state = await controller.teamJoin?.(githubArg, human)
        console.log(green('\n✓ 已加入 team。') + (human ? dim(`  (human: ${human})`) : ''))
        console.log(formatTeamState(state))
        await offerTeamPush(controller, opts, rl, setInteractiveActive)
        break
      }
      case 'add': {
        if (!arg) {
          console.log(`\n${yellow('用法:')} ${cyan('/team add "<task title>"')}\n`)
          break
        }
        const state = await controller.teamStatus?.()
        const id = nextTeamTaskId(state?.tasks ?? [])
        // /team add "<title>" [--kind algo|exp|deploy]
        const kindMatch = arg.match(/\s--kind\s+(algo|exp|deploy)\s*$/i)
        const kind = kindMatch ? kindMatch[1]!.toLowerCase() as TeamTaskKind : undefined
        const rawTitle = kindMatch ? arg.slice(0, kindMatch.index) : arg
        const title = rawTitle.replace(/^['"]|['"]$/g, '').trim()
        if (!title) {
          console.log(`\n${yellow('用法:')} ${cyan('/team add "<task title>" [--kind algo|exp|deploy]')}\n`)
          break
        }
        const result = await controller.teamTaskAdd?.({ id, title, ...(kind ? { kind } : {}) })
        const kindNote = kind ? dim(`  [${kind}]`) : ''
        console.log(green(`\n✓ 已新增 ${result?.task.id ?? id}: ${title}。`) + kindNote)
        console.log(formatTeamState(result?.state))
        await printTeamPublishHint(controller)
        break
      }
      case 'take': {
        if (!arg) {
          console.log(`\n${yellow('用法:')} ${cyan('/team take TASK-001')}\n`)
          break
        }
        // Double-claim guard: fetch remote state first; if the remote team/
        // has changes we haven't pulled, a teammate may already own this task.
        process.stdout.write(dim('领取前同步远端 team 状态…'))
        const preSync = await controller.teamSync?.({ updatePresence: false }).catch(() => undefined)
        process.stdout.write('\r')
        if (preSync && preSync.remoteTeamChanges.length > 0) {
          console.log(
            `${yellow('⚠ 远端 team/ 有未拉取的变更，已中止领取（避免双领）。')}\n` +
            `${dim('先运行')} ${cyan('/team pull')} ${dim('应用远端状态，再重新 take。')}`,
          )
          preSync.remoteTeamChanges.slice(0, 5).forEach(change => console.log(dim(`  - ${change}`)))
          break
        }
        // WIP soft limit: holding several active tasks is legal (waiting on a
        // training run while calibrating is real life) but hoarding hurts the
        // team — confirm before the 3rd concurrent claim.
        const ownedBefore = await controller.teamOwnedTasks?.()
        if (rl && isTTY && !opts.json && (ownedBefore?.owned.length ?? 0) >= 2) {
          const ids = ownedBefore!.owned.map(t => t.id).join(', ')
          setInteractiveActive?.(true)
          let confirm: string
          try {
            confirm = await askQuestion(rl, `  你已持有 ${ownedBefore!.owned.length} 个任务（${ids}），确认再领 ${arg}？[y/N] `)
          } finally {
            setInteractiveActive?.(false)
          }
          if (!/^(y|yes|是|确认)$/i.test(confirm.trim())) {
            console.log(dim('已取消领取。'))
            break
          }
        }
        const result = await controller.teamTake?.(arg)
        const focusNote = (ownedBefore?.owned.length ?? 0) > 0 ? dim('  (focus 已切换至该任务)') : ''
        console.log(green(`\n✓ 已领取 ${result?.task.id ?? arg}。`) + focusNote)
        console.log(formatTeamState(result?.state))
        await printTeamPublishHint(controller)
        break
      }
      case 'drop': {
        const result = await controller.teamDrop?.(arg)
        console.log(green(`\n✓ 已释放 ${result?.task.id ?? '(当前任务)'}。`))
        console.log(formatTeamState(result?.state))
        await printTeamPublishHint(controller)
        break
      }
      case 'steal': {
        const [taskIdArg, ...reasonParts] = rest
        if (!taskIdArg) {
          console.log(`\n${yellow('用法:')} ${cyan('/team steal TASK-001 [reason]')}\n`)
          break
        }
        const reason = reasonParts.join(' ').trim() || undefined
        const result = await controller.teamSteal?.(taskIdArg, reason)
        const from = result?.previousOwner ? ` (from ${result.previousOwner})` : ''
        console.log(green(`\n✓ 已 steal ${result?.task.id ?? taskIdArg}${from}。`))
        if (result?.task.attempts.length) {
          const last = result.task.attempts[result.task.attempts.length - 1]!
          console.log(dim(`  audit: ${last.direction} — ${last.outcome}`))
        }
        console.log(formatTeamState(result?.state))
        await printTeamPublishHint(controller)
        break
      }
      case 'note': {
        const parsed = parseTeamNoteArgs(rest.join(' '))
        if (!parsed) {
          console.log(
            `\n${yellow('用法:')} ${cyan('/team note TASK-001 "<direction>" :: "<outcome>" [@ref]')}\n` +
            `${dim('示例:')} ${cyan('/team note TASK-001 试 ResNet :: 失败 real -2% @ wandb.ai/run-3f2')}\n`,
          )
          break
        }
        const result = await controller.teamNote?.(parsed)
        console.log(green(`\n✓ 已记录 ${result?.task.id ?? parsed.taskId} 的一条尝试。`))
        console.log(dim(`  方向: ${parsed.direction}`))
        console.log(dim(`  结果: ${parsed.outcome}`))
        if (parsed.ref) console.log(dim(`  ref: ${parsed.ref}`))
        await printTeamPublishHint(controller)
        break
      }
      case 'focus': {
        if (!arg) {
          const owned = await controller.teamOwnedTasks?.()
          if (!owned || owned.owned.length === 0) {
            console.log(`\n${dim('你当前没有持有任何任务。')}\n`)
          } else {
            console.log(`\n${bold('你持有的任务:')}`)
            owned.owned.forEach(t => console.log(`  ${t.id === owned.focusId ? cyan('★') : ' '} ${t.id} ${t.title}`))
            console.log(`\n${dim('用法:')} ${cyan('/team focus TASK-001')} ${dim('切换焦点（done/drop 无参时作用于焦点任务）')}\n`)
          }
          break
        }
        const result = await controller.teamFocus?.(arg)
        console.log(green(`\n✓ focus 已切换到 ${result?.task.id ?? arg}: ${result?.task.title ?? ''}。`))
        break
      }
      case 'done': {
        // Resolve MY task: explicit id → focus → single-owned → clear error.
        // (The old code picked the first ACTIVE task owned by ANYONE — with
        // multi-task ownership it could mark the wrong task done.)
        let taskId: string
        try {
          taskId = await controller.teamResolveOwnTaskId?.(arg) ?? ''
        } catch (resolveErr) {
          console.log(`\n${yellow(terminalText(resolveErr instanceof Error ? resolveErr.message : String(resolveErr)))}\n`)
          break
        }
        if (!taskId) {
          console.log(`\n${yellow('没有当前任务。')} 使用 ${cyan('/team done TASK-001')}。\n`)
          break
        }
        const result = await controller.teamTaskStatus?.(taskId, 'done')
        console.log(green(`\n✓ ${result?.task.id ?? taskId} -> done。`))
        console.log(formatTeamState(result?.state))
        await printTeamPublishHint(controller)
        break
      }
      case 'pause': {
        if (!arg) {
          console.log(`\n${yellow('用法:')} ${cyan('/team pause TASK-001')}\n`)
          break
        }
        const result = await controller.teamTaskStatus?.(arg, 'paused')
        console.log(green(`\n✓ ${result?.task.id ?? arg} -> paused。`))
        console.log(formatTeamState(result?.state))
        break
      }
      case 'sync': {
        process.stdout.write(dim('正在同步 team 状态并拉取远端…'))
        const _syncStart = Date.now()
        const summary = await controller.teamSync?.()
        const _elapsed = Date.now() - _syncStart
        process.stdout.write('\r')
        console.log(green('✓ team sync 完成。') + ` ${dim(`git fetch=${summary?.gitFetched ? 'ok' : 'skipped/failed'} (${_elapsed}ms)`)}`)
        if (summary?.currentBranch) console.log(`${dim('Branch:')} ${cyan(summary.currentBranch)}`)
        if (summary?.upstreamBranch) console.log(`${dim('Upstream:')} ${cyan(summary.upstreamBranch)} ${dim(`behind=${summary.behind ?? 0} ahead=${summary.ahead ?? 0}`)}`)
        if (summary?.remoteSummary) console.log(`${dim('Git:')} ${summary.remoteSummary.split('\n')[0]}`)
        if (summary?.remoteTeamChanges.length) {
          console.log(`${yellow('Remote team changes:')}`)
          summary.remoteTeamChanges.slice(0, 8).forEach(change => console.log(`  - ${change}`))
        }
        console.log(formatTeamState(summary?.state))
        console.log(formatTeamWatcherEvents(controller.teamWatcherEvents?.()))
        break
      }
      case 'push': {
        process.stdout.write(dim('正在发布 team/ 变更…'))
        const pushResult = await controller.teamPush?.()
        process.stdout.write('\r')
        if (pushResult?.pushed) {
          console.log(green('✓ ' + pushResult.message) + dim('  队友执行 /team pull 后可见。'))
        } else {
          console.log(yellow('⚠ ' + (pushResult?.message ?? 'push 不可用（robotics 模式未激活？）')))
        }
        break
      }
      case 'pull': {
        const result = await controller.teamPull?.()
        if (result?.applied) {
          const count = result.changedFiles.length
          console.log(green('\n✓ remote team/ 已应用到本地。') + ` ${dim(`files=${count}`)}`)
          if (count > 0) result.changedFiles.slice(0, 8).forEach(change => console.log(`  - ${change}`))
        } else {
          console.log(yellow('\n/team pull 已阻止。') + ` ${result?.reason ?? 'unknown reason'}`)
          ;(result?.changedFiles ?? []).slice(0, 8).forEach(change => console.log(`  - ${change}`))
        }
        if (result?.sync.upstreamBranch) console.log(`${dim('Upstream:')} ${cyan(result.sync.upstreamBranch)} ${dim(`behind=${result.sync.behind ?? 0} ahead=${result.sync.ahead ?? 0}`)}`)
        // Auto-detect merge conflicts after pull and show guidance if any
        const pullConflictReport = await controller.teamConflicts?.()
        if (pullConflictReport?.hasConflicts) {
          console.log(`\n${yellow('⚠ 检测到合并冲突')} — 运行 ${cyan('/team conflicts')} 查看详细引导。`)
        }
        console.log(formatTeamState(result?.state))
        console.log(formatTeamWatcherEvents(controller.teamWatcherEvents?.()))
        break
      }
      case 'conflicts': {
        const resolveMode = arg === 'resolve'
        if (resolveMode) {
          // Auto-resolve team.json conflict using --theirs strategy
          const resolveResult = await controller.teamResolveTeamJson?.()
          if (resolveResult?.resolved) {
            console.log(green('\n✓ team.json 冲突已自动解决。'))
            console.log(dim(resolveResult.message))
          } else if (resolveResult?.strategy === 'none') {
            console.log(dim('\n' + (resolveResult.message ?? 'team.json 无冲突。')))
          } else {
            console.log(red('\n✗ 自动解决失败。'))
            console.log(yellow(resolveResult?.message ?? '请手动解决冲突。'))
          }
          // Show remaining conflicts after resolution attempt
          const afterReport = await controller.teamConflicts?.()
          if (afterReport?.hasConflicts) {
            console.log(`\n${yellow('仍有未解决冲突：')}`)
            afterReport.guidance.forEach(line => console.log(line))
          } else {
            console.log(green('\n✓ 所有合并冲突已解决。'))
          }
        } else {
          // Show conflict report with guidance
          const report = await controller.teamConflicts?.()
          if (!report) {
            console.log(dim('\n无法获取冲突信息。'))
            break
          }
          if (!report.hasConflicts) {
            console.log(green('\n✓ 工作区无 git 合并冲突。'))
          } else {
            console.log(`\n${red('⚠ 合并冲突引导')}`)
            report.guidance.forEach(line => {
              if (line.startsWith('▶')) console.log(`\n${yellow(line)}`)
              else if (line.startsWith('  $')) console.log(cyan(line))
              else if (line.startsWith('  ')) console.log(dim(line))
              else console.log(line)
            })
            if (report.teamJsonConflicted) {
              console.log(`\n${dim('提示：运行')} ${cyan('/team conflicts resolve')} ${dim('自动应用 --theirs 策略解决 team.json 冲突。')}`)
            }
          }
        }
        break
      }
      case 'status':
      case 'board':
      case 'log':
      default: {
        const state = await controller.teamStatus?.()
        console.log(formatTeamState(state))
        if (sub === 'log') {
          console.log(formatTeamLog(state, 30))
        } else {
          console.log(formatTeamLog(state))
        }
        console.log(formatTeamWatcherEvents(controller.teamWatcherEvents?.()))
        if (!['status', 'board', 'log'].includes(sub)) {
          console.log(dim(`未知 team 子命令 "${terminalText(sub)}"。可用: init, join, add, take, focus, note, drop, steal, done, pause, status, board, log, sync, push, pull, conflicts.\n`))
        }
        break
      }
    }
  } catch (err) {
    const msg = terminalText(err instanceof Error ? err.message : String(err))
    console.log(`\n${red('team error:')} ${msg}\n`)
  }
}

