/**
 * @hermes/runtime — Three-Layer Memory System
 *
 * Layer 1 (index-injector): compact directory auto-injected into every run()
 * Layer 2 (topic-store):    per-topic markdown files, loaded on demand
 * Layer 3 (session-log):    persistent JSONL logs, accessible via search only
 */

export { buildMemoryIndex }            from './index-injector.js';
export type { MemoryIndexOptions }     from './index-injector.js';

export { TopicStore, getTopicStore, DEFAULT_TOPIC_DIR, COMMON_TOPICS } from './topic-store.js';
export type { TopicMeta, TopicSearchResult } from './topic-store.js';

export {
  SessionLogger,
  searchSessionLogs,
  getRecentSessionLogs,
  DEFAULT_SESSION_DIR,
} from './session-log.js';
export type { SessionLogEntry, SessionSearchResult } from './session-log.js';
