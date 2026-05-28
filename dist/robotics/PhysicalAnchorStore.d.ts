import type { PhysicalAnchorEntry, PhysicalAnchorSearchQuery } from './types.js';
export declare function isPhysicalAnchorId(id: string): boolean;
export declare class PhysicalAnchorStore {
    private readonly dir;
    constructor(dir?: string);
    ensureDir(): Promise<void>;
    write(entry: Omit<PhysicalAnchorEntry, 'id' | 'schemaVersion' | 'createdAt' | 'updatedAt'>): Promise<string>;
    load(id: string): Promise<PhysicalAnchorEntry | null>;
    search(query?: PhysicalAnchorSearchQuery): Promise<PhysicalAnchorEntry[]>;
    getStats(): Promise<{
        total: number;
        domainCounts: Record<string, number>;
    }>;
    formatForPrompt(opts?: PhysicalAnchorSearchQuery): Promise<string>;
    listIds(): Promise<string[]>;
    private _loadAll;
}
//# sourceMappingURL=PhysicalAnchorStore.d.ts.map