import { randomUUID } from 'crypto';
export const ROBOTICS_DOMAINS = [
    'motion_planning', 'perception', 'manipulation', 'locomotion',
    'navigation', 'simulation', 'hardware_interface', 'deployment',
    'calibration', 'general',
];
export const KNOWLEDGE_CONFIDENCE_TIERS = [
    'observed', 'reproduced', 'derived', 'reported', 'hypothesis',
];
export const KNOWLEDGE_SCOPES = ['global', 'robot', 'code'];
export const PRINCIPLE_ABSTRACTION_LEVELS = [
    'physical', 'system', 'algorithmic', 'statistical', 'operational',
];
export function makeExperienceId() {
    const ts = Date.now().toString(36);
    const uuid8 = randomUUID().replace(/-/g, '').slice(0, 8);
    return `exp_${ts}_${uuid8}`;
}
export function makePrincipleId() {
    const ts = Date.now().toString(36);
    const uuid8 = randomUUID().replace(/-/g, '').slice(0, 8);
    return `pr_${ts}_${uuid8}`;
}
export function makePhysicalAnchorId() {
    const ts = Date.now().toString(36);
    const uuid8 = randomUUID().replace(/-/g, '').slice(0, 8);
    return `pa_${ts}_${uuid8}`;
}
//# sourceMappingURL=types.js.map