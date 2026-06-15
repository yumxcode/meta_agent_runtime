import { rm } from 'fs/promises'
import { homedir } from 'os'
import { META_AGENT_HOME } from '../core/metaAgentHome.js'
import { join } from 'path'
import { atomicWriteJson, ensureDir, listJsonIds, readJsonFile } from '../core/persist/index.js'
import type {
  KnowledgeConfidenceTier,
  PrincipleEntry,
  PrincipleSearchQuery,
} from './types.js'
import { makePrincipleId } from './types.js'

const PRINCIPLE_ROOT = join(META_AGENT_HOME, 'robotics', 'principles')
const MANIFEST_FILE = 'PRINCIPLE_MANIFEST.json'
const LOAD_CONCURRENCY = 32
const PRINCIPLE_ID_RE = /^pr_[0-9a-z]+_[0-9a-f]{8}$/

interface PrincipleManifest {
  schemaVersion: '1.0'
  updatedAt: number
  entries: PrincipleEntry[]
}

const CONFIDENCE_WEIGHT: Record<KnowledgeConfidenceTier, number> = {
  reproduced: 500,
  observed:   400,
  derived:    350,
  reported:   200,
  hypothesis: 100,
}

export function isPrincipleId(id: string): boolean {
  return PRINCIPLE_ID_RE.test(id)
}

export function principleRetrievalScore(principle: PrincipleEntry): number {
  return CONFIDENCE_WEIGHT[principle.confidenceTier] +
    Math.min(principle.observationCount, 10) * 10 -
    principle.contradictionCount * 50 +
    Math.min(principle.anchoredByPhysicalAnchorIds.length, 6) * 12
}

export class PrincipleStore {
  private readonly dir: string
  private readonly manifestPath: string

  constructor(dir?: string) {
    this.dir = dir ?? PRINCIPLE_ROOT
    this.manifestPath = join(this.dir, MANIFEST_FILE)
  }

  async ensureDir(): Promise<void> {
    await ensureDir(this.dir)
  }

  async write(
    entry: Omit<PrincipleEntry, 'id' | 'schemaVersion' | 'createdAt' | 'updatedAt'>,
  ): Promise<string> {
    await this.ensureDir()
    const id = makePrincipleId()
    const now = Date.now()
    const full: PrincipleEntry = {
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

  async load(id: string): Promise<PrincipleEntry | null> {
    if (!isPrincipleId(id)) return null
    return readJsonFile<PrincipleEntry>(join(this.dir, `${id}.json`))
  }

  /**
   * Record a later outcome against a committed principle:
   *   - 'observation'   → a new experience corroborated it (raises retrieval score)
   *   - 'contradiction' → a new experience contradicted it (lowers retrieval
   *     score by 50/contradiction, so a challenged principle sinks in search and
   *     surfaces for human re-review instead of silently standing forever).
   * Returns the updated entry, or null when the principle does not exist.
   */
  async recordOutcomeSignal(
    id: string,
    kind: 'observation' | 'contradiction',
  ): Promise<PrincipleEntry | null> {
    const entry = await this.load(id)
    if (!entry) return null
    const updated: PrincipleEntry = {
      ...entry,
      observationCount: entry.observationCount + (kind === 'observation' ? 1 : 0),
      contradictionCount: entry.contradictionCount + (kind === 'contradiction' ? 1 : 0),
      lastVerifiedAt: kind === 'observation' ? Date.now() : entry.lastVerifiedAt,
      updatedAt: Date.now(),
    }
    await atomicWriteJson(join(this.dir, `${id}.json`), updated)
    await this._upsertManifest(updated).catch(() => undefined)
    return updated
  }

  recordObservation(id: string): Promise<PrincipleEntry | null> {
    return this.recordOutcomeSignal(id, 'observation')
  }

  recordContradiction(id: string): Promise<PrincipleEntry | null> {
    return this.recordOutcomeSignal(id, 'contradiction')
  }

  /**
   * Permanently delete a committed principle by ID and rebuild the manifest.
   * Returns true if the file existed and was removed.
   */
  async delete(id: string): Promise<boolean> {
    if (!isPrincipleId(id)) return false
    try {
      await rm(join(this.dir, `${id}.json`))
    } catch {
      return false
    }
    await this._rebuildManifestFromFiles().catch(() => undefined)
    return true
  }

  async search(query: PrincipleSearchQuery = {}): Promise<PrincipleEntry[]> {
    const limit = Math.min(query.limit ?? 10, 20)
    const entries = await this._loadManifestEntries()
    const filtered = entries.filter(principle => {
      if (query.domain && !principle.domains.includes(query.domain)) return false
      if (query.abstractionLevel && principle.abstractionLevel !== query.abstractionLevel) return false
      if (query.experienceId && !principle.derivedFromExperienceIds.includes(query.experienceId)) return false
      if (query.anchorId && !principle.anchoredByPhysicalAnchorIds.includes(query.anchorId)) return false
      if (query.keyword) {
        const kw = query.keyword.toLowerCase()
        const searchable = [
          principle.title,
          principle.statement,
          principle.mechanism,
          ...principle.firstPrinciplesSupport,
          ...principle.preconditions,
          ...principle.applicabilityBounds,
          ...principle.nonApplicableWhen,
        ].join(' ').toLowerCase()
        if (!searchable.includes(kw)) return false
      }
      return true
    })

    filtered.sort((a, b) => {
      const scoreDelta = principleRetrievalScore(b) - principleRetrievalScore(a)
      return scoreDelta !== 0 ? scoreDelta : b.createdAt - a.createdAt
    })
    return filtered.slice(0, limit)
  }

  async listIds(): Promise<string[]> {
    const ids = await listJsonIds(this.dir)
    return ids.filter(isPrincipleId)
  }

  private async _loadAll(): Promise<PrincipleEntry[]> {
    return this._loadAllFromFiles()
  }

  private async _loadAllFromFiles(): Promise<PrincipleEntry[]> {
    const ids = await this.listIds()
    return loadWithConcurrency(ids, id => this.load(id))
  }

  private async _loadManifestEntries(): Promise<PrincipleEntry[]> {
    const manifest = await readJsonFile<PrincipleManifest>(this.manifestPath)
    if (isPrincipleManifest(manifest)) return manifest.entries
    return this._rebuildManifestFromFiles()
  }

  private async _rebuildManifestFromFiles(): Promise<PrincipleEntry[]> {
    const entries = await this._loadAllFromFiles()
    await this._writeManifest(entries).catch(() => undefined)
    return entries
  }

  private async _upsertManifest(entry: PrincipleEntry): Promise<void> {
    const manifest = await readJsonFile<PrincipleManifest>(this.manifestPath)
    if (!isPrincipleManifest(manifest)) {
      await this._rebuildManifestFromFiles()
      return
    }
    const entries = manifest.entries.filter(existing => existing.id !== entry.id)
    entries.push(entry)
    await this._writeManifest(entries)
  }

  private async _writeManifest(entries: PrincipleEntry[]): Promise<void> {
    await atomicWriteJson(this.manifestPath, {
      schemaVersion: '1.0',
      updatedAt: Date.now(),
      entries,
    } satisfies PrincipleManifest)
  }
}

function isPrincipleManifest(value: unknown): value is PrincipleManifest {
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
