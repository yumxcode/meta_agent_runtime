/**
 * PhysicsConstraintChecker — enforces inviolable physical laws.
 *
 * These are hard constraints that cannot be overridden by domain packages:
 *
 *   - Efficiency / COP in [0, 1] (thermodynamic limit)
 *   - Absolute temperature ≥ 0 K (third law)
 *   - Absolute pressure ≥ 0 Pa
 *   - Probability in [0, 1]
 *   - Mass, density, concentration > 0
 *   - Speed ≤ speed of light (3×10⁸ m/s)
 *
 * Each constraint is defined as a named rule applied to matching field names
 * via a pattern list. Patterns are case-insensitive substring matches.
 *
 * Severity:
 *   Physics violations are always 'critical' — they indicate a fundamental
 *   error in the simulation setup or output parsing, never a calibration issue.
 */
// ─────────────────────────────────────────────────────────────────────────────
// Built-in constraints
// ─────────────────────────────────────────────────────────────────────────────
const SPEED_OF_LIGHT = 2.998e8; // m/s
const BUILT_IN_CONSTRAINTS = [
    {
        name: 'EfficiencyBound',
        fieldPatterns: ['efficiency', 'eta', 'cop'],
        check: v => v < 0 || v > 1
            ? `Efficiency/COP value ${v} is outside [0, 1]. Thermodynamic limit violated.`
            : null,
    },
    {
        name: 'AbsoluteTemperature',
        fieldPatterns: ['temperature_k', 'temp_k', 'temperature_kelvin', 'absolute_temp'],
        check: v => v < 0
            ? `Temperature ${v} K is below absolute zero. Third law violation.`
            : null,
    },
    {
        name: 'AbsolutePressure',
        fieldPatterns: ['pressure_pa', 'absolute_pressure', 'pressure_abs'],
        check: v => v < 0
            ? `Absolute pressure ${v} Pa cannot be negative.`
            : null,
    },
    {
        name: 'Probability',
        fieldPatterns: ['probability', 'prob_', '_probability', 'likelihood', 'confidence'],
        check: v => v < 0 || v > 1
            ? `Probability value ${v} is outside [0, 1].`
            : null,
    },
    {
        name: 'PositiveMass',
        fieldPatterns: ['mass_kg', 'mass_g', 'weight_kg', 'density_kg'],
        check: v => v <= 0
            ? `Mass/density ${v} must be strictly positive.`
            : null,
    },
    {
        name: 'NonNegativeConcentration',
        fieldPatterns: ['concentration', 'mole_fraction', 'mol_frac'],
        check: v => v < 0
            ? `Concentration ${v} cannot be negative.`
            : null,
    },
    {
        name: 'SpeedOfLight',
        fieldPatterns: ['velocity_ms', 'speed_ms', 'wave_speed'],
        check: v => Math.abs(v) > SPEED_OF_LIGHT
            ? `Speed ${v} m/s exceeds the speed of light (${SPEED_OF_LIGHT} m/s).`
            : null,
    },
    {
        name: 'CoulombicEfficiency',
        fieldPatterns: ['coulombic_efficiency', 'ce_'],
        check: v => v < 0 || v > 1
            ? `Coulombic efficiency ${v} is outside [0, 1].`
            : null,
    },
];
// ─────────────────────────────────────────────────────────────────────────────
// PhysicsConstraintChecker
// ─────────────────────────────────────────────────────────────────────────────
export class PhysicsConstraintChecker {
    name = 'PhysicsConstraintChecker';
    phase = ['pre_call', 'post_call'];
    appliesTo = '*';
    constraints;
    constructor(additionalConstraints = []) {
        this.constraints = [...BUILT_IN_CONSTRAINTS, ...additionalConstraints];
    }
    async run(ctx) {
        const record = ctx.phase === 'pre_call' ? ctx.input : ctx.output;
        if (!record || typeof record !== 'object')
            return this._pass();
        const violations = [];
        for (const [field, rawValue] of Object.entries(record)) {
            const value = this._extractNumber(rawValue);
            if (value === null)
                continue;
            for (const constraint of this.constraints) {
                if (!this._matches(field, constraint.fieldPatterns))
                    continue;
                const error = constraint.check(value);
                if (error) {
                    violations.push(`[${constraint.name}] Field "${field}": ${error}`);
                }
            }
        }
        if (violations.length === 0)
            return this._pass();
        return {
            hookName: this.name,
            passed: false,
            severity: 'critical',
            message: `Physics constraint violated in tool "${ctx.toolName}" ` +
                `(phase: ${ctx.phase}):\n` +
                violations.map(v => `  • ${v}`).join('\n'),
            suggestedAction: 'abort',
        };
    }
    // ── helpers ────────────────────────────────────────────────────────────────
    _matches(field, patterns) {
        const lower = field.toLowerCase();
        return patterns.some(p => lower.includes(p.toLowerCase()));
    }
    _extractNumber(v) {
        if (typeof v === 'number' && isFinite(v))
            return v;
        if (typeof v === 'object' && v !== null && 'value' in v) {
            const inner = v.value;
            if (typeof inner === 'number' && isFinite(inner))
                return inner;
        }
        return null;
    }
    _pass() {
        return {
            hookName: this.name,
            passed: true,
            severity: 'info',
            message: 'Physics constraint check passed',
            suggestedAction: 'continue',
        };
    }
}
//# sourceMappingURL=PhysicsConstraintChecker.js.map