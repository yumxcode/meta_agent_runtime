/**
 * Units system — public exports
 */

// Types
export type {
  BaseDimension,
  DimensionVector,
  PhysicalQuantity,
  DimensionError,
  DimensionSpec,
  ConversionResult,
} from './types.js'
export { BASE_DIMENSIONS } from './types.js'

// Dimension vectors + utilities
export {
  DIMENSIONLESS,
  DIMENSIONS,
  formatDimension,
  dimensionsMatch,
  multiplyDimensions,
  invertDimension,
  identifyDimension,
} from './dimensions.js'

// Unit registry
export { UnitRegistry, defaultRegistry } from './UnitRegistry.js'
export type { UnitDef } from './UnitRegistry.js'

// Dimensional consistency checker
export {
  DimensionalConsistencyChecker,
  defaultChecker,
} from './DimensionalConsistencyChecker.js'
