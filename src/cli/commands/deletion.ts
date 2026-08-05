/**
 * cli/commands/deletion — the `/delete` surface.
 *
 * Two paths: a human deleting directly, and reviewing deletions the agent
 * proposed. Both funnel through one DeletionAdapter per mechanism so the
 * confirm-then-commit flow is written once.
 *
 * Extracted from cli/index.ts.
 */
import * as readline from 'node:readline'
import {
  getPendingDeletionStore,
  ensurePendingDeletionsLoaded,
  type DeletionMechanism,
} from '../../core/deletion/PendingDeletionStore.js'
import { ExperienceStore } from '../../robotics/ExperienceStore.js'
import { PrincipleStore } from '../../robotics/PrincipleStore.js'
import { PhysicalAnchorStore } from '../../robotics/PhysicalAnchorStore.js'
import { listMemoryEntries, deleteMemoryEntry } from '../../core/memory/memoryDelete.js'
import { bold, cyan, dim, gray, green, red, yellow, terminalText } from '../term.js'
import { askQuestion } from '../prompts.js'

// ── Deletion (human direct + AI-proposed review) ─────────────────────────────

/**
 * Mechanism-specific glue for the generic delete handlers. Lets one pair of
 * handlers serve memory / experience / principle / anchor.
 */
interface DeletionAdapter {
  mechanism: DeletionMechanism
  /** Chinese display noun, e.g. "经验". */
  noun: string
  /** Base command, e.g. "/experience". */
  command: string
  /** List committed entries available for deletion. */
  listCommitted(): Promise<{ id: string; title: string; meta?: string }[]>
  /** Permanently delete one committed entry. Returns true on success. */
  deleteById(id: string): Promise<boolean>
}

export function makeDeletionAdapter(mechanism: DeletionMechanism): DeletionAdapter {
  switch (mechanism) {
    case 'memory':
      return {
        mechanism, noun: '记忆', command: '/memory',
        async listCommitted() {
          const entries = await listMemoryEntries()
          return entries.map(e => ({ id: e.filename, title: e.name, meta: e.type || undefined }))
        },
        async deleteById(id) {
          const r = await deleteMemoryEntry(id)
          return r.ok
        },
      }
    case 'experience': {
      const store = new ExperienceStore()
      return {
        mechanism, noun: '经验', command: '/experience',
        async listCommitted() {
          const ids = await store.listIds()
          const out: { id: string; title: string; meta?: string }[] = []
          for (const id of ids) {
            const e = await store.load(id)
            if (e) out.push({ id, title: e.title, meta: e.domain })
          }
          return out
        },
        deleteById: id => store.delete(id),
      }
    }
    case 'principle': {
      const store = new PrincipleStore()
      return {
        mechanism, noun: '原则', command: '/principle',
        async listCommitted() {
          const ids = await store.listIds()
          const out: { id: string; title: string; meta?: string }[] = []
          for (const id of ids) {
            const e = await store.load(id)
            if (e) out.push({ id, title: e.title, meta: e.domains?.join(',') })
          }
          return out
        },
        deleteById: id => store.delete(id),
      }
    }
    case 'anchor': {
      const store = new PhysicalAnchorStore()
      return {
        mechanism, noun: '物理锚点', command: '/anchor',
        async listCommitted() {
          const ids = await store.listIds()
          const out: { id: string; title: string; meta?: string }[] = []
          for (const id of ids) {
            const e = await store.load(id)
            if (e) out.push({ id, title: e.title, meta: e.domain })
          }
          return out
        },
        deleteById: id => store.delete(id),
      }
    }
  }
}

/**
 * Human-driven deletion: list committed entries, pick one, confirm, delete now.
 * The human has direct authority — no review queue.
 */
async function handleDirectDelete(rl: readline.Interface, adapter: DeletionAdapter): Promise<void> {
  const entries = await adapter.listCommitted()
  if (entries.length === 0) {
    console.log(dim(`\n暂无已提交的${adapter.noun}可删除。\n`))
    return
  }
  console.log(`\n${bold(`删除${adapter.noun}`)} ${dim(`(${entries.length} 条；输入序号删除，回车取消)`)}\n`)
  entries.forEach((e, i) => {
    const meta = e.meta ? dim(` [${e.meta}]`) : ''
    console.log(`  ${cyan(String(i + 1))}. ${bold(e.title)}${meta}  ${dim(e.id)}`)
  })
  console.log()
  const choice = await askQuestion(rl, `请选择 [1-${entries.length}，回车取消]: `)
  const trimmed = choice.trim()
  if (!trimmed) { console.log(dim('\n已取消。\n')); return }
  const idx = parseInt(trimmed, 10)
  if (!(idx >= 1 && idx <= entries.length)) { console.log(yellow('\n无效选择。\n')); return }
  const target = entries[idx - 1]!
  const confirm = await askQuestion(rl, `${yellow('⚠  确认永久删除 ')}${bold(target.title)}${yellow(' ？此操作不可撤销 [y/N] ')}`)
  if (confirm.trim().toLowerCase() !== 'y') { console.log(dim('\n已取消。\n')); return }
  const ok = await adapter.deleteById(target.id)
  if (ok) console.log(green(`\n✓ 已删除${adapter.noun}: ${dim(target.title)}\n`))
  else console.log(red(`\n✗ 删除失败（条目可能已不存在）。\n`))
}

/**
 * Review AI-proposed deletions: each entry was queued by a `*_delete` tool and
 * is applied only after the user approves it here.
 */
async function handleDeleteReview(rl: readline.Interface, adapter: DeletionAdapter): Promise<void> {
  await ensurePendingDeletionsLoaded(adapter.mechanism)
  const store = getPendingDeletionStore(adapter.mechanism)
  const entries = [...store.list()]
  if (entries.length === 0) {
    console.log(dim(`\n暂无待审${adapter.noun}删除请求。\n`))
    return
  }
  console.log(
    `\n${bold(`${adapter.noun}删除审核`)} ${dim(`(${entries.length} 条待审)`)}\n` +
    `${dim('以下删除由 AI 提议，确认后才会真正删除。')}\n`,
  )
  let deleted = 0
  for (const entry of entries) {
    console.log(
      `\n${'─'.repeat(60)}\n` +
      `${bold(entry.label)}  ${dim(entry.targetId)}\n` +
      (entry.reason ? `${dim('理由:')} ${entry.reason}\n` : '') +
      `${'─'.repeat(60)}\n`,
    )
    const choice = await askQuestion(rl, `删除 [y=确认删除 / n=驳回 / s=跳过]: `)
    const c = choice.trim().toLowerCase()
    if (c === 'y' || c === 'yes') {
      const ok = await adapter.deleteById(entry.targetId)
      if (ok) {
        store.remove(entry.pendingId)
        console.log(green(`  ✓ 已删除`))
        deleted++
      } else {
        store.remove(entry.pendingId)
        console.log(yellow(`  ⚠ 目标已不存在，已从队列移除`))
      }
    } else if (c === 'n') {
      store.remove(entry.pendingId)
      console.log(dim('  已驳回'))
    } else {
      console.log(dim('  已跳过 (保留在待审队列)'))
    }
  }
  await store.flush()
  const remaining = store.count
  console.log(
    `\n${green(`✓ 已删除 ${deleted} 条`)}` +
    (remaining > 0 ? `  ${yellow(`剩余 ${remaining} 条待审`)}` : '') + '\n',
  )
}

/**
 * Dispatch the `delete` / `delete review` sub-commands shared by the memory /
 * experience / principle / anchor REPL commands. Returns true if handled.
 * `available` gates robotics-only mechanisms.
 */
export async function handleDeleteSubcommand(
  rl: readline.Interface,
  mechanism: DeletionMechanism,
  subTokens: string[],
  available: boolean,
): Promise<boolean> {
  if (subTokens[0] !== 'delete') return false
  const adapter = makeDeletionAdapter(mechanism)
  if (!available) {
    console.log(yellow(`\n${adapter.command} delete 仅在 robotics 模式下可用。\n`))
    return true
  }
  if (subTokens[1] === 'review') {
    await handleDeleteReview(rl, adapter)
  } else {
    await handleDirectDelete(rl, adapter)
  }
  return true
}

