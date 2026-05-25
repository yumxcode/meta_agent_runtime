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
/** The ordered canonical list — used for formatting and comparison */
export const BASE_DIMENSIONS = [
    'mass', 'length', 'time', 'temperature', 'current', 'amount', 'luminosity',
];
//# sourceMappingURL=types.js.map