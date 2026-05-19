/**
 * OOMChecker — Order-of-Magnitude reasonableness check.
 *
 * Cross-references numeric outputs against a reference database of typical
 * engineering value ranges.  Catches the most common category of simulation
 * errors: unit conversion mistakes that produce values that are physically
 * plausible in isolation but absurd for the specific quantity.
 *
 * Example:
 *   Steel yield strength is typically 250–1000 MPa.
 *   If a FEM tool returns 250,000 MPa, that's almost certainly a Pa→MPa
 *   unit confusion — the OOMChecker will flag it.
 *
 * Tolerance:
 *   The checker allows ±2 orders of magnitude (factor of 100) beyond the
 *   reference range.  This is intentionally loose — it's meant to catch
 *   gross errors, not replace a proper uncertainty analysis.
 *
 *   Example: reference range [250, 1000] MPa → alert if value < 2.5 or > 100,000 MPa.
 *
 * Reference DB format:
 *
 *   {
 *     [toolCapabilityOrName]: {
 *       [outputFieldName]: {
 *         min: number,       // typical minimum (in the stated unit)
 *         max: number,       // typical maximum
 *         unit: string,      // for human-readable messages only
 *         description?: string
 *       }
 *     }
 *   }
 *
 * The checker matches output fields using three strategies (in order):
 *   1. exact match on field name within the tool's own entry
 *   2. substring match on field name in the global catch-all ('*') entry
 *   3. no match → skip (no false positives on unknown fields)
 */
import type { VVHook, VVResult, VVContext } from '../types.js';
export interface OOMRange {
    min: number;
    max: number;
    unit: string;
    description?: string;
}
/** key = tool name (or '*' for global catch-all), value = field→range map */
export type OOMReferenceDB = Record<string, Record<string, OOMRange>>;
export declare const BUILT_IN_OOM_DB: OOMReferenceDB;
export declare class OOMChecker implements VVHook {
    readonly name = "OOMChecker";
    readonly phase: "post_call";
    readonly appliesTo: "*";
    private readonly db;
    constructor(additionalDB?: OOMReferenceDB);
    run(ctx: VVContext): Promise<VVResult>;
    private _findRange;
    private _inRange;
    private _extractNumber;
    private _fmt;
    private _pass;
}
//# sourceMappingURL=OOMChecker.d.ts.map