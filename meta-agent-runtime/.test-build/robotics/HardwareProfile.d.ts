import type { HardwareProfileData } from './types.js';
export declare class HardwareProfile {
    private readonly dir;
    private readonly robot;
    constructor(dir?: string, robot?: string);
    private _profilePath;
    read(name?: string): Promise<HardwareProfileData | null>;
    write(data: Omit<HardwareProfileData, 'schemaVersion' | 'updatedAt'>): Promise<void>;
    list(): Promise<string[]>;
    /** Format profile as a compact Markdown block for prompt injection (R4 section) */
    formatForPrompt(name?: string): Promise<string>;
}
//# sourceMappingURL=HardwareProfile.d.ts.map