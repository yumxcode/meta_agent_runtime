/**
 * DOE Campaign Plugin
 *
 * Wraps the existing CampaignStateStore / CapsuleBuilder infrastructure
 * so that DOE campaigns participate in the CampaignPlugin framework
 * without any changes to those files.
 *
 * The DOE plugin uses its OWN CampaignStateStore for persistence —
 * GenericCampaignStore is NOT used here.  That means all existing DOE
 * code (Monitor, Coordinator, ParetoAnalyzer) continues to work unchanged.
 *
 * What the plugin provides to the framework:
 *  - buildCapsule()       → delegates to CapsuleBuilder (moved inline)
 *  - buildPhaseGuidance() → returns the PHASE_GUIDANCE strings from dynamicPrompt
 *  - tools                → empty here; DOE tools are registered separately by
 *                           the Coordinator when it creates the DOE session
 *  - phases               → derived from VALID_TRANSITIONS / PHASE_LABELS / sets
 */
import type { CampaignPlugin } from '../../campaign/types.js';
import { CampaignPhase, DesignSpace } from '../../campaign/index.js';
export interface DOEBusinessState {
    designSpace: DesignSpace;
    sampledPointCount: number;
    completedPointCount: number;
    failedPointCount: number;
    pendingPointCount: number;
    paretoFrontSize: number;
    hypervolume: number | null;
    failureReason?: string;
}
export declare const doeCampaignPlugin: CampaignPlugin<CampaignPhase, DOEBusinessState>;
//# sourceMappingURL=plugin.d.ts.map