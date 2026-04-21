/**
 * System prompt builder — assembles the final system prompt from layers.
 *
 * Layer order (each separated by a horizontal rule):
 *   1. Base prompt      — the core persona / tool-use instructions
 *   2. AGENTS.md        — project- and user-level agent instructions
 *   3. Skills           — reusable operation procedures
 *   4. Task Spec        — acceptance criteria (highest recency weight)
 *
 * Any layer that contributes nothing is silently omitted.
 */

import type { AgentsMdResult }  from './agents-md.js';
import type { TaskSpec }        from './spec.js';
import { resolveTaskSpec, formatTaskSpec } from './spec.js';
import type { Skill }           from './skills.js';
import { formatSkills }         from './skills.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SystemPromptLayers {
  /** Core persona / tool instructions (required). */
  basePrompt: string;
  /** Merged AGENTS.md content (from loadAgentsMd). */
  agentsMd?: AgentsMdResult;
  /** Loaded skill procedures (from loadSkills). */
  skills?: Skill[];
  /** Task acceptance criteria spec (resolved or inline). */
  spec?: TaskSpec;
}

export interface BuiltPrompt {
  /** The fully assembled system prompt string. */
  text: string;
  /**
   * Diagnostic breakdown: which layers contributed content.
   * Useful for debug logging.
   */
  layers: {
    base: boolean;
    agentsMd: boolean;     // ≥1 AGENTS.md file was found
    skills: boolean;       // ≥1 skill was loaded
    spec: boolean;         // spec was present and non-empty
  };
  /** Source file paths for AGENTS.md files that contributed. */
  agentsMdSources?: string[];
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Assemble the final system prompt from the provided layers.
 * Resolves the TaskSpec (loading from file if needed) before formatting.
 */
export async function buildSystemPrompt(layers: SystemPromptLayers): Promise<BuiltPrompt> {
  const sections: string[] = [];
  const info: BuiltPrompt['layers'] = {
    base:      false,
    agentsMd:  false,
    skills:    false,
    spec:      false,
  };

  // -------------------------------------------------------------------------
  // Layer 1: Base prompt
  // -------------------------------------------------------------------------
  if (layers.basePrompt.trim()) {
    sections.push(layers.basePrompt.trim());
    info.base = true;
  }

  // -------------------------------------------------------------------------
  // Layer 2: AGENTS.md — project + user instructions
  // -------------------------------------------------------------------------
  const agentsMdContent = layers.agentsMd?.content?.trim() ?? '';
  if (agentsMdContent) {
    sections.push(
      '---',
      '## Project Instructions\n\n' + agentsMdContent,
    );
    info.agentsMd = true;
  }

  // -------------------------------------------------------------------------
  // Layer 3: Skills
  // -------------------------------------------------------------------------
  const skillsSection = layers.skills ? formatSkills(layers.skills) : '';
  if (skillsSection) {
    sections.push('---', skillsSection.trim());
    info.skills = true;
  }

  // -------------------------------------------------------------------------
  // Layer 4: Task Spec (resolved — may load from file)
  // -------------------------------------------------------------------------
  if (layers.spec) {
    const resolvedSpec = await resolveTaskSpec(layers.spec);
    const specSection  = formatTaskSpec(resolvedSpec);
    if (specSection.trim()) {
      sections.push('---', specSection.trim());
      info.spec = true;
    }
  }

  return {
    text:             sections.join('\n\n'),
    layers:           info,
    agentsMdSources:  layers.agentsMd?.sources,
  };
}
