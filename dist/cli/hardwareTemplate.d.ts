/**
 * Hardware Profile Creation Template
 *
 * Controls the fields shown in the `meta-agent --mode robotics` wizard.
 *
 * Load order (highest priority first):
 *   1. <projectDir>/.meta-agent/hardware-template.json
 *   2. ~/.claude/meta-agent/robotics/profile-template.json
 *   3. Built-in default template  (defined below)
 *
 * Template JSON schema: ProfileTemplate (see below)
 */
export type FieldType = 'text' | 'kv' | 'csv';
/**
 * A single wizard field definition.
 *
 * Built-in keys (map to HardwareProfileData):
 *   name, platform, compute, os, actuators, sensors, safetyLimits, knownIssues, notes
 *
 * You can also add arbitrary extra keys — they will be stored in `notes` as
 * "key: value" lines appended to any notes the user provides.
 */
export interface TemplateField {
    /** JSON key in HardwareProfileData (or a custom label-only key) */
    key: string;
    /** Human-readable label shown in the wizard prompt */
    label: string;
    /** Whether the user must fill this field (empty input loops until filled) */
    required?: boolean;
    /**
     * Input type:
     *   'text' — plain single-line string (default)
     *   'kv'   — repeated key:value pairs until blank line (used for safetyLimits)
     *   'csv'  — comma-separated values collapsed to string[] (used for knownIssues)
     */
    type?: FieldType;
    /** Placeholder shown as "(如 …)" in the prompt */
    hint?: string;
    /** Pre-filled default value — user can override by typing a different value */
    default?: string;
}
/**
 * A preset provides default values for a known robot platform.
 * During wizard startup the user is offered a numbered list of presets;
 * choosing one pre-fills all matching fields.
 */
export interface ProfilePreset {
    id: string;
    label: string;
    defaults: Partial<{
        platform: string;
        compute: string;
        os: string;
        actuators: string;
        sensors: string;
        safetyLimits: Record<string, string>;
        notes: string;
    }>;
}
export interface ProfileTemplate {
    /** Optional robot presets (Unitree, Franka, …) */
    presets?: ProfilePreset[];
    /** Ordered field definitions for the creation wizard */
    fields: TemplateField[];
}
export declare const DEFAULT_TEMPLATE: ProfileTemplate;
/**
 * Resolve the active ProfileTemplate using the load order:
 *   1. <projectDir>/.meta-agent/hardware-template.json
 *   2. ~/.claude/meta-agent/robotics/profile-template.json
 *   3. Built-in DEFAULT_TEMPLATE
 */
export declare function resolveTemplate(projectDir?: string): Promise<ProfileTemplate>;
//# sourceMappingURL=hardwareTemplate.d.ts.map