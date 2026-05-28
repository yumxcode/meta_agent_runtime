/**
 * ExperienceSource — IKnowledgeSource backed by the robotics ExperienceStore.
 *
 * listExperiences() returns recent entries filtered by domain (if provided),
 * sorted by recency. Both successes and failures are included — the caller's
 * LLM decides which principles apply via principle-level reasoning.
 */
import type { ExperienceStore } from '../../robotics/ExperienceStore.js';
import type { IKnowledgeSource, ExperienceMatch, ExperienceListOpts } from './IKnowledgeSource.js';
export declare class ExperienceSource implements IKnowledgeSource {
    private readonly store;
    constructor(store: ExperienceStore);
    listExperiences(opts?: ExperienceListOpts): Promise<ExperienceMatch[]>;
    getManifestLine(): Promise<string>;
}
//# sourceMappingURL=ExperienceSource.d.ts.map