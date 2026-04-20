/**
 * Memory Layer 3 — Session Log
 *
 * Persists every AgentStep to disk as newline-delimited JSON (JSONL).
 * The log is write-only from the agent's runtime perspective — it is NEVER
 * auto-loaded into the context window. Access is only via keyword search,
 * implementing the "raw records — search-only" pattern.
 *
 * This gives the LLM a searchable episodic memory:
 *   "What did I do last time I worked on database migrations?"
 *   → session_search returns relevant log snippets
 *
 * Directory layout:
 *   {sessionDir}/logs/
 *     2026-04-20.jsonl   ← one file per day
 *     2026-04-19.jsonl
 *     ...
 *
 * Log entry format (one JSON object per line):
 *   {ts, date, agentId, iteration, assistantText, toolCalls:[{name,args,resultSnippet,error}]}
 */

import fs   from 'fs/promises';
import path from 'path';
import os   from 'os';

import type { AgentStep } from '../types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_SESSION_DIR = path.join(os.homedir(), '.hermes', 'sessions');

/** Maximum characters stored per tool result in the log (saves disk space). */
const MAX_RESULT_SNIPPET = 500;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionLogEntry {
  ts:            number;         // unix-ms
  date:          string;         // ISO-8601
  agentId:       string;
  iteration:     number;
  assistantText: string;
  toolCalls: Array<{
    name:          string;
    args:          Record<string, unknown>;
    resultSnippet: string;       // first MAX_RESULT_SNIPPET chars of result
    error:         boolean;
  }>;
}

export interface SessionSearchResult {
  ts:        number;
  date:      string;
  agentId:   string;
  iteration: number;
  score:     number;
  snippet:   string;           // context around the match
  source:    'assistant' | 'tool';
  toolName?: string;
}

// ---------------------------------------------------------------------------
// SessionLogger — append-only writer (fire-and-forget, never throws)
// ---------------------------------------------------------------------------

export class SessionLogger {
  private readonly logDir: string;

  constructor(sessionDir?: string) {
    this.logDir = path.join(sessionDir ?? DEFAULT_SESSION_DIR, 'logs');
  }

  /**
   * Append one AgentStep to today's JSONL log file.
   * Errors are silently swallowed — logging must never crash the agent.
   */
  async append(agentId: string, step: AgentStep): Promise<void> {
    const now     = new Date();
    const date    = now.toISOString().slice(0, 10);        // YYYY-MM-DD
    const logFile = path.join(this.logDir, `${date}.jsonl`);

    const entry: SessionLogEntry = {
      ts:            now.getTime(),
      date:          now.toISOString(),
      agentId,
      iteration:     step.iteration,
      assistantText: step.assistantText,
      toolCalls: step.toolResults.map((tr, i) => ({
        name:          tr.name,
        args:          step.toolCalls[i]?.args ?? {},
        resultSnippet: tr.result.slice(0, MAX_RESULT_SNIPPET),
        error:         tr.error ?? false,
      })),
    };

    try {
      await fs.mkdir(this.logDir, { recursive: true });
      await fs.appendFile(logFile, JSON.stringify(entry) + '\n', 'utf-8');
    } catch { /* best-effort */ }
  }
}

// ---------------------------------------------------------------------------
// Scoring helpers
// ---------------------------------------------------------------------------

function tokenize(s: string): string[] {
  return s.toLowerCase().match(/[a-z0-9_\-./]+/g) ?? [];
}

interface ScoreResult { score: number; snippet: string }

function scoreText(text: string, queryTokens: string[]): ScoreResult {
  if (queryTokens.length === 0 || !text) return { score: 0, snippet: '' };
  const lower = text.toLowerCase();
  let score   = 0;
  for (const token of queryTokens) {
    const re   = new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    const hits = lower.match(re);
    if (hits) score += hits.length;
  }
  if (score === 0) return { score: 0, snippet: '' };

  // Extract snippet around the first match
  const first = queryTokens.find((t) => lower.includes(t)) ?? queryTokens[0];
  const idx   = lower.indexOf(first);
  const start = Math.max(0, idx - 40);
  const end   = Math.min(text.length, idx + 140);
  const snippet =
    (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');

  return { score, snippet };
}

// ---------------------------------------------------------------------------
// searchSessionLogs — keyword search across JSONL files
// ---------------------------------------------------------------------------

/**
 * Search session log files for entries matching the keyword query.
 * Scans both assistant text and tool results (name + resultSnippet).
 *
 * @param query      Space-separated keywords
 * @param sessionDir Directory containing the `logs/` subdirectory
 * @param limit      Max results (default 10)
 * @param daysBack   How many daily files to scan (default 30)
 */
export async function searchSessionLogs(
  query: string,
  opts: { sessionDir?: string; limit?: number; daysBack?: number } = {},
): Promise<SessionSearchResult[]> {
  const logDir      = path.join(opts.sessionDir ?? DEFAULT_SESSION_DIR, 'logs');
  const limit       = opts.limit   ?? 10;
  const daysBack    = opts.daysBack ?? 30;
  const queryTokens = tokenize(query);

  if (queryTokens.length === 0) return [];

  let files: string[];
  try {
    files = (await fs.readdir(logDir))
      .filter((f) => f.endsWith('.jsonl'))
      .sort()
      .reverse()         // newest first
      .slice(0, daysBack);
  } catch {
    return [];
  }

  const results: SessionSearchResult[] = [];

  for (const file of files) {
    let raw: string;
    try {
      raw = await fs.readFile(path.join(logDir, file), 'utf-8');
    } catch {
      continue;
    }

    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let entry: SessionLogEntry;
      try { entry = JSON.parse(line) as SessionLogEntry; } catch { continue; }

      // Score assistant text
      const { score: aScore, snippet: aSnippet } = scoreText(entry.assistantText, queryTokens);
      if (aScore > 0) {
        results.push({
          ts: entry.ts, date: entry.date, agentId: entry.agentId,
          iteration: entry.iteration, score: aScore,
          snippet: aSnippet, source: 'assistant',
        });
      }

      // Score tool results
      for (const tc of entry.toolCalls) {
        const combined = `${tc.name} ${tc.resultSnippet}`;
        const { score: tScore, snippet: tSnippet } = scoreText(combined, queryTokens);
        if (tScore > 0) {
          results.push({
            ts: entry.ts, date: entry.date, agentId: entry.agentId,
            iteration: entry.iteration, score: tScore,
            snippet: tSnippet, source: 'tool', toolName: tc.name,
          });
        }
      }
    }
  }

  return results
    .sort((a, b) => b.score - a.score || b.ts - a.ts)
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// getRecentSessionLogs — return the most recent N steps (no scoring)
// ---------------------------------------------------------------------------

/**
 * Return the most recent log entries across daily files, ordered newest-first.
 * Used for the `session_recent` memory operation.
 */
export async function getRecentSessionLogs(
  opts: { sessionDir?: string; limit?: number; daysBack?: number } = {},
): Promise<SessionLogEntry[]> {
  const logDir   = path.join(opts.sessionDir ?? DEFAULT_SESSION_DIR, 'logs');
  const limit    = opts.limit   ?? 20;
  const daysBack = opts.daysBack ?? 7;

  let files: string[];
  try {
    files = (await fs.readdir(logDir))
      .filter((f) => f.endsWith('.jsonl'))
      .sort()
      .reverse()
      .slice(0, daysBack);
  } catch {
    return [];
  }

  const all: SessionLogEntry[] = [];

  for (const file of files) {
    let raw: string;
    try {
      raw = await fs.readFile(path.join(logDir, file), 'utf-8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n').reverse()) {
      if (!line.trim()) continue;
      try {
        all.push(JSON.parse(line) as SessionLogEntry);
        if (all.length >= limit) return all;
      } catch { /* skip malformed lines */ }
    }
  }

  return all;
}
