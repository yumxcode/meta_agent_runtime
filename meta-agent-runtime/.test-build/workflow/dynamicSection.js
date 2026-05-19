import { DANGEROUS_uncachedSystemPromptSection } from '../core/systemPromptSections.js';
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
    return DANGEROUS_uncachedSystemPromptSection('workflow_phase', () => {
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
        const lines = [
            `## Workflow: ${definition.title}`,
            `*Phase ${phaseNum} / ${phaseTot} — entered ${formatAge(state.currentPhaseEnteredAt)}*`,
            '',
            `### Current Phase: ${currentPhase.chineseName} (${currentPhase.englishName})`,
            '',
        ];
        // inject first 25 lines of phase content
        const contentLines = currentPhase.content.split('\n').slice(0, 25);
        lines.push(...contentLines, '', '### Gate Criteria', ...gateLines, '');
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
            lines.push('', `### Next Phase Preview: ${nextPhase.chineseName} (${nextPhase.englishName})`);
            const focusM = nextPhase.content.match(/### Focus\n([\s\S]+?)(?=\n###|$)/);
            if (focusM)
                lines.push(...focusM[1].trim().split('\n').slice(0, 3));
        }
        return lines.join('\n');
    }, 'Gate completion and phase advancement happen mid-session; stale phase info causes incorrect gating decisions.');
}
//# sourceMappingURL=dynamicSection.js.map