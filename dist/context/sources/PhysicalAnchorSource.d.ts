/**
 * PhysicalAnchorSource — manifest-line provider for R6 Physical Anchors section.
 *
 * Unlike ExperienceSource (which feeds ContextPager slots via listExperiences),
 * PhysicalAnchorSource only provides a compact manifest line.  Physical anchor
 * slots are loaded proactively in R6 (high-confidence global/robot scope) or
 * on demand via physical_anchor_search / physical_anchor_load.
 */
import type { PhysicalAnchorStore } from '../../robotics/PhysicalAnchorStore.js';
export declare class PhysicalAnchorSource {
    private readonly store;
    constructor(store: PhysicalAnchorStore);
    /**
     * One-line summary for the Manifest layer.
     * Shows total count, scope breakdown (global/robot/code), and top domains.
     * Example: "Physical anchors: 7 total | global:2 robot:3 code:2 | motion_planning:4"
     */
    getManifestLine(): Promise<string>;
    /**
     * Load top-priority anchors for proactive R6 slot injection.
     * Returns up to `limit` high-confidence global and robot-scoped anchors
     * that should always be visible without a tool call.
     */
    loadPriorityAnchors(limit?: number): Promise<Awaited<ReturnType<PhysicalAnchorStore['search']>>>;
}
//# sourceMappingURL=PhysicalAnchorSource.d.ts.map