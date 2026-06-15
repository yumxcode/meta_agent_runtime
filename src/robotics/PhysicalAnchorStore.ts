import { rm } from 'fs/promises'
import { homedir } from 'os'
import { META_AGENT_HOME } from '../core/metaAgentHome.js'
import { join } from 'path'
import { atomicWriteJson, ensureDir, listJsonIds, readJsonFile } from '../core/persist/index.js'
import type {
  KnowledgeConfidenceTier,
  PhysicalAnchorEntry,
  PhysicalAnchorSearchQuery,
} from './types.js'
import { makePhysicalAnchorId } from './types.js'

const PHYSICAL_ANCHOR_ROOT = join(META_AGENT_HOME, 'robotics', 'physical_anchors')
const MANIFEST_FILE = 'PHYSICAL_ANCHOR_MANIFEST.json'
const LOAD_CONCURRENCY = 32
const PHYSICAL_ANCHOR_ID_RE = /^pa_[0-9a-z]+_[0-9a-f]{8}$/

interface PhysicalAnchorManifest {
  schemaVersion: '1.0'
  updatedAt: number
  entries: PhysicalAnchorEntry[]
}

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
  return CONFIDENCE_WEIGHT[anchor.confidenceTier]
    + Math.min(anchor.evidenceRefs.length, 8) * 10
    + Math.min(anchor.observationCount ?? 0, 10) * 8
    - (anchor.contradictionCount ?? 0) * 50
}

export class PhysicalAnchorStore {
  private readonly dir: string
  private readonly manifestPath: string

  constructor(dir?: string) {
    this.dir = dir ?? PHYSICAL_ANCHOR_ROOT
    this.manifestPath = join(this.dir, MANIFEST_FILE)
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
    await this._upsertManifest(full).catch(() => undefined)
    return id
  }

  async load(id: string): Promise<PhysicalAnchorEntry | null> {
    if (!isPhysicalAnchorId(id)) return null
    return readJsonFile<PhysicalAnchorEntry>(join(this.dir, `${id}.json`))
  }

  /**
   * Record a later experiment outcome against a committed anchor:
   *   - 'observation'   → an experiment corroborated the physical fact (raises score)
   *   - 'contradiction' → an experiment observed the fact NOT to hold (lowers score by
   *     50, so a falsified anchor sinks in search and surfaces for human re-review).
   * Returns the updated entry, or null when the anchor does not exist.
   */
  async recordOutcomeSignal(
    id: string,
    kind: 'observation' | 'contradiction',
  ): Promise<PhysicalAnchorEntry | null> {
    const a = await this.load(id)
    if (!a) return null
    const updated: PhysicalAnchorEntry = {
      ...a,
      observationCount: (a.observationCount ?? 0) + (kind === 'observation' ? 1 : 0),
      contradictionCount: (a.contradictionCount ?? 0) + (kind === 'contradiction' ? 1 : 0),
      lastVerifiedAt: kind === 'observation' ? Date.now() : a.lastVerifiedAt,
      updatedAt: Date.now(),
    }
    await atomicWriteJson(join(this.dir, `${id}.json`), updated)
    await this._upsertManifest(updated).catch(() => undefined)
    return updated
  }

  recordObservation(id: string): Promise<PhysicalAnchorEntry | null> {
    return this.recordOutcomeSignal(id, 'observation')
  }

  recordContradiction(id: string): Promise<PhysicalAnchorEntry | null> {
    return this.recordOutcomeSignal(id, 'contradiction')
  }

  /**
   * Back-link a committed principle that cites this anchor as physical support.
   * Enables contradiction propagation (anchor falsified → flag dependent principles).
   * Returns true when the anchor exists (idempotent on duplicates).
   */
  async appendPrincipleReference(anchorId: string, principleId: string): Promise<boolean> {
    const a = await this.load(anchorId)
    if (!a) return false
    const principleIds = a.principleIds ?? []
    if (principleIds.includes(principleId)) return true
    const updated: PhysicalAnchorEntry = {
      ...a,
      principleIds: [...principleIds, principleId],
      updatedAt: Date.now(),
    }
    await atomicWriteJson(join(this.dir, `${anchorId}.json`), updated)
    await this._upsertManifest(updated).catch(() => undefined)
    return true
  }

  /**
   * Permanently delete a committed physical anchor by ID and rebuild the manifest.
   * Returns true if the file existed and was removed.
   */
  async delete(id: string): Promise<boolean> {
    if (!isPhysicalAnchorId(id)) return false
    try {
      await rm(join(this.dir, `${id}.json`))
    } catch {
      return false
    }
    await this._rebuildManifestFromFiles().catch(() => undefined)
    return true
  }

  async search(query: PhysicalAnchorSearchQuery = {}): Promise<PhysicalAnchorEntry[]> {
    const limit = Math.min(query.limit ?? 10, 20)
    const entries = await this._loadManifestEntries()
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

  async getStats(): Promise<{ total: number; domainCounts: Record<string, number>; scopeCounts: Record<string, number> }> {
    const entries = await this._loadManifestEntries()
    const domainCounts: Record<string, number> = {}
    const scopeCounts: Record<string, number> = { global: 0, robot: 0, code: 0 }
    for (const entry of entries) {
      domainCounts[entry.domain] = (domainCounts[entry.domain] ?? 0) + 1
      scopeCounts[entry.scope] = (scopeCounts[entry.scope] ?? 0) + 1
    }
    return { total: entries.length, domainCounts, scopeCounts }
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
    return this._loadAllFromFiles()
  }

  private async _loadAllFromFiles(): Promise<PhysicalAnchorEntry[]> {
    const ids = await this.listIds()
    return loadWithConcurrency(ids, id => this.load(id))
  }

  private async _loadManifestEntries(): Promise<PhysicalAnchorEntry[]> {
    const manifest = await readJsonFile<PhysicalAnchorManifest>(this.manifestPath)
    if (isPhysicalAnchorManifest(manifest)) return manifest.entries
    return this._rebuildManifestFromFiles()
  }

  private async _rebuildManifestFromFiles(): Promise<PhysicalAnchorEntry[]> {
    const entries = await this._loadAllFromFiles()
    await this._writeManifest(entries).catch(() => undefined)
    return entries
  }

  private async _upsertManifest(entry: PhysicalAnchorEntry): Promise<void> {
    const manifest = await readJsonFile<PhysicalAnchorManifest>(this.manifestPath)
    if (!isPhysicalAnchorManifest(manifest)) {
      await this._rebuildManifestFromFiles()
      return
    }
    const entries = manifest.entries.filter(existing => existing.id !== entry.id)
    entries.push(entry)
    await this._writeManifest(entries)
  }

  private async _writeManifest(entries: PhysicalAnchorEntry[]): Promise<void> {
    await atomicWriteJson(this.manifestPath, {
      schemaVersion: '1.0',
      updatedAt: Date.now(),
      entries,
    } satisfies PhysicalAnchorManifest)
  }
}

function isPhysicalAnchorManifest(value: unknown): value is PhysicalAnchorManifest {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return record['schemaVersion'] === '1.0' &&
    typeof record['updatedAt'] === 'number' &&
    Array.isArray(record['entries'])
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
