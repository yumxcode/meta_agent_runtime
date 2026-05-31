import type { FlashClient } from '../core/flash/FlashClient.js';
import type { ExperienceEntry } from './types.js';
import { type ExperienceStore } from './ExperienceStore.js';
import type { PhysicalAnchorStore } from './PhysicalAnchorStore.js';
import type { PrinciplePendingStore } from './PrinciplePendingStore.js';
export declare const PRINCIPLE_PROMOTION_SCORE_THRESHOLD = 500;
export type PrinciplePromotionReason = 'confidence_threshold' | 'explicit_user_request';
export interface PrinciplePromotionResult {
    promoted: boolean;
    pendingId?: string;
    reason: 'below_threshold' | 'missing_experience' | 'missing_flash' | 'flash_failed' | 'queued';
    score?: number;
}
export declare function shouldTriggerPrinciplePromotion(experience: ExperienceEntry, threshold?: number): boolean;
export declare function proposePrincipleFromExperience(opts: {
    experienceId: string;
    experienceStore: ExperienceStore;
    anchorStore: PhysicalAnchorStore;
    pendingStore: PrinciplePendingStore;
    flash?: FlashClient | null;
    reason: PrinciplePromotionReason;
    threshold?: number;
}): Promise<PrinciplePromotionResult>;
//# sourceMappingURL=PrinciplePromotion.d.ts.map