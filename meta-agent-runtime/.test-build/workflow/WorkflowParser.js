export class WorkflowParser {
    static parse(raw, sourceFile) {
        const lines = raw.split('\n');
        const modeMatch = raw.match(/Mode:\s*(\S+)/);
        const verMatch = raw.match(/Version:\s*(\S+)/);
        const titleMatch = raw.match(/^#\s+(.+)$/m);
        const mode = modeMatch?.[1] ?? 'unknown';
        const version = verMatch?.[1] ?? '1.0';
        const title = titleMatch?.[1] ?? 'Workflow';
        const phaseHeaderRe = /^## Phase:\s*(\S+)\s*\|\s*(.+?)\s*\|\s*(.+)$/;
        const phaseStarts = [];
        lines.forEach((line, i) => { if (phaseHeaderRe.test(line))
            phaseStarts.push(i); });
        const firstPhaseStart = phaseStarts[0] ?? lines.length;
        const globalContext = lines.slice(1, firstPhaseStart).join('\n').trim();
        const phases = phaseStarts.map((start, idx) => {
            const end = phaseStarts[idx + 1] ?? lines.length;
            const m = lines[start].match(phaseHeaderRe);
            const [, id, chineseName, englishName] = m;
            const content = lines.slice(start + 1, end).join('\n');
            const gateRe = /^- \[([ x])\] (REQUIRED|APPROVAL|SUGGESTED):\s*(.+)$/;
            const gateItems = [];
            let gateIndex = 0;
            const outputs = [];
            let inOutputs = false;
            for (const line of content.split('\n')) {
                const gm = line.match(gateRe);
                if (gm) {
                    gateItems.push({ id: `${id}_gate_${gateIndex++}`, type: gm[2], description: gm[3].trim(), completed: gm[1] === 'x' });
                    continue;
                }
                if (/^### Outputs/.test(line)) {
                    inOutputs = true;
                    continue;
                }
                if (/^###/.test(line)) {
                    inOutputs = false;
                    continue;
                }
                if (inOutputs && /^- /.test(line))
                    outputs.push(line.replace(/^- /, '').trim());
            }
            return { id, chineseName, englishName, index: idx, content, gateItems, outputs };
        });
        return { mode, version, title, globalContext, phases, sourceFile };
    }
}
//# sourceMappingURL=WorkflowParser.js.map