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
// ─────────────────────────────────────────────────────────────────────────────
// Typed wrapper
// ─────────────────────────────────────────────────────────────────────────────
class TypedCampaignEventBus extends EventEmitter {
    emit(event, data) {
        return super.emit(event, data);
    }
    on(event, listener) {
        return super.on(event, listener);
    }
    once(event, listener) {
        return super.once(event, listener);
    }
    off(event, listener) {
        return super.off(event, listener);
    }
}
// ─────────────────────────────────────────────────────────────────────────────
// Singleton
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Process-level singleton.  Import and use directly:
 *
 *   import { CampaignEventBus } from './CampaignEventBus.js'
 *   CampaignEventBus.on('subagent:completed', ({ taskId, result }) => { ... })
 *   CampaignEventBus.emit('subagent:completed', { taskId, parentSessionId, result })
 */
export const CampaignEventBus = new TypedCampaignEventBus();
// Raise the default listener limit — the bus may have many concurrent
// sub-agent runners + the autonomous loop controller all listening.
CampaignEventBus.setMaxListeners(100);
//# sourceMappingURL=CampaignEventBus.js.map