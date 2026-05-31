import type { PrincipleEntry, PrincipleSearchQuery } from './types.js';
export declare function isPrincipleId(id: string): boolean;
export declare function principleRetrievalScore(principle: PrincipleEntry): number;
export declare class PrincipleStore {
    private readonly dir;
    private readonly manifestPath;
    constructor(dir?: string);
    ensureDir(): Promise<void>;
    write(entry: Omit<PrincipleEntry, 'id' | 'schemaVersion' | 'createdAt' | 'updatedAt'>): Promise<string>;
    load(id: string): Promise<PrincipleEntry | null>;
    search(query?: PrincipleSearchQuery): Promise<PrincipleEntry[]>;
    listIds(): Promise<string[]>;
    private _loadAll;
    private _loadAllFromFiles;
    private _loadManifestEntries;
    private _rebuildManifestFromFiles;
    private _upsertManifest;
    private _writeManifest;
}
//# sourceMappingURL=PrincipleStore.d.ts.map