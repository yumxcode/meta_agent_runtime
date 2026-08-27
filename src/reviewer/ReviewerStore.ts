import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { metaAgentPath } from '../infra/metaAgentHome.js'
import {
  atomicWriteFile,
  atomicWriteJson,
  listJsonIds,
  readJsonFile,
  withFileLock,
} from '../infra/persist/index.js'
import {
  ExperienceCandidateSchema,
  LearningProposalSchema,
  ReviewerRunManifestSchema,
  TaskReviewSchema,
  TaskReviewerRunManifestSchema,
  type ExperienceCandidate,
  type LearningMoment,
  type LearningProposal,
  type ReviewerRunManifest,
  type TaskReview,
  type TaskReviewerRunManifest,
  type ExperienceDraft,
} from './types.js'
import { HumanAcceptanceStore } from './HumanAcceptance.js'

export interface ReviewerPaths {
  root: string
  proposals: string
  candidates: string
  taskReviews: string
  runs: string
  stateLock: string
}

export interface AddLearningProposalInput {
  source: LearningProposal['source']
  moment: LearningMoment
  experienceDraft: ExperienceDraft
  now?: number
}

export interface StoredProposalResult {
  proposal: LearningProposal
  duplicate: boolean
}

export interface ReviewerHistoryState {
  reviewedInputKeys: Set<string>
  completedWindowKeys: Set<string>
  proposalWindowKeys: Set<string>
}

export interface TaskReviewerHistoryState {
  completedCaseKeys: Set<string>
  proposalCaseKeys: Set<string>
}

export interface RecoverableTaskReviewResponse {
  sourceRunId: string
  rawResponse: string
}

export class ReviewerStore {
  readonly paths: ReviewerPaths
  /**
   * Human acceptance verdicts (T3).
   *
   * A sibling store rather than a field on TaskReview: rating is a separate act
   * from reviewing, it happens at a different time, and keeping it out of the
   * review record means recording a verdict cannot disturb TaskReview identity
   * or the incremental-skip bookkeeping built on it.
   */
  readonly acceptance: HumanAcceptanceStore

  constructor(root = metaAgentPath('reviewer')) {
    const normalized = resolve(root)
    this.acceptance = new HumanAcceptanceStore(normalized)
    this.paths = {
      root: normalized,
      proposals: join(normalized, 'proposals'),
      candidates: join(normalized, 'candidates'),
      taskReviews: join(normalized, 'task-reviews'),
      runs: join(normalized, 'runs'),
      stateLock: join(normalized, '.state'),
    }
  }

  async ensureLayout(): Promise<void> {
    for (const dir of [
      this.paths.root,
      this.paths.proposals,
      this.paths.candidates,
      this.paths.taskReviews,
      this.paths.runs,
      this.acceptance.path,
    ]) {
      await mkdir(dir, { recursive: true, mode: 0o700 })
      await chmod(dir, 0o700).catch(() => undefined)
    }
  }

  async addProposal(input: AddLearningProposalInput): Promise<StoredProposalResult> {
    await this.ensureLayout()
    // Idempotency belongs to the evidence identity and analyzer contract —
    // never to model wording or the current TaskCase input hash. Re-running a
    // growing task must not resurrect a rejected finding merely because new,
    // unrelated trajectory lines changed the case digest.
    const fingerprint = proposalFingerprint(input.source)
    const id = `proposal_${fingerprint.slice(0, 24)}`
    return withFileLock(this.paths.stateLock, async () => {
      const file = this.proposalFile(id)
      const existing = await readJsonFile<unknown>(file)
      if (existing) return { proposal: LearningProposalSchema.parse(existing), duplicate: true }

      // Compatibility with task-review proposals written before inputHash was
      // removed from their fingerprint. Preserve the original reviewed record
      // (including a rejection) instead of minting one new stable-id copy.
      if (input.source.caseId && input.source.findingId) {
        for (const proposalId of await listJsonIds(this.paths.proposals)) {
          const raw = await readJsonFile<unknown>(this.proposalFile(proposalId), { tolerateUnreadable: true })
          const parsed = LearningProposalSchema.safeParse(raw)
          if (!parsed.success) continue
          const source = parsed.data.source
          if (
            source.analyzerId === input.source.analyzerId &&
            source.caseId === input.source.caseId &&
            source.findingId === input.source.findingId
          ) {
            return { proposal: parsed.data, duplicate: true }
          }
        }
      }

      const proposal = LearningProposalSchema.parse({
        schemaVersion: 'learning-proposal-1.0',
        id,
        fingerprint,
        status: 'pending',
        createdAt: input.now ?? Date.now(),
        source: input.source,
        moment: input.moment,
        experienceDraft: input.experienceDraft,
      })
      await writePrivateJson(file, proposal)
      return { proposal, duplicate: false }
    })
  }

  async listProposals(status?: LearningProposal['status']): Promise<LearningProposal[]> {
    await this.ensureLayout()
    const records = await Promise.all((await listJsonIds(this.paths.proposals)).map(async id => {
      const raw = await readJsonFile<unknown>(this.proposalFile(id), { tolerateUnreadable: true })
      const parsed = LearningProposalSchema.safeParse(raw)
      return parsed.success ? parsed.data : null
    }))
    return records
      .filter((item): item is LearningProposal => item !== null)
      .filter(item => !status || item.status === status)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  }

  async getProposal(id: string): Promise<LearningProposal | null> {
    assertProposalId(id)
    const raw = await readJsonFile<unknown>(this.proposalFile(id))
    return raw ? LearningProposalSchema.parse(raw) : null
  }

  async listProposalWindowKeys(analyzerId?: string): Promise<Set<string>> {
    const proposals = await this.listProposals()
    return new Set(proposals
      .filter(proposal => !analyzerId || proposal.source.analyzerId === analyzerId)
      .map(proposal => proposalWindowKey(proposal.source)))
  }

  /** Read historical manifests once and derive all incremental-review indexes. */
  async reviewedState(analyzerId: string): Promise<ReviewerHistoryState> {
    const [proposals, manifests] = await Promise.all([
      this.listProposals(),
      this.listRunManifests(),
    ])
    const reviewedInputKeys = new Set<string>()
    const completedWindowKeys = new Set<string>()
    const proposalWindowKeys = new Set(proposals
      .filter(proposal => proposal.source.analyzerId === analyzerId)
      .map(proposal => proposalWindowKey(proposal.source)))
    for (const manifest of manifests) {
      if (manifest.analyzerId !== analyzerId) continue
      for (const key of manifest.completedWindowKeys) completedWindowKeys.add(key)
      const completed = new Set(manifest.completedTrajectoryIds)
      for (const [trajectoryId, inputHash] of Object.entries(manifest.inputHashes)) {
        if (!completed.has(trajectoryId)) continue
        reviewedInputKeys.add(reviewedInputKey(trajectoryId, inputHash))
      }
    }
    return { reviewedInputKeys, completedWindowKeys, proposalWindowKeys }
  }

  /** Input identities already completed by this analyzer, including no-learning runs. */
  async reviewedInputKeys(analyzerId: string): Promise<Set<string>> {
    return (await this.reviewedState(analyzerId)).reviewedInputKeys
  }

  async approveProposal(id: string, note?: string, now = Date.now()): Promise<ExperienceCandidate> {
    assertProposalId(id)
    await this.ensureLayout()
    return withFileLock(this.paths.stateLock, async () => {
      const proposal = await this.requireProposal(id)
      if (proposal.status === 'rejected') throw new Error(`proposal '${id}' was already rejected`)

      const candidateId = candidateIdFor(proposal)
      const candidateFile = this.candidateFile(candidateId)
      const existingCandidate = await readJsonFile<unknown>(candidateFile)
      if (existingCandidate) {
        const candidate = ExperienceCandidateSchema.parse(existingCandidate)
        if (candidate.proposalId !== proposal.id) throw new Error(`candidate '${candidateId}' belongs to another proposal`)
        if (proposal.status !== 'approved') {
          await writePrivateJson(this.proposalFile(id), approveRecord(proposal, note, candidate.approvedAt))
        }
        return candidate
      }

      const workspaceIds = new Set(
        [proposal.moment.context.workspaceId].filter((value): value is string => Boolean(value)),
      )
      const candidate = ExperienceCandidateSchema.parse({
        schemaVersion: 'experience-candidate-1.0',
        id: candidateId,
        proposalId: proposal.id,
        revision: 1,
        status: 'approved',
        approvedAt: now,
        approvedBy: 'human',
        ...(note?.trim() ? { reviewNote: note.trim() } : {}),
        ...proposal.experienceDraft,
        evidence: {
          supportingMomentIds: [proposal.moment.id],
          contradictingMomentIds: [],
          // Root + child trajectories inside one TaskCase are collaborating
          // views of one task, not independent reproductions.
          independentTrajectories: proposal.source.caseId
            ? 1
            : new Set(proposal.source.trajectoryIds).size,
          independentWorkspaces: proposal.source.caseId ? Math.min(1, workspaceIds.size) : workspaceIds.size,
        },
        confidence: observedConfidence(proposal.moment),
      })

      // Candidate first, proposal decision second. A crash between them is
      // repaired by the idempotent existing-candidate path above.
      await writePrivateJson(candidateFile, candidate)
      await writePrivateJson(this.proposalFile(id), approveRecord(proposal, note, now))
      return candidate
    })
  }

  async rejectProposal(id: string, note?: string, now = Date.now()): Promise<LearningProposal> {
    assertProposalId(id)
    await this.ensureLayout()
    return withFileLock(this.paths.stateLock, async () => {
      const proposal = await this.requireProposal(id)
      if (proposal.status === 'approved') throw new Error(`proposal '${id}' was already approved`)
      if (proposal.status === 'rejected') return proposal
      const rejected = LearningProposalSchema.parse({
        ...proposal,
        status: 'rejected',
        review: {
          decision: 'rejected',
          reviewedAt: now,
          reviewedBy: 'human',
          ...(note?.trim() ? { note: note.trim() } : {}),
        },
      })
      await writePrivateJson(this.proposalFile(id), rejected)
      return rejected
    })
  }

  async listCandidates(): Promise<ExperienceCandidate[]> {
    await this.ensureLayout()
    const records = await Promise.all((await listJsonIds(this.paths.candidates)).map(async id => {
      const raw = await readJsonFile<unknown>(this.candidateFile(id), { tolerateUnreadable: true })
      const parsed = ExperienceCandidateSchema.safeParse(raw)
      return parsed.success ? parsed.data : null
    }))
    return records
      .filter((item): item is ExperienceCandidate => Boolean(item))
      .sort((a, b) => b.approvedAt - a.approvedAt || a.id.localeCompare(b.id))
  }

  async writeTaskReview(review: TaskReview): Promise<void> {
    await this.ensureLayout()
    const checked = TaskReviewSchema.parse(review)
    await writePrivateJson(this.taskReviewFile(checked.id), checked)
  }

  async getTaskReview(id: string): Promise<TaskReview | null> {
    assertTaskReviewId(id)
    const raw = await readJsonFile<unknown>(this.taskReviewFile(id))
    return raw ? TaskReviewSchema.parse(raw) : null
  }

  async listTaskReviews(): Promise<TaskReview[]> {
    await this.ensureLayout()
    const records = await Promise.all((await listJsonIds(this.paths.taskReviews)).map(async id => {
      const raw = await readJsonFile<unknown>(this.taskReviewFile(id), { tolerateUnreadable: true })
      const parsed = TaskReviewSchema.safeParse(raw)
      return parsed.success ? parsed.data : null
    }))
    return records
      .filter((item): item is TaskReview => item !== null)
      .sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id))
  }

  async writeTaskRun(manifest: TaskReviewerRunManifest, report: string): Promise<void> {
    await this.ensureLayout()
    const checked = TaskReviewerRunManifestSchema.parse(manifest)
    const runDir = join(this.paths.runs, checked.runId)
    await mkdir(runDir, { recursive: true, mode: 0o700 })
    await chmod(runDir, 0o700).catch(() => undefined)
    await Promise.all([
      writePrivateJson(join(runDir, 'manifest.json'), checked),
      writePrivateText(join(runDir, 'report.md'), report),
    ])
  }

  async writeTaskRunRawResponse(runId: string, caseId: string, content: string): Promise<string> {
    assertReviewerRunId(runId)
    assertTaskCaseId(caseId)
    await this.ensureLayout()
    const artifactDir = join(this.paths.runs, runId, 'analysis')
    await mkdir(artifactDir, { recursive: true, mode: 0o700 })
    await chmod(artifactDir, 0o700).catch(() => undefined)
    const relativePath = `analysis/${caseId}.raw-response.txt`
    await writePrivateText(join(this.paths.runs, runId, relativePath), content)
    return relativePath
  }

  /** Read task-review history once and derive incremental case identities. */
  async taskReviewedState(analyzerId: string): Promise<TaskReviewerHistoryState> {
    const [proposals, manifests] = await Promise.all([
      this.listProposals(),
      this.listTaskRunManifests(),
    ])
    const completedCaseKeys = new Set<string>()
    const proposalCaseKeys = new Set<string>()
    for (const proposal of proposals) {
      const source = proposal.source
      if (source.analyzerId !== analyzerId || !source.caseId) continue
      proposalCaseKeys.add(taskProposalCaseKey(source.caseId, analyzerId))
    }
    for (const manifest of manifests) {
      if (manifest.analyzerId !== analyzerId) continue
      const completed = new Set(manifest.completedCaseIds)
      for (const [caseId, inputHash] of Object.entries(manifest.inputHashes)) {
        if (completed.has(caseId)) completedCaseKeys.add(taskReviewedInputKey(caseId, inputHash, analyzerId))
      }
    }
    return { completedCaseKeys, proposalCaseKeys }
  }

  async findRecoverableTaskResponse(
    caseId: string,
    inputHash: string,
    analyzerId: string,
  ): Promise<RecoverableTaskReviewResponse | null> {
    assertTaskCaseId(caseId)
    const manifests = (await this.listTaskRunManifests())
      .filter(manifest =>
        manifest.analyzerId === analyzerId &&
        manifest.inputHashes[caseId] === inputHash &&
        !manifest.completedCaseIds.includes(caseId),
      )
      .sort((left, right) => right.completedAt - left.completedAt)
    for (const manifest of manifests) {
      const error = manifest.analysisErrors.find(item => item.caseId === caseId && item.rawResponseArtifact)
      if (!error?.rawResponseArtifact) continue
      try {
        const rawResponse = await readFile(
          join(this.paths.runs, manifest.runId, error.rawResponseArtifact),
          'utf8',
        )
        return { sourceRunId: manifest.runId, rawResponse }
      } catch {
        // A missing/corrupt artifact is non-fatal; try older runs and eventually
        // fall back to a fresh ReviewerSession.
      }
    }
    return null
  }

  async writeRun(manifest: ReviewerRunManifest, report: string): Promise<void> {
    await this.ensureLayout()
    const checked = ReviewerRunManifestSchema.parse(manifest)
    const runDir = join(this.paths.runs, checked.runId)
    await mkdir(runDir, { recursive: true, mode: 0o700 })
    await chmod(runDir, 0o700).catch(() => undefined)
    await Promise.all([
      writePrivateJson(join(runDir, 'manifest.json'), checked),
      writePrivateText(join(runDir, 'report.md'), report),
    ])
  }

  proposalFile(id: string): string {
    assertProposalId(id)
    return join(this.paths.proposals, `${id}.json`)
  }

  candidateFile(id: string): string {
    assertCandidateId(id)
    return join(this.paths.candidates, `${id}.json`)
  }

  taskReviewFile(id: string): string {
    assertTaskReviewId(id)
    return join(this.paths.taskReviews, `${id}.json`)
  }

  private async requireProposal(id: string): Promise<LearningProposal> {
    const proposal = await this.getProposal(id)
    if (!proposal) throw new Error(`unknown learning proposal '${id}'`)
    return proposal
  }

  private async listRunManifests(): Promise<ReviewerRunManifest[]> {
    await this.ensureLayout()
    let entries
    try {
      entries = await readdir(this.paths.runs, { withFileTypes: true })
    } catch {
      return []
    }
    const runEntries = entries.filter(entry =>
      entry.isDirectory() && /^review_[a-f0-9]{24}$/.test(entry.name))
    const parsed = await Promise.all(runEntries.map(async entry => {
      const raw = await readJsonFile<unknown>(join(this.paths.runs, entry.name, 'manifest.json'), {
        tolerateUnreadable: true,
      })
      const result = ReviewerRunManifestSchema.safeParse(raw)
      return result.success ? result.data : null
    }))
    return parsed.filter((manifest): manifest is ReviewerRunManifest => manifest !== null)
  }

  private async listTaskRunManifests(): Promise<TaskReviewerRunManifest[]> {
    await this.ensureLayout()
    let entries
    try {
      entries = await readdir(this.paths.runs, { withFileTypes: true })
    } catch {
      return []
    }
    const runEntries = entries.filter(entry =>
      entry.isDirectory() && /^review_[a-f0-9]{24}$/.test(entry.name))
    const parsed = await Promise.all(runEntries.map(async entry => {
      const raw = await readJsonFile<unknown>(join(this.paths.runs, entry.name, 'manifest.json'), {
        tolerateUnreadable: true,
      })
      const result = TaskReviewerRunManifestSchema.safeParse(raw)
      return result.success ? result.data : null
    }))
    return parsed.filter((manifest): manifest is TaskReviewerRunManifest => manifest !== null)
  }
}

function approveRecord(proposal: LearningProposal, note: string | undefined, now: number): LearningProposal {
  return LearningProposalSchema.parse({
    ...proposal,
    status: 'approved',
    review: {
      decision: 'approved',
      reviewedAt: now,
      reviewedBy: 'human',
      ...(note?.trim() ? { note: note.trim() } : {}),
    },
  })
}

function observedConfidence(moment: LearningMoment): ExperienceCandidate['confidence'] {
  const roles = new Set(moment.evidence.map(ref => ref.role))
  const hasFeedback = roles.has('feedback') || roles.has('contradiction')
  const hasResult = roles.has('verification') || roles.has('outcome')
  return hasFeedback && hasResult ? 'observed' : 'hypothesis'
}

function candidateIdFor(proposal: LearningProposal): string {
  return `candidate_${stableHash({ proposalId: proposal.id }).slice(0, 24)}`
}

function assertProposalId(id: string): void {
  if (!/^proposal_[a-f0-9]{24}$/.test(id)) throw new Error(`invalid learning proposal id '${id}'`)
}

function assertCandidateId(id: string): void {
  if (!/^candidate_[a-f0-9]{24}$/.test(id)) throw new Error(`invalid experience candidate id '${id}'`)
}

function assertTaskReviewId(id: string): void {
  if (!/^task_review_[a-f0-9]{24}$/.test(id)) throw new Error(`invalid task review id '${id}'`)
}

function assertReviewerRunId(id: string): void {
  if (!/^review_[a-f0-9]{24}$/.test(id)) throw new Error(`invalid reviewer run id '${id}'`)
}

function assertTaskCaseId(id: string): void {
  if (!/^case_[a-f0-9]{24}$/.test(id)) throw new Error(`invalid task case id '${id}'`)
}

function stableHash(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex')
}

function stableJson(value: unknown): string {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`
}

function freshId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 24)}`
}

export function newReviewerRunId(): string {
  return freshId('review')
}

export function proposalWindowKey(
  source: Pick<LearningProposal['source'], 'windowId' | 'windowHash' | 'analyzerId'>,
): string {
  return stableJson({
    analyzerId: source.analyzerId,
    windowHash: source.windowHash,
    windowId: source.windowId,
  })
}

export function reviewedInputKey(trajectoryId: string, inputHash: string): string {
  return `${trajectoryId}:${inputHash}`
}

function proposalFingerprint(source: LearningProposal['source']): string {
  if (source.findingId && source.caseId) {
    return stableHash({
      analyzerId: source.analyzerId,
      caseId: source.caseId,
      findingId: source.findingId,
    })
  }
  return stableHash({
    analyzerId: source.analyzerId,
    proposalIndex: source.proposalIndex,
    windowHash: source.windowHash,
    windowId: source.windowId,
  })
}

export function taskReviewedInputKey(caseId: string, inputHash: string, analyzerId: string): string {
  return stableJson({ analyzerId, caseId, inputHash })
}

export function taskProposalCaseKey(caseId: string, analyzerId: string): string {
  return stableJson({ analyzerId, caseId })
}

async function writePrivateJson(file: string, value: unknown): Promise<void> {
  await atomicWriteJson(file, value)
  await chmod(file, 0o600).catch(() => undefined)
}

async function writePrivateText(file: string, value: string): Promise<void> {
  await atomicWriteFile(file, value)
  await chmod(file, 0o600).catch(() => undefined)
}
