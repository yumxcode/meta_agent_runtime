/**
 * Auto-Dream Service
 *
 * Background memory consolidation inspired by the "dream" phase of cognition:
 * while the agent is idle, it reviews accumulated memory entries, merges
 * duplicates, prunes stale facts, and produces a structured consolidation.
 *
 * Three-gate activation logic (ALL must pass):
 *   Gate 1 — Time gap:      last consolidation > TIME_THRESHOLD_MS ago
 *   Gate 2 — Session count: sessions since last consolidation >= SESSION_COUNT_THRESHOLD
 *   Gate 3 — File lock:     no other consolidation is currently running (lock file absent)
 *
 * Cheapest-first evaluation: gates are evaluated in order from cheapest (in-memory
 * timestamp check) to most expensive (file I/O for lock), so we fail fast without
 * hitting disk when unnecessary.
 *
 * Consolidation runs as a background task (fire-and-forget) so it never blocks
 * the main agent loop.
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import type { LLMAdapter } from '../adapters/base.js';
import { MemoryStore } from '../tools/memory-tool.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface DreamConfig {
  /** Minimum ms between consolidation runs. Default: 4 hours */
  timeThresholdMs?: number;
  /** Minimum sessions since last consolidation. Default: 3 */
  sessionCountThreshold?: number;
  /** Directory for state files (timestamps, lock). Defaults to ~/.hermes/dream/ */
  stateDir?: string;
  /** Path to the MEMORY.md file to consolidate. Defaults to ~/.hermes/MEMORY.md */
  memoryPath?: string;
  /**
   * Whether to use a cheaper/smaller model for consolidation.
   * Pass a model string to override; undefined = use the provided adapter as-is.
   */
  cheapModel?: string;
  /** Max tokens for the consolidation prompt. Default 4096 */
  maxTokens?: number;
}

const DEFAULTS = {
  timeThresholdMs: 4 * 60 * 60 * 1000,  // 4 hours
  sessionCountThreshold: 3,
  maxTokens: 4096,
};

// ---------------------------------------------------------------------------
// State file paths
// ---------------------------------------------------------------------------

interface DreamState {
  lastRunAt: number;      // Unix ms
  sessionCount: number;   // sessions since last run
  totalRuns: number;
}

const EMPTY_STATE: DreamState = { lastRunAt: 0, sessionCount: 0, totalRuns: 0 };

// ---------------------------------------------------------------------------
// Consolidation prompt
// ---------------------------------------------------------------------------

const CONSOLIDATION_SYSTEM = `You are a memory consolidation agent for an AI assistant.
Your job is to review a set of memory entries and produce a clean, deduplicated,
well-organised version of them. Keep all unique facts; merge duplicates into the
most complete version; remove entries that are clearly stale or contradicted by
newer ones.`;

const CONSOLIDATION_PROMPT = `Below are the current memory entries grouped by category.
Please consolidate them according to these rules:

1. MERGE duplicate entries about the same topic into a single, complete entry.
2. REMOVE entries that are superseded or clearly contradicted by newer information.
3. REWRITE entries to be concise but complete — one clear fact per entry.
4. PRESERVE the category structure. Return entries in this exact format:

<!-- entry: category:key -->
value
<!-- /entry -->

Repeat this block for every consolidated entry. Do not include any other text.

--- CURRENT MEMORY ENTRIES ---

{memory}`;

// ---------------------------------------------------------------------------
// DreamService
// ---------------------------------------------------------------------------

export class DreamService {
  private stateDir: string;
  private memoryPath: string;
  private config: Required<DreamConfig>;
  private _sessionCount = 0;   // in-memory session counter for this process
  private _running = false;

  constructor(private adapter: LLMAdapter, config: DreamConfig = {}) {
    this.stateDir = config.stateDir ?? path.join(os.homedir(), '.hermes', 'dream');
    this.memoryPath = config.memoryPath ?? path.join(os.homedir(), '.hermes', 'MEMORY.md');
    this.config = {
      timeThresholdMs: config.timeThresholdMs ?? DEFAULTS.timeThresholdMs,
      sessionCountThreshold: config.sessionCountThreshold ?? DEFAULTS.sessionCountThreshold,
      stateDir: this.stateDir,
      memoryPath: this.memoryPath,
      cheapModel: config.cheapModel ?? '',
      maxTokens: config.maxTokens ?? DEFAULTS.maxTokens,
    };
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Call this at the start of each agent session.
   * Increments the session counter and, if all three gates pass,
   * fires a background consolidation (non-blocking).
   */
  async tick(): Promise<void> {
    this._sessionCount++;
    await this._persistSessionIncrement();
    // Fire-and-forget; errors are caught internally
    void this._maybeRunBackground();
  }

  /**
   * Force a consolidation run immediately, regardless of gates.
   * Returns a summary of what was done.
   */
  async forceRun(): Promise<string> {
    return this._consolidate();
  }

  /**
   * Check all three gates and return whether consolidation should run.
   * Cheap gates are evaluated first.
   */
  async shouldRun(): Promise<{ should: boolean; reason: string }> {
    // Gate 1 — time (cheapest: in-memory state)
    const state = await this._loadState();
    const now = Date.now();
    const elapsed = now - state.lastRunAt;
    if (elapsed < this.config.timeThresholdMs) {
      const remaining = Math.round((this.config.timeThresholdMs - elapsed) / 60_000);
      return { should: false, reason: `Gate 1 failed: ${remaining}min until next eligible run` };
    }

    // Gate 2 — session count
    if (state.sessionCount < this.config.sessionCountThreshold) {
      return {
        should: false,
        reason: `Gate 2 failed: ${state.sessionCount}/${this.config.sessionCountThreshold} sessions`,
      };
    }

    // Gate 3 — file lock (most expensive: disk I/O)
    const locked = await this._isLocked();
    if (locked) {
      return { should: false, reason: 'Gate 3 failed: consolidation lock held by another process' };
    }

    return { should: true, reason: 'All gates passed' };
  }

  // -------------------------------------------------------------------------
  // Internal: gate checks
  // -------------------------------------------------------------------------

  private get _statePath(): string {
    return path.join(this.stateDir, 'state.json');
  }

  private get _lockPath(): string {
    return path.join(this.stateDir, 'consolidation.lock');
  }

  private async _ensureStateDir(): Promise<void> {
    await fs.mkdir(this.stateDir, { recursive: true });
  }

  private async _loadState(): Promise<DreamState> {
    try {
      const raw = await fs.readFile(this._statePath, 'utf-8');
      return JSON.parse(raw) as DreamState;
    } catch {
      return { ...EMPTY_STATE };
    }
  }

  private async _saveState(state: DreamState): Promise<void> {
    await this._ensureStateDir();
    await fs.writeFile(this._statePath, JSON.stringify(state, null, 2), 'utf-8');
  }

  private async _persistSessionIncrement(): Promise<void> {
    const state = await this._loadState();
    state.sessionCount++;
    await this._saveState(state);
  }

  private async _isLocked(): Promise<boolean> {
    try {
      await fs.access(this._lockPath);
      // Lock file exists — check if it's stale (> 30 min old)
      const stat = await fs.stat(this._lockPath);
      const age = Date.now() - stat.mtimeMs;
      if (age > 30 * 60 * 1000) {
        // Stale lock — remove it
        await fs.unlink(this._lockPath).catch(() => undefined);
        return false;
      }
      return true;
    } catch {
      return false; // Lock file absent
    }
  }

  private async _acquireLock(): Promise<boolean> {
    try {
      await this._ensureStateDir();
      // O_EXCL ensures atomic creation — fails if file already exists
      const handle = await fs.open(this._lockPath, 'wx');
      await handle.close();
      return true;
    } catch {
      return false;
    }
  }

  private async _releaseLock(): Promise<void> {
    await fs.unlink(this._lockPath).catch(() => undefined);
  }

  // -------------------------------------------------------------------------
  // Internal: background runner
  // -------------------------------------------------------------------------

  private async _maybeRunBackground(): Promise<void> {
    if (this._running) return;
    const { should } = await this.shouldRun();
    if (!should) return;

    this._running = true;
    try {
      await this._consolidate();
    } catch {
      // Background task — swallow errors silently
    } finally {
      this._running = false;
    }
  }

  // -------------------------------------------------------------------------
  // Internal: consolidation logic
  // -------------------------------------------------------------------------

  private async _consolidate(): Promise<string> {
    const acquired = await this._acquireLock();
    if (!acquired) return 'Consolidation skipped: lock already held';

    try {
      const store = new MemoryStore({ filePath: this.memoryPath });
      const raw = await store.readAll();

      if (!raw.trim() || raw.trim() === '# Hermes Agent Memory') {
        return 'Consolidation skipped: memory is empty';
      }

      const prompt = CONSOLIDATION_PROMPT.replace('{memory}', raw);
      const response = await this.adapter.call(
        [
          { role: 'system', content: CONSOLIDATION_SYSTEM },
          { role: 'user', content: prompt },
        ],
        [],
        { maxTokens: this.config.maxTokens, temperature: 0.1, stream: false },
      );

      const consolidated = response.text?.trim();
      if (!consolidated) return 'Consolidation failed: empty LLM response';

      // Write back the consolidated content
      const newContent =
        '# Hermes Agent Memory\n\nThis file stores persistent memories across sessions.\n\n' +
        consolidated + '\n';
      await fs.writeFile(this.memoryPath, newContent, 'utf-8');

      // Reset state
      const state = await this._loadState();
      await this._saveState({
        lastRunAt: Date.now(),
        sessionCount: 0,
        totalRuns: (state.totalRuns ?? 0) + 1,
      });

      return `Memory consolidation complete (run #${(state.totalRuns ?? 0) + 1})`;
    } finally {
      await this._releaseLock();
    }
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton factory
// ---------------------------------------------------------------------------

let _dreamService: DreamService | null = null;

export function getDreamService(adapter?: LLMAdapter, config?: DreamConfig): DreamService {
  if (!_dreamService && adapter) {
    _dreamService = new DreamService(adapter, config);
  }
  if (!_dreamService) {
    throw new Error('DreamService not initialised. Call getDreamService(adapter) first.');
  }
  return _dreamService;
}
