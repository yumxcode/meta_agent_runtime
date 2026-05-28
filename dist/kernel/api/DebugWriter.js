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
import { homedir } from 'os';
import { join } from 'path';
import { mkdir, open } from 'fs/promises';
function isoNow() {
    return new Date().toISOString();
}
/** Sanitise model string for use in a filename (replace `/` and `:` etc.) */
function safeModel(model) {
    return model.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60);
}
export class DebugWriter {
    fh;
    constructor(fh) {
        this.fh = fh;
    }
    /** Open (create) a new debug file for one LLM call. Returns null when debug is disabled. */
    static async open(sessionId, model, debug) {
        if (!debug || !sessionId)
            return null;
        const dir = join(homedir(), '.meta-agent', 'debug', sessionId);
        await mkdir(dir, { recursive: true });
        const ts = isoNow().replace(/[:.]/g, '-');
        const filename = `${ts}-${safeModel(model)}.jsonl`;
        const filepath = join(dir, filename);
        const fh = await open(filepath, 'a');
        return new DebugWriter(fh);
    }
    /** Write the full request payload (apiKey is stripped for safety). */
    async writeRequest(payload) {
        // Strip sensitive fields
        const { apiKey: _apiKey, ...safe } = payload;
        void _apiKey;
        const line = JSON.stringify({ type: 'request', ts: isoNow(), payload: safe });
        await this.fh.write(line + '\n');
    }
    /** Write a done sentinel and close the file handle. */
    async close() {
        try {
            const line = JSON.stringify({ type: 'done', ts: isoNow() });
            await this.fh.write(line + '\n');
        }
        finally {
            await this.fh.close();
        }
    }
}
//# sourceMappingURL=DebugWriter.js.map