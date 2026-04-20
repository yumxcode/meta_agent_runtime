/**
 * Built-in tools index.
 *
 * Import this module to register all built-in tools with the global registry.
 * Tree-shakeable: import only the tools you need, or import this file to get all.
 */

// Import to trigger side-effect registrations
import './file-tools.js';
import './web-tools.js';
import './terminal-tool.js';
import './memory-tool.js';
import './todo-tool.js';
import './delegate-tool.js';

export { default as fileTools } from './file-tools.js';
export { default as webTools } from './web-tools.js';
export { default as terminalTools } from './terminal-tool.js';
export { default as memoryTools } from './memory-tool.js';
export { default as todoTools } from './todo-tool.js';

export {
  ToolRegistry,
  registry,
  registerTool,
  registerTools,
  dispatchTool,
  executeToolBatch,
  isParallelSafe,
} from './registry.js';

export type { ToolCallRequest, ToolCallResult } from './registry.js';

// Memory store and todo store exports for direct usage
export { MemoryStore, getMemoryStore, evictMemoryStore } from './memory-tool.js';
export { TodoStore, getTodoStore } from './todo-tool.js';
export type { Todo, TodoStatus, TodoPriority } from './todo-tool.js';

// Delegation tool
export { DELEGATION_CTX_KEY } from './delegate-tool.js';

// Permission system
export { ToolPermissionContext, createPermissionContext } from './permission.js';
