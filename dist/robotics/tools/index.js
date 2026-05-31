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
 *     principle_search    — search reviewed transferable principles
 *     principle_promote   — queue a principle candidate from an experience
 *     principle_load      — load full principle by ID
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
import { ExperienceStore } from '../ExperienceStore.js';
import { ExperiencePendingStore } from '../ExperiencePendingStore.js';
import { PhysicalAnchorStore } from '../PhysicalAnchorStore.js';
import { PhysicalAnchorPendingStore } from '../PhysicalAnchorPendingStore.js';
import { PrincipleStore } from '../PrincipleStore.js';
import { PrinciplePendingStore } from '../PrinciplePendingStore.js';
import { HardwareProfile } from '../HardwareProfile.js';
import { GitWorkspaceManager } from '../git/GitWorkspaceManager.js';
import { createExperienceSearchTool } from './experience_search/index.js';
import { createExperienceWriteTool } from './experience_write/index.js';
import { createExperienceLoadTool } from './experience_load/index.js';
import { createPrincipleSearchTool } from './principle_search/index.js';
import { createPrinciplePromoteTool } from './principle_promote/index.js';
import { createPrincipleLoadTool } from './principle_load/index.js';
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
import { createSessionListTool, createSessionStarTool, createSessionTagTool, } from './session_manage/index.js';
export { ExperiencePendingStore };
export { PhysicalAnchorPendingStore };
export { PrinciplePendingStore };
export { createExperienceSearchTool, createExperienceWriteTool, createExperienceLoadTool, createPrincipleSearchTool, createPrinciplePromoteTool, createPrincipleLoadTool, createHardwareProfileReadTool, createHardwareProfileWriteTool, createPhysicalAnchorSearchTool, createPhysicalAnchorWriteTool, createPhysicalAnchorLoadTool, createExperimentDispatchTool, createPaperSearchTool, createProgressNoteTool, createGitSyncToSubAgentTool, createGitMergeSubAgentTool, createGitDiffSubAgentTool, createGitDiscardSubAgentTool, };
// ── Factory ───────────────────────────────────────────────────────────────────
/**
 * Create all robotics tools.
 *
 * Git tools are always included — they gracefully return an error message when
 * git is not enabled for the project (GitWorkspaceManager.enabled === false).
 */
export function createRoboticsTools(opts) {
    const store = opts.experienceStore ?? new ExperienceStore();
    // Use supplied pending store or fall back to a fresh one (tests / legacy callers)
    const pendingStore = opts.experiencePendingStore ?? new ExperiencePendingStore();
    const hwProfile = opts.hardwareProfile ?? new HardwareProfile(undefined, opts.robot);
    const physicalAnchors = opts.physicalAnchorStore ?? new PhysicalAnchorStore();
    const pendingPhysicalAnchors = opts.physicalAnchorPendingStore ?? new PhysicalAnchorPendingStore();
    const principles = opts.principleStore ?? new PrincipleStore();
    const pendingPrinciples = opts.principlePendingStore ?? new PrinciplePendingStore();
    const gitMgr = opts.gitManager ?? new GitWorkspaceManager(opts.projectDir);
    return [
        // ── Experience tools ─────────────────────────────────────────────────────
        createExperienceSearchTool(store),
        createExperienceWriteTool(store, pendingStore, opts.flashClient),
        createExperienceLoadTool(store),
        createPrincipleSearchTool(principles),
        createPrinciplePromoteTool(store, physicalAnchors, pendingPrinciples, opts.flashClient),
        createPrincipleLoadTool(principles),
        // ── Hardware profile tools ───────────────────────────────────────────────
        createHardwareProfileReadTool(hwProfile),
        createHardwareProfileWriteTool(hwProfile),
        createPhysicalAnchorSearchTool(physicalAnchors),
        createPhysicalAnchorWriteTool(pendingPhysicalAnchors),
        createPhysicalAnchorLoadTool(physicalAnchors),
        // ── Sub-agent dispatchers ────────────────────────────────────────────────
        createExperimentDispatchTool(opts.bridge, gitMgr, opts.projectDir, opts.sessionId),
        createPaperSearchTool(opts.bridge, opts.projectDir, opts.sessionId),
        // ── Project state ────────────────────────────────────────────────────────
        createProgressNoteTool(opts.projectDir, opts.sessionId),
        // ── Session management tools ─────────────────────────────────────────────
        createSessionListTool(),
        createSessionStarTool(),
        createSessionTagTool(),
        // ── Git coordination tools ───────────────────────────────────────────────
        createGitSyncToSubAgentTool(gitMgr, opts.projectDir, opts.sessionId),
        createGitMergeSubAgentTool(gitMgr, opts.projectDir, opts.sessionId),
        createGitDiffSubAgentTool(gitMgr, opts.projectDir, opts.sessionId),
        createGitDiscardSubAgentTool(gitMgr, opts.projectDir, opts.sessionId),
    ];
}
//# sourceMappingURL=index.js.map