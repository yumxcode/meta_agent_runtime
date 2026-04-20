/**
 * Todo Tool
 *
 * Task management for the agent's current work session.
 * Tasks are stored in memory (not persisted) unless a session directory is provided,
 * in which case they are saved to todos.json.
 */

import fs from 'fs/promises';
import path from 'path';
import { registerTools } from './registry.js';
import type { ToolEntry } from '../types.js';

// ---------------------------------------------------------------------------
// Todo types
// ---------------------------------------------------------------------------

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';
export type TodoPriority = 'low' | 'medium' | 'high';

export interface Todo {
  id: string;
  title: string;
  description?: string;
  status: TodoStatus;
  priority: TodoPriority;
  createdAt: number;
  updatedAt: number;
  tags?: string[];
}

// ---------------------------------------------------------------------------
// TodoStore
// ---------------------------------------------------------------------------

export class TodoStore {
  private _todos: Map<string, Todo> = new Map();
  private _filePath: string | null = null;
  private _nextId = 1;

  constructor(sessionDir?: string) {
    if (sessionDir) {
      this._filePath = path.join(sessionDir, 'todos.json');
    }
  }

  async load(): Promise<void> {
    if (!this._filePath) return;
    try {
      const content = await fs.readFile(this._filePath, 'utf-8');
      const todos = JSON.parse(content) as Todo[];
      this._todos.clear();
      for (const todo of todos) {
        this._todos.set(todo.id, todo);
        const num = parseInt(todo.id.replace('todo_', ''), 10);
        if (!isNaN(num) && num >= this._nextId) this._nextId = num + 1;
      }
    } catch {
      // File doesn't exist yet — start fresh
    }
  }

  async save(): Promise<void> {
    if (!this._filePath) return;
    await fs.mkdir(path.dirname(this._filePath), { recursive: true });
    const todos = Array.from(this._todos.values());
    await fs.writeFile(this._filePath, JSON.stringify(todos, null, 2), 'utf-8');
  }

  generateId(): string {
    return `todo_${this._nextId++}`;
  }

  async add(
    title: string,
    opts: { description?: string; priority?: TodoPriority; tags?: string[] } = {},
  ): Promise<Todo> {
    const todo: Todo = {
      id: this.generateId(),
      title,
      description: opts.description,
      status: 'pending',
      priority: opts.priority ?? 'medium',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      tags: opts.tags,
    };
    this._todos.set(todo.id, todo);
    await this.save();
    return todo;
  }

  async update(
    id: string,
    changes: Partial<Pick<Todo, 'title' | 'description' | 'status' | 'priority' | 'tags'>>,
  ): Promise<Todo | null> {
    const todo = this._todos.get(id);
    if (!todo) return null;
    const updated = { ...todo, ...changes, updatedAt: Date.now() };
    this._todos.set(id, updated);
    await this.save();
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    const existed = this._todos.delete(id);
    if (existed) await this.save();
    return existed;
  }

  list(filter?: { status?: TodoStatus; priority?: TodoPriority }): Todo[] {
    let todos = Array.from(this._todos.values());
    if (filter?.status) todos = todos.filter((t) => t.status === filter.status);
    if (filter?.priority) todos = todos.filter((t) => t.priority === filter.priority);
    return todos.sort((a, b) => {
      const priorityOrder = { high: 0, medium: 1, low: 2 };
      return (priorityOrder[a.priority] ?? 1) - (priorityOrder[b.priority] ?? 1);
    });
  }

  get(id: string): Todo | undefined {
    return this._todos.get(id);
  }
}

// Default store (session-level singleton)
let _defaultStore: TodoStore | null = null;

export function getTodoStore(sessionDir?: string): TodoStore {
  if (!_defaultStore) {
    _defaultStore = new TodoStore(sessionDir);
  }
  return _defaultStore;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const STATUS_EMOJI: Record<TodoStatus, string> = {
  pending: '⬜',
  in_progress: '🔄',
  completed: '✅',
  cancelled: '❌',
};

const PRIORITY_LABEL: Record<TodoPriority, string> = {
  high: '🔴 HIGH',
  medium: '🟡 MEDIUM',
  low: '🟢 LOW',
};

function formatTodo(todo: Todo): string {
  const lines = [
    `${STATUS_EMOJI[todo.status]} [${todo.id}] ${todo.title} — ${PRIORITY_LABEL[todo.priority]}`,
  ];
  if (todo.description) lines.push(`   ${todo.description}`);
  if (todo.tags?.length) lines.push(`   Tags: ${todo.tags.join(', ')}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

const todoTools: ToolEntry[] = [
  {
    name: 'todo',
    toolset: 'todo',
    parallelSafe: false,
    emoji: '📝',
    definition: {
      name: 'todo',
      description:
        'Manage a task list for the current session. Operations: add (create task), update (change status/priority), delete (remove task), list (show all/filtered tasks), get (get one task by id). Use this to track your work plan and progress.',
      parameters: {
        type: 'object',
        properties: {
          operation: {
            type: 'string',
            enum: ['add', 'update', 'delete', 'list', 'get'],
            description: 'Operation to perform.',
          },
          id: {
            type: 'string',
            description: 'Task ID (required for update/delete/get).',
          },
          title: {
            type: 'string',
            description: 'Task title (required for add).',
          },
          description: {
            type: 'string',
            description: 'Optional task description.',
          },
          status: {
            type: 'string',
            enum: ['pending', 'in_progress', 'completed', 'cancelled'],
            description: 'Task status (for update).',
          },
          priority: {
            type: 'string',
            enum: ['low', 'medium', 'high'],
            description: 'Task priority. Default: medium.',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional tags.',
          },
          filter_status: {
            type: 'string',
            enum: ['pending', 'in_progress', 'completed', 'cancelled'],
            description: 'Filter list by status.',
          },
        },
        required: ['operation'],
      },
    },
    handler: async (args, context) => {
      const operation = args['operation'] as string;
      const sessionDir = context.metadata?.['sessionDir'] as string | undefined;
      const store = getTodoStore(sessionDir);

      switch (operation) {
        case 'add': {
          const title = args['title'] as string | undefined;
          if (!title) return 'Error: title is required for add operation';
          const todo = await store.add(title, {
            description: args['description'] as string | undefined,
            priority: (args['priority'] as TodoPriority | undefined) ?? 'medium',
            tags: args['tags'] as string[] | undefined,
          });
          return `Created task ${todo.id}: "${todo.title}"`;
        }

        case 'update': {
          const id = args['id'] as string | undefined;
          if (!id) return 'Error: id is required for update operation';
          const changes: Partial<Todo> = {};
          if (args['title'] !== undefined) changes.title = args['title'] as string;
          if (args['description'] !== undefined) changes.description = args['description'] as string;
          if (args['status'] !== undefined) changes.status = args['status'] as TodoStatus;
          if (args['priority'] !== undefined) changes.priority = args['priority'] as TodoPriority;
          if (args['tags'] !== undefined) changes.tags = args['tags'] as string[];
          const updated = await store.update(id, changes);
          if (!updated) return `No task found with id: "${id}"`;
          return `Updated task ${id}:\n${formatTodo(updated)}`;
        }

        case 'delete': {
          const id = args['id'] as string | undefined;
          if (!id) return 'Error: id is required for delete operation';
          const existed = await store.delete(id);
          return existed
            ? `Deleted task "${id}"`
            : `No task found with id: "${id}"`;
        }

        case 'list': {
          const filterStatus = args['filter_status'] as TodoStatus | undefined;
          const todos = store.list(filterStatus ? { status: filterStatus } : undefined);
          if (todos.length === 0) {
            return filterStatus
              ? `No tasks with status "${filterStatus}".`
              : 'No tasks yet. Use todo with operation="add" to create tasks.';
          }
          return todos.map(formatTodo).join('\n\n');
        }

        case 'get': {
          const id = args['id'] as string | undefined;
          if (!id) return 'Error: id is required for get operation';
          const todo = store.get(id);
          if (!todo) return `No task found with id: "${id}"`;
          return formatTodo(todo);
        }

        default:
          return `Unknown operation: "${operation}". Use: add, update, delete, list, get`;
      }
    },
  },
];

// Register todo tools
registerTools(todoTools);

export default todoTools;
