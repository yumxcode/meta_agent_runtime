function taskKey(task) {
    return `${task.id}:${task.status}:${task.ownerUnit ?? ''}:${task.branch ?? ''}:${task.updatedAt}`;
}
function stateSignature(state) {
    if (!state)
        return 'null';
    return JSON.stringify({
        goals: state.goals,
        modules: state.modules.map(m => ({
            name: m.name,
            ownerUnit: m.ownerUnit ?? '',
            paths: m.paths,
        })),
        tasks: state.tasks.map(taskKey),
        units: state.units.map(u => `${u.id}:${u.status}:${u.currentTask ?? ''}:${u.lastSeen}`),
        decisions: state.decisions,
    });
}
function byId(items) {
    return new Map(items.map(i => [i.id, i]));
}
export class TeamWatcher {
    store;
    intervalMs;
    timer = null;
    running = false;
    lastState = null;
    lastSignature = 'uninitialized';
    lastRemoteSignature = 'uninitialized';
    lastSync = null;
    /** ISO timestamp of when the last tick() completed successfully. */
    lastSyncAt = null;
    events = [];
    constructor(store, intervalMs = 1_800_000) {
        this.store = store;
        this.intervalMs = intervalMs;
    }
    start() {
        if (this.timer)
            return;
        void this.tick();
        this.timer = setInterval(() => {
            void this.tick();
        }, this.intervalMs);
        if (this.timer.unref)
            this.timer.unref();
    }
    stop() {
        if (!this.timer)
            return;
        clearInterval(this.timer);
        this.timer = null;
    }
    async forceSync(fetch = true) {
        // If a tick is already in progress, wait for it to finish (up to 5 s)
        // before starting a new one, so we never return stale data.
        let waited = 0;
        while (this.running && waited < 5_000) {
            await new Promise(r => setTimeout(r, 50));
            waited += 50;
        }
        await this.tick(fetch);
        return this.lastSync ?? { gitFetched: false, remoteTeamChanges: [], state: this.lastState };
    }
    getRecentEvents(limit = 8) {
        return this.events.slice(-limit);
    }
    formatPromptContext() {
        const events = this.getRecentEvents();
        if (!this.lastSync && events.length === 0)
            return null;
        const lines = ['### Team Watcher'];
        if (this.lastSync) {
            lines.push(`- Last sync: ${this.lastSyncAt ?? 'pending'}`);
            if (this.lastSync.currentBranch)
                lines.push(`- Current branch: ${this.lastSync.currentBranch}`);
            if (this.lastSync.upstreamBranch)
                lines.push(`- Upstream branch: ${this.lastSync.upstreamBranch}`);
            if (typeof this.lastSync.behind === 'number' || typeof this.lastSync.ahead === 'number') {
                lines.push(`- Remote divergence: behind=${this.lastSync.behind ?? 0}, ahead=${this.lastSync.ahead ?? 0}`);
            }
            if (this.lastSync.remoteSummary)
                lines.push(`- Git summary: ${this.lastSync.remoteSummary.split('\n')[0]}`);
            if (this.lastSync.remoteTeamChanges.length > 0) {
                lines.push('- Remote team file changes are available after pulling:');
                this.lastSync.remoteTeamChanges.slice(0, 8).forEach(change => lines.push(`  - ${change}`));
            }
        }
        if (events.length > 0) {
            lines.push('- Recent team changes:');
            events.forEach(e => lines.push(`  - [${e.at}] ${e.message}`));
        }
        else {
            lines.push('- Recent team changes: none observed');
        }
        return lines.join('\n');
    }
    async tick(forceFetch = false) {
        if (this.running)
            return;
        this.running = true;
        try {
            const current = await this.store.status();
            if (!current) {
                this.lastState = null;
                this.lastSignature = 'null';
                return;
            }
            this.lastSync = await this.store.sync({
                fetch: forceFetch,
                updatePresence: false,
                writeActivity: false,
            });
            this.lastSyncAt = new Date().toISOString();
            this.recordRemoteDiff(this.lastSync);
            const nextState = this.lastSync.state ?? current;
            const nextSignature = stateSignature(nextState);
            if (this.lastSignature !== 'uninitialized' && nextSignature !== this.lastSignature) {
                this.recordDiff(this.lastState, nextState);
            }
            this.lastState = nextState;
            this.lastSignature = nextSignature;
        }
        catch {
            // Watcher is advisory; failures must not affect the main robotics session.
        }
        finally {
            this.running = false;
        }
    }
    record(message) {
        this.events.push({ at: new Date().toISOString(), message });
        if (this.events.length > 20)
            this.events = this.events.slice(-20);
    }
    recordRemoteDiff(sync) {
        const signature = JSON.stringify({
            upstreamBranch: sync.upstreamBranch ?? '',
            ahead: sync.ahead ?? 0,
            behind: sync.behind ?? 0,
            remoteTeamChanges: sync.remoteTeamChanges,
        });
        if (this.lastRemoteSignature !== 'uninitialized' && signature !== this.lastRemoteSignature) {
            if ((sync.behind ?? 0) > 0) {
                this.record(`remote ${sync.upstreamBranch ?? 'upstream'} is ${sync.behind} commit(s) ahead of local branch`);
            }
            if (sync.remoteTeamChanges.length > 0) {
                this.record(`remote team files changed: ${sync.remoteTeamChanges.slice(0, 5).join(', ')}`);
            }
        }
        this.lastRemoteSignature = signature;
    }
    recordDiff(prev, next) {
        if (!prev) {
            this.record('team state became available');
            return;
        }
        const prevTasks = byId(prev.tasks);
        const nextTasks = byId(next.tasks);
        for (const task of next.tasks) {
            const old = prevTasks.get(task.id);
            if (!old) {
                this.record(`new task ${task.id}: ${task.title}`);
                continue;
            }
            if (old.status !== task.status) {
                this.record(`${task.id} status changed ${old.status} -> ${task.status}`);
            }
            if ((old.ownerUnit ?? '') !== (task.ownerUnit ?? '')) {
                this.record(`${task.id} owner changed ${old.ownerUnit ?? 'unclaimed'} -> ${task.ownerUnit ?? 'unclaimed'}`);
            }
            if ((old.branch ?? '') !== (task.branch ?? '')) {
                this.record(`${task.id} branch changed ${old.branch ?? 'none'} -> ${task.branch ?? 'none'}`);
            }
        }
        for (const task of prev.tasks) {
            if (!nextTasks.has(task.id))
                this.record(`task removed: ${task.id}`);
        }
        const prevModules = new Map(prev.modules.map(m => [m.name, m]));
        for (const mod of next.modules) {
            const old = prevModules.get(mod.name);
            if (!old) {
                this.record(`new module boundary: ${mod.name}`);
            }
            else if ((old.ownerUnit ?? '') !== (mod.ownerUnit ?? '')) {
                this.record(`module ${mod.name} owner changed ${old.ownerUnit ?? 'unclaimed'} -> ${mod.ownerUnit ?? 'unclaimed'}`);
            }
        }
        const prevUnits = byId(prev.units);
        for (const unit of next.units) {
            const old = prevUnits.get(unit.id);
            if (!old) {
                this.record(`unit joined: ${unit.id}`);
            }
            else if ((old.currentTask ?? '') !== (unit.currentTask ?? '')) {
                this.record(`unit ${unit.id} task changed ${old.currentTask ?? 'none'} -> ${unit.currentTask ?? 'none'}`);
            }
        }
    }
}
//# sourceMappingURL=TeamWatcher.js.map