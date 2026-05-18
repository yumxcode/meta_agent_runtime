import type { MetaAgentTool, ToolCallContext, ToolResult } from '../../../core/types.js'
import { loadToolPrompt } from '../../util.js'

export interface TodoItem {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  priority: 'high' | 'medium' | 'low'
}

// Session-scoped todo store.
// Keys are sessionIds — entries accumulate for the process lifetime unless
// explicitly cleaned up.  Always call deleteTodosForSession() when a session ends.
const todoStore = new Map<string, TodoItem[]>()

export function getTodosForSession(sessionId: string): TodoItem[] {
  return todoStore.get(sessionId) ?? []
}

/**
 * Remove all todos for a session.  Call this when the session ends to
 * prevent the module-level Map from growing unboundedly in long-running
 * processes (especially relevant under Bun where heap is not returned to
 * the OS until Bun ≥ 1.1.13).
 */
export function deleteTodosForSession(sessionId: string): void {
  todoStore.delete(sessionId)
}

export async function createTodoWriteTool(): Promise<MetaAgentTool> {
  const description = await loadToolPrompt(import.meta.url)
  return {
    name: 'todo_write',
    description,
    inputSchema: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: 'Complete list of todos (replaces current list)',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              content: { type: 'string' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
              priority: { type: 'string', enum: ['high', 'medium', 'low'] },
            },
            required: ['id', 'content', 'status', 'priority'],
          },
        },
      },
      required: ['todos'],
    },
    async call(input: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolResult> {
      const todos = input['todos'] as TodoItem[]
      if (!Array.isArray(todos)) return { content: 'Error: todos must be an array', isError: true }

      // Validate
      for (const todo of todos) {
        if (!todo.id || !todo.content) return { content: `Error: todo missing id or content`, isError: true }
        if (!['pending', 'in_progress', 'completed'].includes(todo.status)) return { content: `Invalid status: ${todo.status}`, isError: true }
        if (!['high', 'medium', 'low'].includes(todo.priority)) return { content: `Invalid priority: ${todo.priority}`, isError: true }
      }

      todoStore.set(ctx.sessionId, todos)

      const summary = todos.map(t => {
        const icon = t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '→' : '○'
        return `  ${icon} [${t.priority.toUpperCase()}] ${t.content}`
      }).join('\n')

      return { content: `Todo list updated (${todos.length} items):\n${summary}`, isError: false }
    },
  }
}
