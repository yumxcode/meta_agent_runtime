import type { MetaAgentTool, ToolResult } from '../../../core/types.js'
import { validatePhysicalAnchorInput, type PhysicalAnchorPendingStore } from '../../PhysicalAnchorPendingStore.js'

export function createPhysicalAnchorWriteTool(pendingStore: PhysicalAnchorPendingStore): MetaAgentTool {
  return {
    name: 'physical_anchor_write',
    description:
      'Propose a physical/device fact that should anchor robotics reasoning. ' +
      'Use this for hardware behavior, physics mechanisms, datasheet facts, measured limits, or observed quirks that an LLM might ignore. ' +
      'The anchor is queued for human review and is not committed until approved with /anchor review.',
    inputSchema: {
      type: 'object',
      required: ['domain', 'title', 'fact', 'implication'],
      properties: {
        domain: {
          type: 'string',
          enum: [
            'motion_planning', 'perception', 'manipulation', 'locomotion',
            'navigation', 'simulation', 'hardware_interface', 'deployment',
            'calibration', 'general',
          ],
          description: 'Robotics domain where this anchor primarily applies',
        },
        scope: {
          type: 'string',
          enum: ['global', 'robot', 'code'],
          description: 'Applicability scope. global=general physics/spec fact, robot=platform-specific, code=current code/project behavior. Defaults to code.',
        },
        title: { type: 'string', description: 'Short title (<= 80 chars)' },
        fact: { type: 'string', description: 'Concrete physical/device fact (<= 800 chars)' },
        mechanism: { type: 'string', description: 'Why this fact happens, if known (<= 800 chars)' },
        implication: { type: 'string', description: 'Operational implication for planning/debugging (<= 800 chars)' },
        robot: { type: 'string', description: 'Robot/platform this anchor applies to, if specific' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Lowercase search tags' },
        confidence_tier: {
          type: 'string',
          enum: ['observed', 'reproduced', 'derived', 'reported', 'hypothesis'],
          description: 'Evidence strength; derived is appropriate for physics/spec facts, observed for measurements',
        },
        evidence_refs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Logs, datasheets, reports, measurements, papers, or source files supporting this anchor',
        },
        source: { type: 'string', description: 'Short source description' },
        last_verified_at: { type: 'number', description: 'Unix timestamp in ms for last verification' },
        invalidates: {
          type: 'array',
          items: { type: 'string' },
          description: 'Assumptions or older rules this anchor invalidates',
        },
      },
    },
    async call(input): Promise<ToolResult> {
      const normalized = validatePhysicalAnchorInput(input as Record<string, unknown>)
      if (!normalized.ok) {
        return {
          content: 'physical_anchor_write rejected invalid input. Required fields: domain, title, fact, implication.',
          isError: true,
        }
      }

      try {
        const pendingId = pendingStore.add(input as Record<string, unknown>)
        return {
          content:
            `Physical anchor queued for review: ${pendingId}\n` +
            `Title: ${normalized.value.title}\n` +
            `Scope: ${normalized.value.scope}\n` +
            `Confidence: ${normalized.value.confidenceTier}\n\n` +
            `Run /anchor review to approve, edit externally, or discard it.`,
          isError: false,
        }
      } catch (err) {
        return { content: `physical_anchor_write failed: ${String(err)}`, isError: true }
      }
    },
  }
}
