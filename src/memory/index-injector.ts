/**
 * Memory Layer 1 — Lightweight Index Injector
 *
 * Builds a compact memory directory and injects it as a user+assistant message
 * pair near the start of every AgentRuntime.run() call.
 *
 * The LLM sees which keys exist (with one-line previews) without loading any
 * full content. This enables on-demand pull: the agent knows what to request
 * via read/search without needing a read_all dump.
 *
 * Design constraints:
 *   • Max 50 entries shown in the index (configurable) — never floods context
 *   • Max 80 chars per preview line
 *   • Returns null (no injection) when memory is empty or unavailable
 *   • Only injected for root agents (depth=0) by default — children inherit
 *     the parent's context and don't need a redundant index
 */

import { getMemoryStore } from '../tools/memory-tool.js';
import { getTopicStore }   from './topic-store.js';
import type { Message }    from '../types.js';

// ---------------------------------------------------------------------------
// Configuration constants
// ---------------------------------------------------------------------------

const MAX_TOTAL_ENTRIES   = 50;
const MAX_PER_CATEGORY    = 12;
const MAX_PREVIEW_CHARS   = 80;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface MemoryIndexOptions {
  memoryPath?: string;
  topicDir?:   string;
}

/**
 * Build a [user, assistant] message pair containing the compact memory index.
 * Returns null if both flat memory and topic store are empty.
 */
export async function buildMemoryIndex(
  opts: MemoryIndexOptions = {},
): Promise<Message[] | null> {
  const sections: string[] = [];

  // ----- Flat memory (MEMORY.md) -------------------------------------------
  try {
    const store   = getMemoryStore(opts.memoryPath);
    const entries = await store.list();

    if (entries.length > 0) {
      const shown   = entries.slice(0, MAX_TOTAL_ENTRIES);
      const omitted = entries.length - shown.length;

      // Group by category
      const byCategory = new Map<string, typeof shown>();
      for (const e of shown) {
        const cat = e.category ?? 'uncategorized';
        if (!byCategory.has(cat)) byCategory.set(cat, []);
        byCategory.get(cat)!.push(e);
      }

      const catLines: string[] = [];
      for (const [cat, catEntries] of byCategory) {
        catLines.push(`${cat}:`);
        const slice = catEntries.slice(0, MAX_PER_CATEGORY);
        for (const e of slice) {
          const preview = e.preview.length > MAX_PREVIEW_CHARS
            ? e.preview.slice(0, MAX_PREVIEW_CHARS) + '…'
            : e.preview;
          catLines.push(`  • ${e.key}: ${preview}`);
        }
        if (catEntries.length > MAX_PER_CATEGORY) {
          catLines.push(`  • … ${catEntries.length - MAX_PER_CATEGORY} more`);
        }
      }
      if (omitted > 0) catLines.push(`(${omitted} more entries — use search)`);

      sections.push(
        `## Memory (${entries.length} entries)\n` + catLines.join('\n'),
      );
    }
  } catch { /* memory not available — skip */ }

  // ----- Topic files (Layer 2) ---------------------------------------------
  try {
    const ts     = getTopicStore(opts.topicDir);
    const topics = await ts.listTopics();

    if (topics.length > 0) {
      const topicLines = topics.map(
        (t) => `  • ${t.name}${t.isBuiltIn ? '' : ' [custom]'}: ${t.entryCount} entries`,
      );
      sections.push(
        `## Topic Files (${topics.length} topics)\n` + topicLines.join('\n'),
      );
    }
  } catch { /* topic dir not available — skip */ }

  if (sections.length === 0) return null;

  const body = [
    '[Memory Index]',
    ...sections,
    '',
    'Instructions: use memory({operation:"search",query:"…"}) to find relevant entries, ' +
    'memory({operation:"read",key:"…"}) for a single entry, ' +
    'memory({operation:"read_topic",topic:"…"}) to load an entire topic file, ' +
    'or memory({operation:"session_search",query:"…"}) to search past session logs.',
  ].join('\n');

  return [
    { role: 'user',      content: body },
    {
      role: 'assistant',
      content:
        'Memory index loaded. I will use targeted reads and search rather than reading everything at once.',
    },
  ];
}
