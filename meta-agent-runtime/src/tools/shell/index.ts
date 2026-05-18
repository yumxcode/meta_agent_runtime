export { createBashTool } from './bash/index.js'
export { createPowerShellTool } from './powershell/index.js'
import type { MetaAgentTool } from '../../core/types.js'
import { createBashTool } from './bash/index.js'
import { createPowerShellTool } from './powershell/index.js'
export async function createShellTools(): Promise<MetaAgentTool[]> {
  return Promise.all([createBashTool(), createPowerShellTool()])
}
