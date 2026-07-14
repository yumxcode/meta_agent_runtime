import { describe, expect, it } from 'vitest'
import { mkdtemp, writeFile, readdir, mkdir } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { archiveInbox, buildCapsule, readInbox, renderCapsule } from '../CapsuleBuilder.js'
import { createInstance } from '../../instance/InstanceStore.js'
import { WakeStore } from '../../wake/WakeStore.js'
import { walkResearchCharter } from '../../__tests__/testCharter.js'

async function freshInstance() {
  const dir = await mkdtemp(join(tmpdir(), 'loop-capsule-'))
  const instance = await createInstance({
    projectDir: dir,
    charter: walkResearchCharter(),
    wakeStore: new WakeStore(dir),
  })
  return { dir, instance }
}

describe('createInstance', () => {
  it('lays down the full skeleton, freezes the charter, registers a wake', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'loop-inst-'))
    const wakeStore = new WakeStore(dir)
    const inst = await createInstance({ projectDir: dir, charter: walkResearchCharter(), wakeStore })
    expect(inst.record.status).toBe('idle')
    expect(inst.charter.frozen.tripwireAsts).toHaveLength(3)
    expect((await inst.ledger.readProgress()).meters).toEqual({ iteration: 0, stale_count: 0 })
    const wakes = await wakeStore.list()
    expect(wakes).toHaveLength(1)
    expect(wakes[0]!.loopId).toBe(inst.record.instanceId)
  })

  it('is idempotent on instanceId (re-create returns existing, no second wake)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'loop-inst-idem-'))
    const wakeStore = new WakeStore(dir)
    const a = await createInstance({ projectDir: dir, charter: walkResearchCharter(), wakeStore })
    const b = await createInstance({ projectDir: dir, charter: walkResearchCharter(), wakeStore })
    expect(b.record.createdAt).toBe(a.record.createdAt)
    expect(await wakeStore.list()).toHaveLength(1)
  })

  it('refuses to instantiate an invalid charter', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'loop-inst-bad-'))
    await expect(createInstance({
      projectDir: dir,
      charter: walkResearchCharter({ tripwires: [] }),
      wakeStore: new WakeStore(dir),
    })).rejects.toThrow(/charter failed validation/)
  })
})

describe('buildCapsule', () => {
  it('digests ledger state; inbox consumption is transactional (read stays, archive moves)', async () => {
    const { instance } = await freshInstance()
    await instance.ledger.appendJsonl(instance.paths.findingsJsonl, { id: 'f1', claim: 'single_foot_contact 提升步态' })
    await instance.ledger.replaceJson(instance.paths.directionsJson, { directions: [{ key: 'reward-shaping' }] })
    await mkdir(instance.paths.inboxDir, { recursive: true })
    await writeFile(join(instance.paths.inboxDir, '001.json'), JSON.stringify({ message: '别再调 sigma 了' }), 'utf-8')

    const capsule = await buildCapsule({
      paths: instance.paths, ledger: instance.ledger,
      goal: instance.charter.goal, round: 1, mode: 'normal',
    })
    expect(capsule.directionsTried).toEqual(['reward-shaping'])
    expect(capsule.recentFindings).toHaveLength(1)
    expect(capsule.inboxMessages).toEqual(['别再调 sigma 了'])

    // NON-destructive: buildCapsule never moves inbox files — an aborted or
    // replayed round re-reads the same feedback (transactional consumption).
    const rebuilt = await buildCapsule({
      paths: instance.paths, ledger: instance.ledger,
      goal: instance.charter.goal, round: 1, mode: 'normal',
    })
    expect(rebuilt.inboxMessages).toEqual(['别再调 sigma 了'])

    // The kernel archives AFTER the round durably commits; then it is gone.
    const inbox = await readInbox(instance.paths)
    expect(inbox.files).toEqual(['001.json'])
    await archiveInbox(instance.paths, inbox.files)
    expect(await readdir(instance.paths.processedDir)).toHaveLength(1)
    const again = await buildCapsule({
      paths: instance.paths, ledger: instance.ledger,
      goal: instance.charter.goal, round: 1, mode: 'normal',
    })
    expect(again.inboxMessages).toEqual([])
  })

  it('renderCapsule surfaces feedback, dedup guard, and pivot directive', async () => {
    const { instance } = await freshInstance()
    const capsule = await buildCapsule({
      paths: instance.paths, ledger: instance.ledger,
      goal: instance.charter.goal, round: 4, mode: 'pivot',
      pivotDirective: '放弃调参，改接触相位约束',
    })
    const text = renderCapsule(capsule)
    expect(text).toContain('模式: pivot')
    expect(text).toContain('结构性转向指令')
    expect(text).toContain('接触相位约束')
  })

  it('truncates oversized entries (size-bounded by construction)', async () => {
    const { instance } = await freshInstance()
    await instance.ledger.appendJsonl(instance.paths.findingsJsonl, { id: 'f1', claim: 'x'.repeat(5000) })
    const capsule = await buildCapsule({
      paths: instance.paths, ledger: instance.ledger,
      goal: instance.charter.goal, round: 1, mode: 'normal',
    })
    expect(capsule.recentFindings[0]!.length).toBeLessThanOrEqual(400)
  })
})
