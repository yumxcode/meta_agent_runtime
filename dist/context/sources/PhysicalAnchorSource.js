/**
 * PhysicalAnchorSource — manifest-line provider for R6 Physical Anchors section.
 *
 * Unlike ExperienceSource (which feeds ContextPager slots via listExperiences),
 * PhysicalAnchorSource only provides a compact manifest line.  Physical anchor
 * slots are loaded proactively in R6 (high-confidence global/robot scope) or
 * on demand via physical_anchor_search / physical_anchor_load.
 */
export class PhysicalAnchorSource {
    store;
    constructor(store) {
        this.store = store;
    }
    /**
     * One-line summary for the Manifest layer.
     * Shows total count, scope breakdown (global/robot/code), and top domains.
     * Example: "Physical anchors: 7 total | global:2 robot:3 code:2 | motion_planning:4"
     */
    async getManifestLine() {
        try {
            const stats = await this.store.getStats();
            if (stats.total === 0)
                return 'Physical anchors: none yet';
            const scopeParts = Object.entries(stats.scopeCounts)
                .filter(([, n]) => n > 0)
                .map(([s, n]) => `${s}:${n}`)
                .join(' ');
            const topDomains = Object.entries(stats.domainCounts)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 2)
                .map(([d, n]) => `${d}:${n}`)
                .join(', ');
            return `Physical anchors: ${stats.total} total | ${scopeParts}${topDomains ? ` | ${topDomains}` : ''}`;
        }
        catch {
            return 'Physical anchors: (unavailable)';
        }
    }
    /**
     * Load top-priority anchors for proactive R6 slot injection.
     * Returns up to `limit` high-confidence global and robot-scoped anchors
     * that should always be visible without a tool call.
     */
    async loadPriorityAnchors(limit = 3) {
        try {
            // Load global anchors (universal physics / spec facts)
            const global = await this.store.search({ scope: 'global', limit });
            // Load robot-specific anchors (platform constraints)
            const robot = await this.store.search({ scope: 'robot', limit });
            // Merge, deduplicate, cap
            const seen = new Set();
            const result = [];
            for (const a of [...global, ...robot]) {
                if (!seen.has(a.id) && result.length < limit) {
                    seen.add(a.id);
                    result.push(a);
                }
            }
            return result;
        }
        catch {
            return [];
        }
    }
}
//# sourceMappingURL=PhysicalAnchorSource.js.map