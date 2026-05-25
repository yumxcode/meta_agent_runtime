/**
 * CapsuleBuilder — deterministic, LLM-free context capsule generator.
 *
 * Input:  CampaignStateStore (current state) + ParetoFront | null
 * Output: CampaignContextCapsule
 *
 * The capsule's contextBlock is a compact Markdown summary (< 500 tokens)
 * injected into the conversation context when the user resumes a session.
 * Because it is pre-computed at phase-transition time, injection at session
 * start costs zero compute — just a disk read.
 *
 * No API calls, no LLM, fully deterministic. Safe to run inside CampaignMonitor.
 */
import { PHASE_LABELS, USER_CHECKPOINT_PHASES } from './types.js';
// ── Public API ────────────────────────────────────────────────────────────────
export function buildCapsule(store, front) {
    const phase = store.phase;
    const objectives = store.designSpace.objectives;
    const structuredData = buildStructuredData(store, front);
    const contextBlock = buildContextBlock(store, front, objectives);
    return {
        schemaVersion: '1.0',
        campaignId: store.campaignId,
        projectName: store.projectName,
        phase,
        generatedAt: new Date().toISOString(),
        contextBlock,
        structuredData,
    };
}
// ── Context block (the part injected into the LLM context) ───────────────────
function buildContextBlock(store, front, objectives) {
    const { phase, projectName, completedTaskCount, failedTaskCount, pendingTaskCount } = store;
    const phaseLabel = PHASE_LABELS[phase];
    const totalPoints = store.sampledPoints.length;
    const lines = [];
    // ── Header ──
    const statusEmoji = statusIcon(phase);
    lines.push(`### ${statusEmoji} Campaign: ${projectName} [${phaseLabel}]`);
    // ── Objectives (always shown — drift guard) ──
    // Always include so the model cannot forget what it is optimising after
    // compaction, even when no Pareto front exists yet.
    if (objectives.length > 0) {
        const objStr = objectives
            .map(o => `${o.direction === 'minimize' ? '↓' : '↑'} ${o.name}${o.unit ? ` (${o.unit})` : ''}`)
            .join('  ');
        lines.push(`Objectives: ${objStr}`);
    }
    // ── Design variable ranges (compact form) ──
    const variables = store.designSpace.variables;
    if (variables.length > 0) {
        const varStr = variables
            .map(v => formatVariable(v))
            .join('  ');
        lines.push(`Variables: ${varStr}`);
    }
    // ── Constraints (always shown — hard limits must never be forgotten) ──
    const constraints = store.designSpace.constraints;
    if (constraints.length > 0) {
        lines.push(`Constraints: ${constraints.map(c => formatConstraint(c)).join('  ')}`);
    }
    // ── Progress ──
    if (totalPoints > 0) {
        const done = completedTaskCount;
        const failed = failedTaskCount;
        const running = pendingTaskCount;
        const pct = totalPoints > 0 ? Math.round((done / totalPoints) * 100) : 0;
        if (running > 0) {
            lines.push(`Progress: ${done}/${totalPoints} points evaluated (${pct}%), ${running} workers active${failed > 0 ? `, ${failed} failed` : ''}`);
        }
        else {
            lines.push(`Progress: ${done}/${totalPoints} evaluated${failed > 0 ? ` (${failed} failed)` : ''}`);
        }
    }
    // ── Pareto front summary ──
    if (front && front.rank1.length > 0) {
        const hv = front.hypervolume !== null ? ` HV=${front.hypervolume.toFixed(3)}` : '';
        lines.push(`\nPareto Front: **${front.rank1.length} non-dominated solutions**${hv}`);
        // Best value per objective
        for (const obj of objectives) {
            const best = findBestForObjective(front.rank1, obj);
            if (best) {
                const val = best.objectives[obj.name];
                const unit = obj.unit ? ` ${obj.unit}` : '';
                const vars = formatTopVars(best, 3);
                lines.push(`  • Best ${obj.name}: **${formatNum(val)}${unit}** (${vars})`);
            }
        }
    }
    // ── Phase-specific call to action ──
    const cta = callToAction(phase, front);
    if (cta) {
        lines.push(`\n${cta}`);
    }
    return lines.join('\n');
}
// ── Design space formatters ───────────────────────────────────────────────────
function formatVariable(v) {
    if ((v.type === 'continuous' || v.type === 'integer') && v.bounds) {
        const unit = v.unit ? ` ${v.unit}` : '';
        return `${v.name}∈[${v.bounds[0]}, ${v.bounds[1]}]${unit}`;
    }
    if ((v.type === 'discrete' || v.type === 'categorical') && v.values) {
        const vals = v.values.slice(0, 4).join('|');
        const trailer = v.values.length > 4 ? `|…(${v.values.length})` : '';
        return `${v.name}∈{${vals}${trailer}}`;
    }
    return v.name;
}
function formatConstraint(c) {
    // Truncate long expressions to keep contextBlock compact
    const expr = c.expression.length > 60
        ? c.expression.slice(0, 57) + '…'
        : c.expression;
    return `[${c.name}: ${expr}]`;
}
// ── Structured data (for tool queries, not injected into context) ─────────────
function buildStructuredData(store, front) {
    const totalPoints = store.sampledPoints.length;
    const completedPoints = store.completedTaskCount;
    const failedPoints = store.failedTaskCount;
    let paretoFrontSize = 0;
    let hypervolume = null;
    const bestResults = {};
    if (front && front.rank1.length > 0) {
        paretoFrontSize = front.rank1.length;
        hypervolume = front.hypervolume;
        for (const obj of store.designSpace.objectives) {
            const best = findBestForObjective(front.rank1, obj);
            if (best) {
                bestResults[obj.name] = {
                    value: best.objectives[obj.name] ?? 0,
                    unit: obj.unit ?? '',
                    pointId: best.designPoint.id,
                };
            }
        }
    }
    const pendingDecision = USER_CHECKPOINT_PHASES.has(store.phase)
        ? suggestNextAction(store.phase, front)
        : null;
    const estimatedMinutesRemaining = store.pendingTaskCount > 0 ? estimateMinutes(store) : null;
    return {
        totalPoints,
        completedPoints,
        failedPoints,
        paretoFrontSize,
        hypervolume,
        bestResults,
        pendingDecision,
        estimatedMinutesRemaining,
    };
}
// ── Helpers ───────────────────────────────────────────────────────────────────
function findBestForObjective(results, obj) {
    if (results.length === 0)
        return null;
    return results.reduce((best, r) => {
        const val = r.objectives[obj.name];
        const bestVal = best.objectives[obj.name];
        if (val === undefined || bestVal === undefined)
            return best;
        return obj.direction === 'minimize' ? (val < bestVal ? r : best) : (val > bestVal ? r : best);
    });
}
function formatTopVars(result, n) {
    return Object.entries(result.designPoint.variables)
        .slice(0, n)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ');
}
function formatNum(n) {
    if (Math.abs(n) >= 1000)
        return n.toFixed(0);
    if (Math.abs(n) >= 10)
        return n.toFixed(1);
    return n.toFixed(3);
}
function statusIcon(phase) {
    if (phase === 'DONE')
        return '✅';
    if (phase === 'FAILED')
        return '❌';
    if (USER_CHECKPOINT_PHASES.has(phase))
        return '🎯';
    return '⏳';
}
function callToAction(phase, front) {
    switch (phase) {
        case 'EVALUATING_L0':
        case 'ESCALATING_L1':
        case 'ESCALATING_L2':
            return 'Workers running in the background — you can safely close this conversation.';
        case 'PARETO_READY_L0':
            return front && front.rank1.length > 0
                ? `**Ready for your decision:** Type "escalate to L1" to refine ${front.rank1.length} candidates, or "export results" to save the L0 front.`
                : '**No feasible Pareto solutions found.** Consider relaxing constraints.';
        case 'PARETO_READY_L1':
            return front && front.rank1.length > 0
                ? `**Ready for your decision:** Type "escalate to L2" for high-fidelity validation, or "generate report" to finish.`
                : null;
        case 'PARETO_READY_L2':
            return '**Ready for your decision:** Type "generate report" to produce the final engineering report.';
        case 'DONE':
            return 'Campaign complete. Type "show report" to view the final results.';
        case 'FAILED':
            return 'Campaign failed. Type "show error" for details, or "restart" to retry from L0.';
        default:
            return null;
    }
}
function suggestNextAction(phase, front) {
    const size = front?.rank1.length ?? 0;
    switch (phase) {
        case 'PARETO_READY_L0':
            return size > 0
                ? `Escalate ${size} Pareto candidates to L1 fidelity (~15 min)`
                : 'Relax constraints and re-run L0 sweep';
        case 'PARETO_READY_L1':
            return size > 0
                ? `Escalate ${size} Pareto candidates to L2 fidelity (~45 min), or generate report`
                : 'Generate report with L1 results';
        case 'PARETO_READY_L2':
            return 'Generate final engineering report';
        default:
            return '';
    }
}
/** Very rough estimate: assume 2 min per point at L0, 8 min at L1, 30 min at L2 */
function estimateMinutes(store) {
    const pending = store.pendingTaskCount;
    const phase = store.phase;
    const minutesPerPoint = phase === 'EVALUATING_L0' ? 2 :
        phase === 'ESCALATING_L1' ? 8 : 30;
    return pending * minutesPerPoint;
}
//# sourceMappingURL=CapsuleBuilder.js.map