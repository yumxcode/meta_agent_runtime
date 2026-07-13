import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { createInstance } from '../../../instance/InstanceStore.js'
import { WakeStore } from '../../../wake/WakeStore.js'
import { walkResearchCharter } from '../../../__tests__/testCharter.js'
import {
  commitResearchArtifacts,
  reconcileResearchArtifacts,
} from '../ResearchArtifacts.js'

describe('ResearchArtifacts', () => {
  it('bootstraps legacy history, commits atomically by event, and rebuilds projections', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'research-artifacts-'))
    const instance = await createInstance({
      projectDir: dir, charter: walkResearchCharter(), wakeStore: new WakeStore(dir),
    })
    await instance.ledger.appendJsonl(instance.paths.findingsJsonl, { claim: 'legacy', evidence: 'e0' })
    await instance.ledger.replaceJson(instance.paths.directionsJson, {
      directions: [{ key: 'legacy-direction' }],
    })
    await reconcileResearchArtifacts(instance)

    await mkdir(instance.paths.draftsDir, { recursive: true })
    await writeFile(join(instance.paths.draftsDir, 'findings_draft.json'), JSON.stringify([
      { claim: 'new', evidence: 'e1' },
    ]))
    await writeFile(join(instance.paths.draftsDir, 'direction.json'), JSON.stringify({ key: 'new-direction' }))
    const result = await commitResearchArtifacts(instance, {
      round: 1, producerOk: true, judgeRequired: true,
      judge: { ok: true, data: { verdict: 'pass', messages: [] } },
    })
    expect(result).toMatchObject({ committed: { finding: 1, direction: 1 }, rejected: 0 })

    const findings = (await readFile(instance.paths.findingsJsonl, 'utf-8')).trim().split('\n')
      .map(line => JSON.parse(line))
    expect(findings.map(finding => finding.claim)).toEqual(['legacy', 'new'])
    const directions = JSON.parse(await readFile(instance.paths.directionsJson, 'utf-8'))
    expect(directions.directions.map((direction: { key: string }) => direction.key)).toEqual([
      'legacy-direction', 'new-direction',
    ])
    const projectionIndex = JSON.parse(await readFile(instance.paths.researchProjectionIndexJson, 'utf-8'))
    expect(projectionIndex).toMatchObject({ lastTransactionId: 'round:1', findingsCount: 2 })
    const events = await instance.ledger.readJsonl<{ type: string }>(instance.paths.artifactsJsonl)
    expect(events.map(event => event.type)).toContain('artifact.transaction_committed')

    // Simulate a crash after the authoritative commit but before/between legacy
    // projection writes. RECONCILE must reproduce both files without duplicates.
    await rm(instance.paths.findingsJsonl, { force: true })
    await instance.ledger.replaceJson(instance.paths.directionsJson, { directions: [] })
    await reconcileResearchArtifacts(instance)
    expect((await readFile(instance.paths.findingsJsonl, 'utf-8')).trim().split('\n')).toHaveLength(2)
    expect(JSON.parse(await readFile(instance.paths.directionsJson, 'utf-8')).directions).toHaveLength(2)

    const repeated = await commitResearchArtifacts(instance, {
      round: 1, producerOk: true, judgeRequired: true,
      judge: { ok: true, data: { verdict: 'pass', messages: [] } },
    })
    expect(repeated.committed).toEqual({ finding: 1, direction: 1 })
    expect((await readFile(instance.paths.findingsJsonl, 'utf-8')).trim().split('\n')).toHaveLength(2)
    expect((await stat(instance.paths.findingsJsonl)).size).toBe(projectionIndex.findingsBytes)
  })

  it('can reject findings while committing an independently gated direction', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'research-artifacts-reject-'))
    const instance = await createInstance({
      projectDir: dir, charter: walkResearchCharter(), wakeStore: new WakeStore(dir),
    })
    await reconcileResearchArtifacts(instance)
    await writeFile(join(instance.paths.draftsDir, 'findings_draft.json'), JSON.stringify([
      { claim: 'unsupported', evidence: 'none' },
    ]))
    await writeFile(join(instance.paths.draftsDir, 'direction.json'), JSON.stringify({ key: 'valid-direction' }))
    const result = await commitResearchArtifacts(instance, {
      round: 1, producerOk: true, judgeRequired: true,
      judge: { ok: true, data: { verdict: 'fail', messages: ['insufficient evidence'] } },
    })
    expect(result).toEqual({
      transactionId: 'round:1', committed: { finding: 0, direction: 1 },
      admittedItems: 0, rejected: 1,
    })
    await expect(readFile(instance.paths.findingsJsonl, 'utf-8')).rejects.toThrow()
    expect(JSON.parse(await readFile(instance.paths.directionsJson, 'utf-8')).directions).toHaveLength(1)
  })

  it('commits only judge-accepted finding indexes from a mixed draft', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'research-artifacts-per-item-'))
    const instance = await createInstance({
      projectDir: dir, charter: walkResearchCharter(), wakeStore: new WakeStore(dir),
    })
    await reconcileResearchArtifacts(instance)
    await writeFile(join(instance.paths.draftsDir, 'findings_draft.json'), JSON.stringify([
      { claim: 'valid', evidence: 'complete' },
      { claim: 'invalid', evidence: 'missing task id' },
      { claim: 'also-valid', evidence: 'complete' },
    ]))
    const result = await commitResearchArtifacts(instance, {
      round: 1, producerOk: true, judgeRequired: true,
      judge: {
        ok: true,
        data: {
          verdict: 'pass', accepted_finding_indexes: [0, 2],
          new_findings_count: 2, messages: ['finding 1 missing task id'],
        },
      },
    })
    expect(result).toMatchObject({ committed: { finding: 2 }, admittedItems: 2, rejected: 1 })
    const findings = (await readFile(instance.paths.findingsJsonl, 'utf-8')).trim().split('\n')
      .map(line => JSON.parse(line) as { claim: string })
    expect(findings.map(finding => finding.claim)).toEqual(['valid', 'also-valid'])
  })

  it('appends the compatibility finding projection on the hot path and rebuilds a lost watermark', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'research-projection-index-'))
    const instance = await createInstance({
      projectDir: dir, charter: walkResearchCharter(), wakeStore: new WakeStore(dir),
    })
    await reconcileResearchArtifacts(instance)
    let firstInode = 0n
    for (let round = 1; round <= 2; round++) {
      await writeFile(join(instance.paths.draftsDir, 'findings_draft.json'), JSON.stringify([
        { claim: `finding-${round}`, evidence: `e${round}` },
      ]))
      await commitResearchArtifacts(instance, {
        round, producerOk: true, judgeRequired: true,
        judge: { ok: true, data: { verdict: 'pass', messages: [] } },
      })
      if (round === 1) firstInode = (await stat(instance.paths.findingsJsonl, { bigint: true })).ino
    }
    expect((await stat(instance.paths.findingsJsonl, { bigint: true })).ino).toBe(firstInode)
    expect((await readFile(instance.paths.findingsJsonl, 'utf-8')).trim().split('\n')).toHaveLength(2)

    await rm(instance.paths.researchProjectionIndexJson, { force: true })
    await reconcileResearchArtifacts(instance)
    const rebuilt = JSON.parse(await readFile(instance.paths.researchProjectionIndexJson, 'utf-8'))
    expect(rebuilt).toMatchObject({ lastTransactionId: 'round:2', findingsCount: 2 })
  })
})
