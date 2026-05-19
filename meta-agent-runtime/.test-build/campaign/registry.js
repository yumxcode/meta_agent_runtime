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
// ─────────────────────────────────────────────────────────────────────────────
// Registry implementation
// ─────────────────────────────────────────────────────────────────────────────
class CampaignPluginRegistry {
    plugins = new Map();
    // ── Registration ───────────────────────────────────────────────────────────
    /**
     * Register a campaign plugin.  Throws if the type is already registered —
     * duplicate registration is always a programming error, not a runtime condition.
     */
    register(plugin) {
        if (this.plugins.has(plugin.type)) {
            throw new Error(`[CampaignPluginRegistry] Plugin type "${plugin.type}" is already registered. ` +
                'Each campaign type may only be registered once.');
        }
        this.plugins.set(plugin.type, plugin);
    }
    // ── Lookup ─────────────────────────────────────────────────────────────────
    /**
     * Retrieve a registered plugin by its type string.
     * Throws a descriptive error if not found — callers should never need to
     * handle "unknown plugin" as a graceful condition.
     *
     * @typeParam P - Narrows the return type to the caller's expected plugin type
     */
    get(type) {
        const plugin = this.plugins.get(type);
        if (!plugin) {
            const registered = [...this.plugins.keys()].join(', ') || '(none)';
            throw new Error(`[CampaignPluginRegistry] Unknown campaign plugin type "${type}". ` +
                `Registered types: ${registered}`);
        }
        return plugin;
    }
    /**
     * Return true if a plugin with the given type is registered.
     * Useful for conditional logic without triggering the get() error.
     */
    has(type) {
        return this.plugins.has(type);
    }
    // ── Introspection ──────────────────────────────────────────────────────────
    /**
     * List all registered plugins in registration order.
     * Used by the campaign picker UI and help text.
     */
    list() {
        return [...this.plugins.values()].map(p => ({
            type: p.type,
            displayName: p.displayName,
            description: p.description,
            version: p.version,
        }));
    }
    /** Number of registered plugins — useful for health checks and tests */
    get size() {
        return this.plugins.size;
    }
    // ── Future extension point ─────────────────────────────────────────────────
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
    async loadExternalPlugin(packageName) {
        // Validate input — prevent path traversal
        if (!packageName.match(/^[@a-zA-Z0-9_\-/.]+$/)) {
            throw new Error(`[CampaignPluginRegistry] Invalid package name: "${packageName}"`);
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const mod = await import(packageName);
        const plugin = mod.default;
        if (!plugin || typeof plugin.type !== 'string' || typeof plugin.buildCapsule !== 'function') {
            throw new Error(`[CampaignPluginRegistry] Package "${packageName}" does not export a valid CampaignPlugin as default.`);
        }
        // Idempotent: if already registered by the same package, skip
        if (this.plugins.has(plugin.type)) {
            return;
        }
        this.register(plugin);
    }
}
// ─────────────────────────────────────────────────────────────────────────────
// Singleton export
// ─────────────────────────────────────────────────────────────────────────────
export const campaignRegistry = new CampaignPluginRegistry();
//# sourceMappingURL=registry.js.map