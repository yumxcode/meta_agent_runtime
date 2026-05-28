import type { WorkflowDefinition, WorkflowRepairer } from './types.js';
export declare class WorkflowLoader {
    /**
     * Load an explicit workflow definition.
     *
     * Workflow activation is opt-in:
     *   1. <projectDir>/.meta-agent/workflows/<mode>.md
     *   2. <projectDir>/.meta-agent/AGENT.md with a <META-WORKFLOW> block
     *   3. <projectDir>/AGENT.md with a <META-WORKFLOW> block
     *   4. ~/.meta-agent/workflows/<mode>.md
     *   5. ~/.meta-agent/AGENT.md with a <META-WORKFLOW> block
     *
     * Plain AGENT.md remains soft guidance only and never creates workflow state.
     */
    static load(mode: string, projectDir: string): WorkflowDefinition | null;
    static loadWithRepair(mode: string, projectDir: string, repairer?: WorkflowRepairer): Promise<WorkflowDefinition | null>;
    private static discover;
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
    static loadAgentDirectives(projectDir: string): string | null;
    static stripMetaWorkflowBlocks(raw: string): string;
    private static parseSource;
    private static readWorkflowFile;
    private static readAgentWorkflowBlock;
    private static extractMetaWorkflowBlocks;
}
//# sourceMappingURL=WorkflowLoader.d.ts.map