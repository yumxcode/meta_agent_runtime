import type { PrincipleStore } from './PrincipleStore.js';
import type { ExperienceStore } from './ExperienceStore.js';
import { type KnowledgeConfidenceTier, type PrincipleAbstractionLevel, type RoboticsDomain } from './types.js';
export interface PendingPrinciple {
    pendingId: string;
    proposedAt: number;
    input: Record<string, unknown>;
}
export declare class PrinciplePendingStore {
    private readonly _pending;
    private readonly _filePath;
    private _persistTail;
    constructor(projectDir?: string, root?: string);
    load(): Promise<void>;
    add(input: Record<string, unknown>): string;
    list(): readonly PendingPrinciple[];
    get count(): number;
    remove(pendingId: string): boolean;
    flush(): Promise<void>;
    commit(pendingId: string, store: PrincipleStore, experienceStore?: ExperienceStore): Promise<string | null>;
    private _persistSoon;
    private _trimToLimit;
    private _persist;
}
type NormalizedPrincipleInput = {
    title: string;
    statement: string;
    mechanism: string;
    firstPrinciplesSupport: string[];
    domains: RoboticsDomain[];
    abstractionLevel: PrincipleAbstractionLevel;
    preconditions: string[];
    applicabilityBounds: string[];
    nonApplicableWhen: string[];
    derivedFromExperienceIds: string[];
    anchoredByPhysicalAnchorIds: string[];
    evidenceRefs: string[];
    invalidatedAssumptions: string[];
    counterExamples: string[];
    confidenceTier: KnowledgeConfidenceTier;
    observationCount: number;
    contradictionCount: number;
    promotionReason: 'confidence_threshold' | 'explicit_user_request';
    sourceExperienceId?: string;
    lastVerifiedAt?: number;
};
export declare function validatePrincipleInput(input: Record<string, unknown>): {
    ok: true;
    value: NormalizedPrincipleInput;
} | {
    ok: false;
};
export {};
//# sourceMappingURL=PrinciplePendingStore.d.ts.map