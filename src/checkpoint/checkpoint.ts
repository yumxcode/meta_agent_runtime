/**
 * Checkpoint — persistent run state for crash recovery
 *
 * Solves Gap 8 (no real checkpoint) and Gap 9 (no structured task state):
 *
 *   Gap 8: After every AgentStep the full run state is atomically written to
 *          {sessionDir}/checkpoints/{runId}.json. A crashed run can be resumed
 *          via AgentRuntime.resume(runId) with full history and budget restored.
 *
 *   Gap 9: Each checkpoint captures a todo snapshot (title + status) so that on
 *          resume the agent receives a precise "done / in-progress / pending"
 *          summary and can continue exactly where it left off — not from scratch.
 *
 * Write strategy: write to a .tmp file then rename atomically so a crash during
 * the write never produces a corrupt checkpoint file.
 */

import fs   from 'fs/promises';
import path from 'path';

import type { Message, AgentStep } from '../types.js';
import type { Todo }               from '../tools/todo-tool.js';
import { getTodoStore }            from '../tools/todo-tool.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Snapshot of a single todo item captured at checkpoint time. */
export interface TodoSnapshot {
  id:          string;
  title:       string;
  status:      string;   // TodoStatus: pending | in_progress | completed | cancelled
  priority:    string;   // TodoPriority: low | medium | high
  description?: string;
}

export interface CheckpointData {
  version:     2;
  runId:       string;
  agentId:     string;
  createdAt:   number;   // unix-ms
  updatedAt:   number;
  status:      'running' | 'completed' | 'interrupted' | 'error';

  // Enough to reconstruct the run
  userInput:    string;
  systemPrompt: string;
  history:      Message[];
  steps:        AgentStep[];
  budgetUsed:   number;
  budgetMax:    number;

  // Gap 9: task state snapshot (from todo store at checkpoint time)
  todoSnapshot: TodoSnapshot[];

  // Set only when status !== 'running'
  finalResponse?: string;
  totalUsage?:    { inputTokens: number; outputTokens: number };
  errorMessage?:  string;
}

export interface CheckpointSummary {
  runId:            string;
  agentId:          string;
  status:           CheckpointData['status'];
  createdAt:        number;
  updatedAt:        number;
  userInputPreview: string;
  stepCount:        number;
  budgetUsed:       number;
  budgetMax:        number;
  pendingTodos:     number;
}

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

export function generateRunId(): string {
  const now  = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, '');
  const time = now.toISOString().slice(11, 19).replace(/:/g, '');
  const rand = Math.random().toString(36).slice(2, 8);
  return `run_${date}_${time}_${rand}`;
  // → "run_20260420_100523_a3b7c2"
}

// ---------------------------------------------------------------------------
// Todo snapshot helper
// ---------------------------------------------------------------------------

/**
 * Read the current todo store state and return a snapshot.
 * Always loads from disk first to get the most up-to-date state.
 * Never throws — returns empty array on any error.
 */
export async function captureToDoSnapshot(sessionDir?: string): Promise<TodoSnapshot[]> {
  if (!sessionDir) return [];
  try {
    const store = getTodoStore(sessionDir);
    await store.load();
    return store.list().map((t: Todo) => ({
      id:          t.id,
      title:       t.title,
      status:      t.status,
      priority:    t.priority,
      description: t.description,
    }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Resume prompt builder (Gap 9: structured task context on resume)
// ---------------------------------------------------------------------------

/**
 * Build the user message injected when resuming an interrupted run.
 * Provides the LLM with:
 *   1. How many steps were already completed
 *   2. The current todo state (done ✓ / active → / pending ○)
 *   3. An explicit instruction to continue rather than restart
 */
export function buildResumePrompt(cp: CheckpointData): string {
  const lines: string[] = [
    `[Task Resume — run ${cp.runId}]`,
    `This task was interrupted after ${cp.steps.length} step(s). ` +
    `${cp.budgetMax - cp.budgetUsed} iteration(s) of budget remain.`,
    '',
  ];

  if (cp.todoSnapshot.length > 0) {
    const done    = cp.todoSnapshot.filter((t) => t.status === 'completed');
    const active  = cp.todoSnapshot.filter((t) => t.status === 'in_progress');
    const pending = cp.todoSnapshot.filter((t) => t.status === 'pending');

    lines.push('Task state at time of interruption:');

    for (const t of done)    lines.push(`  ✓ [done]        ${t.title}`);
    for (const t of active)  lines.push(`  → [in_progress] ${t.title}  ← resume here`);
    for (const t of pending) lines.push(`  ○ [pending]     ${t.title}`);

    lines.push('');
    if (active.length > 0) {
      lines.push(`Continue from the in-progress task(s) above. Do not repeat completed work.`);
    } else if (pending.length > 0) {
      lines.push(`All active tasks were finished. Continue with the first pending task above.`);
    } else {
      lines.push(`All tasks appear completed. Please verify and provide a final summary.`);
    }
  } else {
    lines.push(
      `No todo list was recorded. Continue from the most recent step ` +
      `(iteration ${cp.budgetUsed}) towards the original goal.`,
    );
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CheckpointWriter — atomic read/write/list/delete
// ---------------------------------------------------------------------------

export class CheckpointWriter {
  private readonly dir: string;

  constructor(sessionDir: string) {
    this.dir = path.join(sessionDir, 'checkpoints');
  }

  filePath(runId: string): string {
    return path.join(this.dir, `${runId}.json`);
  }

  /**
   * Atomically write a checkpoint.
   * Writes to a .tmp file first, then renames — safe against partial writes.
   */
  async write(data: CheckpointData): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const target = this.filePath(data.runId);
    const tmp    = `${target}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
      await fs.rename(tmp, target);
    } catch (err) {
      try { await fs.unlink(tmp); } catch { /* ignore cleanup error */ }
      throw err;
    }
  }

  /** Read a checkpoint by runId. Returns null if not found or unreadable. */
  async read(runId: string): Promise<CheckpointData | null> {
    try {
      const raw = await fs.readFile(this.filePath(runId), 'utf-8');
      return JSON.parse(raw) as CheckpointData;
    } catch {
      return null;
    }
  }

  /** List all checkpoints, newest first. */
  async list(): Promise<CheckpointSummary[]> {
    await fs.mkdir(this.dir, { recursive: true });
    let files: string[];
    try {
      files = (await fs.readdir(this.dir)).filter(
        (f) => f.endsWith('.json') && !f.endsWith('.tmp.json'),
      );
    } catch {
      return [];
    }

    const summaries: CheckpointSummary[] = [];
    for (const file of files) {
      try {
        const raw  = await fs.readFile(path.join(this.dir, file), 'utf-8');
        const data = JSON.parse(raw) as CheckpointData;
        summaries.push({
          runId:            data.runId,
          agentId:          data.agentId,
          status:           data.status,
          createdAt:        data.createdAt,
          updatedAt:        data.updatedAt,
          userInputPreview: data.userInput.slice(0, 120),
          stepCount:        data.steps.length,
          budgetUsed:       data.budgetUsed,
          budgetMax:        data.budgetMax,
          pendingTodos:     data.todoSnapshot.filter(
            (t) => t.status === 'pending' || t.status === 'in_progress',
          ).length,
        });
      } catch { /* skip malformed */ }
    }

    return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Delete a checkpoint file. Returns false if not found. */
  async delete(runId: string): Promise<boolean> {
    try {
      await fs.unlink(this.filePath(runId));
      return true;
    } catch {
      return false;
    }
  }
}
