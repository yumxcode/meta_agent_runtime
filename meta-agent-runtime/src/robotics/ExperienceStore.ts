import { createHash } from 'crypto'
import { mkdir, readFile, readdir, rename, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { ExperienceEntry, ExperienceSearchQuery, RoboticsDomain } from './types.js'
import { makeExperienceId } from './types.js'

const EXPERIENCE_ROOT = join(homedir(), '.claude', 'meta-agent', 'robotics', 'experiences')
const INDEX_FILE = 'EXPERIENCE_INDEX.md'
const MAX_INDEX_ENTRIES = 100   // hard cap on index entries shown

export class ExperienceStore {
  private readonly dir: string
  private readonly indexPath: string

  constructor(dir?: string) {
    this.dir = dir ?? EXPERIENCE_ROOT
    this.indexPath = join(this.dir, INDEX_FILE)
  }

  async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true })
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
    const tmp = file + '.tmp'
    await writeFile(tmp, JSON.stringify(full, null, 2), 'utf-8')
    await rename(tmp, file)
    await this.rebuildIndex()
    return id
  }

  // ── Search ──────────────────────────────────────────────────────────────────

  async search(query: ExperienceSearchQuery): Promise<ExperienceEntry[]> {
    const limit = Math.min(query.limit ?? 10, 20)
    const entries = await this._loadAll()
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
    // sort by createdAt descending
    filtered.sort((a, b) => b.createdAt - a.createdAt)
    // strip fullReport from search results
    return filtered.slice(0, limit).map(e => { const { fullReport: _, ...rest } = e; return rest as ExperienceEntry })
  }

  // ── Load by ID ───────────────────────────────────────────────────────────────

  async load(id: string): Promise<ExperienceEntry | null> {
    const file = join(this.dir, `${id}.json`)
    try {
      const raw = await readFile(file, 'utf-8')
      return JSON.parse(raw) as ExperienceEntry
    } catch { return null }
  }

  // ── Index ───────────────────────────────────────────────────────────────────

  async loadIndexMarkdown(): Promise<string> {
    try {
      return await readFile(this.indexPath, 'utf-8')
    } catch { return '' }
  }

  async rebuildIndex(): Promise<void> {
    const entries = await this._loadAll()
    entries.sort((a, b) => b.createdAt - a.createdAt)

    // Group by domain
    const byDomain = new Map<RoboticsDomain, ExperienceEntry[]>()
    for (const e of entries.slice(0, MAX_INDEX_ENTRIES)) {
      const list = byDomain.get(e.domain) ?? []
      list.push(e)
      byDomain.set(e.domain, list)
    }

    const lines: string[] = [
      `# Experience Index`,
      `*Last updated: ${new Date().toISOString().slice(0, 16).replace('T', ' ')} | Total: ${entries.length} entries*`,
      '',
    ]
    for (const [domain, domEntries] of byDomain) {
      lines.push(`## ${domain} (${domEntries.length})`)
      for (const e of domEntries) {
        const icon = e.outcome.success ? '✓' : '✗'
        const tags = e.tags.slice(0, 4).join(', ')
        lines.push(`- [${e.id}] **${e.title}** | ${icon} ${e.outcome.summary.slice(0, 60)} | tags: ${tags}`)
      }
      lines.push('')
    }
    lines.push('## Quick Search')
    lines.push('`experience_search domain=<domain> tags=<tag1,tag2> keyword=<word>`')
    lines.push('`experience_load id=<id>` — load full entry with report')

    const tmp = this.indexPath + '.tmp'
    await writeFile(tmp, lines.join('\n'), 'utf-8')
    await rename(tmp, this.indexPath)
  }

  async listIds(): Promise<string[]> {
    try {
      const files = await readdir(this.dir)
      return files.filter(f => f.startsWith('exp_') && f.endsWith('.json')).map(f => f.replace('.json', ''))
    } catch { return [] }
  }

  // ── Internal ─────────────────────────────────────────────────────────────────

  private async _loadAll(): Promise<ExperienceEntry[]> {
    const ids = await this.listIds()
    const entries = await Promise.all(ids.map(id => this.load(id)))
    return entries.filter((e): e is ExperienceEntry => e !== null)
  }
}
