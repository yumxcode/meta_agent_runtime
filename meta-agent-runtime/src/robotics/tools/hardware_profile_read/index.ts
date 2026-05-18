import type { MetaAgentTool, ToolResult } from '../../../core/types.js'
import type { HardwareProfile } from '../../HardwareProfile.js'

export function createHardwareProfileReadTool(profile: HardwareProfile): MetaAgentTool {
  return {
    name: 'hardware_profile_read',
    isConcurrencySafe: true,
    description:
      'Read the hardware profile for a robot platform. ' +
      'Always call this before designing hardware experiments to check safety limits and known issues. ' +
      'If no name is provided, reads the default profile for the current session\'s robot.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Robot/platform name. Omit to use the session default.',
        },
      },
    },
    async call(input): Promise<ToolResult> {
      const name = input['name'] as string | undefined
      try {
        const available = await profile.list()
        if (available.length === 0 && !name) {
          return {
            content: 'No hardware profiles found. Create one with hardware_profile_write first.',
            isError: false,
          }
        }
        const formatted = await profile.formatForPrompt(name)
        if (!formatted) {
          const hint = available.length
            ? `Available profiles: ${available.join(', ')}`
            : 'No profiles exist yet — use hardware_profile_write to create one.'
          return {
            content: `Hardware profile not found${name ? ` for "${name}"` : ''}. ${hint}`,
            isError: true,
          }
        }
        return { content: formatted, isError: false }
      } catch (err) {
        return { content: `hardware_profile_read failed: ${String(err)}`, isError: true }
      }
    },
  }
}
