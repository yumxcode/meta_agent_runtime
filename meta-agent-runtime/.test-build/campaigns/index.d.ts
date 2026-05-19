/**
 * Campaign Plugin Registration
 *
 * Import this file ONCE at process startup (e.g. in MetaAgentSession or the
 * CLI entrypoint).  It registers all built-in Campaign types with the
 * CampaignPluginRegistry singleton.
 *
 * Adding a new Campaign type:
 *   1. Create src/campaigns/<type>/plugin.ts
 *   2. Export the plugin as a named export from src/campaigns/<type>/index.ts
 *   3. Add one line here: campaignRegistry.register(myNewPlugin)
 *
 * External plugins can be loaded at runtime via:
 *   await campaignRegistry.loadExternalPlugin('@acme/campaign-foo')
 */
export {};
//# sourceMappingURL=index.d.ts.map