/**
 * DebugWriter — writes LLM request + response chunks to disk for debug mode.
 *
 * File layout:
 *   ~/.meta-agent/debug/<sessionId>/<ISO-timestamp>-<model>.jsonl
 *
 * Each file is newline-delimited JSON (JSONL):
 *   Line 0 : { "type": "request", "ts": <iso>, "payload": { ...req params (no apiKey) } }
 *   Line 1 : { "type": "done",    "ts": <iso> }
 *
 * Usage:
 *   const writer = await DebugWriter.open(sessionId, model, debug)
 *   await writer.writeRequest(reqParams)
 *   await writer.close()
 */
/**
 * S4: Best-effort cleanup of stale debug data.
 *
 * Two passes:
 *   1. Age pass — any session directory whose newest file is older than
 *      `ttlMs` (default 14 days) is removed in full.
 *   2. Size pass — within each surviving session directory, if total size
 *      exceeds `sessionSizeCapBytes`, the oldest `.jsonl` files are removed
 *      until under cap.
 *
 * Both passes swallow every error: this runs from session shutdown paths
 * where I/O failures must never block the host.  Returns a summary so
 * callers can log it if desired.
 */
export interface DebugPurgeOptions {
    /** Sessions whose newest file is older than this are deleted. */
    ttlMs?: number;
    /** Per-session-directory size cap (bytes). */
    sessionSizeCapBytes?: number;
    /** Override the debug root (mostly for tests). */
    rootDir?: string;
}
export interface DebugPurgeSummary {
    scannedSessions: number;
    removedSessions: number;
    trimmedFiles: number;
    bytesFreed: number;
}
export declare function pruneStaleDebug(options?: DebugPurgeOptions): Promise<DebugPurgeSummary>;
export declare class DebugWriter {
    private readonly fh;
    private constructor();
    /** Open (create) a new debug file for one LLM call. Returns null when debug is disabled. */
    static open(sessionId: string | undefined, model: string, debug: boolean | undefined): Promise<DebugWriter | null>;
    /** Write the full request payload (apiKey is stripped for safety). */
    writeRequest(payload: Record<string, unknown>): Promise<void>;
    /** Write a done sentinel and close the file handle. */
    close(): Promise<void>;
}
//# sourceMappingURL=DebugWriter.d.ts.map