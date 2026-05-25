/**
 * Echo tool — reference implementation of the tool-folder convention.
 *
 * File layout (required for every tool):
 *
 *   src/tools/echo/
 *   ├── prompt.md   ← authoritative description, read at startup
 *   └── index.ts    ← this file: schema + call() implementation
 *
 * Do NOT inline the description as a string literal here.
 * Edit prompt.md instead — it stays readable and diffable.
 */
import type { MetaAgentTool } from '../../core/types.js';
export declare function createEchoTool(): Promise<MetaAgentTool>;
//# sourceMappingURL=index.d.ts.map