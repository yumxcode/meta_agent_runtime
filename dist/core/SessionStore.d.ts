/**
 * SessionStore — persistent conversation history for session resume.
 *
 * Storage layout under ~/.meta-agent/sessions/:
 *   index.json                           — list of all sessions (newest first)
 *   <sessionId>/history.jsonl            — newline-delimited ConversationMessage records
 *
 * Design decisions:
 *   - JSONL (append-only) for history so every message is written atomically
 *     without rewriting the entire conversation on each turn.
 *   - The index is rewritten on each save (small, bounded by MAX_INDEX_ENTRIES).
 *   - All I/O is best-effort: errors are swallowed so a disk failure never
 *     crashes the CLI session in progress.
 */
import type { ConversationMessage } from './types.js';
export interface SessionMeta {
    sessionId: string;
    mode: string;
    startTime: number;
    lastActivity: number;
    messageCount: number;
    /** First ~80 chars of the first user prompt — shown in the session picker. */
    firstPrompt: string;
    workspace?: string;
}
export interface SessionListOptions {
    workspace?: string;
}
export declare class SessionStore {
    /**
     * Append a batch of new messages to the session's history file.
     * Idempotent: only messages after `appendFrom` index are written.
     *
     * @param sessionId    UUID of the session.
     * @param meta         Metadata to update in the index.
     * @param messages     Full current message list.
     * @param appendFrom   Index of the first NEW message (skip already-written ones).
     */
    static append(sessionId: string, meta: Omit<SessionMeta, 'sessionId'>, messages: readonly ConversationMessage[], appendFrom: number): Promise<void>;
    /**
     * Load the full conversation history for a session.
     * Returns [] if the history file doesn't exist.
     */
    static loadHistory(sessionId: string): Promise<ConversationMessage[]>;
    /**
     * Return the session index, newest first.
     * @param limit  Maximum number of entries to return (default: 10).
     */
    static listSessions(limit?: number, options?: SessionListOptions): Promise<SessionMeta[]>;
    /**
     * Return one session metadata record by ID, or null if it is not indexed.
     */
    static getSession(sessionId: string): Promise<SessionMeta | null>;
    /**
     * Check whether a session directory exists (quick existence check).
     */
    static sessionExists(sessionId: string): boolean;
    /**
     * Delete a single session: remove from index + delete its directory.
     */
    static deleteSession(sessionId: string): Promise<void>;
    /**
     * Delete ALL sessions: clear index + remove every session directory.
     */
    static deleteAllSessions(): Promise<void>;
    private static _upsertIndex;
}
//# sourceMappingURL=SessionStore.d.ts.map