/**
 * Hardware Profile Creation Template
 *
 * Controls the fields shown in the `meta-agent --mode robotics` wizard.
 *
 * Load order (highest priority first):
 *   1. <projectDir>/.meta-agent/hardware-template.json
 *   2. ~/.claude/meta-agent/robotics/profile-template.json
 *   3. Built-in default template  (defined below)
 *
 * Template JSON schema: ProfileTemplate (see below)
 */

import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

// ── Template types ────────────────────────────────────────────────────────────

export type FieldType = 'text' | 'kv' | 'csv'

/**
 * A single wizard field definition.
 *
 * Built-in keys (map to HardwareProfileData):
 *   name, platform, compute, os, actuators, sensors, safetyLimits, knownIssues, notes
 *
 * You can also add arbitrary extra keys — they will be stored in `notes` as
 * "key: value" lines appended to any notes the user provides.
 */
export interface TemplateField {
  /** JSON key in HardwareProfileData (or a custom label-only key) */
  key: string
  /** Human-readable label shown in the wizard prompt */
  label: string
  /** Whether the user must fill this field (empty input loops until filled) */
  required?: boolean
  /**
   * Input type:
   *   'text' — plain single-line string (default)
   *   'kv'   — repeated key:value pairs until blank line (used for safetyLimits)
   *   'csv'  — comma-separated values collapsed to string[] (used for knownIssues)
   */
  type?: FieldType
  /** Placeholder shown as "(如 …)" in the prompt */
  hint?: string
  /** Pre-filled default value — user can override by typing a different value */
  default?: string
}

/**
 * A preset provides default values for a known robot platform.
 * During wizard startup the user is offered a numbered list of presets;
 * choosing one pre-fills all matching fields.
 */
export interface ProfilePreset {
  id: string
  label: string
  defaults: Partial<{
    platform: string
    compute: string
    os: string
    actuators: string
    sensors: string
    safetyLimits: Record<string, string>
    notes: string
  }>
}

export interface ProfileTemplate {
  /** Optional robot presets (Unitree, Franka, …) */
  presets?: ProfilePreset[]
  /** Ordered field definitions for the creation wizard */
  fields: TemplateField[]
}

// ── Built-in default template ─────────────────────────────────────────────────

export const DEFAULT_TEMPLATE: ProfileTemplate = {
  presets: [
    {
      id: 'unitree-go2',
      label: 'Unitree Go2 (EDU)',
      defaults: {
        platform:  'Unitree Go2 EDU',
        compute:   'NVIDIA Jetson Orin NX 16GB',
        os:        'Ubuntu 22.04',
        actuators: '12x servo (3-DOF × 4 legs)',
        sensors:   'LiDAR L1, 4× fisheye cameras, IMU',
        safetyLimits: {
          max_joint_velocity: '4.0 rad/s',
          max_linear_velocity: '1.5 m/s',
          max_payload_kg: '5',
        },
      },
    },
    {
      id: 'franka-panda',
      label: 'Franka Panda (Research 3)',
      defaults: {
        platform:  'Franka Panda Research 3',
        compute:   'Intel NUC i7 / workstation',
        os:        'Ubuntu 22.04 + libfranka',
        actuators: '7-DOF arm + 2-finger gripper',
        sensors:   'Joint torque sensors, optional RealSense D435',
        safetyLimits: {
          max_joint_velocity:  '2.17 rad/s',
          max_cartesian_velocity: '1.7 m/s',
          max_force_n:          '87',
        },
      },
    },
    {
      id: 'ros2-generic',
      label: 'Generic ROS 2 robot',
      defaults: {
        platform: 'Custom / ROS 2 Humble',
        os:       'Ubuntu 22.04',
        safetyLimits: {
          max_velocity: 'unset',
        },
      },
    },
  ],

  fields: [
    {
      key:      'name',
      label:    '配置名称',
      required: true,
      hint:     '如 unitree-go2-lab, franka-panda-1',
    },
    {
      key:      'platform',
      label:    '机器人平台',
      required: true,
      hint:     '如 Unitree Go2 EDU',
    },
    {
      key:      'compute',
      label:    '计算硬件',
      required: true,
      hint:     '如 NVIDIA Orin NX 16GB',
    },
    {
      key:   'os',
      label: '操作系统',
      hint:  '如 Ubuntu 22.04',
    },
    {
      key:   'actuators',
      label: '执行器',
      hint:  '如 12x servo, 6-DOF arm',
    },
    {
      key:   'sensors',
      label: '传感器',
      hint:  '如 LiDAR, IMU, depth cam',
    },
    {
      key:      'safetyLimits',
      label:    '安全限制',
      required: true,
      type:     'kv',
      hint:     'key:value，空行结束',
    },
    {
      key:   'knownIssues',
      label: '已知问题',
      type:  'csv',
      hint:  '逗号分隔，可留空',
    },
    {
      key:   'notes',
      label: '备注',
    },
  ],
}

// ── Template loader ───────────────────────────────────────────────────────────

/**
 * Load a ProfileTemplate from JSON, merging with the default template.
 * Unknown keys in the JSON are silently ignored.
 * Missing keys fall back to the default.
 */
async function loadTemplateFile(path: string): Promise<ProfileTemplate | null> {
  if (!existsSync(path)) return null
  try {
    const raw = await readFile(path, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<ProfileTemplate>
    return {
      presets: parsed.presets ?? DEFAULT_TEMPLATE.presets,
      fields:  parsed.fields  ?? DEFAULT_TEMPLATE.fields,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`[meta-agent] Warning: failed to load hardware template at ${path}: ${msg}\n`)
    return null
  }
}

/**
 * Resolve the active ProfileTemplate using the load order:
 *   1. <projectDir>/.meta-agent/hardware-template.json
 *   2. ~/.claude/meta-agent/robotics/profile-template.json
 *   3. Built-in DEFAULT_TEMPLATE
 */
export async function resolveTemplate(projectDir?: string): Promise<ProfileTemplate> {
  const candidates: string[] = []

  if (projectDir) {
    candidates.push(join(projectDir, '.meta-agent', 'hardware-template.json'))
  }
  candidates.push(
    join(homedir(), '.claude', 'meta-agent', 'robotics', 'profile-template.json'),
  )

  for (const p of candidates) {
    const t = await loadTemplateFile(p)
    if (t) return t
  }

  return DEFAULT_TEMPLATE
}
