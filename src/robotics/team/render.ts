/**
 * Pure markdown renderers for the v2.0 derived views.
 *
 *   board.md  — who has what (with 🔒 lock markers and ⚠ stale warnings)
 *   log.md    — recent attempts across the whole team
 *   goals.md  — project goals
 *   README.md — file inventory + commit conventions
 *
 * All renderers are pure functions of TeamState (or static text) — no IO.
 */

import { isStaleClaim, type TeamState, type TeamTask } from './types.js'

function attemptsCount(task: TeamTask): string {
  return `${task.attempts.length} 次尝试`
}

function relTime(iso?: string): string {
  if (!iso) return ''
  const ms = Date.now() - Date.parse(iso)
  if (Number.isNaN(ms) || ms < 0) return ''
  const m = Math.floor(ms / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

export function renderBoard(state: TeamState): string {
  const owned = state.tasks.filter(t => t.ownerUnit && t.status !== 'done')
  const paused = state.tasks.filter(t => t.status === 'paused')
  const open = state.tasks.filter(t => !t.ownerUnit && t.status === 'open')
  const done = state.tasks.filter(t => t.status === 'done')

  const lines: string[] = ['# Team Board', '']

  lines.push('## 进行中（锁定）')
  if (owned.length === 0) {
    lines.push('- _none_', '')
  } else {
    for (const t of owned) {
      const marker = isStaleClaim(t) ? '⚠' : '🔒'
      const claim = t.claimedAt ? ` · claimed ${relTime(t.claimedAt)}` : ''
      lines.push(`- ${marker} ${t.id} ${t.title} · ${t.ownerUnit}${claim} · ${attemptsCount(t)}`)
    }
    lines.push('')
  }

  if (paused.length > 0) {
    lines.push('## 暂停')
    for (const t of paused) {
      const owner = t.ownerUnit ? ` · ${t.ownerUnit}` : ''
      lines.push(`- ${t.id} ${t.title}${owner} · ${attemptsCount(t)}`)
    }
    lines.push('')
  }

  lines.push('## 待领')
  if (open.length === 0) {
    lines.push('- _none_', '')
  } else {
    for (const t of open) lines.push(`- ${t.id} ${t.title}`)
    lines.push('')
  }

  if (done.length > 0) {
    lines.push('## 已完成')
    for (const t of done.slice(-10)) {
      lines.push(`- ${t.id} ${t.title} · ${attemptsCount(t)}`)
    }
    lines.push('')
  }

  if (state.units.length > 0) {
    lines.push('## Units')
    for (const u of state.units) {
      const cur = u.currentTask ? ` task=${u.currentTask}` : ''
      lines.push(`- ${u.id} · ${u.status} · last seen ${relTime(u.lastSeen)}${cur}`)
    }
    lines.push('')
  }

  return `${lines.join('\n').trimEnd()}\n`
}

export function renderLog(state: TeamState, limit = 30): string {
  type Row = { at: string; taskId: string; title: string; unit: string; direction: string; outcome: string; ref?: string }
  const rows: Row[] = []
  for (const t of state.tasks) {
    for (const a of t.attempts) {
      rows.push({ at: a.at, taskId: t.id, title: t.title, unit: a.unit, direction: a.direction, outcome: a.outcome, ref: a.ref })
    }
  }
  rows.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))

  const lines = ['# Team Log', '', `_最近 ${Math.min(limit, rows.length)} 条尝试_`, '']
  if (rows.length === 0) {
    lines.push('_尚无任何 attempt 记录。使用 `/team note` 追加。_', '')
  } else {
    for (const r of rows.slice(0, limit)) {
      lines.push(`- [${r.at}] ${r.unit} / ${r.taskId} _${r.title}_`)
      lines.push(`  方向：${r.direction}`)
      lines.push(`  结果：${r.outcome}`)
      if (r.ref) lines.push(`  ref: ${r.ref}`)
    }
    lines.push('')
  }
  return `${lines.join('\n').trimEnd()}\n`
}

export function renderGoals(state: TeamState): string {
  const lines = ['# Team Goals', '']
  if (state.goals.length === 0) {
    lines.push('_尚无 goals。编辑 team.json 的 `goals` 字段记录项目级目标。_')
  } else {
    for (const g of state.goals) lines.push(`- ${g}`)
  }
  lines.push('')
  return `${lines.join('\n').trimEnd()}\n`
}

export function renderReadme(): string {
  return [
    '# Team Mode files (v2.0)',
    '',
    'Team mode is a **shared lab notebook**, not a project manager.  Three',
    'concepts only: unit, task, and attempt (direction + outcome).',
    '',
    '## Source of truth — commit these',
    '',
    '- `team.json` — single shared state.  Every other file is derived.',
    '',
    '## Derived views — regenerated on every team write',
    '',
    'These files are convenience renderings of `team.json` and are rewritten',
    'atomically each time the state changes.  Commit them only if you want',
    'GitHub viewers to see the rendered output without the CLI;',
    'they will be overwritten on the next team action.',
    '',
    '- `board.md`  — 当前谁在做什么（🔒 标记锁定，⚠ 标记 ≥7d 陈旧）',
    '- `log.md`    — 最近的 attempts（方向 + 结果，含失败）',
    '- `goals.md`  — 项目目标',
    '',
    '## Commands',
    '',
    '- `/team`                — board + log',
    '- `/team take <task-id>` — 排他领取（已被领则失败并打印 owner）',
    '- `/team note <id> "<direction>" :: "<outcome>" [@ref]` — 追加一条尝试',
    '- `/team drop [id]`      — 释放（仅 owner）',
    '- `/team done [id]`      — 标完成（仅 owner）',
    '- `/team add "<title>"`  — 新增任务',
    '- `/team steal <id> [reason]` — 强制接手他人任务（自动写 audit attempt）',
    '',
    '## Migration',
    '',
    'Older v1.0 files (with modules/decisions/paths) are migrated forward',
    'on read: 9-state status collapses into open|paused|done, ownership',
    'is preserved, and attempts[] is initialised empty.',
    '',
    '## Concurrency',
    '',
    'Two units writing `team.json` at the same time: the optimistic check',
    '(`updatedAt` comparison) rejects the second writer with a',
    '"Concurrent modification" error.  Re-read and retry.',
    '',
    'Git merge conflicts on `team.json` should normally be resolved with',
    '`git checkout --theirs`; `/team conflicts resolve` automates this.',
    '',
  ].join('\n')
}
