import type { MetaAgentTool } from '../../../core/types.js';
export interface TodoItem {
    id: string;
    content: string;
    status: 'pending' | 'in_progress' | 'completed';
    priority: 'high' | 'medium' | 'low';
}
export declare function getTodosForSession(sessionId: string): TodoItem[];
/**
 * Remove all todos for a session.  Call this when the session ends to
 * prevent the module-level Map from growing unboundedly in long-running
 * processes (especially relevant under Bun where heap is not returned to
 * the OS until Bun ≥ 1.1.13).
 */
export declare function deleteTodosForSession(sessionId: string): void;
export declare function createTodoWriteTool(): Promise<MetaAgentTool>;
//# sourceMappingURL=index.d.ts.map