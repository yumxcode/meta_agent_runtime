export { createReadFileTool } from './read_file/index.js'
export { createWriteFileTool } from './write_file/index.js'
export { createEditFileTool } from './edit_file/index.js'
export { createGlobTool } from './glob/index.js'
export { createGrepTool } from './grep/index.js'
export { createNotebookEditTool } from './notebook_edit/index.js'

import type { MetaAgentTool } from '../../core/types.js'
import { createReadFileTool } from './read_file/index.js'
import { createWriteFileTool } from './write_file/index.js'
import { createEditFileTool } from './edit_file/index.js'
import { createGlobTool } from './glob/index.js'
import { createGrepTool } from './grep/index.js'
import { createNotebookEditTool } from './notebook_edit/index.js'

export async function createFsTools(): Promise<MetaAgentTool[]> {
  return Promise.all([
    createReadFileTool(), createWriteFileTool(), createEditFileTool(),
    createGlobTool(), createGrepTool(), createNotebookEditTool(),
  ])
}
