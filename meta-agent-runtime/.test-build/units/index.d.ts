/**
 * Units system — public exports
 */
export type { BaseDimension, DimensionVector, PhysicalQuantity, DimensionError, DimensionSpec, ConversionResult, } from './types.js';
export { BASE_DIMENSIONS } from './types.js';
export { DIMENSIONLESS, DIMENSIONS, formatDimension, dimensionsMatch, multiplyDimensions, invertDimension, identifyDimension, } from './dimensions.js';
export { UnitRegistry, defaultRegistry } from './UnitRegistry.js';
export type { UnitDef } from './UnitRegistry.js';
export { DimensionalConsistencyChecker, defaultChecker, } from './DimensionalConsistencyChecker.js';
//# sourceMappingURL=index.d.ts.map