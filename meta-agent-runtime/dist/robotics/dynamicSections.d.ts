/**
 * Robotics dynamic system prompt sections — R1 through R5.
 *
 * R1 — Robotics Domain Context + Git Coordination Protocol (memoized)
 * R2 — Experience Index (memoized; rebuilt when experience_write is called)
 * R3 — Active Sub-Agent Tasks + Git Branch Status (volatile — changes each turn)
 * R4 — Hardware Profile (memoized)
 * R5 — Session Resume / Progress Notes (volatile — notes append during session)
 *
 * Sections are registered into the SectionRegistry in RoboticsSession.
 */
import { type SystemPromptSection } from '../core/systemPromptSections.js';
import type { ExperienceStore } from './ExperienceStore.js';
import type { HardwareProfile } from './HardwareProfile.js';
import type { SubAgentBridge } from '../subagent/SubAgentBridge.js';
import type { GitWorkspaceManager } from './git/GitWorkspaceManager.js';
import type { RoboticsAgentMode, RoboticsProjectState } from './types.js';
/**
 * Build R1 section.
 *
 * @param robot     Optional robot/platform name injected into the header.
 * @param getMode   Getter returning the current agent mode. Called at section
 *                  evaluation time so that an invalidate() + re-resolve cycle
 *                  picks up the mode determined on the first submit().
 *                  Defaults to 'multi' when absent.
 */
export declare function buildR1Section(robot?: string, getMode?: () => RoboticsAgentMode): SystemPromptSection;
export declare function buildR2Section(store: ExperienceStore): SystemPromptSection;
export declare function buildR3Section(bridge: SubAgentBridge, gitMgr: GitWorkspaceManager, getState: () => RoboticsProjectState | null): SystemPromptSection;
export declare function buildR4Section(hwProfile: HardwareProfile, robot?: string): SystemPromptSection;
export declare function buildR5Section(getState: () => RoboticsProjectState | null, resumedAt: number | null): SystemPromptSection;
//# sourceMappingURL=dynamicSections.d.ts.map