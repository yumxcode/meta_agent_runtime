/**
 * Memory Layer 2 — Topic Store
 *
 * Organises memory into per-topic markdown files under a directory instead of
 * one flat MEMORY.md. Each topic is a standalone MemoryStore backed by its
 * own file.
 *
 * Default topics map to the four built-in categories. Additional custom topic
 * files can be created for project-specific domains (e.g. "architecture",
 * "api-design", "decisions").
 *
 * Directory layout:
 *   {topicDir}/
 *     user.md          ← user preferences & long-term facts
 *     project.md       ← project state & decisions
 *     feedback.md      ← agent lessons learned
 *     reference.md     ← external knowledge / API docs
 *     {custom}.md      ← any additional topic
 *
 * The LLM sees topic names + entry counts in the memory index (Layer 1),
 * then calls read_topic when it needs the full content of a specific domain.
 */

import fs   from 'fs/promises';
import path from 'path';
import os   from 'os';

import { getMemoryStore, evictMemoryStore } from '../tools/memory-tool.js';
import type { StalenessRisk }               from '../types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_TOPIC_DIR = path.join(os.homedir(), '.hermes', 'topics');

const BUILT_IN_TOPICS = ['user', 'project', 'feedback', 'reference'] as const;
export type BuiltInTopic = (typeof BUILT_IN_TOPICS)[number];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TopicMeta {
  name:          string;
  filePath:      string;
  entryCount:    number;
  fileSizeBytes: number;
  isBuiltIn:     boolean;
}

export interface TopicSearchResult {
  topic:     string;
  key:       string;
  score:     number;
  preview:   string;
  staleness: StalenessRisk | null;
}

// ---------------------------------------------------------------------------
// TopicStore
// ---------------------------------------------------------------------------

export class TopicStore {
  private readonly topicDir: string;

  constructor(topicDir?: string) {
    this.topicDir = topicDir ?? DEFAULT_TOPIC_DIR;
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /** Sanitise a topic name to a safe filename stem. */
  private _safeName(name: string): string {
    return name.replace(/[^a-z0-9\-_]/gi, '_').toLowerCase();
  }

  /** Resolve the absolute file path for a topic. */
  topicPath(name: string): string {
    return path.join(this.topicDir, `${this._safeName(name)}.md`);
  }

  /** Get (or lazily create) the MemoryStore for a topic. */
  getStore(topic: string) {
    return getMemoryStore(this.topicPath(topic));
  }

  // -------------------------------------------------------------------------
  // Topic-level operations
  // -------------------------------------------------------------------------

  /**
   * List all existing topic files in the directory with metadata.
   * Built-in topics are listed first; custom topics follow alphabetically.
   */
  async listTopics(): Promise<TopicMeta[]> {
    await fs.mkdir(this.topicDir, { recursive: true });

    let files: string[];
    try {
      files = await fs.readdir(this.topicDir);
    } catch {
      return [];
    }

    const mdFiles = files.filter((f) => f.endsWith('.md'));
    const metas: TopicMeta[] = [];

    for (const file of mdFiles) {
      const name     = file.slice(0, -3); // strip .md
      const filePath = path.join(this.topicDir, file);
      try {
        const store = getMemoryStore(filePath);
        const stats = await store.stats();
        metas.push({
          name,
          filePath,
          entryCount:    stats.entries,
          fileSizeBytes: stats.fileSizeBytes,
          isBuiltIn:     (BUILT_IN_TOPICS as readonly string[]).includes(name),
        });
      } catch { /* skip unreadable files */ }
    }

    return metas.sort((a, b) => {
      if (a.isBuiltIn !== b.isBuiltIn) return a.isBuiltIn ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  /**
   * Read the full markdown content of a topic file (all entries with keys).
   * This is the "on-demand topic pull" operation.
   */
  async readTopic(topic: string): Promise<string> {
    const store = this.getStore(topic);
    return store.readAll();
  }

  /** Write a key-value pair to a specific topic file. */
  async write(
    topic: string,
    key:   string,
    value: string,
  ): Promise<{ warning?: string }> {
    const store = this.getStore(topic);
    return store.set(key, value);
  }

  /** Delete an entire topic file and evict its cached store. */
  async deleteTopic(topic: string): Promise<boolean> {
    const filePath = this.topicPath(topic);
    evictMemoryStore(filePath);
    try {
      await fs.unlink(filePath);
      return true;
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Cross-topic search
  // -------------------------------------------------------------------------

  /**
   * Keyword search across ALL topic files.
   * Results are merged and ranked by score descending.
   * Staleness risk is assessed per-entry.
   */
  async searchAll(query: string, limit = 10): Promise<TopicSearchResult[]> {
    const topics = await this.listTopics();
    const all: TopicSearchResult[] = [];

    for (const t of topics) {
      const store   = this.getStore(t.name);
      const results = await store.search(query, { limit });
      for (const r of results) {
        all.push({
          topic:     t.name,
          key:       r.key,
          score:     r.score,
          preview:   r.preview,
          staleness: r.staleness,
        });
      }
    }

    return all
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton (keyed by topicDir path)
// ---------------------------------------------------------------------------

const _registry = new Map<string, TopicStore>();

export function getTopicStore(topicDir?: string): TopicStore {
  const dir = topicDir ?? DEFAULT_TOPIC_DIR;
  let ts = _registry.get(dir);
  if (!ts) {
    ts = new TopicStore(dir);
    _registry.set(dir, ts);
  }
  return ts;
}
