import { createHash } from 'node:crypto'
import type { FlashClient } from '../core/flash/FlashClient.js'
import type { TrajectoryReviewWindow } from './TrajectoryReviewScanner.js'
import {
  ModelLearningReviewSchema,
  type ModelLearningReview,
} from './types.js'

export interface LearningAnalyzer {
  readonly id: string
  analyze(window: TrajectoryReviewWindow): Promise<ModelLearningReview>
}

const ANALYZER_VERSION = 'trajectory-learning-reviewer-v1'

const SYSTEM_PROMPT = `You are a conservative trajectory-learning reviewer.

Your job is to identify reusable learning from one bounded agent trajectory window. You do not
reward or punish the worker, and you do not rewrite its policy. You only create proposals for a
human reviewer.

Propose learning only when the supplied evidence supports a real update, such as:
- result and expectation differ materially;
- the same failure repeats;
- an evaluator or reviewer reveals a gap the worker did not notice;
- a human corrects or redirects the worker;
- a new method clearly reduces cost or steps;
- prior knowledge is contradicted;
- a pattern plausibly transfers to another task.

Evidence rules:
- Cite only exact ordinal values present in the input window.
- Use at least two distinct evidence lines per proposal.
- Separate observed facts from inference. Use low confidence for reviewer-inferred expectations.
- Do not treat an error alone as learning. Explain the correction, mechanism, or policy delta.
- Do not invent a corrected outcome or verification that was not observed.
- Excludes must name at least one boundary where the advice should not be applied.
- Avoid generic advice such as "be careful", "analyze more", or "follow best practices".
- It is correct to return no proposals when the evidence is insufficient.

Return JSON only, with this exact top-level shape:
{
  "proposals": [
    {
      "moment": {
        "kind": "expectation_mismatch|repeated_failure|reviewer_correction|human_correction|breakthrough|contradiction|transferable_pattern",
        "taskSummary": "...",
        "taskFamily": "optional",
        "relevantState": ["..."],
        "expectation": {"statement":"...","source":"agent_explicit|task_contract|action_implied|reviewer_inferred","confidence":"high|medium|low"},
        "action": "...",
        "observedOutcome": "...",
        "feedback": "optional",
        "correction": "optional",
        "correctedOutcome": "optional",
        "transferableHint": "optional",
        "evidence": [{"ordinal": 1, "role": "context|expectation|action|outcome|feedback|correction|verification|contradiction"}]
      },
      "experienceDraft": {
        "title": "...",
        "category": "diagnosis|strategy_selection|procedure|verification|recovery|tool_usage|calibration",
        "applicability": {"context":"...","cues":["..."],"prerequisites":[],"excludes":["..."]},
        "policyDelta": {"previousApproach":"optional","recommendedAction":"...","avoidAction":"optional","expectedEffect":"..."},
        "mechanism": "...",
        "verification": {"checks":["..."],"successSignals":["..."],"failureSignals":["..."]},
        "impact": {"reliability":"none|low|medium|high","stability":"none|low|medium|high","effectiveness":"none|low|medium|high","rationale":["..."]}
      }
    }
  ],
  "noLearningReason": "required when proposals is empty"
}

Return at most three proposals. Omit optional fields instead of emitting null.`

export class FlashLearningAnalyzer implements LearningAnalyzer {
  readonly id: string

  constructor(private readonly flash: FlashClient) {
    this.id = `${ANALYZER_VERSION}:${flash.modelId}`
  }

  async analyze(window: TrajectoryReviewWindow): Promise<ModelLearningReview> {
    const user = JSON.stringify({
      window: {
        id: window.id,
        trigger: window.trigger,
        triggerOrdinals: window.triggerOrdinals,
        taskSummary: window.taskSummary,
        ...(window.workspaceId ? { workspaceId: window.workspaceId } : {}),
        ...(window.graphHash ? { graphHash: window.graphHash } : {}),
        ...(window.nodeId ? { nodeId: window.nodeId } : {}),
        lines: window.lines,
      },
    }, null, 2)
    const cacheKey = createHash('sha256')
      .update(`${ANALYZER_VERSION}\n${SYSTEM_PROMPT}\n${user}`)
      .digest('hex')
    const raw = await this.flash.query({
      system: SYSTEM_PROMPT,
      user,
      maxTokens: 4_000,
      cacheKey: `reviewer:${cacheKey}`,
    })
    if (!raw) {
      return { proposals: [], noLearningReason: 'analyzer returned no result' }
    }
    return ModelLearningReviewSchema.parse(parseJsonObject(raw))
  }
}

function parseJsonObject(raw: string): unknown {
  const trimmed = raw.trim()
  const unfenced = trimmed.startsWith('```')
    ? trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    : trimmed
  try {
    return JSON.parse(unfenced)
  } catch {
    const from = unfenced.indexOf('{')
    const to = unfenced.lastIndexOf('}')
    if (from >= 0 && to > from) return JSON.parse(unfenced.slice(from, to + 1))
    throw new Error('reviewer analyzer did not return a JSON object')
  }
}
