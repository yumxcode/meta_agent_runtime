// Re-export shim — ExperienceStore moved to neutral infra (infra/knowledge) so
// it's no longer a robotics-package dependency for auto mode. The data location
// and API are unchanged. See architecture-review-2026-06-18.md §5.1 (#2b).
export * from '../infra/knowledge/ExperienceStore.js'
