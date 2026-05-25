import { readdir } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { atomicWriteJson, readJsonFile } from '../core/persist/index.js';
const PROFILES_ROOT = join(homedir(), '.claude', 'meta-agent', 'robotics', 'hardware_profiles');
export class HardwareProfile {
    dir;
    robot;
    constructor(dir, robot) {
        this.dir = dir ?? PROFILES_ROOT;
        this.robot = robot;
    }
    _profilePath(name) {
        return join(this.dir, `${name.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
    }
    async read(name) {
        const target = name ?? this.robot;
        if (!target)
            return null;
        return readJsonFile(this._profilePath(target));
    }
    async write(data) {
        const full = { ...data, schemaVersion: '1.0', updatedAt: Date.now() };
        await atomicWriteJson(this._profilePath(data.name), full);
    }
    async list() {
        try {
            const files = await readdir(this.dir);
            return files.filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));
        }
        catch {
            return [];
        }
    }
    /** Format profile as a compact Markdown block for prompt injection (R4 section) */
    async formatForPrompt(name) {
        const profile = await this.read(name);
        if (!profile)
            return '';
        const lines = [
            `## Hardware Profile: ${profile.name}`,
            `**Platform**: ${profile.platform}`,
            `**Compute**: ${profile.compute}`,
        ];
        if (profile.os)
            lines.push(`**OS**: ${profile.os}`);
        if (profile.actuators)
            lines.push(`**Actuators**: ${profile.actuators}`);
        if (profile.sensors)
            lines.push(`**Sensors**: ${profile.sensors}`);
        lines.push('**Safety Limits**:');
        for (const [k, v] of Object.entries(profile.safetyLimits)) {
            lines.push(`  - ${k}: ${v}`);
        }
        if (profile.knownIssues?.length) {
            lines.push('**Known Issues**:');
            profile.knownIssues.forEach(i => lines.push(`  - ${i}`));
        }
        if (profile.notes)
            lines.push(`**Notes**: ${profile.notes}`);
        return lines.join('\n');
    }
}
//# sourceMappingURL=HardwareProfile.js.map