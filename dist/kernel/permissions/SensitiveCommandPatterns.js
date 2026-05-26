export const SENSITIVE_SHELL_PATTERNS = [
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
];
export function detectSensitiveShellCommand(command) {
    for (const { pattern, label } of SENSITIVE_SHELL_PATTERNS) {
        if (pattern.test(command))
            return label;
    }
    return null;
}
//# sourceMappingURL=SensitiveCommandPatterns.js.map