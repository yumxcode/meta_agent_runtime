/**
 * Units system — core types
 *
 * The 7 SI base dimensions are the foundation. Every derived unit is
 * expressed as a product of integer (or rational) powers of these.
 *
 * Examples:
 *   velocity  = length¹ · time⁻¹          → { length: 1, time: -1 }
 *   stress    = mass¹ · length⁻¹ · time⁻² → { mass: 1, length: -1, time: -2 }
 *   voltage   = mass¹ · length² · time⁻³ · current⁻¹
 */
export type BaseDimension = 'mass' | 'length' | 'time' | 'temperature' | 'current' | 'amount' | 'luminosity';
/** The ordered canonical list — used for formatting and comparison */
export declare const BASE_DIMENSIONS: BaseDimension[];
/**
 * Exponents for each base dimension.
 * Absent keys are treated as exponent 0 (dimensionless for that component).
 *
 * Dimensionless quantity: {} (empty object)
 */
export type DimensionVector = Partial<Record<BaseDimension, number>>;
/**
 * A numeric value with an explicit unit and its dimensional signature.
 *
 * `dimension` is the machine-verifiable part; `unit` is human-readable.
 * Both must be consistent: if unit = "MPa" then dimension must equal STRESS.
 *
 * `uncertainty` is one standard deviation (1σ) in the same unit as `value`.
 */
export interface PhysicalQuantity {
    value: number;
    /** Human-readable unit string: "MPa", "°C", "mAh/g", "m/s²" … */
    unit: string;
    dimension: DimensionVector;
    /** 1σ measurement / simulation uncertainty (same unit as value, optional) */
    uncertainty?: number;
}
export interface DimensionError {
    /** Field name in the tool input/output record */
    param: string;
    expected: DimensionVector;
    received: DimensionVector;
    /** Plain-English hint for the model */
    hint: string;
}
/**
 * Per-field dimension declaration in a tool's input/output schema.
 * Tools use this to tell the DimensionalConsistencyChecker what they expect.
 *
 * Example:
 *   const schema: DimensionSpec = {
 *     temperature:    { dimension: DIMENSIONS.TEMPERATURE },
 *     voltage_cutoff: { dimension: DIMENSIONS.VOLTAGE },
 *     label:          {}   // no dimension — string field, skip check
 *   }
 */
export type DimensionSpec = Record<string, {
    dimension?: DimensionVector;
    required?: boolean;
}>;
export interface ConversionResult {
    quantity: PhysicalQuantity;
    /** True if the source and target units have the same dimension */
    compatible: boolean;
    /** Set when compatible=false */
    error?: string;
}
//# sourceMappingURL=types.d.ts.map