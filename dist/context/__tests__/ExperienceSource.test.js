import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, describe, expect, it } from 'vitest';
import { ExperienceStore } from '../../robotics/ExperienceStore.js';
import { ExperienceSource } from '../sources/ExperienceSource.js';
// ─────────────────────────────────────────────────────────────────────────────
// Temp-dir lifecycle
// ─────────────────────────────────────────────────────────────────────────────
const tempDirs = [];
async function tempDir() {
    const dir = await mkdtemp(join(tmpdir(), 'meta-agent-expsrc-'));
    tempDirs.push(dir);
    return dir;
}
afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map(d => rm(d, { recursive: true, force: true })));
});
// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
async function writeEntry(store, domain, title, success, abstractPrinciple) {
    return store.write({
        domain,
        title,
        tags: [],
        difficulty: 'medium',
        problem: `Problem for ${title}`,
        solution: `Solution for ${title}`,
        outcome: {
            success,
            summary: `Outcome for ${title}`,
            failureReason: success ? undefined : `Root cause for ${title}`,
        },
        abstractPrinciple,
    });
}
// ─────────────────────────────────────────────────────────────────────────────
// listExperiences — domain filtering
// ─────────────────────────────────────────────────────────────────────────────
describe('ExperienceSource — listExperiences domain filtering', () => {
    it('returns all entries when no domain filter is provided', async () => {
        const dir = await tempDir();
        const store = new ExperienceStore(dir);
        await writeEntry(store, 'perception', 'Camera OOM', false);
        await writeEntry(store, 'motion_planning', 'RRT timeout', false);
        await writeEntry(store, 'navigation', 'Costmap error', false);
        const source = new ExperienceSource(store);
        const results = await source.listExperiences();
        expect(results).toHaveLength(3);
    });
    it('filters to matching domain when one domain is given', async () => {
        const dir = await tempDir();
        const store = new ExperienceStore(dir);
        await writeEntry(store, 'perception', 'Camera OOM', false);
        await writeEntry(store, 'motion_planning', 'RRT timeout', false);
        const source = new ExperienceSource(store);
        const results = await source.listExperiences({ domains: ['perception'] });
        expect(results).toHaveLength(1);
        expect(results[0].domain).toBe('perception');
        expect(results[0].title).toBe('Camera OOM');
    });
    it('filters to multiple domains when multiple are given', async () => {
        const dir = await tempDir();
        const store = new ExperienceStore(dir);
        await writeEntry(store, 'perception', 'Lidar OOM', false);
        await writeEntry(store, 'motion_planning', 'Path failure', false);
        await writeEntry(store, 'calibration', 'Extrinsic drift', false);
        const source = new ExperienceSource(store);
        const results = await source.listExperiences({ domains: ['perception', 'calibration'] });
        expect(results).toHaveLength(2);
        const domains = results.map(r => r.domain);
        expect(domains).toContain('perception');
        expect(domains).toContain('calibration');
        expect(domains).not.toContain('motion_planning');
    });
    it('returns empty array when domain filter matches nothing', async () => {
        const dir = await tempDir();
        const store = new ExperienceStore(dir);
        await writeEntry(store, 'perception', 'Camera OOM', false);
        const source = new ExperienceSource(store);
        const results = await source.listExperiences({ domains: ['locomotion'] });
        expect(results).toHaveLength(0);
    });
});
// ─────────────────────────────────────────────────────────────────────────────
// listExperiences — both successes and failures
// ─────────────────────────────────────────────────────────────────────────────
describe('ExperienceSource — includes both successes and failures', () => {
    it('returns successful experiences alongside failures', async () => {
        const dir = await tempDir();
        const store = new ExperienceStore(dir);
        await writeEntry(store, 'perception', 'OOM failure', false);
        await writeEntry(store, 'perception', 'Optimised success', true);
        const source = new ExperienceSource(store);
        const results = await source.listExperiences();
        const outcomes = results.map(r => r.outcome);
        expect(outcomes).toContain('success');
        expect(outcomes).toContain('failure');
    });
});
// ─────────────────────────────────────────────────────────────────────────────
// abstractPrinciple fallback
// ─────────────────────────────────────────────────────────────────────────────
describe('ExperienceSource — abstractPrinciple fallback', () => {
    it('uses abstractPrinciple when stored', async () => {
        const dir = await tempDir();
        const store = new ExperienceStore(dir);
        await writeEntry(store, 'perception', 'Camera OOM', false, 'Allocate memory budgets up front.');
        const source = new ExperienceSource(store);
        const [result] = await source.listExperiences();
        expect(result.abstractPrinciple).toBe('Allocate memory budgets up front.');
    });
    it('falls back to outcome.summary when abstractPrinciple is absent (older entries)', async () => {
        const dir = await tempDir();
        const store = new ExperienceStore(dir);
        // Write without abstractPrinciple
        await writeEntry(store, 'perception', 'Old entry without principle', false, undefined);
        const source = new ExperienceSource(store);
        const [result] = await source.listExperiences();
        // Should fall back to the outcome summary, not undefined
        expect(result.abstractPrinciple).toBeTruthy();
        expect(typeof result.abstractPrinciple).toBe('string');
    });
});
// ─────────────────────────────────────────────────────────────────────────────
// listExperiences — limit
// ─────────────────────────────────────────────────────────────────────────────
describe('ExperienceSource — limit enforcement', () => {
    it('respects the limit parameter', async () => {
        const dir = await tempDir();
        const store = new ExperienceStore(dir);
        for (let i = 0; i < 8; i++) {
            await writeEntry(store, 'navigation', `Entry ${i}`, true);
        }
        const source = new ExperienceSource(store);
        const results = await source.listExperiences({ limit: 3 });
        expect(results).toHaveLength(3);
    });
    it('returns most recent entries first', async () => {
        const dir = await tempDir();
        const store = new ExperienceStore(dir);
        await writeEntry(store, 'navigation', 'Older entry', false);
        await new Promise(r => setTimeout(r, 10));
        await writeEntry(store, 'navigation', 'Newer entry', true);
        const source = new ExperienceSource(store);
        const results = await source.listExperiences({ limit: 2 });
        expect(results[0].title).toBe('Newer entry');
    });
});
// ─────────────────────────────────────────────────────────────────────────────
// getManifestLine
// ─────────────────────────────────────────────────────────────────────────────
describe('ExperienceSource — getManifestLine()', () => {
    it('returns placeholder when store is empty', async () => {
        const dir = await tempDir();
        const store = new ExperienceStore(dir);
        const source = new ExperienceSource(store);
        const line = await source.getManifestLine();
        expect(line).toMatch(/none yet/);
    });
    it('includes total count and failure count', async () => {
        const dir = await tempDir();
        const store = new ExperienceStore(dir);
        await writeEntry(store, 'perception', 'Success entry', true);
        await writeEntry(store, 'perception', 'Failure entry', false);
        const source = new ExperienceSource(store);
        const line = await source.getManifestLine();
        expect(line).toMatch(/2 total/);
        expect(line).toMatch(/failures: 1/);
    });
});
//# sourceMappingURL=ExperienceSource.test.js.map