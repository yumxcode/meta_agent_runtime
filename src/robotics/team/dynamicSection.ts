import {
  DANGEROUS_uncachedSystemPromptSection,
  type SystemPromptSection,
} from '../../core/systemPromptSections.js'
import type { TeamStore } from './TeamStore.js'
import type { TeamWatcher } from './TeamWatcher.js'

export function buildTeamSection(teamStore: TeamStore, teamWatcher?: TeamWatcher): SystemPromptSection {
  return DANGEROUS_uncachedSystemPromptSection(
    'robotics_team_mode',
    async () => {
      try {
        const base = await teamStore.formatPromptContext()
        const watcher = teamWatcher?.formatPromptContext()
        return [base, watcher].filter(Boolean).join('\n\n') || null
      } catch {
        return null
      }
    },
    'Team board ownership and GitHub-backed coordination state may change between turns.',
  )
}
