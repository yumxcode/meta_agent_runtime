export interface SensitivePattern {
    pattern: RegExp;
    label: string;
}
export declare const SENSITIVE_SHELL_PATTERNS: SensitivePattern[];
export declare function detectSensitiveShellCommand(command: string): string | null;
//# sourceMappingURL=SensitiveCommandPatterns.d.ts.map