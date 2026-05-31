/**
 * Sensitive-shell-command detection — BEST-EFFORT defense-in-depth ONLY.
 *
 * L4: these regexes flag commands worth a human confirmation prompt; they are
 * NOT a security boundary and must never be relied on as one. A determined
 * model or user can trivially evade every pattern here — e.g. `r''m -rf`,
 * `${HOME:0:0}rm`, base64-decode-then-pipe, aliases, `eval "$(...)"`, invoking
 * a script that runs the command, or any of a thousand other shell tricks.
 *
 * The real containment guarantees come from the layers BELOW this one:
 *   - the OS sandbox (bwrap / sandbox-exec) with a read-only root and a
 *     writable-workspace jail, and
 *   - the workspace-boundary path guard (isInsideWorkspace).
 *
 * Treat a match as "ask the user first," and treat a non-match as "no signal,"
 * never as "this command is safe." Add patterns freely to widen the prompt
 * surface, but do not delete a security control on the assumption this list
 * covers it.
 */
export interface SensitivePattern {
  pattern: RegExp
  label: string
}

export const SENSITIVE_SHELL_PATTERNS: SensitivePattern[] = [
  // File deletion
  { pattern: /\brm\b/, label: 'rm (file deletion)' },
  { pattern: /\brmdir\b/, label: 'rmdir' },
  { pattern: /\bunlink\b/, label: 'unlink' },
  { pattern: /\btrash\b/, label: 'trash' },
  { pattern: /\bshred\b/, label: 'shred' },

  // Git destructive or shared-state operations
  { pattern: /\bgit\s+push\b/, label: 'git push' },
  { pattern: /\bgit\s+clean\b/, label: 'git clean' },
  { pattern: /\bgit\s+branch\b.*-[dD]\b/, label: 'git branch delete' },
  { pattern: /\bgit\s+tag\b.*-[dD]\b/, label: 'git tag delete' },
  { pattern: /\bgit\s+reset\s+--hard\b/, label: 'git reset --hard' },

  // Package installs
  { pattern: /\bpip3?\s+install\b/, label: 'pip install' },
  { pattern: /\bconda\s+install\b/, label: 'conda install' },
  { pattern: /\bapt(?:-get)?\s+install\b/, label: 'apt install' },
  { pattern: /\bbrew\s+install\b/, label: 'brew install' },
  { pattern: /\bnpm\b.*\b(?:install|i)\b.*\b(?:-g|--global)\b/, label: 'npm install -g' },

  // Downloads and high-risk system operations
  { pattern: /\bcurl\b.*\s-[a-zA-Z]*[oO][a-zA-Z]*\s/, label: 'curl download' },
  { pattern: /\bwget\b/, label: 'wget' },
  { pattern: /\bsudo\b/, label: 'sudo' },
  { pattern: /\bcurl\b.*\|\s*(ba)?sh\b/, label: 'curl pipe to shell' },
  { pattern: /\bwget\b.*\|\s*(ba)?sh\b/, label: 'wget pipe to shell' },
  { pattern: /\bchmod\s+(-R\s+)?777\b/, label: 'chmod 777' },
  { pattern: /\bchown\s+(-R\s+)?/, label: 'chown' },

  // In-place file edits
  { pattern: /\bsed\s+.*\s-i(?:\s|$)/, label: 'sed in-place edit' },
  { pattern: /\bperl\s+.*\s-i(?:\s|$)/, label: 'perl in-place edit' },
]

export function detectSensitiveShellCommand(command: string): string | null {
  for (const { pattern, label } of SENSITIVE_SHELL_PATTERNS) {
    if (pattern.test(command)) return label
  }
  return null
}
