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
import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
// ─────────────────────────────────────────────────────────────────────────────
const SESSIONS_ROOT = join(homedir(), '.meta-agent', 'sessions');
const INDEX_FILE = join(SESSIONS_ROOT, 'index.json');
const MAX_INDEX_ENTRIES = 50; // keep last 50 sessions in the index
// ── Helpers ──────────────────────────────────────────────────────────────────
function sessionDir(sessionId) {
    return join(SESSIONS_ROOT, sessionId);
}
function historyPath(sessionId) {
    return join(sessionDir(sessionId), 'history.jsonl');
}
async function ensureDir(dir) {
    await mkdir(dir, { recursive: true });
}
async function readIndex() {
    try {
        const raw = await readFile(INDEX_FILE, 'utf-8');
        return JSON.parse(raw);
    }
    catch {
        return [];
    }
}
async function writeIndex(entries) {
    await ensureDir(SESSIONS_ROOT);
    await writeFile(INDEX_FILE, JSON.stringify(entries, null, 2), 'utf-8');
}
// ── SessionStore ──────────────────────────────────────────────────────────────
export class SessionStore {
    /**
     * Append a batch of new messages to the session's history file.
     * Idempotent: only messages after `appendFrom` index are written.
     *
     * @param sessionId    UUID of the session.
     * @param meta         Metadata to update in the index.
     * @param messages     Full current message list.
     * @param appendFrom   Index of the first NEW message (skip already-written ones).
     */
    static async append(sessionId, meta, messages, appendFrom) {
        if (messages.length === 0 || appendFrom >= messages.length)
            return;
        try {
            await ensureDir(sessionDir(sessionId));
            const lines = messages
                .slice(appendFrom)
                .map(m => JSON.stringify(m))
                .join('\n') + '\n';
            await appendFile(historyPath(sessionId), lines, 'utf-8');
            await SessionStore._upsertIndex({ sessionId, ...meta });
        }
        catch {
            // Best-effort — never crash the session on a storage failure
        }
    }
    /**
     * Load the full conversation history for a session.
     * Returns [] if the history file doesn't exist.
     */
    static async loadHistory(sessionId) {
        try {
            const raw = await readFile(historyPath(sessionId), 'utf-8');
            return raw
                .split('\n')
                .filter(Boolean)
                .map(line => JSON.parse(line));
        }
        catch {
            return [];
        }
    }
    /**
     * Return the session index, newest first.
     * @param limit  Maximum number of entries to return (default: 10).
     */
    static async listSessions(limit = 10) {
        const index = await readIndex();
        return index.slice(0, limit);
    }
    /**
     * Check whether a session directory exists (quick existence check).
     */
    static sessionExists(sessionId) {
        return existsSync(historyPath(sessionId));
    }
    // ── Private ────────────────────────────────────────────────────────────────
    static async _upsertIndex(meta) {
        const entries = await readIndex();
        const idx = entries.findIndex(e => e.sessionId === meta.sessionId);
        if (idx >= 0) {
            entries[idx] = meta;
        }
        else {
            entries.unshift(meta);
        }
        // Keep index bounded
        const trimmed = entries.slice(0, MAX_INDEX_ENTRIES);
        // Sort newest-first by lastActivity
        trimmed.sort((a, b) => b.lastActivity - a.lastActivity);
        await writeIndex(trimmed);
    }
}
//# sourceMappingURL=SessionStore.js.map