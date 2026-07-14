import { describe, expect, it } from 'vitest'
import { access, mkdtemp, writeFile, readdir, mkdir } from 'fs/promises'
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
    await mkdir(instance.paths.inboxDir, { recursive: true })
    await writeFile(join(instance.paths.inboxDir, '001.json'), JSON.stringify({ message: '别再调 sigma 了' }), 'utf-8')

    const capsule = await buildCapsule({
      paths: instance.paths, ledger: instance.ledger,
      goal: instance.charter.goal, round: 1, mode: 'normal',
      scenario: {
        id: instance.charter.scenario,
        view: {
          schemaVersion: 1, data: {}, sections: [
            { title: '已试方向', items: ['reward-shaping'] },
            { title: '近期 findings', items: ['single_foot_contact 提升步态'] },
          ],
        },
      },
    })
    expect(capsule.scenario.view.sections[0]!.items).toEqual(['reward-shaping'])
    expect(capsule.scenario.view.sections[1]!.items).toHaveLength(1)
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
    const capsule = await buildCapsule({
      paths: instance.paths, ledger: instance.ledger,
      goal: instance.charter.goal, round: 1, mode: 'normal',
      scenario: {
        id: instance.charter.scenario,
        view: {
          schemaVersion: 1, data: {},
          sections: [{ title: 'large', items: ['x'.repeat(5000)] }],
        },
      },
    })
    const rendered = renderCapsule(capsule)
    expect(rendered.split('\n').find(line => line.startsWith('- x'))!.length).toBeLessThanOrEqual(402)
  })

  it('limits one ingestion batch and quarantines oversized inbox files', async () => {
    const { instance } = await freshInstance()
    await mkdir(instance.paths.inboxDir, { recursive: true })
    await Promise.all(Array.from({ length: 40 }, (_, i) => writeFile(
      join(instance.paths.inboxDir, `${String(i).padStart(2, '0')}.txt`), `message-${i}`,
    )))
    const first = await readInbox(instance.paths)
    expect(first.files).toHaveLength(32)

    const huge = join(instance.paths.inboxDir, '00-huge.txt')
    await writeFile(huge, 'x'.repeat(256 * 1024 + 1))
    const bounded = await readInbox(instance.paths)
    expect(bounded.files).not.toContain('00-huge.txt')
    await expect(access(`${huge}.oversize`)).resolves.toBeUndefined()
  })
})
