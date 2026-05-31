/**
 * Execute the action list produced by TeamPlanner (v2.0).
 *
 * Asks for human confirmation when the planner flagged `requiresConfirmation`.
 * `risk === 'blocked'` aborts the whole plan; individual action failures are
 * recorded but don't stop subsequent actions.
 */
import type { RoboticsTeamController } from '../routing/SessionRouter.js';
import type { TeamPlannerAction, TeamPlannerPlan } from '../robotics/team/TeamPlanner.js';
export type AskFn = (question: string) => Promise<string>;
export interface ExecutorReport {
    executed: TeamPlannerAction[];
    skipped: Array<{
        action: TeamPlannerAction;
        reason: string;
    }>;
    failed: Array<{
        action: TeamPlannerAction;
        error: string;
    }>;
    aborted: boolean;
}
export interface ExecuteOptions {
    autoApprove?: boolean;
    onAction?: (action: TeamPlannerAction, status: 'starting' | 'done' | 'skipped' | 'failed', detail?: string) => void;
}
export declare function executePlan(controller: RoboticsTeamController, plan: TeamPlannerPlan, ask: AskFn, options?: ExecuteOptions): Promise<ExecutorReport>;
//# sourceMappingURL=teamPlannerExecutor.d.ts.map