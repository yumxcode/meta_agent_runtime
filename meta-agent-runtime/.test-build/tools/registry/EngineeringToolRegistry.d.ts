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
import type { MetaAgentTool } from '../../../src/core/types.js';
export type FidelityLevel = 0 | 1 | 2 | 3 | 4;
export declare const FIDELITY_LABELS: Record<FidelityLevel, string>;
export interface RegistryEntry {
    /** Capability identifier, e.g. 'battery.cell_voltage' */
    capability: string;
    fidelity: FidelityLevel;
    tool: MetaAgentTool;
    registeredAt: number;
    /** Optional free-form notes (solver name, accuracy bounds, etc.) */
    notes?: string;
}
export declare class EngineeringToolRegistry {
    /** capability → fidelity → RegistryEntry */
    private readonly map;
    /**
     * Register a tool under a capability + fidelity pair.
     * Overwrites any existing entry at the same (capability, fidelity).
     */
    register(capability: string, fidelity: FidelityLevel, tool: MetaAgentTool, notes?: string): void;
    /**
     * Remove a specific (capability, fidelity) entry.
     * Returns true if an entry was removed.
     */
    unregister(capability: string, fidelity: FidelityLevel): boolean;
    /**
     * Exact lookup: returns the tool at exactly (capability, fidelity), or null.
     */
    get(capability: string, fidelity: FidelityLevel): MetaAgentTool | null;
    /**
     * Best-available lookup: returns the highest-fidelity tool at or below
     * `maxFidelity` (default: L4).  Returns null if no tool is registered for
     * the capability.
     *
     * Example: if L0 and L2 are registered and maxFidelity=1 → returns L0.
     *          if L0 and L2 are registered and maxFidelity=4 → returns L2.
     */
    bestAvailable(capability: string, maxFidelity?: FidelityLevel): MetaAgentTool | null;
    /**
     * Minimum-fidelity lookup: returns the lowest-fidelity tool at or above
     * `minFidelity`.  Useful when a minimum accuracy is required.
     */
    cheapestAtOrAbove(capability: string, minFidelity?: FidelityLevel): MetaAgentTool | null;
    /**
     * List all entries, optionally filtered by capability prefix.
     * Results are sorted by capability ASC, then fidelity ASC.
     */
    list(capabilityPrefix?: string): RegistryEntry[];
    /**
     * All known capability identifiers (sorted).
     */
    capabilities(): string[];
    /**
     * All fidelity levels registered for a given capability.
     */
    fidelitiesFor(capability: string): FidelityLevel[];
    /**
     * Flat deduplicated list of all registered tools.
     * Suitable for `session.registerTool()` / `bridge.registerTool()` bulk setup.
     *
     * Tools registered under multiple (capability, fidelity) pairs are
     * returned once (by tool.name identity).
     */
    allTools(): MetaAgentTool[];
    /**
     * Human-readable summary for debugging / logging.
     */
    toString(): string;
}
/** Module-level shared registry — use if you don't need multiple registries. */
export declare const defaultRegistry: EngineeringToolRegistry;
//# sourceMappingURL=EngineeringToolRegistry.d.ts.map