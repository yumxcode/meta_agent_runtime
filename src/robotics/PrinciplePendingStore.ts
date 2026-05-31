import { createHash } from 'crypto'
import { mkdir, readFile, rm, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { dirname, join } from 'path'
import type { PrincipleStore } from './PrincipleStore.js'
import type { ExperienceStore } from './ExperienceStore.js'
import {
  KNOWLEDGE_CONFIDENCE_TIERS,
  PRINCIPLE_ABSTRACTION_LEVELS,
  ROBOTICS_DOMAINS,
  type KnowledgeConfidenceTier,
  type PrincipleAbstractionLevel,
  type RoboticsDomain,
} from './types.js'

const PENDING_ROOT = join(homedir(), '.claude', 'meta-agent', 'robotics', 'pending-principles')
const MAX_PENDING_ENTRIES = 500

export interface PendingPrinciple {
  pendingId: string
  proposedAt: number
  input: Record<string, unknown>
}

export class PrinciplePendingStore {
  private readonly _pending: PendingPrinciple[] = []
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
        if (isPendingPrinciple(item)) this._pending.push(item)
      }
      this._trimToLimit()
    } catch {
      // Missing or malformed pending file: start empty.
    }
  }

  add(input: Record<string, unknown>): string {
    if (this._pending.length >= MAX_PENDING_ENTRIES) {
      throw new Error(`Pending principle queue limit reached (${MAX_PENDING_ENTRIES}); run /principle review before adding more.`)
    }
    const pendingId = `pr_pending_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
    this._pending.push({ pendingId, proposedAt: Date.now(), input })
    this._persistSoon()
    return pendingId
  }

  list(): readonly PendingPrinciple[] {
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

  async commit(
    pendingId: string,
    store: PrincipleStore,
    experienceStore?: ExperienceStore,
  ): Promise<string | null> {
    const entry = this._pending.find(p => p.pendingId === pendingId)
    if (!entry) return null

    try {
      const normalized = validatePrincipleInput(entry.input)
      if (!normalized.ok) return null
      const id = await store.write(normalized.value)
      if (experienceStore) {
        const sourceIds = [
          normalized.value.sourceExperienceId,
          ...normalized.value.derivedFromExperienceIds,
        ].filter((value): value is string => typeof value === 'string' && value.length > 0)
        await Promise.allSettled([...new Set(sourceIds)].map(sourceId =>
          experienceStore.appendPrincipleReference(sourceId, id),
        ))
      }
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

  private async _persist(snapshot: PendingPrinciple[]): Promise<void> {
    if (!this._filePath) return
    if (snapshot.length === 0) {
      await rm(this._filePath, { force: true }).catch(() => undefined)
      return
    }
    await mkdir(dirname(this._filePath), { recursive: true })
    await writeFile(this._filePath, JSON.stringify(snapshot, null, 2), 'utf-8')
  }
}

type NormalizedPrincipleInput = {
  title: string
  statement: string
  mechanism: string
  firstPrinciplesSupport: string[]
  domains: RoboticsDomain[]
  abstractionLevel: PrincipleAbstractionLevel
  preconditions: string[]
  applicabilityBounds: string[]
  nonApplicableWhen: string[]
  derivedFromExperienceIds: string[]
  anchoredByPhysicalAnchorIds: string[]
  evidenceRefs: string[]
  invalidatedAssumptions: string[]
  counterExamples: string[]
  confidenceTier: KnowledgeConfidenceTier
  observationCount: number
  contradictionCount: number
  promotionReason: 'confidence_threshold' | 'explicit_user_request'
  sourceExperienceId?: string
  lastVerifiedAt?: number
}

export function validatePrincipleInput(input: Record<string, unknown>):
  | { ok: true; value: NormalizedPrincipleInput }
  | { ok: false } {
  const title = requiredString(input['title'], 100)
  const statement = requiredString(input['statement'], 800)
  const mechanism = requiredString(input['mechanism'], 800)
  const firstPrinciplesSupport = normalizeStringArray(input['first_principles_support'], 8, 300) ?? []
  const domains = normalizeDomains(input['domains'])
  const abstractionLevel = normalizeAbstractionLevel(input['abstraction_level']) ?? 'system'
  const preconditions = normalizeStringArray(input['preconditions'], 12, 240) ?? []
  const applicabilityBounds = normalizeStringArray(input['applicability_bounds'], 12, 240) ?? []
  const nonApplicableWhen = normalizeStringArray(input['non_applicable_when'], 12, 240) ?? []
  const promotionReason = input['promotion_reason'] === 'explicit_user_request'
    ? 'explicit_user_request'
    : input['promotion_reason'] === 'confidence_threshold'
      ? 'confidence_threshold'
      : null
  if (
    !title || !statement || !mechanism || domains.length === 0 || !promotionReason ||
    firstPrinciplesSupport.length === 0 ||
    (preconditions.length + applicabilityBounds.length + nonApplicableWhen.length) === 0
  ) return { ok: false }

  return {
    ok: true,
    value: {
      title,
      statement,
      mechanism,
      firstPrinciplesSupport,
      domains,
      abstractionLevel,
      preconditions,
      applicabilityBounds,
      nonApplicableWhen,
      derivedFromExperienceIds: normalizeStringArray(input['derived_from_experience_ids'], 20, 120) ?? [],
      anchoredByPhysicalAnchorIds: normalizeStringArray(input['anchored_by_physical_anchor_ids'], 20, 120) ?? [],
      evidenceRefs: normalizeStringArray(input['evidence_refs'], 30, 300) ?? [],
      invalidatedAssumptions: normalizeStringArray(input['invalidated_assumptions'], 20, 240) ?? [],
      counterExamples: normalizeStringArray(input['counter_examples'], 20, 240) ?? [],
      confidenceTier: normalizeConfidence(input['confidence_tier']) ?? 'observed',
      observationCount: normalizeNonNegativeInteger(input['observation_count'], 1),
      contradictionCount: normalizeNonNegativeInteger(input['contradiction_count'], 0),
      promotionReason,
      sourceExperienceId: optionalString(input['source_experience_id'], 120),
      lastVerifiedAt: normalizeTimestamp(input['last_verified_at']),
    },
  }
}

function isPendingPrinciple(value: unknown): value is PendingPrinciple {
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

function normalizeDomains(value: unknown): RoboticsDomain[] {
  if (!Array.isArray(value)) return []
  const out = value
    .filter((v): v is RoboticsDomain => typeof v === 'string' && ROBOTICS_DOMAINS.includes(v as RoboticsDomain))
  return [...new Set(out)].slice(0, 6)
}

function normalizeAbstractionLevel(value: unknown): PrincipleAbstractionLevel | undefined {
  return typeof value === 'string' && PRINCIPLE_ABSTRACTION_LEVELS.includes(value as PrincipleAbstractionLevel)
    ? value as PrincipleAbstractionLevel
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

function normalizeNonNegativeInteger(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(0, Math.floor(value))
}

function normalizeTimestamp(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return Math.floor(value)
}
