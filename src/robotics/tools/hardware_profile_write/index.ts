import type { MetaAgentTool, ToolResult } from '../../../core/types.js'
import type { HardwareProfile } from '../../HardwareProfile.js'

export function createHardwareProfileWriteTool(profile: HardwareProfile): MetaAgentTool {
  return {
    name: 'hardware_profile_write',
    description:
      'Create or update a hardware profile for a robot platform. ' +
      'Hardware profiles store safety limits, compute specs, and known issues — they are loaded into ' +
      'the R4 system prompt section and inform every hardware experiment design.',
    inputSchema: {
      type: 'object',
      required: ['name', 'platform', 'compute', 'safety_limits'],
      properties: {
        name: {
          type: 'string',
          description: 'Unique profile name / robot identifier (used as filename key)',
        },
        platform: {
          type: 'string',
          description: 'Platform description (e.g. "Unitree Go2", "Franka Panda", "Custom wheeled")',
        },
        compute: {
          type: 'string',
          description: 'Onboard compute (e.g. "Jetson Orin NX 16GB", "Raspberry Pi 4")',
        },
        os: { type: 'string', description: 'Operating system (e.g. "Ubuntu 22.04 + ROS2 Humble")' },
        actuators: { type: 'string', description: 'Actuator summary (e.g. "12 × Unitree A1 motors, 80W max")' },
        sensors: { type: 'string', description: 'Sensor summary (e.g. "Livox Mid-360 LiDAR, D435i RGB-D")' },
        safety_limits: {
          type: 'object',
          description: 'Key safety limits as key→value pairs (e.g. {"max_joint_vel_rad_s": 10, "max_payload_kg": 5})',
        },
        known_issues: {
          type: 'array',
          items: { type: 'string' },
          description: 'Known hardware bugs or operational warnings',
        },
        notes: {
          type: 'string',
          description: 'Additional notes for the hardware',
        },
      },
    },
    async call(input): Promise<ToolResult> {
      try {
        await profile.write({
          name: String(input['name']),
          platform: String(input['platform']),
          compute: String(input['compute']),
          os: input['os'] as string | undefined,
          actuators: input['actuators'] as string | undefined,
          sensors: input['sensors'] as string | undefined,
          safetyLimits: (input['safety_limits'] as Record<string, string | number>) ?? {},
          knownIssues: input['known_issues'] as string[] | undefined,
          notes: input['notes'] as string | undefined,
        })
        return {
          content: `✅ Hardware profile saved for "${input['name']}". It will be loaded into R4 on next session turn.`,
          isError: false,
        }
      } catch (err) {
        return { content: `hardware_profile_write failed: ${String(err)}`, isError: true }
      }
    },
  }
}
