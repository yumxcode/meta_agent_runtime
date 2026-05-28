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