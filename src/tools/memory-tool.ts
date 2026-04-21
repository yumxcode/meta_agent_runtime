/**
 * Memory Tool
 *
 * Persistent key-value memory backed by a MEMORY.md file.
 * Supports typed categories, size limits with explicit warnings,
 * and category-scoped listing/reading.
 *
 * File format (MEMORY.md):
 *   # Memory
 *   <!-- entry: category:key -->
 *   value text
 *   <!-- /entry -->
 *
 * Categories:
 *   user      — long-term facts about the user (preferences, context)
 *   feedback  — agent self-corrections and lessons learned
 *   project   — project-specific state (paths, configs, decisions)
 *   reference — external knowledge to retain (API signatures, docs)
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { registerTools } from './registry.js';
import type { ToolEntry, Observation, StalenessRisk } from '../types.js';
import { getTopicStore }                               from '../memory/topic-store.js';
import { searchSessionLogs, getRecentSessionLogs }     from '../memory/session-log.js';

// ---------------------------------------------------------------------------
// MemoryCategory
// ---------------------------------------------------------------------------

export type MemoryCategory = 'user' | 'feedback' | 'project' | 'reference';

const VALID_CATEGORIES: MemoryCategory[] = ['user', 'feedback', 'project', 'reference'];

// ---------------------------------------------------------------------------
// MemoryConfig
// ---------------------------------------------------------------------------

export interface MemoryConfig {
  /** Path to MEMORY.md file. Defaults to ~/.hermes/MEMORY.md */
  filePath?: string;
  /** Maximum number of entries. Default: 200 */
  maxEntries?: number;
  /** Maximum file size in bytes. Default: 512 KB */
  maxBytes?: number;
  /** Per-category entry limits. */
  categoryLimits?: Partial<Record<MemoryCategory, number>>;
}

const DEFAULT_CONFIG: Required<Omit<MemoryConfig, 'filePath' | 'categoryLimits'>> = {
  maxEntries: 200,
  maxBytes: 512 * 1024, // 512 KB
};

// ---------------------------------------------------------------------------
// MemoryStore
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Staleness risk detector
// ---------------------------------------------------------------------------

/** Volatile content patterns that signal a memory entry may need verification. */
const VOLATILE_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /(?:^|\s)(?:\/[\w\-.]+){2,}/,               reason: 'file path reference' },
  { re: /~\/[\w\-./]+/,                              reason: 'home-relative path' },
  { re: /https?:\/\//i,                              reason: 'URL reference' },
  { re: /\bv\d+\.\d+[\d.]*\b/i,                     reason: 'version number' },
  { re: /\b(?:version|release)\s*[:=]?\s*[\d.]+/i,  reason: 'versioned dependency' },
  { re: /\b(?:port|pid|process)\s*[:=]?\s*\d+/i,    reason: 'runtime process/port' },
  { re: /\b(?:current|latest|running|active|enabled|now|today|live)\b/i,
                                                      reason: 'volatile state keyword' },
  { re: /\b(?:token|secret|password|key)\s*[:=]/i,  reason: 'credential reference' },
];

/** Thresholds (hours) for medium / high risk when volatile patterns match. */
const STALE_MEDIUM_H = 24;   // 1 day
const STALE_HIGH_H   = 168;  // 7 days

function assessStaleness(key: string, value: string, ts: number): StalenessRisk | null {
  const matched = VOLATILE_PATTERNS.find(
    (p) => p.re.test(value) || p.re.test(key),
  );
  if (!matched) return null;

  const now = Date.now();
  const ageMs = ts > 0 ? now - ts : -1;
  const ageHours = ageMs >= 0 ? Math.round(ageMs / 3_600_000) : -1;

  let level: StalenessRisk['level'];
  if (ageHours < 0) {
    level = 'low'; // age unknown but content is volatile
  } else if (ageHours >= STALE_HIGH_H) {
    level = 'high';
  } else if (ageHours >= STALE_MEDIUM_H) {
    level = 'medium';
  } else {
    level = 'low';
  }

  const agePart = ageHours >= 0 ? `, written ${ageHours}h ago` : ' (write time unknown)';
  const hint =
    level === 'high'
      ? `This memory is ${ageHours}h old and contains a ${matched.reason}. ` +
        `Verify against the real environment before relying on it.`
      : level === 'medium'
        ? `This memory contains a ${matched.reason}${agePart}. ` +
          `Consider confirming it is still accurate.`
        : `This memory contains a ${matched.reason}. ` +
          `Treat as a hint, not ground truth.`;

  return { level, reason: matched.reason, age_hours: ageHours, hint };
}

// ---------------------------------------------------------------------------
// Keyword search scoring
// ---------------------------------------------------------------------------

function tokenize(s: string): string[] {
  return s.toLowerCase().match(/[a-z0-9_\-./]+/g) ?? [];
}

function scoreEntry(key: string, value: string, queryTokens: string[]): number {
  if (queryTokens.length === 0) return 0;
  const keyLower = key.toLowerCase();
  const valueLower = value.toLowerCase();
  let score = 0;
  for (const token of queryTokens) {
    // Exact key prefix match gets highest weight
    if (keyLower === token) { score += 10; continue; }
    if (keyLower.includes(token)) score += 4;
    // Value occurrence count
    const re = new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    const hits = valueLower.match(re);
    if (hits) score += hits.length;
  }
  return score;
}

// ---------------------------------------------------------------------------
// MemoryStore
// ---------------------------------------------------------------------------

export class MemoryStore {
  private filePath: string;
  private config: Required<Omit<MemoryConfig, 'filePath'>>;
  private _cache: Map<string, string> | null = null;
  /**
   * Parallel timestamp map: key → unix-ms when the entry was last written.
   * 0 means "loaded from file without a ts marker" (legacy entry).
   */
  private _tsMeta: Map<string, number> = new Map();

  constructor(memoryConfig?: MemoryConfig | string) {
    if (typeof memoryConfig === 'string') {
      this.filePath = memoryConfig;
      this.config = { ...DEFAULT_CONFIG, categoryLimits: {} };
    } else {
      this.filePath =
        memoryConfig?.filePath ?? path.join(os.homedir(), '.hermes', 'MEMORY.md');
      this.config = {
        maxEntries: memoryConfig?.maxEntries ?? DEFAULT_CONFIG.maxEntries,
        maxBytes: memoryConfig?.maxBytes ?? DEFAULT_CONFIG.maxBytes,
        categoryLimits: memoryConfig?.categoryLimits ?? {},
      };
    }
  }

  // -------------------------------------------------------------------------
  // File I/O
  // -------------------------------------------------------------------------

  private async _ensureFile(): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    try {
      await fs.access(this.filePath);
    } catch {
      await fs.writeFile(
        this.filePath,
        '# Hermes Agent Memory\n\nThis file stores persistent memories across sessions.\n',
        'utf-8',
      );
    }
  }

  async load(): Promise<Map<string, string>> {
    if (this._cache) return this._cache;
    await this._ensureFile();
    const content = await fs.readFile(this.filePath, 'utf-8');
    this._cache = this._parse(content);
    return this._cache;
  }

  /**
   * Entry format (backward-compatible):
   *   <!-- entry: key -->          ← legacy (ts treated as 0 = unknown)
   *   <!-- entry: key ts=NNN -->   ← new format with write timestamp
   */
  private _parse(content: string): Map<string, string> {
    const map = new Map<string, string>();
    const entryRegex = /<!-- entry: ([^\n]+?) (?:ts=(\d+) )?-->\n([\s\S]*?)<!-- \/entry -->/g;
    let match: RegExpExecArray | null;
    while ((match = entryRegex.exec(content)) !== null) {
      const key = match[1]?.trim() ?? '';
      const ts = match[2] ? parseInt(match[2], 10) : 0;
      const value = match[3]?.trim() ?? '';
      if (key) {
        map.set(key, value);
        this._tsMeta.set(key, ts);
      }
    }
    return map;
  }

  private _serialize(map: Map<string, string>): string {
    const header = '# Hermes Agent Memory\n\nThis file stores persistent memories across sessions.\n\n';
    if (map.size === 0) return header;
    const entries = Array.from(map.entries())
      .map(([k, v]) => {
        const ts = this._tsMeta.get(k) ?? Date.now();
        return `<!-- entry: ${k} ts=${ts} -->\n${v}\n<!-- /entry -->`;
      })
      .join('\n\n');
    return header + entries + '\n';
  }

  async save(): Promise<void> {
    if (!this._cache) return;
    const content = this._serialize(this._cache);
    await fs.writeFile(this.filePath, content, 'utf-8');
  }

  // -------------------------------------------------------------------------
  // Size limit checks
  // -------------------------------------------------------------------------

  private async _checkLimits(
    map: Map<string, string>,
    category: MemoryCategory | undefined,
    key: string,
    isNew: boolean,
  ): Promise<string | null> {
    const warnings: string[] = [];

    if (isNew) {
      if (map.size >= this.config.maxEntries) {
        warnings.push(
          `⚠️  Memory entry limit reached (${map.size}/${this.config.maxEntries}). ` +
          `Consider deleting stale entries before writing "${key}".`,
        );
      }
      if (category) {
        const catLimit = this.config.categoryLimits?.[category];
        if (catLimit !== undefined) {
          const catCount = Array.from(map.keys()).filter((k) => k.startsWith(`${category}:`)).length;
          if (catCount >= catLimit) {
            warnings.push(
              `⚠️  Category "${category}" entry limit reached (${catCount}/${catLimit}). ` +
              `Consider removing older "${category}" entries.`,
            );
          }
        }
      }
    }

    const projected = this._serialize(map).length;
    if (projected >= this.config.maxBytes) {
      warnings.push(
        `⚠️  Memory file approaching size limit (${Math.round(projected / 1024)}KB / ` +
        `${Math.round(this.config.maxBytes / 1024)}KB). ` +
        `Run memory consolidation or delete stale entries.`,
      );
    }

    return warnings.length > 0 ? warnings.join('\n') : null;
  }

  // -------------------------------------------------------------------------
  // CRUD
  // -------------------------------------------------------------------------

  static buildKey(key: string, category?: MemoryCategory): string {
    if (category && !key.startsWith(`${category}:`)) {
      return `${category}:${key}`;
    }
    return key;
  }

  static parseCategory(key: string): { category: MemoryCategory | undefined; baseKey: string } {
    const sep = key.indexOf(':');
    if (sep > 0) {
      const cat = key.slice(0, sep) as MemoryCategory;
      if ((VALID_CATEGORIES as string[]).includes(cat)) {
        return { category: cat, baseKey: key.slice(sep + 1) };
      }
    }
    return { category: undefined, baseKey: key };
  }

  async get(key: string, category?: MemoryCategory): Promise<string | undefined> {
    const map = await this.load();
    const fullKey = MemoryStore.buildKey(key, category);
    return map.get(fullKey) ?? map.get(key);
  }

  /** Returns the write timestamp (ms) for a key, or 0 if unknown. */
  getTimestamp(key: string): number {
    return this._tsMeta.get(key) ?? 0;
  }

  async set(key: string, value: string, category?: MemoryCategory): Promise<{ warning?: string }> {
    const map = await this.load();
    const fullKey = MemoryStore.buildKey(key, category);
    const isNew = !map.has(fullKey);
    const warning = await this._checkLimits(map, category, fullKey, isNew) ?? undefined;
    map.set(fullKey, value);
    this._tsMeta.set(fullKey, Date.now()); // stamp write time
    await this.save();
    return { warning };
  }

  async delete(key: string, category?: MemoryCategory): Promise<boolean> {
    const map = await this.load();
    const fullKey = MemoryStore.buildKey(key, category);
    const existed = map.delete(fullKey) || map.delete(key);
    if (existed) {
      this._tsMeta.delete(fullKey);
      this._tsMeta.delete(key);
      await this.save();
    }
    return existed;
  }

  async list(category?: MemoryCategory): Promise<Array<{ key: string; category?: MemoryCategory; preview: string }>> {
    const map = await this.load();
    return Array.from(map.entries())
      .filter(([k]) => !category || k.startsWith(`${category}:`))
      .map(([key, value]) => {
        const { category: cat } = MemoryStore.parseCategory(key);
        return {
          key,
          category: cat,
          preview: value.slice(0, 120) + (value.length > 120 ? '…' : ''),
        };
      });
  }

  async readAll(category?: MemoryCategory): Promise<string> {
    if (!category) {
      await this._ensureFile();
      return fs.readFile(this.filePath, 'utf-8');
    }
    const map = await this.load();
    const filtered = Array.from(map.entries()).filter(([k]) => k.startsWith(`${category}:`));
    if (filtered.length === 0) return `No entries found in category "${category}".`;
    return filtered.map(([k, v]) => `### ${k}\n${v}`).join('\n\n');
  }

  async stats(): Promise<{ entries: number; fileSizeBytes: number; categories: Record<string, number> }> {
    const map = await this.load();
    const content = this._serialize(map);
    const categories: Record<string, number> = {};
    for (const key of map.keys()) {
      const { category } = MemoryStore.parseCategory(key);
      const cat = category ?? 'uncategorized';
      categories[cat] = (categories[cat] ?? 0) + 1;
    }
    return { entries: map.size, fileSizeBytes: Buffer.byteLength(content, 'utf-8'), categories };
  }

  // -------------------------------------------------------------------------
  // Keyword search
  // -------------------------------------------------------------------------

  /**
   * Search memory entries by keyword query.
   * Scores each entry by token overlap in key (weight ×4) and value (weight ×1).
   * Returns top-`limit` results sorted by descending score, each optionally
   * annotated with a StalenessRisk if the entry has volatile content.
   */
  async search(
    query: string,
    opts?: { category?: MemoryCategory; limit?: number },
  ): Promise<Array<{
    key: string;
    category?: MemoryCategory;
    score: number;
    preview: string;
    staleness: StalenessRisk | null;
  }>> {
    const map = await this.load();
    const limit = opts?.limit ?? 10;
    const queryTokens = tokenize(query);

    const results: Array<{
      key: string;
      category?: MemoryCategory;
      score: number;
      preview: string;
      staleness: StalenessRisk | null;
    }> = [];

    for (const [key, value] of map.entries()) {
      if (opts?.category && !key.startsWith(`${opts.category}:`)) continue;

      const score = scoreEntry(key, value, queryTokens);
      if (score === 0) continue;

      const { category: cat } = MemoryStore.parseCategory(key);
      const ts = this._tsMeta.get(key) ?? 0;

      results.push({
        key,
        category: cat,
        score,
        preview: value.slice(0, 200) + (value.length > 200 ? '…' : ''),
        staleness: assessStaleness(key, value, ts),
      });
    }

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}

// ---------------------------------------------------------------------------
// Store registry — one MemoryStore per resolved file path.
// This prevents multiple instances from racing over the same file and
// ensures the in-memory cache (_cache) is actually shared across calls.
// ---------------------------------------------------------------------------

const _storeRegistry = new Map<string, MemoryStore>();

function resolveMemoryPath(config?: MemoryConfig | string): string {
  if (typeof config === 'string') return config;
  return config?.filePath ?? path.join(os.homedir(), '.hermes', 'MEMORY.md');
}

export function getMemoryStore(config?: MemoryConfig | string): MemoryStore {
  const filePath = resolveMemoryPath(config);
  let store = _storeRegistry.get(filePath);
  if (!store) {
    store = new MemoryStore(config);
    _storeRegistry.set(filePath, store);
  }
  return store;
}

/** Evict a cached store (e.g. after tests or when config must change). */
export function evictMemoryStore(filePath: string): void {
  _storeRegistry.delete(filePath);
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const memoryTools: ToolEntry[] = [
  {
    name: 'memory',
    toolset: 'memory',
    parallelSafe: false,
    emoji: '🧠',
    definition: {
      name: 'memory',
      description:
        'Unified three-layer memory system. ' +
        'Layer 1 (flat KV): read, write, delete, list, search, read_all, stats. ' +
        'Layer 2 (topic files): list_topics, read_topic, write_topic, search_topics — ' +
        'organises knowledge into per-domain markdown files; prefer read_topic over read_all. ' +
        'Layer 3 (session logs): session_search, session_recent — ' +
        'keyword search across persisted raw interaction history. ' +
        'Read results include staleness_risk metadata — treat memories as hints, ' +
        'not ground truth; verify against real environment when risk level is medium/high.',
      parameters: {
        type: 'object',
        properties: {
          operation: {
            type: 'string',
            enum: [
              // Layer 1
              'read', 'write', 'delete', 'list', 'search', 'read_all', 'stats',
              // Layer 2
              'list_topics', 'read_topic', 'write_topic', 'search_topics',
              // Layer 3
              'session_search', 'session_recent',
            ],
            description: 'Operation to perform.',
          },
          key: {
            type: 'string',
            description: 'Memory key (Layer 1). May include a category prefix, e.g. "project:api_key".',
          },
          value: {
            type: 'string',
            description: 'Value to store (required for write / write_topic).',
          },
          category: {
            type: 'string',
            enum: ['user', 'feedback', 'project', 'reference'],
            description: 'Category for Layer 1 entries.',
          },
          topic: {
            type: 'string',
            description: 'Topic file name for Layer 2 operations (e.g. "architecture", "api-notes").',
          },
          query: {
            type: 'string',
            description: 'Keyword query for search / search_topics / session_search.',
          },
          limit: {
            type: 'number',
            description: 'Max results to return (default: 10 for search, 20 for session_recent).',
          },
        },
        required: ['operation'],
      },
    },
    handler: async (args, context): Promise<string | Observation> => {
      const operation = args['operation'] as string;
      const key       = args['key']      as string | undefined;
      const value     = args['value']    as string | undefined;
      const category  = args['category'] as MemoryCategory | undefined;
      const topic     = args['topic']    as string | undefined;
      const query     = args['query']    as string | undefined;
      const limit     = args['limit']    as number | undefined;

      const memoryPath = context.metadata?.['memoryPath'] as string | undefined;
      const store = getMemoryStore(memoryPath);

      switch (operation) {

        // -------------------------------------------------------------------
        // read — exact key lookup + staleness risk assessment
        // -------------------------------------------------------------------
        case 'read': {
          if (!key) return 'Error: key is required for read operation';
          const fullKey = MemoryStore.buildKey(key, category);
          const val = await store.get(key, category);
          if (val === undefined) {
            return `No memory entry found for key: "${fullKey}"`;
          }
          const ts = store.getTimestamp(fullKey) || store.getTimestamp(key);
          const staleness = assessStaleness(fullKey, val, ts);

          const content = `Memory[${fullKey}]:\n${val}`;
          if (!staleness) {
            return { status: 'ok', content } satisfies Observation;
          }
          // Attach risk metadata so LLM can see the warning in a structured way
          return {
            status: 'ok',
            content,
            metadata: { staleness_risk: staleness },
          } satisfies Observation;
        }

        // -------------------------------------------------------------------
        // write
        // -------------------------------------------------------------------
        case 'write': {
          if (!key) return 'Error: key is required for write operation';
          if (value === undefined) return 'Error: value is required for write operation';
          const { warning } = await store.set(key, value, category);
          const saved = `Saved memory entry "${MemoryStore.buildKey(key, category)}"`;
          return warning ? `${saved}\n${warning}` : saved;
        }

        // -------------------------------------------------------------------
        // delete
        // -------------------------------------------------------------------
        case 'delete': {
          if (!key) return 'Error: key is required for delete operation';
          const existed = await store.delete(key, category);
          return existed
            ? `Deleted memory entry "${MemoryStore.buildKey(key, category)}"`
            : `No memory entry found for key: "${key}"`;
        }

        // -------------------------------------------------------------------
        // list
        // -------------------------------------------------------------------
        case 'list': {
          const entries = await store.list(category);
          if (entries.length === 0) {
            return category ? `No entries in category "${category}".` : 'Memory is empty.';
          }
          return entries
            .map((e, i) => {
              const catTag = e.category ? ` [${e.category}]` : '';
              return `${i + 1}. ${e.key}${catTag}: ${e.preview}`;
            })
            .join('\n');
        }

        // -------------------------------------------------------------------
        // search — keyword retrieval, no need for read_all
        // -------------------------------------------------------------------
        case 'search': {
          if (!query) return 'Error: query is required for search operation';
          const results = await store.search(query, { category, limit });
          if (results.length === 0) {
            return `No memory entries matched query: "${query}"` +
              (category ? ` in category "${category}"` : '');
          }
          const lines = results.map((r, i) => {
            const risk = r.staleness ? ` ⚠️ [${r.staleness.level}]` : '';
            const catTag = r.category ? ` [${r.category}]` : '';
            return `${i + 1}. ${r.key}${catTag}${risk} (score=${r.score})\n   ${r.preview}` +
              (r.staleness ? `\n   ↳ ${r.staleness.hint}` : '');
          });
          return lines.join('\n\n');
        }

        // -------------------------------------------------------------------
        // read_all
        // -------------------------------------------------------------------
        case 'read_all': {
          return store.readAll(category);
        }

        // -------------------------------------------------------------------
        // stats
        // -------------------------------------------------------------------
        case 'stats': {
          const s = await store.stats();
          const catLines = Object.entries(s.categories)
            .map(([c, n]) => `  ${c}: ${n}`)
            .join('\n');
          return [
            `Memory stats:`,
            `  Total entries: ${s.entries}`,
            `  File size: ${Math.round(s.fileSizeBytes / 1024)}KB`,
            `  By category:\n${catLines}`,
          ].join('\n');
        }

        // -------------------------------------------------------------------
        // Layer 2: Topic file operations
        // -------------------------------------------------------------------

        case 'list_topics': {
          const ts     = getTopicStore(context.metadata?.['topicDir'] as string | undefined);
          const topics = await ts.listTopics();
          if (topics.length === 0) return 'No topic files found. Create one with write_topic.';
          return topics
            .map((t) => {
              const tag  = t.isBuiltIn ? ' [built-in]' : ' [custom]';
              const size = Math.round(t.fileSizeBytes / 1024);
              return `${t.name}${tag}: ${t.entryCount} entries, ${size}KB — ${t.filePath}`;
            })
            .join('\n');
        }

        case 'read_topic': {
          if (!topic) return 'Error: topic is required for read_topic';
          const ts = getTopicStore(context.metadata?.['topicDir'] as string | undefined);
          const content = await ts.readTopic(topic);
          return content || `Topic "${topic}" is empty or does not exist.`;
        }

        case 'write_topic': {
          if (!topic) return 'Error: topic is required for write_topic';
          if (!key)   return 'Error: key is required for write_topic';
          if (value === undefined) return 'Error: value is required for write_topic';
          const ts = getTopicStore(context.metadata?.['topicDir'] as string | undefined);
          const { warning } = await ts.write(topic, key, value);
          const saved = `Saved "${key}" to topic "${topic}"`;
          return warning ? `${saved}\n${warning}` : saved;
        }

        case 'search_topics': {
          if (!query) return 'Error: query is required for search_topics';
          const ts      = getTopicStore(context.metadata?.['topicDir'] as string | undefined);
          const results = await ts.searchAll(query, limit ?? 10);
          if (results.length === 0) return `No results across topic files for: "${query}"`;
          return results
            .map((r, i) => {
              const risk = r.staleness ? ` ⚠️ [${r.staleness.level}]` : '';
              return (
                `${i + 1}. [${r.topic}] ${r.key}${risk} (score=${r.score})\n` +
                `   ${r.preview}` +
                (r.staleness ? `\n   ↳ ${r.staleness.hint}` : '')
              );
            })
            .join('\n\n');
        }

        // -------------------------------------------------------------------
        // Layer 3: Session log operations
        // -------------------------------------------------------------------

        case 'session_search': {
          if (!query) return 'Error: query is required for session_search';
          const sessionDir = context.metadata?.['sessionDir'] as string | undefined;
          const results    = await searchSessionLogs(query, { sessionDir, limit: limit ?? 10 });
          if (results.length === 0) return `No session log entries matched: "${query}"`;
          return results
            .map((r, i) => {
              const when = new Date(r.ts).toLocaleString();
              const src  = r.source === 'tool' ? `[tool:${r.toolName}]` : '[assistant]';
              return `${i + 1}. ${when} | agent:${r.agentId} | iter:${r.iteration} ${src} (score=${r.score})\n   ${r.snippet}`;
            })
            .join('\n\n');
        }

        case 'session_recent': {
          const sessionDir = context.metadata?.['sessionDir'] as string | undefined;
          const entries    = await getRecentSessionLogs({ sessionDir, limit: limit ?? 20 });
          if (entries.length === 0) return 'No session logs found.';
          return entries
            .map((e, i) => {
              const when  = new Date(e.ts).toLocaleString();
              const tools = e.toolCalls.map((tc) => tc.name).join(', ') || 'none';
              const text  = e.assistantText.slice(0, 120) + (e.assistantText.length > 120 ? '…' : '');
              return `${i + 1}. ${when} | agent:${e.agentId} | iter:${e.iteration}\n   ${text}\n   tools: ${tools}`;
            })
            .join('\n\n');
        }

        default:
          return `Unknown operation: "${operation}". Valid operations: read, write, delete, list, search, read_all, stats, list_topics, read_topic, write_topic, search_topics, session_search, session_recent`;
      }
    },
  },
];

// Register memory tools
registerTools(memoryTools);

export default memoryTools;
