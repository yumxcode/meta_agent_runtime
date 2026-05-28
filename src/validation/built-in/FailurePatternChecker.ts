/**
 * ExperiencePatternChecker — pre-call principle-based experience matching.
 *
 * Surfaces relevant historical experiences before a tool executes, giving the
 * agent a chance to apply known principles in the same domain before acting.
 *
 * Key design shift vs. keyword/semantic similarity matching:
 *   The LLM judges whether a stored ABSTRACT PRINCIPLE applies to the current
 *   operation within the same robotics domain, not whether the surface
 *   description looks similar.
 *
 * Two-phase operation:
 *   Phase 1 — listExperiences(): domain-filtered list (both successes + failures)
 *   Phase 2 — FlashModel judgment: "which principles apply to this operation?"
 *              Falls back to all candidates if flash call fails.
 *
  * Design principles:
 *   • passed=true always — this hook never blocks execution (no abort)
 *   • severity='warning' — surfaces findings without interrupting workflow
 *   • Short notice in tool result + full details in ContextPager (next turn)
 *
 * Applies to: experiment_dispatch
 * Phase: pre_call
 */

import type { VVHook, VVResult, VVContext, VVPhase } from '../types.js'
import type { IKnowledgeSource, ExperienceMatch } from '../../context/sources/IKnowledgeSource.js'
import type { FlashClient } from '../../core/flash/FlashClient.js'
import type { ContextPager } from '../../context/ContextPager.js'
import { estimateTokens } from '../../context/TokenEstimator.js'

// ─────────────────────────────────────────────────────────────────────────────
// Flash model prompt
// ─────────────────────────────────────────────────────────────────────────────

const PRINCIPLE_JUDGMENT_SYSTEM = `\
You assess whether stored experience principles apply to a planned operation.

Principles can be from successes (patterns to replicate) or failures (pitfalls to avoid).
Match by PRINCIPLE APPLICABILITY inside the current robotics domain — not surface or keyword similarity.

Do not force cross-domain transfer. Prefer principles from the same robotics domain.
Think like a senior engineer who knows the underlying mechanics, not a document retriever.

Return a JSON object (no markdown):
{"applicable": ["id1", "id2"], "reasoning": "one concise sentence"}

Rules:
- Include an ID only if the principle genuinely informs or constrains this operation.
- Success principles: include to signal "replicate this pattern here".
- Failure principles: include to signal "this pitfall applies here".
- Be selective: false positives cause noise. Irrelevant = omit.
- If none apply: {"applicable": [], "reasoning": "no applicable principles"}
- Do NOT include IDs not present in the candidate list.`

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Simple djb2-style hash for cache keys. */
function hashish(text: string): string {
  let h = 5381
  for (let i = 0; i < Math.min(text.length, 400); i++) {
    h = (h * 33) ^ text.charCodeAt(i)
  }
  return (h >>> 0).toString(36)
}

/** Extract searchable operation text from tool input. */
function extractText(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const fields = ['procedure', 'command', 'hypothesis', 'environment', 'title', 'description']
  return fields
    .map(f => (input as Record<string, unknown>)[f])
    .filter((v): v is string => typeof v === 'string')
    .join(' ')
}

/**
 * Extract robotics domain hints from free-form operation text.
 *
 * Uses keyword matching — no LLM call required.  Returns an array of matching
 * domain labels (empty array = no recognisable domain → caller falls back to
 * unfiltered recency-based retrieval).
 */
function extractDomainHints(text: string): string[] {
  const DOMAIN_KEYWORDS: Array<[string, string[]]> = [
    ['motion_planning',  ['motion', 'planning', 'trajectory', 'path planning', 'rrt', 'prm', 'kinematic', 'kinematics', 'ik ', 'fk ']],
    ['perception',       ['perception', 'lidar', 'point cloud', 'pointcloud', 'camera', 'depth', 'slam', 'mapping', 'localiz', 'detection', 'segmentation', 'voxel']],
    ['locomotion',       ['control', 'pid', 'controller', 'feedback', 'actuator', 'torque', 'servo', 'regulator', 'stabiliz', 'gait', 'quadruped']],
    ['simulation',       ['simulation', 'simulator', 'sim ', 'gazebo', 'pybullet', 'mujoco', 'urdf', 'sdf ', 'physics engine']],
    ['navigation',       ['navigation', 'nav ', 'waypoint', 'obstacle avoidance', 'costmap', 'global plan', 'local plan', 'move_base']],
    ['manipulation',     ['manipulation', 'grasp', 'gripper', 'pick and place', 'pick-and-place', 'end effector', 'end-effector', 'wrist', 'finger']],
    ['perception',       ['neural network', 'deep learning', 'model train', 'inference', 'dataset', 'batch size', 'gradient', 'epoch', 'loss function', 'embedding']],
    ['navigation',       ['localization', 'localisation', 'pose estimation', 'imu', 'odometry', 'dead reckoning', 'kalman', 'ekf', 'ukf']],
    ['calibration',      ['calibration', 'calibrate', 'intrinsic', 'extrinsic', 'hand-eye', 'distortion', 'reprojection']],
  ]

  const lower = text.toLowerCase()
  const found = new Set<string>()
  for (const [domain, keywords] of DOMAIN_KEYWORDS) {
    if (keywords.some(kw => lower.includes(kw))) {
      found.add(domain)
    }
  }
  return [...found]
}

/** Format experiences for the flash model prompt. */
function formatCandidates(experiences: ExperienceMatch[]): string {
  return experiences.map(e =>
    `ID: ${e.id}
Outcome: ${e.outcome === 'success' ? '✓ success' : '✗ failure'}
Domain: ${e.domain}
Confidence: ${e.confidenceTier ?? 'observed'}${e.observationCount ? ` (${e.observationCount} observation${e.observationCount === 1 ? '' : 's'})` : ''}
Title: ${e.title}
Abstract Principle: ${e.abstractPrinciple}` +
    (e.failureReason ? `\nFailure detail: ${e.failureReason.slice(0, 120)}` : '') +
    (e.workarounds?.length ? `\nWorkaround: ${e.workarounds[0]}` : ''),
  ).join('\n\n')
}

/** Format a single experience as a ContextPager slot. */
function formatSlotContent(e: ExperienceMatch): string {
  const icon = e.outcome === 'success' ? '✓' : '✗'
  const lines = [
    `### ${icon} Past Experience: ${e.title}`,
    `**Domain:** ${e.domain}  **Outcome:** ${e.outcome}`,
    `**Confidence:** ${e.confidenceTier ?? 'observed'}${e.observationCount ? ` (${e.observationCount} observation${e.observationCount === 1 ? '' : 's'})` : ''}`,
    `**Principle:** ${e.abstractPrinciple}`,
  ]
  if (e.failureReason) lines.push(`**Failure detail:** ${e.failureReason}`)
  if (e.workarounds?.length) {
    lines.push(`**Workarounds:** ${e.workarounds.join(' / ')}`)
  }
  return lines.join('\n')
}

/** Parse flash model JSON response into applicable IDs. */
function parseApplicableIds(raw: string, candidates: ExperienceMatch[]): string[] {
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return []
    const parsed = JSON.parse(jsonMatch[0]) as unknown
    if (
      typeof parsed !== 'object' || parsed === null ||
      !Array.isArray((parsed as Record<string, unknown>)['applicable'])
    ) return []
    const validIds = new Set(candidates.map(c => c.id))
    return ((parsed as Record<string, unknown>)['applicable'] as unknown[])
      .filter((id): id is string => typeof id === 'string' && validIds.has(id))
  } catch {
    return []
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ExperiencePatternChecker
// ─────────────────────────────────────────────────────────────────────────────

export class ExperiencePatternChecker implements VVHook {
  readonly name = 'ExperiencePatternChecker'
  readonly phase: VVPhase[] = ['pre_call']
  readonly appliesTo = ['experiment_dispatch']

  constructor(
    private readonly source: IKnowledgeSource,
    private readonly flash: FlashClient,
    private readonly pager?: ContextPager,
  ) {}

  async run(ctx: VVContext): Promise<VVResult> {
    const text = extractText(ctx.input)
    if (!text.trim()) return this._pass()

    // ── Phase 1: Load domain-relevant experiences ─────────────────────────
    // Extract domain hints from operation text (fast keyword match, no flash).
    // Domain-filtered retrieval keeps the candidate pool relevant as the store
    // grows.  Falls back to unfiltered recency when no domain hint is found.
    const domainHints = extractDomainHints(text)
    let candidates: ExperienceMatch[]
    try {
      candidates = await this.source.listExperiences({
        domains: domainHints.length > 0 ? domainHints : undefined,
        limit:   15,   // slightly larger than before: domain filter makes each slot more relevant
      })
    } catch {
      return this._pass()
    }
    if (candidates.length === 0) return this._pass()

    // ── Phase 2: FlashModel principle judgment ────────────────────────────
    const cacheKey = `epc:${hashish(text)}:${candidates.map(c => c.id).sort().join(',')}`
    const raw = await this.flash.query({
      system: PRINCIPLE_JUDGMENT_SYSTEM,
      user: `Planned operation:\n${text.slice(0, 600)}\n\nCandidate experiences:\n${formatCandidates(candidates)}`,
      maxTokens: 200,
      timeoutMs: 4_000,
      cacheKey,
    })

    // Fallback: use all candidates (conservative)
    const applicableIds = raw ? parseApplicableIds(raw, candidates) : candidates.map(c => c.id)
    const applicable = candidates.filter(c => applicableIds.includes(c.id))

    if (applicable.length === 0) return this._pass()

    // ── Checkout into ContextPager (next turn) ────────────────────────────
    if (this.pager) {
      for (const e of applicable) {
        const content = formatSlotContent(e)
        this.pager.checkout({
          id: `experience:${e.id}`,
          tag: `${e.outcome === 'success' ? '✓' : '⚠️'} [EXP] ${e.title.slice(0, 40)}`,
          content,
          tokenEst: estimateTokens(content),
          priority: 'high',
          ttlTurns: 3,
          source: 'vv_hook',
        })
      }
    }

    // ── Brief notice for current turn ─────────────────────────────────────
    const notice = applicable
      .map(e => `• [${e.domain}] ${e.title} (${e.outcome}): ${e.abstractPrinciple.slice(0, 100)}`)
      .join('\n')

    return {
      hookName: this.name,
      passed: true,
      severity: 'warning',
      message:
        `⚠️ ${applicable.length} applicable experience principle(s):\n${notice}\n` +
        (this.pager ? `Full details available in next turn context.` : ''),
      suggestedAction: 'warn_user',
    }
  }

  private _pass(): VVResult {
    return {
      hookName: this.name,
      passed: true,
      severity: 'info',
      message: '',   // silent pass — no tool-result noise when nothing matches
      suggestedAction: 'continue',
    }
  }
}

// Re-export under old name for backward compatibility
export { ExperiencePatternChecker as FailurePatternChecker }
