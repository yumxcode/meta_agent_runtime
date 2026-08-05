/**
 * cli/commands/review — interactive human review of AI-proposed knowledge.
 *
 * Experience entries, memories, principles and physical anchors all land in a
 * pending buffer rather than the shared store; nothing is committed until a
 * person approves it here. That discipline is what keeps a wrong inference from
 * being retrieved, cited and eventually promoted into a principle.
 *
 * Extracted from cli/index.ts.
 */
import * as readline from 'node:readline'
import { ExperiencePendingStore } from '../../robotics/ExperiencePendingStore.js'
import { ExperienceStore } from '../../robotics/ExperienceStore.js'
import { PhysicalAnchorPendingStore } from '../../robotics/PhysicalAnchorPendingStore.js'
import { PhysicalAnchorStore } from '../../robotics/PhysicalAnchorStore.js'
import { PrinciplePendingStore } from '../../robotics/PrinciplePendingStore.js'
import { PrincipleStore } from '../../robotics/PrincipleStore.js'
import { MemoryPendingStore, getMemoryPendingStore, ensureMemoryPendingLoaded } from '../../core/memory/MemoryPendingStore.js'
import { bold, cyan, dim, gray, green, red, yellow, terminalText } from '../term.js'
import { askQuestion } from '../prompts.js'

// ── Experience review ─────────────────────────────────────────────────────────

/**
 * Interactive review of pending experience entries.
 * Shows each entry in turn; user can approve (y), discard (n), or skip (s).
 * Returns the count of committed entries.
 */
export async function reviewPendingExperiences(
  rl: readline.Interface,
  pending: ExperiencePendingStore,
  store: ExperienceStore,
  onCommitted?: (experienceId: string) => Promise<void>,
): Promise<number> {
  const entries = [...pending.list()]
  if (entries.length === 0) {
    console.log(dim('\n暂无待审经验条目。\n'))
    return 0
  }

  console.log(
    `\n${bold('经验审核')} ${dim(`(${entries.length} 条待审)`)}\n` +
    `${dim('每条经验由 AI 在本次会话中提议，需要你审核后才会写入共享知识库。')}\n`,
  )

  let committed = 0
  for (const entry of entries) {
    const input = entry.input
    const title   = String(input['title'] ?? '(无标题)')
    const problem = String(input['problem'] ?? '').slice(0, 200)
    const solution = String(input['solution'] ?? '').slice(0, 200)
    const success = Boolean(input['success'])
    const domain  = String(input['domain'] ?? 'general')
    const tags    = (input['tags'] as string[] | undefined)?.join(', ') ?? ''

    console.log(
      `\n${'─'.repeat(60)}\n` +
      `${bold(title)} ${dim(`[${domain}]`)} ${success ? green('✅ 成功') : red('❌ 失败')}\n` +
      `${dim('问题:')} ${problem}\n` +
      `${dim('方案:')} ${solution}\n` +
      (tags ? `${dim('标签:')} ${tags}\n` : '') +
      `${'─'.repeat(60)}\n`,
    )

    const choice = await askQuestion(rl, `提交 [y=是 / n=丢弃 / s=跳过]: `)
    if (choice.toLowerCase() === 'y' || choice.toLowerCase() === 'yes') {
      const id = await pending.commit(entry.pendingId, store)
      if (id) {
        console.log(green(`  ✓ 已提交 (ID: ${id})`))
        await onCommitted?.(id)
        committed++
      } else {
        console.log(red('  ✗ 提交失败'))
      }
    } else if (choice.toLowerCase() === 'n') {
      pending.remove(entry.pendingId)
      console.log(dim('  已丢弃'))
    } else {
      console.log(dim('  已跳过 (保留在待审队列)'))
    }
  }

  const remaining = pending.count
  if (committed > 0 || remaining > 0) {
    console.log(
      `\n${green(`✓ 已提交 ${committed} 条`)}` +
      (remaining > 0 ? `  ${yellow(`剩余 ${remaining} 条待审`)}` : '') +
      '\n',
    )
  }
  return committed
}

// ── Memory review ──────────────────────────────────────────────────────────────

/**
 * Interactive review of pending memory entries (global, all modes).
 * Each proposal was queued either by the `memory_write` tool or the
 * post-session auto-writer. Only approved entries are written to the global
 * memory directory. Returns the count of committed entries.
 */
export async function reviewPendingMemories(
  rl: readline.Interface,
  pending: MemoryPendingStore,
): Promise<number> {
  const entries = [...pending.list()]
  if (entries.length === 0) {
    console.log(dim('\n暂无待审记忆条目。\n'))
    return 0
  }

  console.log(
    `\n${bold('记忆审核')} ${dim(`(${entries.length} 条待审)`)}\n` +
    `${dim('记忆仅存储用户画像 (user) 与反馈 (feedback)，需要你审核后才会写入。')}\n`,
  )

  let committed = 0
  for (const entry of entries) {
    const p = entry.proposal
    const origin = entry.origin === 'auto' ? '自动提取' : 'AI 主动'
    console.log(
      `\n${'─'.repeat(60)}\n` +
      `${bold(p.name)} ${dim(`[${p.type}]`)} ${dim(`(${origin})`)}\n` +
      `${dim('摘要:')} ${p.description}\n` +
      `${dim('正文:')} ${p.body.slice(0, 300)}${p.body.length > 300 ? '…' : ''}\n` +
      `${dim('文件:')} ${p.filename}\n` +
      `${'─'.repeat(60)}\n`,
    )

    const choice = await askQuestion(rl, `提交 [y=是 / n=丢弃 / s=跳过]: `)
    const c = choice.trim().toLowerCase()
    if (c === 'y' || c === 'yes') {
      const result = await pending.commit(entry.pendingId)
      if (result.ok) {
        console.log(green(`  ✓ 已写入记忆 (${result.filename})`))
        committed++
      } else if (result.reason === 'duplicate' || result.reason === 'exists') {
        console.log(yellow(`  ⚠ 已存在同名记忆 (${result.detail ?? p.filename})，是否覆盖更新？`))
        const overwriteChoice = await askQuestion(rl, `  覆盖 [y=覆盖 / n=丢弃]: `)
        const oc = overwriteChoice.trim().toLowerCase()
        if (oc === 'y' || oc === 'yes') {
          const overwriteResult = await pending.commit(entry.pendingId, undefined, true)
          if (overwriteResult.ok) {
            console.log(green(`  ✓ 已覆盖更新记忆 (${overwriteResult.filename})`))
            committed++
          } else {
            console.log(red(`  ✗ 覆盖失败${overwriteResult.detail ? `: ${overwriteResult.detail}` : ''}`))
          }
        } else {
          pending.remove(entry.pendingId)
          console.log(dim('  已丢弃'))
        }
      } else {
        console.log(red(`  ✗ 写入失败${result.detail ? `: ${result.detail}` : ''}`))
      }
    } else if (c === 'n') {
      pending.remove(entry.pendingId)
      console.log(dim('  已丢弃'))
    } else {
      console.log(dim('  已跳过 (保留在待审队列)'))
    }
  }
  await pending.flush()

  const remaining = pending.count
  if (committed > 0 || remaining > 0) {
    console.log(
      `\n${green(`✓ 已提交 ${committed} 条`)}` +
      (remaining > 0 ? `  ${yellow(`剩余 ${remaining} 条待审`)}` : '') +
      '\n',
    )
  }
  return committed
}

// ── Principle review ─────────────────────────────────────────────────────────

export async function reviewPendingPrinciples(
  rl: readline.Interface,
  pending: PrinciplePendingStore,
  store: PrincipleStore,
  experienceStore?: ExperienceStore,
  anchorStore?: PhysicalAnchorStore,
): Promise<number> {
  const entries = [...pending.list()]
  if (entries.length === 0) {
    console.log(dim('\n暂无待审原则。\n'))
    return 0
  }

  console.log(
    `\n${bold('原则审核')} ${dim(`(${entries.length} 条待审)`)}\n` +
    `${dim('Principle 是由经验和物理锚点抽象出的可迁移机制；提交前需要你审核边界是否明确。')}\n`,
  )

  let committed = 0
  for (const entry of entries) {
    const input = entry.input
    const title = String(input['title'] ?? '(无标题)')
    const statement = String(input['statement'] ?? '').slice(0, 300)
    const mechanism = String(input['mechanism'] ?? '').slice(0, 220)
    const domains = (input['domains'] as string[] | undefined)?.join(', ') ?? 'general'
    const confidence = String(input['confidence_tier'] ?? 'observed')
    const reason = String(input['promotion_reason'] ?? 'unknown')
    const firstPrinciples = (input['first_principles_support'] as string[] | undefined)?.slice(0, 3).join('; ') ?? ''
    const bounds = (input['applicability_bounds'] as string[] | undefined)?.slice(0, 3).join('; ') ?? ''
    const exclusions = (input['non_applicable_when'] as string[] | undefined)?.slice(0, 3).join('; ') ?? ''
    // Surface the evidence chain and any counterexamples so the reviewer can
    // judge fabrication / overgeneralization before approving (the promotion
    // model is told "do not invent measurements", but only review enforces it).
    const evidence = (input['evidence_refs'] as string[] | undefined)?.slice(0, 4).join('; ') ?? ''
    const counterExamples = (input['counter_examples'] as string[] | undefined)?.slice(0, 3).join('; ') ?? ''

    console.log(
      `\n${'─'.repeat(60)}\n` +
      `${bold(title)} ${dim(`[${domains}]`)} ${dim(`conf:${confidence}`)} ${dim(`trigger:${reason}`)}\n` +
      `${dim('原则:')} ${statement}\n` +
      `${dim('机制:')} ${mechanism}\n` +
      (firstPrinciples ? `${dim('第一性原理支撑:')} ${firstPrinciples}\n` : '') +
      (bounds ? `${dim('适用边界:')} ${bounds}\n` : '') +
      (exclusions ? `${dim('不适用:')} ${exclusions}\n` : '') +
      (evidence ? `${dim('证据:')} ${evidence}\n` : `${yellow('⚠ 无证据引用')}\n`) +
      (counterExamples ? `${dim('反例:')} ${counterExamples}\n` : '') +
      `${'─'.repeat(60)}\n`,
    )

    const choice = await askQuestion(rl, `提交 [y=是 / n=丢弃 / s=跳过]: `)
    if (choice.toLowerCase() === 'y' || choice.toLowerCase() === 'yes') {
      const id = await pending.commit(entry.pendingId, store, experienceStore, anchorStore)
      if (id) {
        console.log(green(`  ✓ 已提交 (ID: ${id})`))
        committed++
      } else {
        console.log(red('  ✗ 提交失败（字段校验未通过）'))
      }
    } else if (choice.toLowerCase() === 'n') {
      pending.remove(entry.pendingId)
      console.log(dim('  已丢弃'))
    } else {
      console.log(dim('  已跳过 (保留在待审队列)'))
    }
  }

  const remaining = pending.count
  if (committed > 0 || remaining > 0) {
    console.log(
      `\n${green(`✓ 已提交 ${committed} 条原则`)}` +
      (remaining > 0 ? `  ${yellow(`剩余 ${remaining} 条待审`)}` : '') +
      '\n',
    )
  }
  return committed
}

// ── Physical anchor review ─────────────────────────────────────────────────────

/**
 * Interactive review of pending physical anchor proposals.
 * Shows each candidate; user can approve (y), discard (n), or skip (s).
 * Returns the count of committed anchors.
 */
export async function reviewPendingPhysicalAnchors(
  rl: readline.Interface,
  pending: PhysicalAnchorPendingStore,
  store: PhysicalAnchorStore,
): Promise<number> {
  const entries = [...pending.list()]
  if (entries.length === 0) {
    console.log(dim('\n暂无待审物理锚点。\n'))
    return 0
  }

  console.log(
    `\n${bold('物理锚点审核')} ${dim(`(${entries.length} 条待审)`)}\n` +
    `${dim('每个锚点由 AI 在本次会话中提议（或会话结束时自动提取），需要你审核后才会写入跨 session 知识库。')}\n`,
  )

  let committed = 0
  for (const entry of entries) {
    const inp = entry.input
    const title       = String(inp['title'] ?? '(无标题)')
    const domain      = String(inp['domain'] ?? 'general')
    const scope       = String(inp['scope'] ?? 'code')
    const fact        = String(inp['fact'] ?? '').slice(0, 300)
    const implication = String(inp['implication'] ?? '').slice(0, 200)
    const confidence  = String(inp['confidence_tier'] ?? 'observed')
    const tags        = (inp['tags'] as string[] | undefined)?.join(', ') ?? ''
    const proposed    = new Date(entry.proposedAt).toLocaleTimeString()

    const scopeLabel  = scope === 'global' ? green(scope) : scope === 'robot' ? cyan(scope) : dim(scope)

    console.log(
      `\n${'─'.repeat(60)}\n` +
      `${bold(title)} ${dim(`[${domain}]`)} ${scopeLabel} ${dim(`conf:${confidence}`)}\n` +
      `${dim('事实:')} ${fact}\n` +
      `${dim('含义:')} ${implication}\n` +
      (tags ? `${dim('标签:')} ${tags}\n` : '') +
      `${dim('提议时间:')} ${proposed}\n` +
      `${'─'.repeat(60)}\n`,
    )

    const choice = await askQuestion(rl, `提交 [y=是 / n=丢弃 / s=跳过]: `)
    if (choice.toLowerCase() === 'y' || choice.toLowerCase() === 'yes') {
      const id = await pending.commit(entry.pendingId, store)
      if (id) {
        console.log(green(`  ✓ 已提交 (ID: ${id})`))
        committed++
      } else {
        console.log(red('  ✗ 提交失败（字段校验未通过）'))
      }
    } else if (choice.toLowerCase() === 'n') {
      pending.remove(entry.pendingId)
      console.log(dim('  已丢弃'))
    } else {
      console.log(dim('  已跳过 (保留在待审队列)'))
    }
  }

  const remaining = pending.count
  if (committed > 0 || remaining > 0) {
    console.log(
      `\n${green(`✓ 已提交 ${committed} 条物理锚点`)}` +
      (remaining > 0 ? `  ${yellow(`剩余 ${remaining} 条待审`)}` : '') +
      '\n',
    )
  }
  return committed
}

