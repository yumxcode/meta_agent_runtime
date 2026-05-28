import { existsSync, readFileSync } from 'fs';
import { createHash } from 'crypto';
import { homedir } from 'os';
import { join } from 'path';
import { WorkflowParser } from './WorkflowParser.js';
function sha256(raw) {
    return createHash('sha256').update(raw).digest('hex');
}
function parseAttrs(raw) {
    const attrs = {};
    const re = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>/]+))/g;
    let m;
    while ((m = re.exec(raw)) !== null) {
        attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
    }
    return attrs;
}
function stripMarkdownFence(raw) {
    const trimmed = raw.trim();
    const m = trimmed.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i);
    return m ? m[1].trim() : trimmed;
}
function definitionHash(def) {
    return sha256(JSON.stringify({
        mode: def.mode,
        version: def.version,
        title: def.title,
        globalContext: def.globalContext,
        phases: def.phases.map(p => ({
            id: p.id,
            chineseName: p.chineseName,
            englishName: p.englishName,
            content: p.content,
            gateItems: p.gateItems.map(g => ({
                type: g.type,
                description: g.description,
                completed: g.completed,
            })),
            outputs: p.outputs,
        })),
    }));
}
export class WorkflowLoader {
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
    static load(mode, projectDir) {
        const source = WorkflowLoader.discover(mode, projectDir);
        return source ? WorkflowLoader.parseSource(mode, source) : null;
    }
    static async loadWithRepair(mode, projectDir, repairer) {
        const source = WorkflowLoader.discover(mode, projectDir);
        if (!source)
            return null;
        const parsed = WorkflowLoader.parseSource(mode, source);
        if (parsed || !repairer)
            return parsed;
        const repaired = await repairer({
            mode,
            sourceFile: source.sourceFile,
            sourceKind: source.sourceKind,
            content: source.content,
        });
        if (!repaired)
            return null;
        return WorkflowLoader.parseSource(mode, {
            ...source,
            content: stripMarkdownFence(repaired),
        });
    }
    static discover(mode, projectDir) {
        const projectWorkflow = WorkflowLoader.readWorkflowFile(join(projectDir, '.meta-agent', 'workflows', `${mode}.md`));
        if (projectWorkflow)
            return projectWorkflow;
        for (const path of [
            join(projectDir, '.meta-agent', 'AGENT.md'),
            join(projectDir, 'AGENT.md'),
        ]) {
            const source = WorkflowLoader.readAgentWorkflowBlock(path, mode);
            if (source)
                return source;
        }
        const globalWorkflow = WorkflowLoader.readWorkflowFile(join(homedir(), '.meta-agent', 'workflows', `${mode}.md`));
        if (globalWorkflow)
            return globalWorkflow;
        return WorkflowLoader.readAgentWorkflowBlock(join(homedir(), '.meta-agent', 'AGENT.md'), mode);
    }
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
    static loadRaw(projectDir) {
        const candidates = [
            join(projectDir, '.meta-agent', 'AGENT.md'),
            join(projectDir, 'AGENT.md'),
            join(homedir(), '.meta-agent', 'AGENT.md'),
        ];
        const found = candidates.find(p => existsSync(p));
        if (!found)
            return null;
        try {
            return readFileSync(found, 'utf-8');
        }
        catch {
            return null;
        }
    }
    static loadAgentDirectives(projectDir) {
        const raw = WorkflowLoader.loadRaw(projectDir);
        if (!raw)
            return null;
        const stripped = WorkflowLoader.stripMetaWorkflowBlocks(raw).trim();
        return stripped ? stripped : null;
    }
    static stripMetaWorkflowBlocks(raw) {
        return raw.replace(/<META-WORKFLOW\b[^>]*>[\s\S]*?<\/META-WORKFLOW>/gi, '').trim();
    }
    static parseSource(mode, source) {
        try {
            const def = WorkflowParser.parse(source.content, source.sourceFile);
            if (def.phases.length === 0)
                return null;
            const parsedMode = def.mode === 'unknown' ? mode : def.mode;
            if (parsedMode !== mode)
                return null;
            return {
                ...def,
                mode: parsedMode,
                sourceKind: source.sourceKind,
                workflowBlockHash: sha256(source.hashBasis),
                workflowDefinitionHash: definitionHash({ ...def, mode: parsedMode }),
            };
        }
        catch {
            return null;
        }
    }
    static readWorkflowFile(path) {
        if (!existsSync(path))
            return null;
        try {
            const raw = readFileSync(path, 'utf-8');
            return {
                sourceFile: path,
                sourceKind: 'workflow_file',
                content: raw,
                hashBasis: raw,
            };
        }
        catch {
            return null;
        }
    }
    static readAgentWorkflowBlock(path, mode) {
        if (!existsSync(path))
            return null;
        try {
            const raw = readFileSync(path, 'utf-8');
            const block = WorkflowLoader.extractMetaWorkflowBlocks(raw)
                .find(b => !b.attrs.mode || b.attrs.mode === mode);
            if (!block)
                return null;
            return {
                sourceFile: path,
                sourceKind: 'agent_tag',
                content: block.content.trim(),
                hashBasis: block.fullText,
            };
        }
        catch {
            return null;
        }
    }
    static extractMetaWorkflowBlocks(raw) {
        const blocks = [];
        const re = /<META-WORKFLOW\b([^>]*)>([\s\S]*?)<\/META-WORKFLOW>/gi;
        let m;
        while ((m = re.exec(raw)) !== null) {
            blocks.push({
                attrs: parseAttrs(m[1] ?? ''),
                content: m[2] ?? '',
                fullText: m[0],
            });
        }
        return blocks;
    }
}
//# sourceMappingURL=WorkflowLoader.js.map