import { createHash } from 'crypto'
import { mkdir, readFile, rm, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { dirname, join } from 'path'
import type { PhysicalAnchorStore } from './PhysicalAnchorStore.js'
import {
  KNOWLEDGE_CONFIDENCE_TIERS,
  KNOWLEDGE_SCOPES,
  ROBOTICS_DOMAINS,
  type KnowledgeConfidenceTier,
  type KnowledgeScope,
  type RoboticsDomain,
} from './types.js'

const PENDING_ROOT = join(homedir(), '.claude', 'meta-agent', 'robotics', 'pending-physical-anchors')
const MAX_PENDING_ENTRIES = 500

export interface PendingPhysicalAnchor {
  pendingId: string
  proposedAt: number
  input: Record<string, unknown>
}

export class PhysicalAnchorPendingStore {
  private readonly _pending: PendingPhysicalAnchor[] = []
  private readonly _filePath: string | null
  private _persistTail: Promise<void> = Promise.resolve()

  constructor(projectDir?: string, root = PENDING_ROOT) {
    this._filePath = projectDir
      ? join(root, `${createHash('sha256').update(projectDir).digest('hex').slice(0, 16)}.json`)
      : null
  }

  async load(): Promise<void> {
    if (!this._filePath) return
    try {
      const raw = await readFile(this._filePath, 'utf-8')
      const parsed = JSON.parse(raw) as unknown
      if (!Array.isArray(parsed)) return
      this._pending.length = 0
      for (const item of parsed) {
        if (isPendingPhysicalAnchor(item)) this._pending.push(item)
      }
      this._trimToLimit()
    } catch {
      // Missing or malformed pending file: start empty.
    }
  }

  add(input: Record<string, unknown>): string {
    if (this._pending.length >= MAX_PENDING_ENTRIES) {
      throw new Error(`Pending physical anchor queue limit reached (${MAX_PENDING_ENTRIES}); run /anchor review before adding more.`)
    }
    const pendingId = `pa_pending_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
    this._pending.push({ pendingId, proposedAt: Date.now(), input })
    this._persistSoon()
    return pendingId
  }

  list(): readonly PendingPhysicalAnchor[] {
    return this._pending
  }

  get count(): number {
    return this._pending.length
  }

  remove(pendingId: string): boolean {
    const idx = this._pending.findIndex(p => p.pendingId === pendingId)
    if (idx < 0) return false
    this._pending.splice(idx, 1)
    this._persistSoon()
    return true
  }

  async flush(): Promise<void> {
    await this._persistTail
  }

  async commit(pendingId: string, store: PhysicalAnchorStore): Promise<string | null> {
    const entry = this._pending.find(p => p.pendingId === pendingId)
    if (!entry) return null

    try {
      const normalized = validatePhysicalAnchorInput(entry.input)
      if (!normalized.ok) return null
      const id = await store.write(normalized.value)
      this.remove(pendingId)
      return id
    } catch {
      return null
    }
  }

  private _persistSoon(): void {
    const snapshot = this._pending.map(item => ({
      pendingId: item.pendingId,
      proposedAt: item.proposedAt,
      input: { ...item.input },
    }))
    this._persistTail = this._persistTail
      .catch(() => {})
      .then(() => this._persist(snapshot))
      .catch(() => {})
  }

  private _trimToLimit(): void {
    if (this._pending.length <= MAX_PENDING_ENTRIES) return
    this._pending.splice(0, this._pending.length - MAX_PENDING_ENTRIES)
    this._persistSoon()
  }

  private async _persist(snapshot: PendingPhysicalAnchor[]): Promise<void> {
    if (!this._filePath) return
    if (snapshot.length === 0) {
      await rm(this._filePath, { force: true }).catch(() => undefined)
      return
    }
    await mkdir(dirname(this._filePath), { recursive: true })
    await writeFile(this._filePath, JSON.stringify(snapshot, null, 2), 'utf-8')
  }
}

type NormalizedPhysicalAnchorInput = {
  domain: RoboticsDomain
  scope: KnowledgeScope
  title: string
  fact: string
  implication: string
  mechanism?: string
  robot?: string
  tags: string[]
  confidenceTier: KnowledgeConfidenceTier
  evidenceRefs: string[]
  source?: string
  lastVerifiedAt?: number
  invalidates?: string[]
}

export function validatePhysicalAnchorInput(input: Record<string, unknown>):
  | { ok: true; value: NormalizedPhysicalAnchorInput }
  | { ok: false } {
  const domain = normalizeDomain(input['domain'])
  const scope = normalizeScope(input['scope']) ?? 'code'
  const title = requiredString(input['title'], 80)
  const fact = requiredString(input['fact'], 800)
  const implication = requiredString(input['implication'], 800)
  if (!domain || !title || !fact || !implication) return { ok: false }

  return {
    ok: true,
    value: {
      domain,
      scope,
      title,
      fact,
      implication,
      mechanism: optionalString(input['mechanism'], 800),
      robot: optionalString(input['robot'], 80),
      tags: normalizeStringArray(input['tags'], 20, 40) ?? [],
      confidenceTier: normalizeConfidence(input['confidence_tier']) ?? 'observed',
      evidenceRefs: normalizeStringArray(input['evidence_refs'], 20, 300) ?? [],
      source: optionalString(input['source'], 240),
      lastVerifiedAt: normalizeTimestamp(input['last_verified_at']),
      invalidates: normalizeStringArray(input['invalidates'], 10, 240),
    },
  }
}

function isPendingPhysicalAnchor(value: unknown): value is PendingPhysicalAnchor {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record['pendingId'] === 'string' &&
    typeof record['proposedAt'] === 'number' &&
    Boolean(record['input']) &&
    typeof record['input'] === 'object'
}

function requiredString(value: unknown, max: number): string | null {
  const str = optionalString(value, max)
  return str && str.trim() ? str : null
}

function optionalString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, max) : undefined
}

function normalizeDomain(value: unknown): RoboticsDomain | null {
  return typeof value === 'string' && ROBOTICS_DOMAINS.includes(value as RoboticsDomain)
    ? value as RoboticsDomain
    : null
}

function normalizeScope(value: unknown): KnowledgeScope | undefined {
  return typeof value === 'string' && KNOWLEDGE_SCOPES.includes(value as KnowledgeScope)
    ? value as KnowledgeScope
    : undefined
}

function normalizeConfidence(value: unknown): KnowledgeConfidenceTier | undefined {
  return typeof value === 'string' && KNOWLEDGE_CONFIDENCE_TIERS.includes(value as KnowledgeConfidenceTier)
    ? value as KnowledgeConfidenceTier
    : undefined
}

function normalizeStringArray(value: unknown, maxItems: number, maxLen: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out = value
    .filter((v): v is string => typeof v === 'string')
    .map(v => v.trim().slice(0, maxLen))
    .filter(Boolean)
    .slice(0, maxItems)
  return out.length ? out : undefined
}

function normalizeTimestamp(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return Math.floor(value)
}
