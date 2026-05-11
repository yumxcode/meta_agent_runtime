/**
 * smoke-test-units.ts — quick sanity check for the dimensional system
 *
 * Run:
 *   cd packages/meta-agent-runtime
 *   npx tsx examples/smoke-test-units.ts
 */

import {
  DIMENSIONS, DIMENSIONLESS, formatDimension,
  dimensionsMatch, multiplyDimensions, invertDimension, identifyDimension,
  defaultRegistry,
  DimensionalConsistencyChecker, defaultChecker,
} from '../src/units/index.js'

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

let passed = 0
let failed = 0

function ok(label: string, cond: boolean) {
  if (cond) {
    console.log(`  ✅  ${label}`)
    passed++
  } else {
    console.error(`  ❌  ${label}`)
    failed++
  }
}

function section(name: string) {
  console.log(`\n── ${name} ──`)
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. formatDimension
// ─────────────────────────────────────────────────────────────────────────────

section('formatDimension')
ok('dimensionless → "dimensionless"',      formatDimension({}) === 'dimensionless')
ok('MASS → "M¹"',                          formatDimension(DIMENSIONS.MASS) === 'M¹')
ok('PRESSURE → "M¹·L⁻¹·T⁻²"',            formatDimension(DIMENSIONS.PRESSURE) === 'M¹·L⁻¹·T⁻²')
ok('VELOCITY → "L¹·T⁻¹"',                formatDimension(DIMENSIONS.VELOCITY) === 'L¹·T⁻¹')
ok('SPECIFIC_ENERGY → "L²·T⁻²"',         formatDimension(DIMENSIONS.SPECIFIC_ENERGY) === 'L²·T⁻²')

// ─────────────────────────────────────────────────────────────────────────────
// 2. dimensionsMatch
// ─────────────────────────────────────────────────────────────────────────────

section('dimensionsMatch')
ok('PRESSURE === STRESS',                  dimensionsMatch(DIMENSIONS.PRESSURE, DIMENSIONS.STRESS))
ok('ENERGY === TORQUE (same dim vector)',   dimensionsMatch(DIMENSIONS.ENERGY, DIMENSIONS.TORQUE))
ok('MASS !== LENGTH',                      !dimensionsMatch(DIMENSIONS.MASS, DIMENSIONS.LENGTH))
ok('absent key treated as 0',              dimensionsMatch({ mass: 1 }, { mass: 1, length: 0 }))
ok('DIMENSIONLESS === {}',                 dimensionsMatch(DIMENSIONLESS, {}))

// ─────────────────────────────────────────────────────────────────────────────
// 3. multiplyDimensions / invertDimension
// ─────────────────────────────────────────────────────────────────────────────

section('multiplyDimensions / invertDimension')
// FORCE × LENGTH should give ENERGY/TORQUE
const forceTimes = multiplyDimensions(DIMENSIONS.FORCE, DIMENSIONS.LENGTH)
ok('FORCE × LENGTH = ENERGY dim',         dimensionsMatch(forceTimes, DIMENSIONS.ENERGY))

// PRESSURE = FORCE / AREA
const forceOverArea = multiplyDimensions(DIMENSIONS.FORCE, invertDimension(DIMENSIONS.AREA))
ok('FORCE / AREA = PRESSURE dim',         dimensionsMatch(forceOverArea, DIMENSIONS.PRESSURE))

// invertDimension of TIME = FREQUENCY
ok('1/TIME = FREQUENCY dim',              dimensionsMatch(invertDimension(DIMENSIONS.TIME), DIMENSIONS.FREQUENCY))

// ─────────────────────────────────────────────────────────────────────────────
// 4. identifyDimension
// ─────────────────────────────────────────────────────────────────────────────

section('identifyDimension')
ok('identifies FORCE',                    identifyDimension(DIMENSIONS.FORCE) === 'FORCE')
ok('identifies VOLTAGE',                  identifyDimension(DIMENSIONS.VOLTAGE) === 'VOLTAGE')
ok('unknown dimension → null',            identifyDimension({ mass: 3 }) === null)

// ─────────────────────────────────────────────────────────────────────────────
// 5. UnitRegistry — basic lookup
// ─────────────────────────────────────────────────────────────────────────────

section('UnitRegistry — lookup')
ok('Pa exists',                           defaultRegistry.get('Pa') !== null)
ok('MPa exists',                          defaultRegistry.get('MPa') !== null)
ok('°C exists',                           defaultRegistry.get('°C') !== null)
ok('mAh/g exists',                        defaultRegistry.get('mAh/g') !== null)
ok('unknown → null',                      defaultRegistry.get('furlong') === null)

// ─────────────────────────────────────────────────────────────────────────────
// 6. UnitRegistry — conversion (linear)
// ─────────────────────────────────────────────────────────────────────────────

section('UnitRegistry — linear conversion')

const paMPa = defaultRegistry.convert({ value: 1_000_000, unit: 'Pa', dimension: DIMENSIONS.PRESSURE }, 'MPa')
ok('1,000,000 Pa → 1 MPa',               paMPa !== null && Math.abs(paMPa!.value - 1) < 1e-9)

const kgLb = defaultRegistry.convert({ value: 1, unit: 'kg', dimension: DIMENSIONS.MASS }, 'lb')
ok('1 kg → ~2.2046 lb',                  kgLb !== null && Math.abs(kgLb!.value - 2.20462262) < 1e-4)

const mKm = defaultRegistry.convert({ value: 1000, unit: 'm', dimension: DIMENSIONS.LENGTH }, 'km')
ok('1000 m → 1 km',                      mKm !== null && Math.abs(mKm!.value - 1) < 1e-9)

const mInch = defaultRegistry.convert({ value: 0.0254, unit: 'm', dimension: DIMENSIONS.LENGTH }, 'in')
ok('0.0254 m → 1 in',                    mInch !== null && Math.abs(mInch!.value - 1) < 1e-6)

// ─────────────────────────────────────────────────────────────────────────────
// 7. UnitRegistry — affine temperature conversion
// ─────────────────────────────────────────────────────────────────────────────

section('UnitRegistry — temperature (affine)')

const celsiusToK = defaultRegistry.convert({ value: 0, unit: '°C', dimension: DIMENSIONS.TEMPERATURE }, 'K')
ok('0 °C → 273.15 K',                    celsiusToK !== null && Math.abs(celsiusToK!.value - 273.15) < 1e-9)

const KtoCelsius = defaultRegistry.convert({ value: 300, unit: 'K', dimension: DIMENSIONS.TEMPERATURE }, '°C')
ok('300 K → 26.85 °C',                   KtoCelsius !== null && Math.abs(KtoCelsius!.value - 26.85) < 1e-9)

const FtoK = defaultRegistry.convert({ value: 32, unit: '°F', dimension: DIMENSIONS.TEMPERATURE }, 'K')
ok('32 °F → 273.15 K',                   FtoK !== null && Math.abs(FtoK!.value - 273.15) < 1e-6)

const CtoF = defaultRegistry.convert({ value: 100, unit: '°C', dimension: DIMENSIONS.TEMPERATURE }, '°F')
ok('100 °C → 212 °F',                    CtoF !== null && Math.abs(CtoF!.value - 212) < 1e-6)

// ─────────────────────────────────────────────────────────────────────────────
// 8. UnitRegistry — incompatible dimensions → null
// ─────────────────────────────────────────────────────────────────────────────

section('UnitRegistry — incompatible dimensions')
const impossible = defaultRegistry.convert({ value: 1, unit: 'kg', dimension: DIMENSIONS.MASS }, 'm')
ok('kg → m returns null',                impossible === null)

// ─────────────────────────────────────────────────────────────────────────────
// 9. UnitRegistry — quantity factory
// ─────────────────────────────────────────────────────────────────────────────

section('UnitRegistry — quantity()')
const q1 = defaultRegistry.quantity(100, 'MPa')
ok('quantity() fills dimension from registry', q1 !== null && dimensionsMatch(q1!.dimension, DIMENSIONS.PRESSURE))
ok('quantity() value is preserved',            q1 !== null && q1!.value === 100)

const qBad = defaultRegistry.quantity(1, 'furlong')
ok('unknown unit → null',                      qBad === null)

// ─────────────────────────────────────────────────────────────────────────────
// 10. DimensionalConsistencyChecker — checkInput / checkOutput
// ─────────────────────────────────────────────────────────────────────────────

section('DimensionalConsistencyChecker — schema-level checkInput')

const spec = {
  stress:  { dimension: DIMENSIONS.PRESSURE, required: true },
  energy:  { dimension: DIMENSIONS.ENERGY,   required: false },
}

// Good record: correct dimensions
const good = {
  stress: { value: 200, unit: 'MPa', dimension: DIMENSIONS.PRESSURE },
  energy: { value: 5,   unit: 'kJ',  dimension: DIMENSIONS.ENERGY   },
}
const errGood = defaultChecker.checkInput(spec, good)
ok('checkInput passes for correct dimensions', errGood.length === 0)

// Bad record: stress field has MASS dimension instead of PRESSURE
const bad = {
  stress: { value: 200, unit: 'kg', dimension: DIMENSIONS.MASS },
}
const errBad = defaultChecker.checkInput(spec, bad)
ok('checkInput catches wrong dimension',       errBad.length > 0 && errBad[0].param === 'stress')

// Non-PhysicalQuantity field where a quantity is expected
const mistyped = {
  stress: 200,  // plain number
}
const errMistyped = defaultChecker.checkInput(spec, mistyped)
ok('checkInput catches non-PhysicalQuantity', errMistyped.length > 0)

// ─────────────────────────────────────────────────────────────────────────────
// 11. DimensionalConsistencyChecker — scanForQuantities
// ─────────────────────────────────────────────────────────────────────────────

section('DimensionalConsistencyChecker — scanForQuantities')

const record = {
  stress:  { value: 200, unit: 'MPa',     dimension: DIMENSIONS.PRESSURE },   // consistent
  // Deliberately wrong: MPa has PRESSURE dimension, but we say MASS
  wrong:   { value: 5,   unit: 'MPa',     dimension: DIMENSIONS.MASS },        // inconsistent
  // Unknown unit
  weird:   { value: 1,   unit: 'furlong', dimension: DIMENSIONS.LENGTH },      // unitKnown=false
  scalar:  42,  // ignored
}

const scan = defaultChecker.scanForQuantities(record as any)
ok('scans 3 PhysicalQuantity fields',          scan.length === 3)

const stressResult = scan.find(r => r.field === 'stress')
ok('stress: consistent',                       stressResult?.consistent === true)

const wrongResult  = scan.find(r => r.field === 'wrong')
ok('wrong: inconsistent (MPa dimension≠MASS)', wrongResult?.consistent === false && wrongResult.unitKnown === true)

const weirdResult  = scan.find(r => r.field === 'weird')
ok('weird: unitKnown=false',                   weirdResult?.unitKnown === false)

// ─────────────────────────────────────────────────────────────────────────────
// 12. DimensionalConsistencyChecker — convert / tryConvert / toSI
// ─────────────────────────────────────────────────────────────────────────────

section('DimensionalConsistencyChecker — convert / tryConvert / toSI')

const qMPa = defaultChecker.quantity(250, 'MPa')
ok('quantity() factory works',                 dimensionsMatch(qMPa.dimension, DIMENSIONS.PRESSURE))

const qPa = defaultChecker.convert(qMPa, 'Pa')
ok('250 MPa → 2.5e8 Pa',                      Math.abs(qPa.value - 2.5e8) < 1)

const si = defaultChecker.toSI(qMPa)
ok('toSI(MPa) returns Pa value',               si !== null && si!.unit === 'Pa' && Math.abs(si!.value - 2.5e8) < 1)

// tryConvert across incompatible dims → null
const bad2 = defaultChecker.tryConvert(qMPa, 'kg')
ok('tryConvert(MPa→kg) → null',               bad2 === null)

// convert across incompatible dims → throws
let threw = false
try { defaultChecker.convert(qMPa, 'kg') } catch { threw = true }
ok('convert(MPa→kg) throws',                  threw)

// ─────────────────────────────────────────────────────────────────────────────
// 13. Specific-capacity (electrochemistry) units
// ─────────────────────────────────────────────────────────────────────────────

section('Electrochemistry units')
const mAhG = defaultRegistry.get('mAh/g')
ok('mAh/g in registry',                        mAhG !== null)
ok('mAh/g dimension = SPECIFIC_CAPACITY',       mAhG !== null && dimensionsMatch(mAhG.dimension, DIMENSIONS.SPECIFIC_CAPACITY))

const cap = defaultChecker.quantity(200, 'mAh/g')   // typical Li-ion cathode
const capAhKg = defaultChecker.convert(cap, 'Ah/kg')
ok('200 mAh/g → 200 Ah/kg',                   Math.abs(capAhKg.value - 200) < 1e-6)

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`)
console.log(`  Total: ${passed + failed}  ✅ ${passed}  ❌ ${failed}`)
if (failed > 0) {
  console.error('\nSome tests failed.')
  process.exit(1)
} else {
  console.log('\nAll tests passed. 量纲系统 ✅')
}
