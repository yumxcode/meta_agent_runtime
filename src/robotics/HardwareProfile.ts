import { readdir } from 'fs/promises'
import { homedir } from 'os'
import { META_AGENT_HOME } from '../core/metaAgentHome.js'
import { join } from 'path'
import { atomicWriteJson, readJsonFile } from '../core/persist/index.js'
import type { HardwareProfileData } from './types.js'

const PROFILES_ROOT = join(META_AGENT_HOME, 'robotics', 'hardware_profiles')

export class HardwareProfile {
  private readonly dir: string
  private readonly robot: string | undefined

  constructor(dir?: string, robot?: string) {
    this.dir = dir ?? PROFILES_ROOT
    this.robot = robot
  }

  private _profilePath(name: string): string {
    return join(this.dir, `${name.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`)
  }

  async read(name?: string): Promise<HardwareProfileData | null> {
    const target = name ?? this.robot
    if (!target) return null
    return readJsonFile<HardwareProfileData>(this._profilePath(target))
  }

  async write(data: Omit<HardwareProfileData, 'schemaVersion' | 'updatedAt'>): Promise<void> {
    const full: HardwareProfileData = { ...data, schemaVersion: '1.0', updatedAt: Date.now() }
    await atomicWriteJson(this._profilePath(data.name), full)
  }

  async list(): Promise<string[]> {
    try {
      const files = await readdir(this.dir)
      return files.filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''))
    } catch { return [] }
  }

  /** Format profile as a compact Markdown block for prompt injection (R4 section) */
  async formatForPrompt(name?: string): Promise<string> {
    const profile = await this.read(name)
    if (!profile) return ''
    const lines = [
      `## Hardware Profile: ${profile.name}`,
      `**Platform**: ${profile.platform}`,
      `**Compute**: ${profile.compute}`,
    ]
    if (profile.os) lines.push(`**OS**: ${profile.os}`)
    if (profile.actuators) lines.push(`**Actuators**: ${profile.actuators}`)
    if (profile.sensors) lines.push(`**Sensors**: ${profile.sensors}`)
    lines.push('**Safety Limits**:')
    for (const [k, v] of Object.entries(profile.safetyLimits)) {
      lines.push(`  - ${k}: ${v}`)
    }
    if (profile.knownIssues?.length) {
      lines.push('**Known Issues**:')
      profile.knownIssues.forEach(i => lines.push(`  - ${i}`))
    }
    if (profile.notes) lines.push(`**Notes**: ${profile.notes}`)
    return lines.join('\n')
  }
}
