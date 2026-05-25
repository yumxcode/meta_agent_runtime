/**
 * EngineeringToolRegistry — capability × fidelity → MetaAgentTool
 *
 * Every engineering tool is registered under a capability identifier (e.g.
 * 'battery.cell_voltage', 'structural.beam_deflection') at a specific
 * fidelity level (L0–L4).  The registry lets the agent select the best
 * available tool for a computation without hard-coding tool names.
 *
 * Fidelity levels:
 *   L0  Analytical / closed-form      < 1 s     (default entry point)
 *   L1  Fast numerical / surrogate     < 1 min
 *   L2  High-fidelity FEA / CFD        < 1 h
 *   L3  Multi-physics coupled          < 1 day
 *   L4  HPC / experimental             days
 *
 * Hot-registration:
 *   register() / unregister() can be called at any time, including while a
 *   session is active.  allTools() returns a deduplicated flat list suitable
 *   for passing to MetaAgentSession.registerTool().
 */
export const FIDELITY_LABELS = {
    0: 'L0 Analytical',
    1: 'L1 Fast-numerical',
    2: 'L2 High-fidelity',
    3: 'L3 Multi-physics',
    4: 'L4 HPC/Experimental',
};
// ─────────────────────────────────────────────────────────────────────────────
// Registry
// ─────────────────────────────────────────────────────────────────────────────
export class EngineeringToolRegistry {
    /** capability → fidelity → RegistryEntry */
    map = new Map();
    // ── Registration ────────────────────────────────────────────────────────────
    /**
     * Register a tool under a capability + fidelity pair.
     * Overwrites any existing entry at the same (capability, fidelity).
     */
    register(capability, fidelity, tool, notes) {
        if (!this.map.has(capability)) {
            this.map.set(capability, new Map());
        }
        this.map.get(capability).set(fidelity, {
            capability,
            fidelity,
            tool,
            registeredAt: Date.now(),
            notes,
        });
    }
    /**
     * Remove a specific (capability, fidelity) entry.
     * Returns true if an entry was removed.
     */
    unregister(capability, fidelity) {
        const fMap = this.map.get(capability);
        if (!fMap)
            return false;
        const removed = fMap.delete(fidelity);
        if (fMap.size === 0)
            this.map.delete(capability);
        return removed;
    }
    // ── Lookup ──────────────────────────────────────────────────────────────────
    /**
     * Exact lookup: returns the tool at exactly (capability, fidelity), or null.
     */
    get(capability, fidelity) {
        return this.map.get(capability)?.get(fidelity)?.tool ?? null;
    }
    /**
     * Best-available lookup: returns the highest-fidelity tool at or below
     * `maxFidelity` (default: L4).  Returns null if no tool is registered for
     * the capability.
     *
     * Example: if L0 and L2 are registered and maxFidelity=1 → returns L0.
     *          if L0 and L2 are registered and maxFidelity=4 → returns L2.
     */
    bestAvailable(capability, maxFidelity = 4) {
        const fMap = this.map.get(capability);
        if (!fMap)
            return null;
        let best = null;
        let bestLevel = -1;
        for (const [level, entry] of fMap) {
            if (level <= maxFidelity && level > bestLevel) {
                best = entry.tool;
                bestLevel = level;
            }
        }
        return best;
    }
    /**
     * Minimum-fidelity lookup: returns the lowest-fidelity tool at or above
     * `minFidelity`.  Useful when a minimum accuracy is required.
     */
    cheapestAtOrAbove(capability, minFidelity = 0) {
        const fMap = this.map.get(capability);
        if (!fMap)
            return null;
        let best = null;
        let bestLevel = 5; // above max
        for (const [level, entry] of fMap) {
            if (level >= minFidelity && level < bestLevel) {
                best = entry.tool;
                bestLevel = level;
            }
        }
        return best;
    }
    // ── Enumeration ─────────────────────────────────────────────────────────────
    /**
     * List all entries, optionally filtered by capability prefix.
     * Results are sorted by capability ASC, then fidelity ASC.
     */
    list(capabilityPrefix) {
        const entries = [];
        for (const [cap, fMap] of this.map) {
            if (capabilityPrefix && !cap.startsWith(capabilityPrefix))
                continue;
            for (const entry of fMap.values()) {
                entries.push(entry);
            }
        }
        return entries.sort((a, b) => a.capability.localeCompare(b.capability) || a.fidelity - b.fidelity);
    }
    /**
     * All known capability identifiers (sorted).
     */
    capabilities() {
        return [...this.map.keys()].sort();
    }
    /**
     * All fidelity levels registered for a given capability.
     */
    fidelitiesFor(capability) {
        const fMap = this.map.get(capability);
        if (!fMap)
            return [];
        return [...fMap.keys()].sort((a, b) => a - b);
    }
    /**
     * Flat deduplicated list of all registered tools.
     * Suitable for `session.registerTool()` / `bridge.registerTool()` bulk setup.
     *
     * Tools registered under multiple (capability, fidelity) pairs are
     * returned once (by tool.name identity).
     */
    allTools() {
        const seen = new Set();
        const tools = [];
        for (const fMap of this.map.values()) {
            for (const { tool } of fMap.values()) {
                if (!seen.has(tool.name)) {
                    seen.add(tool.name);
                    tools.push(tool);
                }
            }
        }
        return tools;
    }
    // ── Diagnostics ─────────────────────────────────────────────────────────────
    /**
     * Human-readable summary for debugging / logging.
     */
    toString() {
        const lines = ['EngineeringToolRegistry:'];
        for (const [cap, fMap] of [...this.map.entries()].sort()) {
            for (const [level, entry] of [...fMap.entries()].sort()) {
                lines.push(`  ${cap} @ ${FIDELITY_LABELS[level]}` +
                    ` → "${entry.tool.name}"` +
                    (entry.notes ? ` (${entry.notes})` : ''));
            }
        }
        return lines.join('\n');
    }
}
/** Module-level shared registry — use if you don't need multiple registries. */
export const defaultRegistry = new EngineeringToolRegistry();
//# sourceMappingURL=EngineeringToolRegistry.js.map