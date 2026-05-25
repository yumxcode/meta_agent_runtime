/**
 * KernelBridge — legacy shim.
 *
 * The original KernelBridge wired CC's internal QueryEngine into the
 * MetaAgentSession API surface. It has been superseded by CampaignSession,
 * which uses the self-contained cc-kernel TypeScript rewrite and requires
 * no CC binary dependency.
 *
 * This file is kept for backward-compatibility only. All consumers should
 * migrate to CampaignSession.
 *
 * @deprecated Use CampaignSession from '../modes/CampaignSession.js' instead.
 */
export { CampaignSession as KernelBridge } from '../modes/CampaignSession.js';
//# sourceMappingURL=KernelBridge.d.ts.map