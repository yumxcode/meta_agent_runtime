/**
 * ResearchStore — durable, project-level registry of research deliverables.
 *
 * Core idea ("result on disk + handle in context"): a research sub-agent's
 * deliverable is written to disk and only a tiny handle (one-line conclusion +
 * report path) ever enters the main agent's context. After a compaction the
 * model recovers the material with a cheap `read_file <report_path>` instead
 * of re-running the whole search-fetch-summarize pipeline.
 *
 * Layout (project-level, survives sessions → cross-session reuse for free;
 * `.meta-agent/` is this runtime's standard project-local directory, alongside
 * `.meta-agent/skills` and `.meta-agent/AGENT.md`):
 *   <projectDir>/.meta-agent/research/index.json            registry (newest last)
 *   <projectDir>/.meta-agent/research/<taskId>/report.md    structured report
 *   <projectDir>/.meta-agent/research/<taskId>/sources.md   source list + raw excerpts
 *
 * Sync read path (`listSync`) exists because compact instruction/anchor thunks
 * resolve synchronously inside compactConversation().
 */

import { mkdir, readFile, rename, writeFile } from 'fs/promises'
import { readFileSync } from 'fs'
import { join, relative } from 'path'

export interface ResearchIndexEntry {
  taskId: string
  question: string
  status: 'success' | 'partial'
  /** One-line conclusion (clipped to CONCLUSION_MAX_CHARS). */
  conclusion: string
  /** Relative to projectDir, e.g. ".meta-agent/research/task_x/report.md". */
  reportPath: string
  sourcesPath?: string
  papersCovered?: number
  sessionId: string
  createdAt: number
}

export interface SaveResearchResultOptions {
  taskId: string
  question: string
  status: 'success' | 'partial'
  conclusion: string
  reportMarkdown: string
  sourcesMarkdown?: string
  papersCovered?: number
  sessionId: string
}

const CONCLUSION_MAX_CHARS = 300
const INDEX_MAX_ENTRIES = 200

function clip(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`
}

export function researchRootDir(projectDir: string): string {
  return join(projectDir, '.meta-agent', 'research')
}

function indexPath(projectDir: string): string {
  return join(researchRootDir(projectDir), 'index.json')
}

function parseIndex(raw: string): ResearchIndexEntry[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((e): e is ResearchIndexEntry =>
      !!e && typeof e === 'object' &&
      typeof (e as ResearchIndexEntry).taskId === 'string' &&
      typeof (e as ResearchIndexEntry).reportPath === 'string')
  } catch {
    return []
  }
}

export class ResearchStore {
  constructor(private readonly projectDir: string) {}

  get rootDir(): string {
    return researchRootDir(this.projectDir)
  }

  /**
   * Persist a research deliverable: write report/sources files, then append
   * the registry entry (atomic tmp+rename so a crash never corrupts the index).
   * Returns the registered entry (paths relative to projectDir).
   */
  async saveResult(opts: SaveResearchResultOptions): Promise<ResearchIndexEntry> {
    const taskDir = join(this.rootDir, opts.taskId)
    await mkdir(taskDir, { recursive: true })

    const reportAbs = join(taskDir, 'report.md')
    await writeFile(reportAbs, opts.reportMarkdown, 'utf-8')

    let sourcesPath: string | undefined
    if (opts.sourcesMarkdown?.trim()) {
      const sourcesAbs = join(taskDir, 'sources.md')
      await writeFile(sourcesAbs, opts.sourcesMarkdown, 'utf-8')
      sourcesPath = relative(this.projectDir, sourcesAbs)
    }

    const entry: ResearchIndexEntry = {
      taskId: opts.taskId,
      question: clip(opts.question, 200),
      status: opts.status,
      conclusion: clip(opts.conclusion, CONCLUSION_MAX_CHARS),
      reportPath: relative(this.projectDir, reportAbs),
      ...(sourcesPath ? { sourcesPath } : {}),
      ...(opts.papersCovered !== undefined ? { papersCovered: opts.papersCovered } : {}),
      sessionId: opts.sessionId,
      createdAt: Date.now(),
    }

    const existing = await this.list()
    const next = [...existing.filter(e => e.taskId !== entry.taskId), entry]
      .slice(-INDEX_MAX_ENTRIES)
    const tmp = indexPath(this.projectDir) + '.tmp'
    await writeFile(tmp, JSON.stringify(next, null, 2), 'utf-8')
    await rename(tmp, indexPath(this.projectDir))

    return entry
  }

  /** All registry entries, oldest → newest. */
  async list(): Promise<ResearchIndexEntry[]> {
    try {
      return parseIndex(await readFile(indexPath(this.projectDir), 'utf-8'))
    } catch {
      return []
    }
  }

  /**
   * Sync registry read for compact thunks (resolved synchronously inside
   * compactConversation). Returns newest-first, limited.
   */
  static listSync(projectDir: string, limit = 8): ResearchIndexEntry[] {
    try {
      const entries = parseIndex(readFileSync(indexPath(projectDir), 'utf-8'))
      return entries.slice(-limit).reverse()
    } catch {
      return []
    }
  }
}

/**
 * Deterministic compact anchor block for persisted research deliverables.
 *
 * Appended (via the mode layer's deterministicAnchors thunk) to every compact
 * summary so that, post-compaction, the model re-READS the report files
 * instead of re-RUNNING the research — the post-compact "files need
 * re-reading" reminder then points at exactly the right recovery action.
 * Soft constraint by design: no dedupe/forcing at the tool layer.
 *
 * Returns null when no research artifacts exist.
 */
export function buildResearchArtifactAnchors(
  projectDir: string | undefined,
  limit = 8,
): string | null {
  if (!projectDir) return null
  const entries = ResearchStore.listSync(projectDir, limit)
  if (entries.length === 0) return null

  const lines = entries.map(entry => {
    const papers = entry.papersCovered !== undefined ? ` · ${entry.papersCovered} sources` : ''
    return [
      `- [${entry.status}] ${entry.question}${papers}`,
      `  conclusion: ${entry.conclusion}`,
      `  → read_file ${entry.reportPath}${entry.sourcesPath ? `  (sources: ${entry.sourcesPath})` : ''}`,
    ].join('\n')
  })

  return [
    '### Persisted Research Reports (durable on disk)',
    '- These research results are SAVED AS FILES and survive compaction.',
    '- To recover details: re-READ the report file with `read_file`. Do NOT re-run the research or re-fetch the papers — that wastes minutes and tokens reproducing what is already on disk.',
    '',
    ...lines,
  ].join('\n')
}
