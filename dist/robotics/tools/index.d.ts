/**
 * Robotics tool factory — creates all robotics-mode tools and bundles them.
 *
 * Exported factory: createRoboticsTools(opts) → MetaAgentTool[]
 *
 * Tool inventory (12 tools):
 *   Experience:
 *     experience_search   — search the experience store (isConcurrencySafe)
 *     experience_write    — propose a new pending experience entry
 *     experience_load     — load full experience by ID (isConcurrencySafe)
 *
 *   Hardware:
 *     hardware_profile_read   — read hardware profile (isConcurrencySafe)
 *     hardware_profile_write  — create/update hardware profile
 *     physical_anchor_search  — search physical/device facts (isConcurrencySafe)
 *     physical_anchor_write   — persist a physical/device fact
 *     physical_anchor_load    — load full physical anchor by ID (isConcurrencySafe)
 *
 *   Sub-agents:
 *     experiment_dispatch — spawn an ExperimentAgent sub-agent
 *     paper_search        — spawn a PaperSearchAgent sub-agent
 *
 *   Project state:
 *     progress_note       — write a session progress note
 *
 *   Git coordination (only registered when git is enabled):
 *     git_sync_to_subagent  — rebase sub-agent branch onto main
 *     git_merge_subagent    — merge sub-agent branch into main
 *     git_diff_subagent     — diff sub-agent vs main (isConcurrencySafe)
 *     git_discard_subagent  — discard sub-agent branch / worktree
 */
import type { MetaAgentTool } from '../../core/types.js';
import type { SubAgentBridge } from '../../subagent/SubAgentBridge.js';
import type { FlashClient } from '../../core/flash/FlashClient.js';
import { ExperienceStore } from '../ExperienceStore.js';
import { ExperiencePendingStore } from '../ExperiencePendingStore.js';
import { PhysicalAnchorStore } from '../PhysicalAnchorStore.js';
import { PhysicalAnchorPendingStore } from '../PhysicalAnchorPendingStore.js';
import { HardwareProfile } from '../HardwareProfile.js';
import { GitWorkspaceManager } from '../git/GitWorkspaceManager.js';
import { createExperienceSearchTool } from './experience_search/index.js';
import { createExperienceWriteTool } from './experience_write/index.js';
import { createExperienceLoadTool } from './experience_load/index.js';
import { createHardwareProfileReadTool } from './hardware_profile_read/index.js';
import { createHardwareProfileWriteTool } from './hardware_profile_write/index.js';
import { createPhysicalAnchorSearchTool } from './physical_anchor_search/index.js';
import { createPhysicalAnchorWriteTool } from './physical_anchor_write/index.js';
import { createPhysicalAnchorLoadTool } from './physical_anchor_load/index.js';
import { createExperimentDispatchTool } from './experiment_dispatch/index.js';
import { createPaperSearchTool } from './paper_search/index.js';
import { createProgressNoteTool } from './progress_note/index.js';
import { createGitSyncToSubAgentTool } from './git_sync_to_subagent/index.js';
import { createGitMergeSubAgentTool } from './git_merge_subagent/index.js';
import { createGitDiffSubAgentTool } from './git_diff_subagent/index.js';
import { createGitDiscardSubAgentTool } from './git_discard_subagent/index.js';
export { ExperiencePendingStore };
export { PhysicalAnchorPendingStore };
export { createExperienceSearchTool, createExperienceWriteTool, createExperienceLoadTool, createHardwareProfileReadTool, createHardwareProfileWriteTool, createPhysicalAnchorSearchTool, createPhysicalAnchorWriteTool, createPhysicalAnchorLoadTool, createExperimentDispatchTool, createPaperSearchTool, createProgressNoteTool, createGitSyncToSubAgentTool, createGitMergeSubAgentTool, createGitDiffSubAgentTool, createGitDiscardSubAgentTool, };
export interface RoboticsToolsOptions {
    /** Sub-agent bridge (required for experiment_dispatch, paper_search) */
    bridge: SubAgentBridge;
    /** Absolute path to the project directory (used by git tools and project store) */
    projectDir: string;
    /**
     * Storage session ID used for all RoboticsProjectStore reads/writes.
     * Fresh session: equals the current RoboticsSession.sessionId.
     * Resumed session: equals the original session's sessionId so progress notes
     * accumulate in the same bucket and are never mixed with other sessions.
     */
    sessionId: string;
    /** Optional robot name for hardware profile lookup */
    robot?: string;
    /** Optional custom ExperienceStore instance (for testing / custom dir) */
    experienceStore?: ExperienceStore;
    /**
     * Session-scoped pending experience buffer.
     * When provided, experience_write queues entries here instead of committing
     * directly to the shared store — requiring user review via `/experience review`.
     * If omitted (e.g. in tests), a transient pending store is used.
     */
    experiencePendingStore?: ExperiencePendingStore;
    /** Optional custom HardwareProfile instance */
    hardwareProfile?: HardwareProfile;
    /** Optional custom PhysicalAnchorStore instance */
    physicalAnchorStore?: PhysicalAnchorStore;
    /** Optional session-scoped pending physical anchor buffer. */
    physicalAnchorPendingStore?: PhysicalAnchorPendingStore;
    /** Optional custom GitWorkspaceManager instance */
    gitManager?: GitWorkspaceManager;
    /**
     * FlashClient for abstract principle extraction in experience_write.
     * When provided, a 3s flash call extracts a same-domain principle
     * at write time, enabling principle matching in ExperiencePatternChecker.
     */
    flashClient?: FlashClient;
}
/**
 * Create all robotics tools.
 *
 * Git tools are always included — they gracefully return an error message when
 * git is not enabled for the project (GitWorkspaceManager.enabled === false).
 */
export declare function createRoboticsTools(opts: RoboticsToolsOptions): MetaAgentTool[];
//# sourceMappingURL=index.d.ts.map