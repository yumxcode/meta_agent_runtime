import type { PhysicalAnchorStore } from './PhysicalAnchorStore.js';
import { type KnowledgeConfidenceTier, type KnowledgeScope, type RoboticsDomain } from './types.js';
export interface PendingPhysicalAnchor {
    pendingId: string;
    proposedAt: number;
    input: Record<string, unknown>;
}
export declare class PhysicalAnchorPendingStore {
    private readonly _pending;
    private readonly _filePath;
    private _persistTail;
    constructor(projectDir?: string, root?: string);
    load(): Promise<void>;
    add(input: Record<string, unknown>): string;
    list(): readonly PendingPhysicalAnchor[];
    get count(): number;
    remove(pendingId: string): boolean;
    flush(): Promise<void>;
    commit(pendingId: string, store: PhysicalAnchorStore): Promise<string | null>;
    private _persistSoon;
    private _persist;
}
type NormalizedPhysicalAnchorInput = {
    domain: RoboticsDomain;
    scope: KnowledgeScope;
    title: string;
    fact: string;
    implication: string;
    mechanism?: string;
    robot?: string;
    tags: string[];
    confidenceTier: KnowledgeConfidenceTier;
    evidenceRefs: string[];
    source?: string;
    lastVerifiedAt?: number;
    invalidates?: string[];
};
export declare function validatePhysicalAnchorInput(input: Record<string, unknown>): {
    ok: true;
    value: NormalizedPhysicalAnchorInput;
} | {
    ok: false;
};
export {};
//# sourceMappingURL=PhysicalAnchorPendingStore.d.ts.map