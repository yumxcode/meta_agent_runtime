/**
 * Prompt injection guard — scans externally-loaded content before it is
 * injected into the system prompt.
 *
 * External files (AGENTS.md, skill files, task specs) are attacker-controlled
 * surfaces: a malicious project repo can embed prompt injection in any of them.
 * This module mirrors the Python-side `_scan_context_content()` in
 * hermes-agent/agent/prompt_builder.py.
 *
 * Scan results:
 *   blocked = false → return sanitized content (invisible chars stripped)
 *   blocked = true  → return a [BLOCKED: ...] notice; never inject raw content
 *
 * YAML frontmatter stripping is also provided here (used by AGENTS.md loader)
 * because frontmatter may contain config keys that are handled separately and
 * should not be injected into the LLM prompt as prose.
 */

import { logger as rootLogger } from '../utils/logger.js';

const log = rootLogger.child('injection-guard');

// ---------------------------------------------------------------------------
// Threat pattern table
// (id, regex) pairs — first match that fires determines the block reason.
// Patterns are checked case-insensitively (RegExp flag `i`).
// ---------------------------------------------------------------------------

const THREAT_PATTERNS: Array<[string, RegExp]> = [
  // Classic override phrases
  ['prompt_injection',    /ignore\s+(previous|all|above|prior)\s+instructions/i],
  ['deception_hide',      /do\s+not\s+tell\s+the\s+user/i],
  ['sys_prompt_override', /system\s+prompt\s+override/i],
  ['disregard_rules',     /disregard\s+(your|all|any)\s+(instructions|rules|guidelines)/i],
  ['bypass_restrictions', /act\s+as\s+(if|though)\s+you\s+(have\s+no|don't\s+have)\s+(restrictions|limits|rules)/i],

  // HTML steganography
  ['html_comment_injection', /<!--[^>]*(?:ignore|override|system|secret|hidden)[^>]*-->/i],
  ['hidden_div',             /<\s*div\s+style\s*=\s*["'][^"']*display\s*:\s*none/i],

  // Exfiltration / code execution
  ['translate_execute',  /translate\s+.+\s+into\s+.+\s+and\s+(execute|run|eval)/i],
  ['exfil_curl',         /curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i],
  ['read_secrets',       /cat\s+[^\n]*(\.env|credentials|\.netrc|\.pgpass)/i],
];

// ---------------------------------------------------------------------------
// Invisible / bidi-control Unicode codepoints
//
// These can hide injected text from human reviewers while remaining visible
// to the LLM.  Any occurrence is treated as a hard block.
// ---------------------------------------------------------------------------

const INVISIBLE_CHARS = new Set([
  '\u200b', // ZERO WIDTH SPACE
  '\u200c', // ZERO WIDTH NON-JOINER
  '\u200d', // ZERO WIDTH JOINER
  '\u2060', // WORD JOINER
  '\ufeff', // BOM / ZERO WIDTH NO-BREAK SPACE
  '\u202a', // LEFT-TO-RIGHT EMBEDDING
  '\u202b', // RIGHT-TO-LEFT EMBEDDING
  '\u202c', // POP DIRECTIONAL FORMATTING
  '\u202d', // LEFT-TO-RIGHT OVERRIDE
  '\u202e', // RIGHT-TO-LEFT OVERRIDE  ← most dangerous: reverses rendered text
]);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ScanResult {
  /** Whether the content was blocked due to detected threats. */
  blocked: boolean;
  /**
   * The content to use downstream:
   *   • blocked=false → original content with invisible chars stripped
   *   • blocked=true  → a `[BLOCKED: ...]` notice string; NEVER inject raw
   */
  content: string;
  /** Machine-readable list of threat IDs that triggered the block. */
  threats: string[];
}

// ---------------------------------------------------------------------------
// Core scanner
// ---------------------------------------------------------------------------

/**
 * Scan `content` loaded from `source` (a file path or logical name) for
 * prompt-injection threats.
 *
 * - Invisible / bidi-override Unicode → hard block (regardless of patterns)
 * - Any matching threat pattern      → hard block
 * - Otherwise                        → return content unchanged (safe to inject)
 *
 * Never throws.
 */
export function scanContent(content: string, source: string): ScanResult {
  const threats: string[] = [];

  // -------------------------------------------------------------------------
  // 1. Invisible / bidi-override Unicode check
  // -------------------------------------------------------------------------
  for (const ch of INVISIBLE_CHARS) {
    if (content.includes(ch)) {
      threats.push(`invisible_unicode_U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`);
    }
  }

  // -------------------------------------------------------------------------
  // 2. Threat pattern scan
  // -------------------------------------------------------------------------
  for (const [id, pattern] of THREAT_PATTERNS) {
    if (pattern.test(content)) {
      threats.push(id);
    }
  }

  if (threats.length > 0) {
    log.warn(`Blocked ${source}: ${threats.join(', ')}`);
    return {
      blocked:  true,
      content:  `[BLOCKED: "${source}" contained potential prompt injection (${threats.join(', ')}). Content not loaded.]`,
      threats,
    };
  }

  return { blocked: false, content, threats: [] };
}

// ---------------------------------------------------------------------------
// YAML frontmatter stripper
// ---------------------------------------------------------------------------

/**
 * Remove YAML frontmatter (--- delimited) from the start of a Markdown file.
 *
 * AGENTS.md and skill files may carry structured config in frontmatter (model
 * overrides, tool gates, etc.) that will be handled separately.  We strip it
 * before injecting into the prompt so only the human-readable Markdown body
 * reaches the LLM.
 *
 * Returns the content unchanged if no frontmatter is detected.
 */
export function stripYamlFrontmatter(content: string): string {
  if (!content.startsWith('---')) return content;

  const end = content.indexOf('\n---', 3);
  if (end === -1) return content; // unclosed frontmatter — treat as body

  // Skip past `\n---` and any leading newline after it
  const body = content.slice(end + 4).replace(/^\n/, '');
  return body || content;
}
