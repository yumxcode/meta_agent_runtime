import type { WorkflowDefinition } from './types.js';
export declare class WorkflowLoader {
    static load(mode: string, projectDir: string): WorkflowDefinition | null;
    static discover(mode: string, projectDir: string): string | null;
    /**
     * Load the raw Markdown content of the project's AGENT.md file.
     *
     * Searches in priority order:
     *   1. <projectDir>/.meta-agent/AGENT.md
     *   2. <projectDir>/AGENT.md
     *   3. ~/.meta-agent/AGENT.md
     *
     * Returns null when no AGENT.md is found or the file cannot be read.
     * Use this instead of reimplementing the discovery cascade in each caller.
     */
    static loadRaw(projectDir: string): string | null;
}
//# sourceMappingURL=WorkflowLoader.d.ts.map