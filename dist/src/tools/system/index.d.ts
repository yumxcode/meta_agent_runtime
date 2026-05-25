export { createSleepTool } from './sleep/index.js';
export { createCronCreateTool } from './cron_create/index.js';
export { createCronDeleteTool } from './cron_delete/index.js';
export { createCronListTool } from './cron_list/index.js';
export { createEnterPlanModeTool } from './enter_plan_mode/index.js';
export { createExitPlanModeTool } from './exit_plan_mode/index.js';
export { createSkillTool } from './skill/index.js';
export { createConfigTool } from './config/index.js';
export { listCronJobs, deleteCronJob, createCronJob, deleteJobsForSession } from './cronStore.js';
export type { CronJob } from './cronStore.js';
import type { MetaAgentTool } from '../../core/types.js';
export interface SystemToolsOptions {
    /**
     * Working directory for skill and config tools.
     * Defaults to process.cwd() when omitted.
     */
    cwd?: string;
    /**
     * Shared plan-mode ref injected into enter_plan_mode / exit_plan_mode.
     * When omitted a private ref is created (tools will still work, but the
     * MetaAgentSession won't be aware of the mode unless the ref is the same
     * object as session._planModeRef).
     */
    planModeRef?: {
        active: boolean;
    };
}
export declare function createSystemTools(options?: SystemToolsOptions): Promise<MetaAgentTool[]>;
//# sourceMappingURL=index.d.ts.map