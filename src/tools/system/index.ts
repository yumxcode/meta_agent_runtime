export { createSleepTool } from './sleep/index.js'
export { createCronCreateTool } from './cron_create/index.js'
export { createCronDeleteTool } from './cron_delete/index.js'
export { createCronListTool } from './cron_list/index.js'
export { createEnterPlanModeTool } from './enter_plan_mode/index.js'
export { createExitPlanModeTool } from './exit_plan_mode/index.js'
export { createSkillTool } from './skill/index.js'
export { createConfigTool } from './config/index.js'
export { createMemoryWriteTool } from './memory_write/index.js'
export { createMemoryDeleteTool } from './memory_delete/index.js'
export { listCronJobs, deleteCronJob, createCronJob, deleteJobsForSession } from './cronStore.js'
export type { CronJob } from './cronStore.js'

import type { MetaAgentTool } from '../../core/types.js'
import type { AgentMode } from '../../core/dynamicPrompt.js'
import { createSleepTool } from './sleep/index.js'
import { createCronCreateTool } from './cron_create/index.js'
import { createCronDeleteTool } from './cron_delete/index.js'
import { createCronListTool } from './cron_list/index.js'
import { createEnterPlanModeTool } from './enter_plan_mode/index.js'
import { createExitPlanModeTool } from './exit_plan_mode/index.js'
import { createSkillTool } from './skill/index.js'
import { createConfigTool } from './config/index.js'
import { createMemoryWriteTool } from './memory_write/index.js'
import { createMemoryDeleteTool } from './memory_delete/index.js'

export interface SystemToolsOptions {
  /**
   * Working directory for skill and config tools.
   * Defaults to process.cwd() when omitted.
   */
  cwd?: string
  /**
   * Session mode — determines which mode-specific skill directory is searched.
   * Defaults to 'agentic' when omitted.
   */
  mode?: AgentMode
  /**
   * Shared plan-mode ref injected into enter_plan_mode / exit_plan_mode.
   * When omitted a private ref is created (tools will still work, but the
   * MetaAgentSession won't be aware of the mode unless the ref is the same
   * object as session._planModeRef).
   */
  planModeRef?: { active: boolean }
  /** Engineering domain configured for the session — attached to memory proposals. */
  domain?: string
}

export async function createSystemTools(options: SystemToolsOptions = {}): Promise<MetaAgentTool[]> {
  const planModeRef = options.planModeRef ?? { active: false }
  return Promise.all([
    createSleepTool(),
    createCronCreateTool(),
    createCronDeleteTool(),
    createCronListTool(),
    createEnterPlanModeTool(planModeRef),
    createExitPlanModeTool(planModeRef),
    createSkillTool(options.cwd, options.mode ?? 'agentic'),
    createConfigTool(options.cwd),
    createMemoryWriteTool({ mode: options.mode ?? 'agentic', domain: options.domain }),
    createMemoryDeleteTool(),
  ])
}
