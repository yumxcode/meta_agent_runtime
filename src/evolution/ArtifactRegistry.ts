/**
 * Artifact registry contract (G0-C).
 *
 * Before an incumbent and a candidate can be compared, the whole candidate
 * surface has to be recoverable: prompt, tool schema, evaluator bundle, runtime
 * version, model/provider config. The failure this guards against is subtle —
 * recording a hash *feels* like versioning, but a hash you cannot exchange for
 * content cannot reproduce anything. `turn_context` already stores tool schema
 * and policy hashes today with no way to retrieve what they referred to.
 *
 * So the contract is: every artifact carries a retrievable handle, and the hash
 * is verifiable against the content it names.
 *
 * This is a contract only — no store, no wiring.
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'

export const ARTIFACT_KINDS = [
  'prompt',
  'tool_schema',
  'evaluator_bundle',
  'runtime_version',
  'model_config',
  'selector',
  'skill',
  'workflow',
  'playbook',
  'permission_policy',
  'retrieval_index',
] as const

export type ArtifactKind = (typeof ARTIFACT_KINDS)[number]

/**
 * Lifecycle states. `rolled_back` is terminal for that version and is kept
 * rather than deleted: an artifact that had to be withdrawn is evidence.
 */
export const ARTIFACT_APPROVAL_STATES = [
  'draft',
  'shadow',
  'canary',
  'promoted',
  'rolled_back',
] as const

export type ArtifactApprovalState = (typeof ARTIFACT_APPROVAL_STATES)[number]

/** Inline for small text, external for anything a JSON record should not carry. */
export const ArtifactContentSchema = z.discriminatedUnion('storage', [
  z.object({
    storage: z.literal('inline'),
    text: z.string().max(200_000),
  }).strict(),
  z.object({
    storage: z.literal('external'),
    /** Resolvable by the host; a bare hash is explicitly not enough. */
    ref: z.string().min(1),
    sizeBytes: z.number().int().nonnegative(),
  }).strict(),
])

export type ArtifactContent = z.infer<typeof ArtifactContentSchema>

export const ArtifactEntrySchema = z.object({
  schemaVersion: z.literal('artifact-entry-1.0'),
  artifactId: z.string().regex(/^artifact_[a-f0-9]{24}$/),
  kind: z.enum(ARTIFACT_KINDS),
  /** sha256 of the canonical content bytes. */
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  content: ArtifactContentSchema,
  /** Version this one was derived from, forming an auditable chain. */
  baseArtifactId: z.string().regex(/^artifact_[a-f0-9]{24}$/).optional(),
  createdBy: z.string().min(1),
  createdAt: z.number(),
  /** Where this artifact came from: a TaskCase, a reviewer run, a human edit. */
  sourceRef: z.string().min(1).optional(),
  approvalState: z.enum(ARTIFACT_APPROVAL_STATES),
  /** Empty scope means "not deployed anywhere", which is the safe default. */
  deployScope: z.array(z.string().min(1)).max(64).default([]),
  /** The version to fall back to. Required once anything is exposed to traffic. */
  rollbackTarget: z.string().regex(/^artifact_[a-f0-9]{24}$/).optional(),
  riskTier: z.enum(['R1', 'R2', 'R3']).optional(),
  note: z.string().max(2_000).optional(),
}).strict().superRefine((entry, ctx) => {
  // Rollback is a first-class action, not a recovery plan written after an
  // incident. Anything a real session can reach must already name its way back.
  if ((entry.approvalState === 'canary' || entry.approvalState === 'promoted') && !entry.rollbackTarget) {
    ctx.addIssue({
      code: 'custom',
      message: `${entry.approvalState} artifact must name a rollbackTarget before exposure`,
      path: ['rollbackTarget'],
    })
  }
  if (entry.rollbackTarget === entry.artifactId) {
    ctx.addIssue({
      code: 'custom',
      message: 'rollbackTarget cannot be the artifact itself',
      path: ['rollbackTarget'],
    })
  }
  if (entry.baseArtifactId === entry.artifactId) {
    ctx.addIssue({
      code: 'custom',
      message: 'baseArtifactId cannot be the artifact itself',
      path: ['baseArtifactId'],
    })
  }
  if (entry.approvalState === 'draft' && entry.deployScope.length > 0) {
    ctx.addIssue({
      code: 'custom',
      message: 'a draft artifact cannot declare a deploy scope',
      path: ['deployScope'],
    })
  }
})

export type ArtifactEntry = z.infer<typeof ArtifactEntrySchema>

export function hashArtifactContent(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export function artifactIdFor(kind: ArtifactKind, contentHash: string): string {
  return `artifact_${createHash('sha256').update(`${kind}\0${contentHash}`).digest('hex').slice(0, 24)}`
}

/**
 * A registry entry is only useful if its hash can be checked against content.
 * Inline content is verified here; external content needs the host to resolve
 * it first, so callers pass the resolved bytes.
 */
export function verifyArtifactContent(entry: ArtifactEntry, resolvedText?: string): boolean {
  const text = entry.content.storage === 'inline' ? entry.content.text : resolvedText
  if (text === undefined) return false
  return hashArtifactContent(text) === entry.contentHash
}

export function assertArtifactRetrievable(entry: ArtifactEntry, resolvedText?: string): void {
  if (entry.content.storage === 'external' && resolvedText === undefined) {
    throw new Error(
      `artifact '${entry.artifactId}' stores content externally at '${entry.content.ref}' and it could not be resolved; ` +
      'a hash without retrievable content cannot reproduce a comparison',
    )
  }
  if (!verifyArtifactContent(entry, resolvedText)) {
    throw new Error(`artifact '${entry.artifactId}' content does not match its recorded contentHash`)
  }
}

/**
 * The full candidate surface for one side of a comparison.
 *
 * Keyed by kind so a missing dimension is visible rather than implied.
 */
export const ArtifactSetSchema = z.object({
  prompt: z.string().min(1),
  tool_schema: z.string().min(1),
  runtime_version: z.string().min(1),
  model_config: z.string().min(1),
  evaluator_bundle: z.string().min(1),
  selector: z.string().min(1).optional(),
  skill: z.array(z.string().min(1)).max(64).default([]),
  workflow: z.array(z.string().min(1)).max(64).default([]),
  playbook: z.array(z.string().min(1)).max(64).default([]),
  permission_policy: z.string().min(1).optional(),
  retrieval_index: z.string().min(1).optional(),
}).strict()

export type ArtifactSet = z.infer<typeof ArtifactSetSchema>

/**
 * Two sides are comparable only when they differ in a way you can name. A
 * comparison where nothing differs measures noise; one where everything differs
 * cannot attribute the result to anything.
 */
export function differingArtifactKinds(incumbent: ArtifactSet, candidate: ArtifactSet): string[] {
  const differing: string[] = []
  for (const key of Object.keys(incumbent) as Array<keyof ArtifactSet>) {
    const left = incumbent[key]
    const right = candidate[key]
    const same = Array.isArray(left) && Array.isArray(right)
      ? left.length === right.length && left.every((value, index) => value === right[index])
      : left === right
    if (!same) differing.push(key)
  }
  return differing.sort()
}
