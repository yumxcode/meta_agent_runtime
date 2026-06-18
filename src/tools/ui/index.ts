export { createAskUserTool } from './ask_user/index.js'
export { createTodoWriteTool, getTodosForSession, deleteTodosForSession } from './todo_write/index.js'
export type { TodoItem } from './todo_write/index.js'
export { createSendMessageTool } from './send_message/index.js'
export { createProgressNoteTool, getProgressNoteForSession, deleteProgressNoteForSession } from './progress_note/index.js'
export { createArtifactsRegisterTool, getArtifactsForSession, deleteArtifactsForSession } from './artifacts_register/index.js'
import type { MetaAgentTool } from '../../core/types.js'
import { createAskUserTool } from './ask_user/index.js'
import { createTodoWriteTool } from './todo_write/index.js'
import { createSendMessageTool } from './send_message/index.js'
import { createProgressNoteTool } from './progress_note/index.js'
import { createArtifactsRegisterTool } from './artifacts_register/index.js'

/**
 * Create UI tools for agentic/campaign/robotics modes (interactive).
 * Includes ask_user, send_message, and progress tracking tools.
 */
export async function createUiTools(): Promise<MetaAgentTool[]> {
  return Promise.all([createAskUserTool(), createTodoWriteTool(), createSendMessageTool(), createProgressNoteTool(), createArtifactsRegisterTool()])
}

/**
 * Create UI tools for auto mode (unattended).
 * Excludes ask_user and send_message since auto is无人值守 mode.
 * Only progress tracking tools are included.
 */
export async function createAutoUiTools(): Promise<MetaAgentTool[]> {
  return Promise.all([createTodoWriteTool(), createProgressNoteTool(), createArtifactsRegisterTool()])
}
