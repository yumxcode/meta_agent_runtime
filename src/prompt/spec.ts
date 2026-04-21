/**
 * Task Spec — declarative completion criteria (Spec layer).
 *
 * A TaskSpec describes what "done" means for the current task.  It is injected
 * near the end of the assembled system prompt so it has the highest recency
 * weight.  It complements programmatic CompletionGuards: specs are natural-
 * language acceptance criteria that the LLM can reason over, while guards are
 * code callbacks that can check artifacts on disk.
 *
 * File format (when loaded from disk):
 *   .json  — parsed as a full TaskSpec object
 *   .md / .txt / any other extension — treated as the `criteria` string
 */

import fs from 'fs/promises';
import { scanContent } from './injection-guard.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TaskSpec {
  /** Human-readable description of what "done" looks like. */
  criteria: string;
  /**
   * Specific outcomes that must ALL be true before the task is complete.
   * Each item is rendered as a checklist item in the prompt.
   */
  outcomes?: string[];
  /**
   * Hard constraints that must NOT be violated at any point.
   * Rendered separately to ensure the LLM treats them as invariants.
   */
  constraints?: string[];
  /**
   * A file path to load the spec from.
   * When set, other fields (criteria, outcomes, constraints) from the config
   * object are used as fallbacks if the file is absent.
   */
  filePath?: string;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Resolve a TaskSpec to a fully-populated object.
 * If `spec.filePath` is set, the file is loaded and merged (file wins over
 * inline values for the same field).  Never throws on missing files — falls
 * back to the inline spec.
 */
export async function resolveTaskSpec(spec: TaskSpec): Promise<TaskSpec> {
  if (!spec.filePath) return spec;

  try {
    const raw     = await fs.readFile(spec.filePath, 'utf-8');
    const isJson  = spec.filePath.endsWith('.json');

    if (isJson) {
      // JSON specs are structured data, not prose — scan the serialized form
      const { content: scanned, blocked } = scanContent(raw, spec.filePath);
      if (blocked) {
        // Return the block notice as criteria so callers can see it was blocked
        return { criteria: scanned, outcomes: spec.outcomes, constraints: spec.constraints };
      }
      const parsed = JSON.parse(scanned) as Partial<TaskSpec>;
      return {
        criteria:    parsed.criteria    ?? spec.criteria,
        outcomes:    parsed.outcomes    ?? spec.outcomes,
        constraints: parsed.constraints ?? spec.constraints,
      };
    }

    // Plain text / Markdown — scan before use
    const { content } = scanContent(raw.trim(), spec.filePath);
    return {
      criteria:    content,
      outcomes:    spec.outcomes,
      constraints: spec.constraints,
    };
  } catch {
    // File not found or unreadable — silently use inline spec
    return spec;
  }
}

// ---------------------------------------------------------------------------
// Formatter
// ---------------------------------------------------------------------------

/**
 * Render a TaskSpec as a structured Markdown section for injection into the
 * system prompt.
 */
export function formatTaskSpec(spec: TaskSpec): string {
  const lines: string[] = [
    '## Task Specification',
    '',
    spec.criteria,
  ];

  if (spec.outcomes && spec.outcomes.length > 0) {
    lines.push('', '**Success criteria — all must be met before reporting completion:**');
    for (const outcome of spec.outcomes) {
      lines.push(`- [ ] ${outcome}`);
    }
  }

  if (spec.constraints && spec.constraints.length > 0) {
    lines.push('', '**Constraints — must not be violated:**');
    for (const constraint of spec.constraints) {
      lines.push(`- ⚠ ${constraint}`);
    }
  }

  return lines.join('\n');
}
