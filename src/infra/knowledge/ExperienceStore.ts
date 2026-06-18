import { readFile, readdir, rm } from 'fs/promises'
import { homedir } from 'os'
import { META_AGENT_HOME } from '../metaAgentHome.js'
import { join } from 'path'
import {
  atomicWriteFile,
  atomicWriteJson,
  readJsonFile,
  ensureDir,
  withFileLock,
  listJsonIds,
} from '../persist/index.js'
import type { ExperienceEntry, ExperienceSearchQuery, KnowledgeConfidenceTier, KnowledgeDomain } from './types.js'
import { makeExperienceId } from './types.js'

const EXPERIENCE_ROOT = join(META_AGENT_HOME, 'robotics', 'experiences')
const INDEX_FILE = 'EXPERIENCE_INDEX.md'
const MANIFEST_FILE = 'EXPERIENCE_MANIFEST.json'
const SEARCH_INDEX_DIR = 'search-index'
const SUMMARY_FILE = 'EXPERIENCE_INDEX_SUMMARY.json'
const MAX_INDEX_ENTRIES = 100   // hard cap on index entries shown
const LOAD_CONCURRENCY = 32
const EXPERIENCE_ID_RE = /^exp_[0-9a-z]+_[0-9a-f]{8}$/

type ExperienceSearchEntry = Omit<ExperienceEntry, 'fullReport'>

interface ExperienceManifest {
  schemaVersion: '1.0'
  updatedAt: number
  entries: ExperienceSearchEntry[]
}

interface ExperienceIndexSummary {
  schemaVersion: '1.0'
  updatedAt: number
  total: number
  failures: number
  domainCounts: Record<string, number>
  latest: ExperienceSearchEntry[]
}

export function isExperienceId(id: string): boolean {
  return EXPERIENCE_ID_RE.test(id)
}

const CONFIDENCE_WEIGHT: Record<KnowledgeConfidenceTier, number> = {
  reproduced: 500,
  observed:   400,
  derived:    350,
  reported:   200,
  hypothesis: 100,
}

export function experienceRetrievalScore(entry: ExperienceEntry): number {
  const tier = entry.confidenceTier ?? 'observed'
  const observations = Math.max(1, entry.observationCount ?? 1)
  const contradictions = Math.max(0, entry.contradictionCount ?? 0)
  return CONFIDENCE_WEIGHT[tier] + Math.min(observations, 10) * 8 - contradictions * 40
}

export class ExperienceStore {
  private readonly dir: string
  private readonly indexPath: string
  private readonly manifestPath: string
  private readonly searchIndexDir: string
  private readonly summaryPath: string

  constructor(dir?: string) {
    this.dir = dir ?? EXPERIENCE_ROOT
    this.indexPath = join(this.dir, INDEX_FILE)
    this.manifestPath = join(this.dir, MANIFEST_FILE)
    this.searchIndexDir = join(this.dir, SEARCH_INDEX_DIR)
    this.summaryPath = join(this.dir, SUMMARY_FILE)
  }

  async ensureDir(): Promise<void> {
    await ensureDir(this.dir)
  }

  // ── Write ───────────────────────────────────────────────────────────────────

  async write(
    entry: Omit<ExperienceEntry, 'id' | 'schemaVersion' | 'createdAt' | 'updatedAt'>,
  ): Promise<string> {
    await this.ensureDir()
    const id = makeExperienceId()
    const full: ExperienceEntry = {
      ...entry,
      id,
      schemaVersion: '1.0',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    const file = join(this.dir, `${id}.json`)
    await atomicWriteJson(file, full)
    await this._upsertIndexEntry(full)
    return id
  }

  // ── Search ──────────────────────────────────────────────────────────────────

  async search(query: ExperienceSearchQuery): Promise<ExperienceEntry[]> {
    const limit = Math.min(query.limit ?? 10, 20)
    const entries = await this._loadSearchEntries()
    const filtered = entries.filter(e => {
      if (query.domain && e.domain !== query.domain) return false
      if (query.robot && e.robot !== query.robot) return false
      if (query.algorithm && e.algorithm?.toLowerCase() !== query.algorithm.toLowerCase()) return false
      if (query.successOnly && !e.outcome.success) return false
      if (query.tags?.length) {
        const haystack = e.tags.map(t => t.toLowerCase())
        if (!query.tags.every(t => haystack.includes(t.toLowerCase()))) return false
      }
      if (query.keyword) {
        const kw = query.keyword.toLowerCase()
        const searchable = `${e.title} ${e.problem} ${e.solution}`.toLowerCase()
        if (!searchable.includes(kw)) return false
      }
      return true
    })
    // Prefer stronger evidence; keep recency as a tiebreaker.
    filtered.sort((a, b) => {
      const scoreDelta = experienceRetrievalScore(b) - experienceRetrievalScore(a)
      return scoreDelta !== 0 ? scoreDelta : b.createdAt - a.createdAt
    })
    // strip fullReport from search results
    return filtered.slice(0, limit) as ExperienceEntry[]
  }

  // ── Load by ID ───────────────────────────────────────────────────────────────

  async load(id: string): Promise<ExperienceEntry | null> {
    if (!isExperienceId(id)) return null
    return readJsonFile<ExperienceEntry>(join(this.dir, `${id}.json`))
  }

  async appendPrincipleReference(experienceId: string, principleId: string): Promise<boolean> {
    if (!isExperienceId(experienceId)) return false
    const entry = await this.load(experienceId)
    if (!entry) return false
    const principleIds = entry.principleIds ?? []
    if (principleIds.includes(principleId)) return true
    const updated: ExperienceEntry = {
      ...entry,
      principleIds: [...principleIds, principleId],
      updatedAt: Date.now(),
    }
    await atomicWriteJson(join(this.dir, `${experienceId}.json`), updated)
    await this._upsertIndexEntry(updated)
    return true
  }

  /** Link a physical anchor this experience applied/validated/contradicted. Idempotent. */
  async appendAnchorReference(experienceId: string, anchorId: string): Promise<boolean> {
    if (!isExperienceId(experienceId)) return false
    const entry = await this.load(experienceId)
    if (!entry) return false
    const anchorIds = entry.anchorIds ?? []
    if (anchorIds.includes(anchorId)) return true
    const updated: ExperienceEntry = {
      ...entry,
      anchorIds: [...anchorIds, anchorId],
      updatedAt: Date.now(),
    }
    await atomicWriteJson(join(this.dir, `${experienceId}.json`), updated)
    await this._upsertIndexEntry(updated)
    return true
  }

  /**
   * Permanently delete a committed experience by ID and rebuild the index.
   * Returns true if the file existed and was removed.
   */
  async delete(id: string): Promise<boolean> {
    if (!isExperienceId(id)) return false
    const file = join(this.dir, `${id}.json`)
    try {
      await rm(file)
    } catch {
      return false
    }
    await this._removeIndexEntry(id)
    return true
  }

  async getStats(): Promise<{ total: number; failures: number; domainCounts: Record<string, number> }> {
    const entries = await this._loadSearchEntries()
    const domainCounts: Record<string, number> = {}
    let failures = 0
    for (const e of entries) {
      if (!e.outcome.success) failures += 1
      domainCounts[e.domain] = (domainCounts[e.domain] ?? 0) + 1
    }
    return { total: entries.length, failures, domainCounts }
  }

  // ── Index ───────────────────────────────────────────────────────────────────

  async loadIndexMarkdown(): Promise<string> {
    try {
      return await readFile(this.indexPath, 'utf-8')
    } catch { return '' }
  }

  async rebuildIndex(): Promise<void> {
    await withFileLock(this.summaryPath, async () => {
      const entries = await this._loadAllFromFiles()
      entries.sort((a, b) => b.createdAt - a.createdAt)
      await rm(this.searchIndexDir, { recursive: true, force: true })
      await ensureDir(this.searchIndexDir)
      await Promise.all(entries.map(entry =>
        atomicWriteJson(this._searchEntryPath(entry.id), stripFullReport(entry)),
      ))
      await this._writeSummaryAndMarkdown(entries.map(stripFullReport))
    })
  }

  private async _writeIndexMarkdown(
    entries: ExperienceSearchEntry[],
    total = entries.length,
  ): Promise<void> {
    // Group by domain
    const byDomain = new Map<KnowledgeDomain, ExperienceSearchEntry[]>()
    for (const e of entries.slice(0, MAX_INDEX_ENTRIES)) {
      const list = byDomain.get(e.domain) ?? []
      list.push(e)
      byDomain.set(e.domain, list)
    }

    const lines: string[] = [
      `# Experience Index`,
      `*Last updated: ${new Date().toISOString().slice(0, 16).replace('T', ' ')} | Total: ${total} entries*`,
      '',
    ]
    for (const [domain, domEntries] of byDomain) {
      lines.push(`## ${domain} (${domEntries.length})`)
      for (const e of domEntries) {
        const icon = e.outcome.success ? '✓' : '✗'
        const tags = e.tags.slice(0, 4).join(', ')
        const confidence = e.confidenceTier ?? 'observed'
        lines.push(`- [${e.id}] **${e.title}** | ${icon} ${e.outcome.summary.slice(0, 60)} | confidence: ${confidence} | tags: ${tags}`)
      }
      lines.push('')
    }
    lines.push('## Quick Search')
    lines.push('`experience_search domain=<domain> tags=<tag1,tag2> keyword=<word>`')
    lines.push('`experience_load id=<id>` — load full entry with report')

    // Index is Markdown not JSON — atomicWriteFile gives crash-safe rename
    // without JSON.stringify wrapping.
    await atomicWriteFile(this.indexPath, lines.join('\n'))
  }

  async listIds(): Promise<string[]> {
    try {
      const files = await readdir(this.dir)
      return files
        .filter(f => f.endsWith('.json'))
        .map(f => f.replace('.json', ''))
        .filter(isExperienceId)
    } catch { return [] }
  }

  // ── Internal ─────────────────────────────────────────────────────────────────

  private async _loadAll(): Promise<ExperienceEntry[]> {
    return this._loadAllFromFiles()
  }

  private async _loadAllFromFiles(): Promise<ExperienceEntry[]> {
    const ids = await this.listIds()
    return loadWithConcurrency(ids, id => this.load(id))
  }

  private async _loadSearchEntries(): Promise<ExperienceSearchEntry[]> {
    await this._ensureIncrementalIndex()
    const ids = await listJsonIds(this.searchIndexDir)
    return loadWithConcurrency(
      ids,
      id => readJsonFile<ExperienceSearchEntry>(this._searchEntryPath(id)),
    )
  }

  private async _upsertIndexEntry(entry: ExperienceEntry): Promise<void> {
    await this._ensureIncrementalIndex()
    await withFileLock(this.summaryPath, async () => {
      const path = this._searchEntryPath(entry.id)
      const previous = await readJsonFile<ExperienceSearchEntry>(path)
      const compact = stripFullReport(entry)
      await atomicWriteJson(path, compact)
      const summary = await readJsonFile<ExperienceIndexSummary>(this.summaryPath)
      if (!isExperienceIndexSummary(summary)) {
        await this._rebuildSummaryFromSearchIndex()
        return
      }
      if (!previous) summary.total++
      if (previous?.outcome.success === false) summary.failures--
      if (!compact.outcome.success) summary.failures++
      if (previous) {
        summary.domainCounts[previous.domain] =
          Math.max(0, (summary.domainCounts[previous.domain] ?? 1) - 1)
      }
      summary.domainCounts[compact.domain] =
        (summary.domainCounts[compact.domain] ?? 0) + 1
      summary.latest = [
        compact,
        ...summary.latest.filter(existing => existing.id !== compact.id),
      ]
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, MAX_INDEX_ENTRIES)
      await this._persistSummary(summary)
    })
  }

  private async _removeIndexEntry(id: string): Promise<void> {
    await this._ensureIncrementalIndex()
    await withFileLock(this.summaryPath, async () => {
      const path = this._searchEntryPath(id)
      const previous = await readJsonFile<ExperienceSearchEntry>(path)
      await rm(path, { force: true })
      const summary = await readJsonFile<ExperienceIndexSummary>(this.summaryPath)
      if (!previous || !isExperienceIndexSummary(summary)) {
        await this._rebuildSummaryFromSearchIndex()
        return
      }
      summary.total = Math.max(0, summary.total - 1)
      if (!previous.outcome.success) summary.failures = Math.max(0, summary.failures - 1)
      summary.domainCounts[previous.domain] =
        Math.max(0, (summary.domainCounts[previous.domain] ?? 1) - 1)
      summary.latest = summary.latest.filter(existing => existing.id !== id)
      await this._persistSummary(summary)
    })
  }

  private async _ensureIncrementalIndex(): Promise<void> {
    if (isExperienceIndexSummary(
      await readJsonFile<ExperienceIndexSummary>(this.summaryPath),
    )) return
    await withFileLock(this.summaryPath, async () => {
      if (isExperienceIndexSummary(
        await readJsonFile<ExperienceIndexSummary>(this.summaryPath),
      )) return
      const indexedIds = await listJsonIds(this.searchIndexDir)
      const legacy = await readJsonFile<ExperienceManifest>(this.manifestPath)
      const entries = indexedIds.length > 0
        ? await loadWithConcurrency(
            indexedIds,
            id => readJsonFile<ExperienceSearchEntry>(this._searchEntryPath(id)),
          )
        : isExperienceManifest(legacy)
          ? legacy.entries
          : (await this._loadAllFromFiles()).map(stripFullReport)
      await ensureDir(this.searchIndexDir)
      await Promise.all(entries.map(entry =>
        atomicWriteJson(this._searchEntryPath(entry.id), entry),
      ))
      await this._writeSummaryAndMarkdown(entries)
    })
  }

  private async _rebuildSummaryFromSearchIndex(): Promise<void> {
    const ids = await listJsonIds(this.searchIndexDir)
    const entries = await loadWithConcurrency(
      ids,
      id => readJsonFile<ExperienceSearchEntry>(this._searchEntryPath(id)),
    )
    await this._writeSummaryAndMarkdown(entries)
  }

  private async _writeSummaryAndMarkdown(entries: ExperienceSearchEntry[]): Promise<void> {
    const domainCounts: Record<string, number> = {}
    let failures = 0
    for (const entry of entries) {
      domainCounts[entry.domain] = (domainCounts[entry.domain] ?? 0) + 1
      if (!entry.outcome.success) failures++
    }
    const summary: ExperienceIndexSummary = {
      schemaVersion: '1.0',
      updatedAt: Date.now(),
      total: entries.length,
      failures,
      domainCounts,
      latest: [...entries]
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, MAX_INDEX_ENTRIES),
    }
    await this._persistSummary(summary)
  }

  private async _persistSummary(summary: ExperienceIndexSummary): Promise<void> {
    summary.updatedAt = Date.now()
    await atomicWriteJson(this.summaryPath, summary)
    await this._writeIndexMarkdown(summary.latest, summary.total)
  }

  private _searchEntryPath(id: string): string {
    return join(this.searchIndexDir, `${id}.json`)
  }
}

function stripFullReport(entry: ExperienceEntry): ExperienceSearchEntry {
  const { fullReport: _, ...rest } = entry
  return rest
}

function isExperienceManifest(value: unknown): value is ExperienceManifest {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return record['schemaVersion'] === '1.0' &&
    typeof record['updatedAt'] === 'number' &&
    Array.isArray(record['entries'])
}

function isExperienceIndexSummary(value: unknown): value is ExperienceIndexSummary {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return record['schemaVersion'] === '1.0' &&
    typeof record['updatedAt'] === 'number' &&
    typeof record['total'] === 'number' &&
    typeof record['failures'] === 'number' &&
    Boolean(record['domainCounts']) &&
    Array.isArray(record['latest'])
}

async function loadWithConcurrency<T>(
  ids: string[],
  load: (id: string) => Promise<T | null>,
): Promise<T[]> {
  const out: T[] = []
  let next = 0
  const workerCount = Math.min(LOAD_CONCURRENCY, ids.length)
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (next < ids.length) {
      const id = ids[next++]
      const entry = await load(id)
      if (entry) out.push(entry)
    }
  }))
  return out
}
