/**
 * CampaignPluginRegistry — process-level singleton
 *
 * All built-in Campaign types are registered at startup by importing
 * src/campaigns/index.ts.  Future external plugins can be loaded via
 * loadExternalPlugin() once we move to true dynamic loading.
 *
 * Usage:
 *   // Registration (at startup)
 *   import '../campaigns/index.js'   // side-effect: registers all built-ins
 *
 *   // Lookup (anywhere)
 *   import { campaignRegistry } from '../campaign/registry.js'
 *   const plugin = campaignRegistry.get('doe')
 *   const guidance = plugin.buildPhaseGuidance(phase, state)
 */
import type { AnyPlugin, CampaignPlugin } from './types.js';
declare class CampaignPluginRegistry {
    private readonly plugins;
    /**
     * Register a campaign plugin.  Throws if the type is already registered —
     * duplicate registration is always a programming error, not a runtime condition.
     */
    register(plugin: AnyPlugin): void;
    /**
     * Retrieve a registered plugin by its type string.
     * Throws a descriptive error if not found — callers should never need to
     * handle "unknown plugin" as a graceful condition.
     *
     * @typeParam P - Narrows the return type to the caller's expected plugin type
     */
    get<P extends AnyPlugin = AnyPlugin>(type: string): P;
    /**
     * Return true if a plugin with the given type is registered.
     * Useful for conditional logic without triggering the get() error.
     */
    has(type: string): boolean;
    /**
     * List all registered plugins in registration order.
     * Used by the campaign picker UI and help text.
     */
    list(): Array<{
        type: string;
        displayName: string;
        description: string;
        version: string;
    }>;
    /** Number of registered plugins — useful for health checks and tests */
    get size(): number;
    /**
     * Load and register an external plugin from an npm package.
     *
     * CONTRACT (for future implementation):
     *   - The package must export a default export conforming to AnyPlugin
     *   - The package must be pre-installed; this method does NOT run npm install
     *   - Loading is idempotent — if the type is already registered, this is a no-op
     *
     * @example
     *   await campaignRegistry.loadExternalPlugin('@acme/campaign-doe-advanced')
     *
     * @throws if the package cannot be loaded or its export is not a valid plugin
     */
    loadExternalPlugin(packageName: string): Promise<void>;
}
export declare const campaignRegistry: CampaignPluginRegistry;
export type { CampaignPlugin, AnyPlugin };
//# sourceMappingURL=registry.d.ts.map