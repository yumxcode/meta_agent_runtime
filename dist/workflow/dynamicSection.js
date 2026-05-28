import { systemPromptSection } from '../core/systemPromptSections.js';
function formatAge(ms) {
    const diff = Date.now() - ms;
    if (diff < 60_000)
        return 'just now';
    if (diff < 3_600_000)
        return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000)
        return `${Math.floor(diff / 3_600_000)}h ago`;
    return `${Math.floor(diff / 86_400_000)}d ago`;
}
export function buildW1Section(definition, getState) {
    return systemPromptSection('workflow_phase', () => {
        const state = getState();
        if (!state)
            return null;
        const currentPhase = definition.phases.find(p => p.id === state.currentPhaseId);
        if (!currentPhase)
            return null;
        const phaseNum = currentPhase.index + 1;
        const phaseTot = definition.phases.length;
        const nextPhase = definition.phases[currentPhase.index + 1];
        const completed = new Set(state.completedGateItems);
        const gates = currentPhase.gateItems.map(g => ({ ...g, completed: completed.has(g.id) }));
        const allRequiredDone = gates.filter(g => g.type === 'REQUIRED').every(g => g.completed);
        const gateLines = gates.map(g => {
            const check = g.completed ? '[x]' : '[ ]';
            const status = g.completed ? 'DONE' : g.type;
            return `- ${check} ${status}: ${g.description}`;
        });
        // Phase content (objectives, focus, procedure) lives in AGENT.md → already
        // loaded by D1c.  W1 only surfaces runtime execution state: current position,
        // gate progress, and the advance prompt — not the definition text.
        const lines = [
            `## Workflow Status: ${definition.title}`,
            `*Phase ${phaseNum} / ${phaseTot} — ${currentPhase.chineseName} (${currentPhase.englishName}) — entered ${formatAge(state.currentPhaseEnteredAt)}*`,
            '',
            `### Gate Criteria`,
            ...gateLines,
            '',
        ];
        if (!nextPhase) {
            lines.push(allRequiredDone ? '> ✅ All gates met. This is the final phase.' : '> ⚠ Complete remaining gates.');
        }
        else if (allRequiredDone) {
            lines.push(`> ✅ All REQUIRED gates met. Ready to advance to **${nextPhase.chineseName}**.`, '> Run `workflow_advance` when ready.');
        }
        else {
            const rem = gates.filter(g => g.type === 'REQUIRED' && !g.completed).length;
            lines.push(`> ⚠ ${rem} REQUIRED gate(s) remain. Run \`workflow_complete_gate <gateId>\` when met.`);
        }
        if (nextPhase) {
            // Only name the next phase — its full content is already in AGENT.md / D1c.
            lines.push('', `> **Next**: ${nextPhase.chineseName} (${nextPhase.englishName})`);
        }
        return lines.join('\n');
    });
}
//# sourceMappingURL=dynamicSection.js.map