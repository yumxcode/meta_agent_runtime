import type { MetaAgentTool, ToolResult } from '../../../core/types.js'
import type { FlashClient } from '../../../core/flash/FlashClient.js'
import type { ExperienceStore } from '../../ExperienceStore.js'
import type { PhysicalAnchorStore } from '../../PhysicalAnchorStore.js'
import type { PrinciplePendingStore } from '../../PrinciplePendingStore.js'
import type { PrincipleStore } from '../../PrincipleStore.js'
import { proposePrincipleFromExperience } from '../../PrinciplePromotion.js'

export function createPrinciplePromoteTool(
  experienceStore: ExperienceStore,
  anchorStore: PhysicalAnchorStore,
  pendingStore: PrinciplePendingStore,
  principleStore: PrincipleStore,
  flash?: FlashClient,
): MetaAgentTool {
  return {
    name: 'principle_promote',
    description:
      'Promote an approved experience into a reusable Principle candidate when the user explicitly asks to extract, promote, generalize, or abstract a principle. ' +
      'The generated principle is queued for human review and is NOT committed until `/principle review` approves it. ' +
      'Use this only for explicit user requests; confidence-threshold promotion is handled automatically after experience review.',
    inputSchema: {
      type: 'object',
      required: ['experience_id'],
      properties: {
        experience_id: {
          type: 'string',
          description: 'Approved ExperienceStore ID to promote into a principle candidate.',
        },
      },
    },
    async call(input): Promise<ToolResult> {
      const experienceId = String(input['experience_id'] ?? '').trim()
      if (!experienceId) return { content: 'experience_id is required', isError: true }
      const result = await proposePrincipleFromExperience({
        experienceId,
        experienceStore,
        anchorStore,
        pendingStore,
        principleStore,
        flash,
        reason: 'explicit_user_request',
      })
      if (!result.promoted) {
        // 'already_promoted' / 'already_pending' / 'below_threshold' are benign
        // no-ops, not failures — a principle for this experience already exists.
        const benign = result.reason === 'below_threshold'
          || result.reason === 'already_promoted'
          || result.reason === 'already_pending'
        return {
          content: `principle_promote did not queue a proposal: ${result.reason}`,
          isError: !benign,
        }
      }
      return {
        content:
          `Principle candidate queued for review: ${result.pendingId}\n` +
          `Trigger: explicit_user_request\n` +
          `Score: ${result.score ?? 'n/a'}\n\n` +
          `Run /principle review to approve, edit externally, or discard it.`,
        isError: false,
      }
    },
  }
}
