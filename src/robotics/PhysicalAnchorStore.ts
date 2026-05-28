import { homedir } from 'os'
import { join } from 'path'
import { atomicWriteJson, ensureDir, listJsonIds, readJsonFile } from '../core/persist/index.js'
import type {
  KnowledgeConfidenceTier,
  PhysicalAnchorEntry,
  PhysicalAnchorSearchQuery,
} from './types.js'
import { makePhysicalAnchorId } from './types.js'

const PHYSICAL_ANCHOR_ROOT = join(homedir(), '.claude', 'meta-agent', 'robotics', 'physical_anchors')
const PHYSICAL_ANCHOR_ID_RE = /^pa_[0-9a-z]+_[0-9a-f]{8}$/

const CONFIDENCE_WEIGHT: Record<KnowledgeConfidenceTier, number> = {
  reproduced: 500,
  observed:   450,
  derived:    425,
  reported:   250,
  hypothesis: 100,
}

export function isPhysicalAnchorId(id: string): boolean {
  return PHYSICAL_ANCHOR_ID_RE.test(id)
}

function anchorScore(anchor: PhysicalAnchorEntry): number {
  return CONFIDENCE_WEIGHT[anchor.confidenceTier] + Math.min(anchor.evidenceRefs.length, 8) * 10
}

export class PhysicalAnchorStore {
  private readonly dir: string

  constructor(dir?: string) {
    this.dir = dir ?? PHYSICAL_ANCHOR_ROOT
  }

  async ensureDir(): Promise<void> {
    await ensureDir(this.dir)
  }

  async write(
    entry: Omit<PhysicalAnchorEntry, 'id' | 'schemaVersion' | 'createdAt' | 'updatedAt'>,
  ): Promise<string> {
    await this.ensureDir()
    const id = makePhysicalAnchorId()
    const now = Date.now()
    const full: PhysicalAnchorEntry = {
      ...entry,
      id,
      schemaVersion: '1.0',
      createdAt: now,
      updatedAt: now,
    }
    await atomicWriteJson(join(this.dir, `${id}.json`), full)
    return id
  }

  async load(id: string): Promise<PhysicalAnchorEntry | null> {
    if (!isPhysicalAnchorId(id)) return null
    return readJsonFile<PhysicalAnchorEntry>(join(this.dir, `${id}.json`))
  }

  async search(query: PhysicalAnchorSearchQuery = {}): Promise<PhysicalAnchorEntry[]> {
    const limit = Math.min(query.limit ?? 10, 20)
    const entries = await this._loadAll()
    const filtered = entries.filter(anchor => {
      if (query.domain && anchor.domain !== query.domain) return false
      if (query.scope && anchor.scope !== query.scope) return false
      if (query.robot && anchor.scope === 'robot' && anchor.robot && anchor.robot !== query.robot) return false
      if (query.tags?.length) {
        const tags = anchor.tags.map(t => t.toLowerCase())
        if (!query.tags.every(t => tags.includes(t.toLowerCase()))) return false
      }
      if (query.keyword) {
        const kw = query.keyword.toLowerCase()
        const searchable = [
          anchor.title,
          anchor.fact,
          anchor.mechanism ?? '',
          anchor.implication,
          anchor.source ?? '',
        ].join(' ').toLowerCase()
        if (!searchable.includes(kw)) return false
      }
      return true
    })
    filtered.sort((a, b) => {
      const scoreDelta = anchorScore(b) - anchorScore(a)
      return scoreDelta !== 0 ? scoreDelta : b.createdAt - a.createdAt
    })
    return filtered.slice(0, limit)
  }

  async getStats(): Promise<{ total: number; domainCounts: Record<string, number> }> {
    const entries = await this._loadAll()
    const domainCounts: Record<string, number> = {}
    for (const entry of entries) {
      domainCounts[entry.domain] = (domainCounts[entry.domain] ?? 0) + 1
    }
    return { total: entries.length, domainCounts }
  }

  async formatForPrompt(opts: PhysicalAnchorSearchQuery = {}): Promise<string> {
    const anchors = await this.search({ ...opts, limit: opts.limit ?? 8 })
    if (anchors.length === 0) return ''
    const lines = ['## Physical Anchors']
    for (const anchor of anchors) {
      lines.push(
        `- [${anchor.id}] ${anchor.title} (${anchor.domain}, scope: ${anchor.scope}, confidence: ${anchor.confidenceTier})`,
        `  Fact: ${anchor.fact}`,
      )
      if (anchor.mechanism) lines.push(`  Mechanism: ${anchor.mechanism}`)
      lines.push(`  Implication: ${anchor.implication}`)
      if (anchor.robot) lines.push(`  Robot: ${anchor.robot}`)
      if (anchor.tags.length) lines.push(`  Tags: ${anchor.tags.slice(0, 6).join(', ')}`)
    }
    return lines.join('\n')
  }

  async listIds(): Promise<string[]> {
    const ids = await listJsonIds(this.dir)
    return ids.filter(isPhysicalAnchorId)
  }

  private async _loadAll(): Promise<PhysicalAnchorEntry[]> {
    const ids = await this.listIds()
    const entries = await Promise.all(ids.map(id => this.load(id)))
    return entries.filter((entry): entry is PhysicalAnchorEntry => entry !== null)
  }
}
