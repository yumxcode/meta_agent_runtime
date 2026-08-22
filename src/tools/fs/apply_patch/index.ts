import { readFile, writeFile, mkdir, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { MetaAgentTool, ToolCallContext, ToolResult } from '../../../core/types.js'
import { loadToolPrompt } from '../../util.js'
import { resolveInsideWorkspace } from '../workspaceGuard.js'
import {
  parsePatch,
  applyHunks,
  describeOperations,
  PatchParseError,
  PatchApplyError,
  type PatchOperation,
} from '../../../infra/fs/patchFormat.js'
import { diffStat } from '../../../infra/fs/unifiedDiff.js'

/** Same ceiling `edit_file` uses — a file too large to edit safely is also too large to patch. */
const MAX_PATCH_TARGET_BYTES = 5 * 1024 * 1024

/** A resolved, validated operation with its final bytes already computed. */
interface PlannedWrite {
  /** Canonical absolute path being written (or removed). */
  path: string
  /** Path as written in the patch, for messages. */
  displayPath: string
  action: 'add' | 'update' | 'delete' | 'move'
  /** Final contents; null means "remove this path". */
  contents: string | null
  /** For a move: the original path that must be removed after the write. */
  removePath?: string
  added: number
  removed: number
}

export async function createApplyPatchTool(): Promise<MetaAgentTool> {
  const description = await loadToolPrompt(import.meta.url)
  return {
    name: 'apply_patch',
    abortSupport: 'bounded',
    description,
    permission: {
      category: 'write',
      // No pathFields: the paths live INSIDE the patch text, not in a
      // declarable field, so this tool validates every one of them itself
      // against `resolveInsideWorkspace` before planning any write. Declaring a
      // field the kernel could not parse would be worse than declaring none —
      // it would look protected without being so.
      requiresWorkspace: true,
      sensitive: false,
      planMode: 'ask',
    },
    inputSchema: {
      type: 'object',
      properties: {
        patch: {
          type: 'string',
          description:
            'The patch envelope, from "*** Begin Patch" to "*** End Patch".',
        },
      },
      required: ['patch'],
    },
    async call(input: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolResult> {
      const patchText = input['patch']
      if (typeof patchText !== 'string' || !patchText.trim()) {
        return { content: 'Error: patch is required', isError: true }
      }

      let ops: PatchOperation[]
      try {
        ops = parsePatch(patchText)
      } catch (err) {
        if (err instanceof PatchParseError) {
          return { content: `Patch parse error: ${err.message}`, isError: true }
        }
        throw err
      }

      // ── Phase 1: resolve + validate every path BEFORE touching anything ────
      const resolved: { op: PatchOperation; path: string; movePath?: string }[] = []
      for (const op of ops) {
        const target = resolveInsideWorkspace(op.path, ctx.workspaceRoot)
        if (!target.ok) return { content: `${target.error} (in patch)`, isError: true }
        let movePath: string | undefined
        if (op.kind === 'update' && op.movePath) {
          const moved = resolveInsideWorkspace(op.movePath, ctx.workspaceRoot)
          if (!moved.ok) return { content: `${moved.error} (move target)`, isError: true }
          movePath = moved.path
        }
        resolved.push({ op, path: target.path, ...(movePath ? { movePath } : {}) })
      }

      // Hold the write lock across plan AND apply. Validating against content a
      // concurrent sub-agent then changes would let a patch apply cleanly to a
      // file that no longer looks like what it was checked against.
      const locks: (() => void)[] = []
      if (ctx.writeMutex) {
        // Sorted so two concurrent patches acquire shared paths in the same
        // order and cannot deadlock against each other.
        const paths = [...new Set(resolved.flatMap(r => [r.path, r.movePath ?? r.path]))].sort()
        for (const p of paths) locks.push(await ctx.writeMutex.acquire(p))
      }

      try {
        // ── Phase 2: compute every final content in memory ──────────────────
        const plan: PlannedWrite[] = []
        for (const { op, path, movePath } of resolved) {
          try {
            plan.push(await planOne(op, path, movePath, ctx))
          } catch (err) {
            if (err instanceof PatchApplyError) {
              return { content: `Patch failed (nothing was written): ${err.message}`, isError: true }
            }
            return {
              content:
                `Patch failed (nothing was written): ${op.path}: ` +
                `${err instanceof Error ? err.message : String(err)}`,
              isError: true,
            }
          }
        }

        // Tell the turn tracker about every path we are about to touch, while
        // the OLD bytes are still on disk. After the writes it is too late.
        const touched = plan.flatMap(p => (p.removePath ? [p.path, p.removePath] : [p.path]))
        await ctx.turnDiff?.captureAll(touched)

        // ── Phase 3: write, rolling back on failure ─────────────────────────
        const undo: (() => Promise<void>)[] = []
        try {
          for (const entry of plan) {
            const priorExists = await exists(entry.path)
            const prior = priorExists ? await readFile(entry.path, 'utf-8') : null
            undo.push(async () => {
              if (prior === null) await rm(entry.path, { force: true })
              else await writeFile(entry.path, prior, 'utf-8')
            })

            if (entry.contents === null) {
              await rm(entry.path, { force: true })
            } else {
              await mkdir(dirname(entry.path), { recursive: true })
              await writeFile(entry.path, entry.contents, 'utf-8')
            }

            if (entry.removePath) {
              const movedFrom = entry.removePath
              const original = await readFile(movedFrom, 'utf-8')
              undo.push(async () => { await writeFile(movedFrom, original, 'utf-8') })
              await rm(movedFrom, { force: true })
            }
          }
        } catch (err) {
          // Roll back in reverse order. A partially-applied multi-file patch is
          // the exact failure this tool exists to prevent, so a write error
          // must not be allowed to produce one.
          for (const step of undo.reverse()) {
            try { await step() } catch { /* best effort */ }
          }
          return {
            content:
              `Patch failed while writing and was rolled back: ` +
              `${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          }
        }

        // Refresh the read-snapshot cache for every file we wrote, so a
        // follow-up edit_file in the same turn does not trip the TOCTOU guard
        // on bytes this tool itself just wrote.
        for (const entry of plan) {
          if (entry.contents === null) continue
          try {
            const after = await stat(entry.path)
            ctx.readFileState?.record?.(entry.path, after.size, after.mtimeMs)
          } catch { /* best-effort */ }
        }

        const lines = plan.map(renderPlanLine)
        const totals = plan.reduce(
          (acc, p) => ({ added: acc.added + p.added, removed: acc.removed + p.removed }),
          { added: 0, removed: 0 },
        )
        return {
          content:
            `Applied patch: ${describeOperations(ops)} ` +
            `(+${totals.added} -${totals.removed})\n${lines.join('\n')}`,
          isError: false,
        }
      } finally {
        for (const release of locks) release()
      }
    },
  }
}

async function planOne(
  op: PatchOperation,
  path: string,
  movePath: string | undefined,
  ctx: ToolCallContext,
): Promise<PlannedWrite> {
  if (op.kind === 'add') {
    if (await exists(path)) {
      throw new PatchApplyError(
        'file already exists — use "*** Update File:" to change it',
        op.path,
      )
    }
    const { added } = diffStat('', op.contents)
    return {
      path, displayPath: op.path, action: 'add',
      contents: op.contents, added, removed: 0,
    }
  }

  if (op.kind === 'delete') {
    if (!(await exists(path))) {
      throw new PatchApplyError('file does not exist', op.path)
    }
    const current = await readFile(path, 'utf-8')
    const { removed } = diffStat(current, '')
    return {
      path, displayPath: op.path, action: 'delete',
      contents: null, added: 0, removed,
    }
  }

  // update
  const info = await stat(path).catch(() => null)
  if (!info || !info.isFile()) {
    throw new PatchApplyError('file does not exist', op.path)
  }
  if (info.size > MAX_PATCH_TARGET_BYTES) {
    throw new PatchApplyError(
      `file is too large to patch safely (${info.size} bytes)`,
      op.path,
    )
  }

  // Same TOCTOU defence edit_file applies: if read_file snapshotted this file
  // and it has drifted since, the hunks were written against contents that are
  // no longer there. They might still MATCH — and applying them anyway would
  // silently clobber whatever changed it.
  const snapshot = ctx.readFileState?.get?.(path)
  if (snapshot) {
    const sizeChanged = snapshot.sizeBytes !== info.size
    const mtimeChanged =
      snapshot.mtimeMs !== undefined &&
      Number.isFinite(info.mtimeMs) &&
      Math.abs(info.mtimeMs - snapshot.mtimeMs) > 1
    if (sizeChanged || mtimeChanged) {
      throw new PatchApplyError(
        'changed on disk since it was last read — re-read it (read_file) and rebuild the patch',
        op.path,
      )
    }
  }

  const original = await readFile(path, 'utf-8')
  const updated = applyHunks(original, op.hunks, op.path)
  const { added, removed } = diffStat(original, updated)

  if (movePath) {
    if (movePath !== path && (await exists(movePath))) {
      throw new PatchApplyError(`move target already exists: ${op.movePath}`, op.path)
    }
    return {
      path: movePath,
      displayPath: `${op.path} → ${op.movePath}`,
      action: 'move',
      contents: updated,
      removePath: path,
      added, removed,
    }
  }

  return {
    path, displayPath: op.path, action: 'update',
    contents: updated, added, removed,
  }
}

function renderPlanLine(entry: PlannedWrite): string {
  const marker =
    entry.action === 'add' ? 'A'
      : entry.action === 'delete' ? 'D'
      : entry.action === 'move' ? 'R'
      : 'M'
  return `  ${marker} ${entry.displayPath}  +${entry.added} -${entry.removed}`
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
