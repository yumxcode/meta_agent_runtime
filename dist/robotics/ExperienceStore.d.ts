import type { ExperienceEntry, ExperienceSearchQuery } from './types.js';
export declare function isExperienceId(id: string): boolean;
export declare function experienceRetrievalScore(entry: ExperienceEntry): number;
export declare class ExperienceStore {
    private readonly dir;
    private readonly indexPath;
    constructor(dir?: string);
    ensureDir(): Promise<void>;
    write(entry: Omit<ExperienceEntry, 'id' | 'schemaVersion' | 'createdAt' | 'updatedAt'>): Promise<string>;
    search(query: ExperienceSearchQuery): Promise<ExperienceEntry[]>;
    load(id: string): Promise<ExperienceEntry | null>;
    getStats(): Promise<{
        total: number;
        failures: number;
        domainCounts: Record<string, number>;
    }>;
    loadIndexMarkdown(): Promise<string>;
    rebuildIndex(): Promise<void>;
    listIds(): Promise<string[]>;
    private _loadAll;
}
//# sourceMappingURL=ExperienceStore.d.ts.map