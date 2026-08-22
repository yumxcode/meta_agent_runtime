export { createBashTool } from './bash/index.js'
export { createPowerShellTool } from './powershell/index.js'
export { createExecSessionTool } from './exec_session/index.js'
export { createWriteStdinTool } from './write_stdin/index.js'
export { createCloseSessionTool } from './close_session/index.js'
export type { ShellSessionToolOptions } from './sessionSupport.js'
export { resetSessionGrantCache } from './sessionSupport.js'

import type { MetaAgentTool } from '../../core/types.js'
import { createBashTool } from './bash/index.js'
import { createPowerShellTool } from './powershell/index.js'
import { createExecSessionTool } from './exec_session/index.js'
import { createWriteStdinTool } from './write_stdin/index.js'
import { createCloseSessionTool } from './close_session/index.js'

export interface ShellToolsOptions {
  /**
   * Register the persistent-session tools (exec_session / write_stdin /
   * close_session). Default: true.
   *
   * Turning this off leaves the one-shot `bash`/`powershell` pair untouched —
   * the escape hatch for a host that cannot afford long-lived child processes
   * (a short-lived serverless worker, a test harness that asserts on process
   * counts), not a security control: sessions run under exactly the same jail,
   * env filter and OS sandbox as `bash`.
   */
  sessions?: boolean
}

export async function createShellTools(
  options: ShellToolsOptions = {},
): Promise<MetaAgentTool[]> {
  const base = await Promise.all([createBashTool(), createPowerShellTool()])
  if (options.sessions === false) return base
  const sessionTools = await Promise.all([
    createExecSessionTool(),
    createWriteStdinTool(),
    createCloseSessionTool(),
  ])
  return [...base, ...sessionTools]
}
