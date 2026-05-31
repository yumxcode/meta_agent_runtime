/**
 * Execute the action list produced by TeamPlanner (v2.0).
 *
 * Asks for human confirmation when the planner flagged `requiresConfirmation`.
 * `risk === 'blocked'` aborts the whole plan; individual action failures are
 * recorded but don't stop subsequent actions.
 */
function describeAction(a) {
    switch (a.type) {
        case 'show_board': return 'show team board';
        case 'take_task': return `take ${a.taskId ?? '<unspecified>'}`;
        case 'add_note': return `note on ${a.taskId ?? '<unspecified>'}: ${a.direction ?? '?'} → ${a.outcome ?? '?'}`;
        case 'drop_task': return `drop ${a.taskId ?? 'current'}`;
        case 'mark_done': return `mark ${a.taskId ?? 'current'} done`;
        case 'mark_paused': return `mark ${a.taskId ?? 'current'} paused`;
        case 'steal_task': return `steal ${a.taskId ?? '<unspecified>'}${a.reason ? ` (${a.reason})` : ''}`;
        case 'sync_team': return 'fetch + sync team state';
        case 'pull_team': return 'pull remote team/ files';
        default: return a.type;
    }
}
async function runAction(controller, a) {
    switch (a.type) {
        case 'show_board':
            await controller.teamStatus?.();
            return;
        case 'take_task':
            if (!a.taskId)
                throw new Error('take_task missing taskId');
            await controller.teamTake?.(a.taskId);
            return;
        case 'add_note':
            if (!a.taskId)
                throw new Error('add_note missing taskId');
            if (!a.direction)
                throw new Error('add_note missing direction');
            if (!a.outcome)
                throw new Error('add_note missing outcome');
            await controller.teamNote?.({ taskId: a.taskId, direction: a.direction, outcome: a.outcome, ref: a.ref });
            return;
        case 'drop_task':
            await controller.teamDrop?.(a.taskId);
            return;
        case 'mark_done':
            if (!a.taskId)
                throw new Error('mark_done missing taskId');
            await controller.teamTaskStatus?.(a.taskId, 'done');
            return;
        case 'mark_paused':
            if (!a.taskId)
                throw new Error('mark_paused missing taskId');
            await controller.teamTaskStatus?.(a.taskId, 'paused');
            return;
        case 'steal_task':
            if (!a.taskId)
                throw new Error('steal_task missing taskId');
            if (!a.reason?.trim())
                throw new Error('steal_task missing reason');
            await controller.teamSteal?.(a.taskId, a.reason);
            return;
        case 'sync_team':
            await controller.teamSync?.();
            return;
        case 'pull_team':
            await controller.teamPull?.();
            return;
        default:
            throw new Error(`unknown action type "${a.type}"`);
    }
}
export async function executePlan(controller, plan, ask, options = {}) {
    const report = { executed: [], skipped: [], failed: [], aborted: false };
    if (plan.risk === 'blocked') {
        report.aborted = true;
        return report;
    }
    if (plan.actions.length === 0)
        return report;
    for (const action of plan.actions) {
        if (action.requiresConfirmation && !options.autoApprove) {
            const reasonNote = action.reason ? ` (${action.reason})` : '';
            const answer = (await ask(`  执行 "${describeAction(action)}"?${reasonNote} [y/N] `)).trim().toLowerCase();
            if (!/^(y|yes|是|确认)$/.test(answer)) {
                options.onAction?.(action, 'skipped', 'user declined');
                report.skipped.push({ action, reason: 'user declined' });
                continue;
            }
        }
        options.onAction?.(action, 'starting');
        try {
            await runAction(controller, action);
            options.onAction?.(action, 'done');
            report.executed.push(action);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            options.onAction?.(action, 'failed', msg);
            report.failed.push({ action, error: msg });
        }
    }
    return report;
}
//# sourceMappingURL=teamPlannerExecutor.js.map