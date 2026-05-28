/**
 * IKnowledgeSource — abstraction over any domain knowledge store.
 *
 * ExperiencePatternChecker depends only on this interface, making it reusable
 * across all session modes:
 *
 *   Robotics  → ExperienceSource        (wraps ExperienceStore)
 *   Campaign  → CampaignLessonSource    (wraps campaign_lessons memory files)
 *   Agentic   → future implementation
 *
 * Design: listExperiences returns BOTH successes and failures.
 * Principle matching is done by the LLM caller — the source layer does not
 * pre-filter by outcome. Successes carry "replicate this pattern" principles;
 * failures carry "avoid this pitfall" principles. Both matter for reasoning.
 */
export {};
//# sourceMappingURL=IKnowledgeSource.js.map