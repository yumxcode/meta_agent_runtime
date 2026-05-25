/**
 * GenericCampaignStore<TPhase, TState>
 *
 * A reusable, file-backed ICampaignStore for any campaign type EXCEPT DOE
 * (which keeps its own CampaignStateStore to avoid migration risk).
 *
 * On-disk layout:
 *   ~/.claude/meta-agent/campaigns/<campaignId>/state.json
 *
 * Concurrency model:
 *   Identical to CampaignStateStore — a per-instance promise chain (_lock)
 *   serialises all mutations.  Reads are non-locking but re-read from disk
 *   to stay consistent after external modifications.
 *
 * Atomic writes:
 *   state.json is written to a .tmp file first, then renamed — same pattern
 *   as CampaignStateStore to survive process crashes.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { GENERIC_SCHEMA_VERSION } from './types.js';
import { campaignRegistry } from './registry.js';
// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────
const CAMPAIGNS_DIR = path.join(os.homedir(), '.claude', 'meta-agent', 'campaigns');
const STATE_FILE = 'state.json';
// ─────────────────────────────────────────────────────────────────────────────
// GenericCampaignStore
// ─────────────────────────────────────────────────────────────────────────────
export class GenericCampaignStore {
    campaignId;
    projectName;
    campaignDir;
    pluginType;
    /** Serialise all write operations — matches CampaignStateStore pattern */
    _lock = Promise.resolve();
    constructor(campaignId, projectName, pluginType) {
        this.campaignId = campaignId;
        this.projectName = projectName;
        this.pluginType = pluginType;
        this.campaignDir = path.join(CAMPAIGNS_DIR, campaignId);
    }
    // ── Factory methods ─────────────────────────────────────────────────────────
    /**
     * Create a brand-new campaign on disk and return its store.
     * Throws if a campaign with the same ID already exists.
     */
    static async create(campaignId, projectName, pluginType, pluginVersion, initialState, initialPhase) {
        const store = new GenericCampaignStore(campaignId, projectName, pluginType);
        await fs.mkdir(store.campaignDir, { recursive: true });
        const stateFile = path.join(store.campaignDir, STATE_FILE);
        // Guard against accidental overwrite
        try {
            await fs.access(stateFile);
            throw new Error(`Campaign "${campaignId}" already exists at ${stateFile}`);
        }
        catch (err) {
            if (err.code !== 'ENOENT')
                throw err;
        }
        const persisted = {
            schemaVersion: GENERIC_SCHEMA_VERSION,
            pluginType,
            pluginVersion,
            campaignId,
            projectName,
            phase: initialPhase,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            businessState: initialState,
            pendingTaskIds: [],
            completedTaskIds: [],
            failedTaskIds: [],
        };
        await store._writeAtomic(persisted);
        return store;
    }
    /**
     * Open an existing campaign from disk.
     * Runs validateState() and migrateState() if the plugin version changed.
     */
    static async open(campaignId) {
        const stateFile = path.join(CAMPAIGNS_DIR, campaignId, STATE_FILE);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const raw = JSON.parse(await fs.readFile(stateFile, 'utf8'));
        const plugin = campaignRegistry.get(raw.pluginType);
        let businessState;
        if (raw.pluginVersion !== plugin.version) {
            // Version mismatch — migration is required.
            // P1-3: If the plugin has no migrateState() we must throw, not silently
            // fall through to validateState() on the old-schema data.
            if (!plugin.migrateState) {
                throw new Error(`[GenericCampaignStore] Plugin "${raw.pluginType}" v${plugin.version} has no migrateState() — ` +
                    `cannot load persisted state from v${raw.pluginVersion}. ` +
                    `Delete or manually migrate: ${stateFile}`);
            }
            businessState = plugin.migrateState(raw.businessState, raw.pluginVersion);
            // P1-3: Always validate AFTER migration — a buggy migration must fail loudly,
            // not silently corrupt state on the next write.
            if (!plugin.validateState(businessState)) {
                throw new Error(`[GenericCampaignStore] Campaign "${campaignId}" state failed validation after ` +
                    `migration from v${raw.pluginVersion} → v${plugin.version} (plugin: "${raw.pluginType}").`);
            }
        }
        else {
            // Same version — validate as-is
            if (!plugin.validateState(raw.businessState)) {
                throw new Error(`[GenericCampaignStore] Campaign "${campaignId}" has invalid state for plugin "${raw.pluginType}".`);
            }
            businessState = raw.businessState;
        }
        const store = new GenericCampaignStore(campaignId, raw.projectName, raw.pluginType);
        // Eagerly cache in memory — _read() will reload from disk on next write
        void businessState; // state is on disk; reads come from disk for consistency
        return store;
    }
    // ── ICampaignStore implementation ───────────────────────────────────────────
    async getPhase() {
        const s = await this._read();
        return s.phase;
    }
    async getState() {
        const s = await this._read();
        return s.businessState;
    }
    async updateState(patch) {
        await this._withLock(async () => {
            const s = await this._read();
            s.businessState = { ...s.businessState, ...patch };
            s.updatedAt = new Date().toISOString();
            await this._writeAtomic(s);
        });
    }
    async transitionPhase(to) {
        await this._withLock(async () => {
            const s = await this._read();
            const plugin = campaignRegistry.get(this.pluginType);
            const allowed = plugin.phases.transitions[s.phase] ?? [];
            if (!allowed.includes(to)) {
                throw new Error(`[GenericCampaignStore] Invalid transition ${s.phase} → ${to} ` +
                    `for campaign "${this.campaignId}" (plugin: ${this.pluginType}). ` +
                    `Allowed: [${allowed.join(', ')}]`);
            }
            // Fire onPhaseExit — errors are caught and logged
            try {
                const exitHook = plugin.onPhaseExit;
                if (exitHook) {
                    await exitHook.call(plugin, s.phase, s.businessState);
                }
            }
            catch (err) {
                console.error(`[GenericCampaignStore] onPhaseExit(${s.phase}) threw:`, err);
            }
            s.phase = to;
            s.updatedAt = new Date().toISOString();
            await this._writeAtomic(s);
            // Fire onPhaseEnter — errors are caught and logged
            try {
                const enterHook = plugin.onPhaseEnter;
                if (enterHook) {
                    await enterHook.call(plugin, to, s.businessState);
                }
            }
            catch (err) {
                console.error(`[GenericCampaignStore] onPhaseEnter(${to}) threw:`, err);
            }
        });
    }
    async markFailed(reason) {
        await this._withLock(async () => {
            const s = await this._read();
            const plugin = campaignRegistry.get(this.pluginType);
            const terminal = plugin.phases.terminal;
            // Find a FAILED/BLOCKED terminal phase
            const failPhase = plugin.phases.terminal.find(p => p === 'FAILED' || p === 'BLOCKED');
            if (!failPhase) {
                throw new Error(`[GenericCampaignStore] Plugin "${this.pluginType}" has no FAILED/BLOCKED terminal phase. ` +
                    `Terminal phases: [${terminal.join(', ')}]`);
            }
            s.phase = failPhase;
            s.failureReason = reason;
            s.updatedAt = new Date().toISOString();
            await this._writeAtomic(s);
        });
    }
    // ── Sub-agent task tracking helpers ────────────────────────────────────────
    async addPendingTask(taskId) {
        await this._withLock(async () => {
            const s = await this._read();
            if (!s.pendingTaskIds.includes(taskId))
                s.pendingTaskIds.push(taskId);
            s.updatedAt = new Date().toISOString();
            await this._writeAtomic(s);
        });
    }
    async completeTask(taskId) {
        await this._withLock(async () => {
            const s = await this._read();
            s.pendingTaskIds = s.pendingTaskIds.filter(id => id !== taskId);
            if (!s.completedTaskIds.includes(taskId))
                s.completedTaskIds.push(taskId);
            s.updatedAt = new Date().toISOString();
            await this._writeAtomic(s);
        });
    }
    async failTask(taskId) {
        await this._withLock(async () => {
            const s = await this._read();
            s.pendingTaskIds = s.pendingTaskIds.filter(id => id !== taskId);
            if (!s.failedTaskIds.includes(taskId))
                s.failedTaskIds.push(taskId);
            s.updatedAt = new Date().toISOString();
            await this._writeAtomic(s);
        });
    }
    // ── Private helpers ─────────────────────────────────────────────────────────
    _withLock(fn) {
        this._lock = this._lock.then(fn, fn);
        return this._lock;
    }
    async _read() {
        const stateFile = path.join(this.campaignDir, STATE_FILE);
        const text = await fs.readFile(stateFile, 'utf8');
        return JSON.parse(text);
    }
    async _writeAtomic(state) {
        const stateFile = path.join(this.campaignDir, STATE_FILE);
        const tmpFile = stateFile + '.tmp';
        await fs.writeFile(tmpFile, JSON.stringify(state, null, 2), 'utf8');
        await fs.rename(tmpFile, stateFile);
    }
}
/**
 * Scan CAMPAIGNS_DIR and return a lightweight summary of every persisted
 * generic campaign.  Skips directories that don't contain a valid state.json.
 */
export async function listGenericCampaigns() {
    let entries;
    try {
        entries = await fs.readdir(CAMPAIGNS_DIR);
    }
    catch {
        return [];
    }
    const results = [];
    for (const entry of entries) {
        const stateFile = path.join(CAMPAIGNS_DIR, entry, STATE_FILE);
        try {
            const raw = JSON.parse(await fs.readFile(stateFile, 'utf8'));
            results.push({
                campaignId: raw.campaignId,
                projectName: raw.projectName,
                pluginType: raw.pluginType,
                phase: raw.phase,
                updatedAt: raw.updatedAt,
                failureReason: raw.failureReason,
            });
        }
        catch {
            // Not a valid generic campaign directory — skip
        }
    }
    return results;
}
//# sourceMappingURL=store.js.map