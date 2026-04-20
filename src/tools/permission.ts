/**
 * @hermes/runtime — Tool Permission State Machine
 *
 * Implements a rule-based permission layer that sits BEFORE tool dispatch.
 * Design goals:
 *  - Fast pre-model filtering: tools denied at the registry level are never
 *    sent to the LLM, so the model can't even attempt to call them.
 *  - Four states: always_allow | always_deny | ask | auto
 *  - Default high-risk rules protect destructive operations out of the box.
 *  - Glob-style wildcard matching for rule patterns.
 */

import type { PermissionConfig, PermissionLevel, PermissionRule } from '../types.js';

// ---------------------------------------------------------------------------
// Built-in high-risk default rules
// ---------------------------------------------------------------------------

const HIGH_RISK_DEFAULTS: PermissionRule[] = [
  // Terminal execution is sensitive — require explicit allow by default
  { tool: 'terminal', level: 'ask' },
  // Broad file writes/patches allowed by default (common agent need)
  { tool: 'write_file', level: 'auto' },
  { tool: 'patch_file', level: 'auto' },
  // Delegation of sub-agents is fine by default
  { tool: 'delegate_task', level: 'auto' },
];

// ---------------------------------------------------------------------------
// Glob matcher (supports '*' wildcard only)
// ---------------------------------------------------------------------------

function matchesGlob(pattern: string, toolName: string): boolean {
  if (pattern === '*') return true;
  if (!pattern.includes('*')) return pattern === toolName;
  const regex = new RegExp('^' + pattern.split('*').map(escapeRegex).join('.*') + '$');
  return regex.test(toolName);
}

function escapeRegex(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// ToolPermissionContext
// ---------------------------------------------------------------------------

export class ToolPermissionContext {
  private readonly config: Required<Pick<PermissionConfig, 'defaultLevel' | 'rules'>>;
  private readonly onAsk: PermissionConfig['onAsk'];

  constructor(config: PermissionConfig = {}) {
    this.config = {
      defaultLevel: config.defaultLevel ?? 'auto',
      rules: [...HIGH_RISK_DEFAULTS, ...(config.rules ?? [])],
    };
    this.onAsk = config.onAsk;
  }

  /**
   * Resolve the effective permission level for a tool name.
   * Rule list is evaluated in order — first match wins.
   */
  resolve(toolName: string): PermissionLevel {
    for (const rule of this.config.rules) {
      if (matchesGlob(rule.tool, toolName)) {
        return rule.level;
      }
    }
    return this.config.defaultLevel;
  }

  /**
   * Check whether a tool is allowed to execute.
   *
   * - always_allow → true immediately
   * - always_deny  → false immediately
   * - auto         → true (no prompt needed)
   * - ask          → delegates to onAsk callback; if none provided, defaults to allow
   *
   * @returns true if execution should proceed, false if blocked.
   */
  async check(toolName: string, args: Record<string, unknown>): Promise<boolean> {
    const level = this.resolve(toolName);

    switch (level) {
      case 'always_allow':
      case 'auto':
        return true;

      case 'always_deny':
        return false;

      case 'ask': {
        if (!this.onAsk) {
          // No ask handler registered → default to allow (non-interactive mode)
          return true;
        }
        const decision = await this.onAsk(toolName, args);
        return decision === 'allow';
      }
    }
  }

  /**
   * Return the set of tool names that are pre-filtered OUT (always_deny).
   * Used by the registry to exclude tools from the definition list sent to the LLM.
   */
  isDenied(toolName: string): boolean {
    return this.resolve(toolName) === 'always_deny';
  }
}

// ---------------------------------------------------------------------------
// Factory helper
// ---------------------------------------------------------------------------

export function createPermissionContext(config?: PermissionConfig): ToolPermissionContext {
  return new ToolPermissionContext(config);
}
