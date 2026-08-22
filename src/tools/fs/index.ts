export { createReadFileTool } from './read_file/index.js'
export { createWriteFileTool } from './write_file/index.js'
export { createAppendFileTool } from './append_file/index.js'
export { createEditFileTool } from './edit_file/index.js'
export { createApplyPatchTool } from './apply_patch/index.js'
export { createTurnDiffTool } from './turn_diff/index.js'
export { createGlobTool } from './glob/index.js'
export { createListDirTool } from './list_dir/index.js'
export { createGrepTool } from './grep/index.js'
export { createNotebookEditTool } from './notebook_edit/index.js'

import type { MetaAgentTool } from '../../core/types.js'
import { createReadFileTool } from './read_file/index.js'
import { createWriteFileTool } from './write_file/index.js'
import { createAppendFileTool } from './append_file/index.js'
import { createEditFileTool } from './edit_file/index.js'
import { createApplyPatchTool } from './apply_patch/index.js'
import { createTurnDiffTool } from './turn_diff/index.js'
import { createGlobTool } from './glob/index.js'
import { createListDirTool } from './list_dir/index.js'
import { createGrepTool } from './grep/index.js'
import { createNotebookEditTool } from './notebook_edit/index.js'

export interface FsToolsOptions {
  /**
   * Register `turn_diff`. Default: true.
   *
   * The tool is harmless without a tracker — it says so and returns an error
   * rather than pretending there were no changes — but a host that never
   * injects one can drop it to save the schema.
   */
  turnDiff?: boolean
}

export async function createFsTools(options: FsToolsOptions = {}): Promise<MetaAgentTool[]> {
  const tools = await Promise.all([
    createReadFileTool(), createWriteFileTool(), createAppendFileTool(), createEditFileTool(),
    createApplyPatchTool(),
    createGlobTool(), createListDirTool(), createGrepTool(), createNotebookEditTool(),
  ])
  if (options.turnDiff === false) return tools
  return [...tools, await createTurnDiffTool()]
}
