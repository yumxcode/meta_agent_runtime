/**
 * UnitRegistry — maps unit symbol strings to SI conversion functions.
 *
 * Every unit definition contains:
 *   dimension  — DimensionVector (for compatibility checks)
 *   toSI(v)    — converts a value in this unit to the SI base value
 *   fromSI(v)  — converts an SI base value back to this unit
 *
 * Linear units (most):   toSI = v * factor,  fromSI = v / factor
 * Affine units (°C, °F): require an offset in addition to the scale factor
 *
 * SI base values:
 *   mass        → kg
 *   length      → m
 *   time        → s
 *   temperature → K
 *   current     → A
 *   amount      → mol
 *   charge      → C (= A·s)
 *   energy      → J (= kg·m²·s⁻²)
 *   force       → N (= kg·m·s⁻²)
 *   pressure    → Pa (= kg·m⁻¹·s⁻²)
 *   voltage     → V (= kg·m²·s⁻³·A⁻¹)
 */

import type { DimensionVector, PhysicalQuantity } from './types.js'
import { DIMENSIONS } from './dimensions.js'
import { dimensionsMatch } from './dimensions.js'

// ─────────────────────────────────────────────────────────────────────────────
// Unit definition
// ─────────────────────────────────────────────────────────────────────────────

export interface UnitDef {
  dimension: DimensionVector
  /** Convert a value in this unit to the corresponding SI base value */
  toSI: (value: number) => number
  /** Convert an SI base value to this unit */
  fromSI: (value: number) => number
  /** Optional description */
  description?: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: linear unit factory
// ─────────────────────────────────────────────────────────────────────────────

function linear(dimension: DimensionVector, factor: number, description?: string): UnitDef {
  return {
    dimension,
    toSI:   v => v * factor,
    fromSI: v => v / factor,
    description,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Built-in unit table
// ─────────────────────────────────────────────────────────────────────────────

const BUILT_IN_UNITS: Record<string, UnitDef> = {

  // ── Mass ─────────────────────────────────────────────────────────────────
  'kg':   linear(DIMENSIONS.MASS, 1,        'kilogram (SI base)'),
  'g':    linear(DIMENSIONS.MASS, 1e-3,     'gram'),
  'mg':   linear(DIMENSIONS.MASS, 1e-6,     'milligram'),
  't':    linear(DIMENSIONS.MASS, 1e3,      'metric tonne'),
  'lb':   linear(DIMENSIONS.MASS, 0.453592, 'pound'),
  'oz':   linear(DIMENSIONS.MASS, 0.028350, 'ounce'),

  // ── Length ───────────────────────────────────────────────────────────────
  'm':    linear(DIMENSIONS.LENGTH, 1,         'metre (SI base)'),
  'km':   linear(DIMENSIONS.LENGTH, 1e3,       'kilometre'),
  'cm':   linear(DIMENSIONS.LENGTH, 1e-2,      'centimetre'),
  'mm':   linear(DIMENSIONS.LENGTH, 1e-3,      'millimetre'),
  'µm':   linear(DIMENSIONS.LENGTH, 1e-6,      'micrometre'),
  'um':   linear(DIMENSIONS.LENGTH, 1e-6,      'micrometre (ASCII)'),
  'nm':   linear(DIMENSIONS.LENGTH, 1e-9,      'nanometre'),
  'in':   linear(DIMENSIONS.LENGTH, 0.025400,  'inch'),
  'ft':   linear(DIMENSIONS.LENGTH, 0.304800,  'foot'),
  'yd':   linear(DIMENSIONS.LENGTH, 0.914400,  'yard'),
  'mi':   linear(DIMENSIONS.LENGTH, 1609.344,  'mile'),

  // ── Time ──────────────────────────────────────────────────────────────────
  's':    linear(DIMENSIONS.TIME, 1,        'second (SI base)'),
  'ms':   linear(DIMENSIONS.TIME, 1e-3,    'millisecond'),
  'µs':   linear(DIMENSIONS.TIME, 1e-6,    'microsecond'),
  'us':   linear(DIMENSIONS.TIME, 1e-6,    'microsecond (ASCII)'),
  'ns':   linear(DIMENSIONS.TIME, 1e-9,    'nanosecond'),
  'min':  linear(DIMENSIONS.TIME, 60,      'minute'),
  'h':    linear(DIMENSIONS.TIME, 3600,    'hour'),
  'hr':   linear(DIMENSIONS.TIME, 3600,    'hour (alt)'),
  'd':    linear(DIMENSIONS.TIME, 86400,   'day'),

  // ── Temperature (affine — require special handling) ───────────────────────
  'K': {
    dimension: DIMENSIONS.TEMPERATURE,
    toSI:   v => v,
    fromSI: v => v,
    description: 'Kelvin (SI base)',
  },
  '°C': {
    dimension: DIMENSIONS.TEMPERATURE,
    toSI:   v => v + 273.15,
    fromSI: v => v - 273.15,
    description: 'Celsius',
  },
  'C': {  // allow "C" as alias when context is temperature
    dimension: DIMENSIONS.TEMPERATURE,
    toSI:   v => v + 273.15,
    fromSI: v => v - 273.15,
    description: 'Celsius (no-degree alias)',
  },
  '°F': {
    dimension: DIMENSIONS.TEMPERATURE,
    toSI:   v => (v + 459.67) * 5 / 9,
    fromSI: v => v * 9 / 5 - 459.67,
    description: 'Fahrenheit',
  },

  // ── Current ───────────────────────────────────────────────────────────────
  'A':    linear(DIMENSIONS.CURRENT, 1,     'ampere (SI base)'),
  'mA':   linear(DIMENSIONS.CURRENT, 1e-3, 'milliampere'),
  'µA':   linear(DIMENSIONS.CURRENT, 1e-6, 'microampere'),
  'uA':   linear(DIMENSIONS.CURRENT, 1e-6, 'microampere (ASCII)'),
  'kA':   linear(DIMENSIONS.CURRENT, 1e3,  'kiloampere'),

  // ── Force ─────────────────────────────────────────────────────────────────
  'N':    linear(DIMENSIONS.FORCE, 1,       'newton (SI base)'),
  'kN':   linear(DIMENSIONS.FORCE, 1e3,    'kilonewton'),
  'MN':   linear(DIMENSIONS.FORCE, 1e6,    'meganewton'),
  'GN':   linear(DIMENSIONS.FORCE, 1e9,    'giganewton'),
  'lbf':  linear(DIMENSIONS.FORCE, 4.44822,'pound-force'),

  // ── Pressure / Stress ─────────────────────────────────────────────────────
  'Pa':   linear(DIMENSIONS.PRESSURE, 1,       'pascal (SI base)'),
  'kPa':  linear(DIMENSIONS.PRESSURE, 1e3,     'kilopascal'),
  'MPa':  linear(DIMENSIONS.PRESSURE, 1e6,     'megapascal'),
  'GPa':  linear(DIMENSIONS.PRESSURE, 1e9,     'gigapascal'),
  'bar':  linear(DIMENSIONS.PRESSURE, 1e5,     'bar'),
  'mbar': linear(DIMENSIONS.PRESSURE, 100,     'millibar'),
  'atm':  linear(DIMENSIONS.PRESSURE, 101325,  'standard atmosphere'),
  'psi':  linear(DIMENSIONS.PRESSURE, 6894.76, 'pound per square inch'),
  'ksi':  linear(DIMENSIONS.PRESSURE, 6894760, 'kilopound per square inch'),

  // ── Energy ────────────────────────────────────────────────────────────────
  'J':    linear(DIMENSIONS.ENERGY, 1,          'joule (SI base)'),
  'kJ':   linear(DIMENSIONS.ENERGY, 1e3,        'kilojoule'),
  'MJ':   linear(DIMENSIONS.ENERGY, 1e6,        'megajoule'),
  'GJ':   linear(DIMENSIONS.ENERGY, 1e9,        'gigajoule'),
  'Wh':   linear(DIMENSIONS.ENERGY, 3600,       'watt-hour'),
  'kWh':  linear(DIMENSIONS.ENERGY, 3.6e6,      'kilowatt-hour'),
  'MWh':  linear(DIMENSIONS.ENERGY, 3.6e9,      'megawatt-hour'),
  'eV':   linear(DIMENSIONS.ENERGY, 1.60218e-19,'electronvolt'),
  'cal':  linear(DIMENSIONS.ENERGY, 4.184,      'calorie (thermochemical)'),
  'kcal': linear(DIMENSIONS.ENERGY, 4184,       'kilocalorie'),
  'BTU':  linear(DIMENSIONS.ENERGY, 1055.06,    'British thermal unit'),

  // ── Power ─────────────────────────────────────────────────────────────────
  'W':    linear(DIMENSIONS.POWER, 1,      'watt (SI base)'),
  'kW':   linear(DIMENSIONS.POWER, 1e3,   'kilowatt'),
  'MW':   linear(DIMENSIONS.POWER, 1e6,   'megawatt'),
  'GW':   linear(DIMENSIONS.POWER, 1e9,   'gigawatt'),
  'hp':   linear(DIMENSIONS.POWER, 745.7, 'mechanical horsepower'),

  // ── Voltage ───────────────────────────────────────────────────────────────
  'V':    linear(DIMENSIONS.VOLTAGE, 1,     'volt (SI base)'),
  'mV':   linear(DIMENSIONS.VOLTAGE, 1e-3, 'millivolt'),
  'µV':   linear(DIMENSIONS.VOLTAGE, 1e-6, 'microvolt'),
  'uV':   linear(DIMENSIONS.VOLTAGE, 1e-6, 'microvolt (ASCII)'),
  'kV':   linear(DIMENSIONS.VOLTAGE, 1e3,  'kilovolt'),

  // ── Charge ────────────────────────────────────────────────────────────────
  'C_charge': linear(DIMENSIONS.CHARGE, 1,       'coulomb (SI base)'), // 'C' is taken by Celsius alias
  'mAh':      linear(DIMENSIONS.CHARGE, 3.6,     'milliampere-hour'),
  'Ah':       linear(DIMENSIONS.CHARGE, 3600,    'ampere-hour'),

  // ── Specific capacity (battery) — A·s/kg ─────────────────────────────────
  'Ah/kg':  linear(DIMENSIONS.SPECIFIC_CAPACITY, 3600,    'ampere-hour per kilogram'),
  'mAh/g':  linear(DIMENSIONS.SPECIFIC_CAPACITY, 3600,    'milliampere-hour per gram (= Ah/kg)'),
  'mAh/kg': linear(DIMENSIONS.SPECIFIC_CAPACITY, 3.6,     'milliampere-hour per kilogram'),

  // ── Specific energy (battery) — J/kg ────────────────────────────────────
  'Wh/kg':  linear(DIMENSIONS.SPECIFIC_ENERGY, 3600,      'watt-hour per kilogram'),
  'kWh/kg': linear(DIMENSIONS.SPECIFIC_ENERGY, 3.6e6,     'kilowatt-hour per kilogram'),
  'J/kg':   linear(DIMENSIONS.SPECIFIC_ENERGY, 1,         'joule per kilogram'),

  // ── Frequency ─────────────────────────────────────────────────────────────
  'Hz':    linear(DIMENSIONS.FREQUENCY, 1,    'hertz (SI base)'),
  'kHz':   linear(DIMENSIONS.FREQUENCY, 1e3, 'kilohertz'),
  'MHz':   linear(DIMENSIONS.FREQUENCY, 1e6, 'megahertz'),
  'GHz':   linear(DIMENSIONS.FREQUENCY, 1e9, 'gigahertz'),
  'rpm':   linear(DIMENSIONS.FREQUENCY, 1/60,'revolutions per minute'),

  // ── Velocity ──────────────────────────────────────────────────────────────
  'm/s':   linear(DIMENSIONS.VELOCITY, 1,         'metre per second (SI)'),
  'km/h':  linear(DIMENSIONS.VELOCITY, 1/3.6,     'kilometre per hour'),
  'mph':   linear(DIMENSIONS.VELOCITY, 0.44704,   'mile per hour'),
  'ft/s':  linear(DIMENSIONS.VELOCITY, 0.3048,    'foot per second'),
  'knot':  linear(DIMENSIONS.VELOCITY, 0.514444,  'knot'),

  // ── Acceleration ─────────────────────────────────────────────────────────
  'm/s²':  linear(DIMENSIONS.ACCELERATION, 1,     'metre per second squared (SI)'),
  'g0':    linear(DIMENSIONS.ACCELERATION, 9.80665,'standard gravity'),

  // ── Thermal conductivity ─────────────────────────────────────────────────
  'W/(m·K)': linear(DIMENSIONS.THERMAL_CONDUCTIVITY, 1,       'watt per metre kelvin (SI)'),
  'W/mK':    linear(DIMENSIONS.THERMAL_CONDUCTIVITY, 1,       'watt per metre kelvin (alt)'),
  'BTU/(h·ft·°F)': linear(DIMENSIONS.THERMAL_CONDUCTIVITY, 1.73073, 'BTU per hour foot Fahrenheit'),

  // ── Specific heat ─────────────────────────────────────────────────────────
  'J/(kg·K)':   linear(DIMENSIONS.SPECIFIC_HEAT, 1,      'joule per kilogram kelvin (SI)'),
  'kJ/(kg·K)':  linear(DIMENSIONS.SPECIFIC_HEAT, 1e3,    'kilojoule per kilogram kelvin'),
  'cal/(g·°C)': linear(DIMENSIONS.SPECIFIC_HEAT, 4184,   'calorie per gram degree Celsius'),

  // ── Density ───────────────────────────────────────────────────────────────
  'kg/m³':  linear(DIMENSIONS.DENSITY, 1,       'kilogram per cubic metre (SI)'),
  'g/cm³':  linear(DIMENSIONS.DENSITY, 1e3,     'gram per cubic centimetre'),
  'g/cc':   linear(DIMENSIONS.DENSITY, 1e3,     'gram per cubic centimetre (alt)'),
  'kg/L':   linear(DIMENSIONS.DENSITY, 1e3,     'kilogram per litre'),
  'lb/ft³': linear(DIMENSIONS.DENSITY, 16.0185, 'pound per cubic foot'),

  // ── Dimensionless ─────────────────────────────────────────────────────────
  '%':       linear({}, 0.01,  'percent'),
  'ppm':     linear({}, 1e-6,  'parts per million'),
  'ppb':     linear({}, 1e-9,  'parts per billion'),
  '—':       linear({}, 1,     'dimensionless'),
  'ratio':   linear({}, 1,     'dimensionless ratio'),
  'dimensionless': linear({}, 1, 'dimensionless'),
}

// ─────────────────────────────────────────────────────────────────────────────
// UnitRegistry class
// ─────────────────────────────────────────────────────────────────────────────

export class UnitRegistry {
  private units: Map<string, UnitDef>

  constructor(additionalUnits: Record<string, UnitDef> = {}) {
    this.units = new Map(Object.entries({ ...BUILT_IN_UNITS, ...additionalUnits }))
  }

  /** Look up a unit definition. Returns null if unknown. */
  get(unit: string): UnitDef | null {
    return this.units.get(unit) ?? null
  }

  /** All known unit symbols */
  knownUnits(): string[] {
    return [...this.units.keys()]
  }

  /** Register a custom unit at runtime */
  register(symbol: string, def: UnitDef): void {
    this.units.set(symbol, def)
  }

  /**
   * Convert a PhysicalQuantity to a different unit.
   *
   * Returns null if either unit is unknown or they have incompatible dimensions.
   */
  convert(qty: PhysicalQuantity, targetUnit: string): PhysicalQuantity | null {
    const srcDef = this.get(qty.unit)
    const tgtDef = this.get(targetUnit)
    if (!srcDef || !tgtDef) return null
    if (!dimensionsMatch(srcDef.dimension, tgtDef.dimension)) return null

    const siValue = srcDef.toSI(qty.value)
    const newValue = tgtDef.fromSI(siValue)

    const result: PhysicalQuantity = {
      value: newValue,
      unit: targetUnit,
      dimension: tgtDef.dimension,
    }
    if (qty.uncertainty !== undefined) {
      // Scale uncertainty proportionally (valid for linear units)
      // For affine units (°C, °F) this is approximate but acceptable for 1σ
      const siUncertainty = srcDef.toSI(qty.value + qty.uncertainty) - siValue
      result.uncertainty = Math.abs(tgtDef.fromSI(siValue + siUncertainty) - newValue)
    }
    return result
  }

  /**
   * Convert a raw numeric value from one unit to another.
   * Returns null if either unit is unknown or incompatible.
   */
  convertValue(value: number, fromUnit: string, toUnit: string): number | null {
    const srcDef = this.get(fromUnit)
    const tgtDef = this.get(toUnit)
    if (!srcDef || !tgtDef) return null
    if (!dimensionsMatch(srcDef.dimension, tgtDef.dimension)) return null
    return tgtDef.fromSI(srcDef.toSI(value))
  }

  /**
   * Create a PhysicalQuantity from a raw value and unit string.
   * Returns null if the unit is unknown.
   */
  quantity(value: number, unit: string, uncertainty?: number): PhysicalQuantity | null {
    const def = this.get(unit)
    if (!def) return null
    const q: PhysicalQuantity = { value, unit, dimension: def.dimension }
    if (uncertainty !== undefined) q.uncertainty = uncertainty
    return q
  }

  /**
   * Return the SI value of a quantity (for internal computation).
   */
  toSIValue(qty: PhysicalQuantity): number | null {
    const def = this.get(qty.unit)
    return def ? def.toSI(qty.value) : null
  }
}

/** Shared default registry — use this unless you need custom units */
export const defaultRegistry = new UnitRegistry()
