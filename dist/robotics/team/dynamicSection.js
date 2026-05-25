import { DANGEROUS_uncachedSystemPromptSection, } from '../../core/systemPromptSections.js';
export function buildTeamSection(teamStore, teamWatcher) {
    return DANGEROUS_uncachedSystemPromptSection('robotics_team_mode', async () => {
        try {
            const base = await teamStore.formatPromptContext();
            const watcher = teamWatcher?.formatPromptContext();
            return [base, watcher].filter(Boolean).join('\n\n') || null;
        }
        catch {
            return null;
        }
    }, 'Team board ownership and GitHub-backed coordination state may change between turns.');
}
//# sourceMappingURL=dynamicSection.js.map