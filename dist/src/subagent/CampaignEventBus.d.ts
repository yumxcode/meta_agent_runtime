/**
 * CampaignEventBus — typed event bus singleton
 *
 * Single process-level EventEmitter for all campaign and sub-agent lifecycle
 * events.  All consumers import the singleton directly.
 *
 * Event types:
 *   'subagent:completed'  — sub-agent task finished successfully
 *   'subagent:failed'     — sub-agent task failed (circuit-breaker or error)
 *   'subagent:checkpoint' — sub-agent periodic checkpoint (intermediate output)
 *   'phase:transitioned'  — campaign phase changed (§8 AutonomousLoopController)
 *
 * Design constraint: single-process only.  Cross-process event delivery
 * (§7.2 daemon mode) would require a message broker — this bus is the
 * foundation that would be proxied to IPC in that future upgrade.
 */
import { EventEmitter } from 'events';
import type { CampaignEventMap } from './types.js';
declare class TypedCampaignEventBus extends EventEmitter {
    emit<K extends keyof CampaignEventMap>(event: K, data: CampaignEventMap[K]): boolean;
    on<K extends keyof CampaignEventMap>(event: K, listener: (data: CampaignEventMap[K]) => void): this;
    once<K extends keyof CampaignEventMap>(event: K, listener: (data: CampaignEventMap[K]) => void): this;
    off<K extends keyof CampaignEventMap>(event: K, listener: (data: CampaignEventMap[K]) => void): this;
}
/**
 * Process-level singleton.  Import and use directly:
 *
 *   import { CampaignEventBus } from './CampaignEventBus.js'
 *   CampaignEventBus.on('subagent:completed', ({ taskId, result }) => { ... })
 *   CampaignEventBus.emit('subagent:completed', { taskId, parentSessionId, result })
 */
export declare const CampaignEventBus: TypedCampaignEventBus;
export {};
//# sourceMappingURL=CampaignEventBus.d.ts.map