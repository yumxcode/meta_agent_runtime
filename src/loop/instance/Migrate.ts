/**
 * Migrate — explicit charter migration for a RUNNING instance (spec T3.2, D9).
 *
 * D9 froze the charter at instantiation so library edits can never silently
 * change a live loop. Migration is the ONE sanctioned path: a human runs
 * `loop migrate`, the new version is frozen, and an audit entry records the
 * hop. Rules:
 *   • only an idle or paused_attention instance may migrate (never mid-round,
 *     never while waiting on an effect whose wait policy might change);
 *   • same charter id — migrating to a different loop's charter is a create,
 *     not a migrate;
 *   • meters carry over by NAME (new meters start at 0; dropped meters are
 *     archived in the audit entry, their history stays in rounds.jsonl);
 *   • migration of a paused_attention instance also re-arms it (that IS the
 *     human ack: the charter was amended in response to the report).
 */
import { createHash } from 'crypto'
import { join } from 'path'
import { atomicWriteJson } from '../../infra/persist/index.js'
import type { Charter } from '../charter/CharterTypes.js'
import { freezeCharter } from '../charter/CharterValidate.js'
import { WakeStore } from '../wake/WakeStore.js'
import type { LoopInstance } from './InstanceStore.js'
import { setInstanceStatus } from './InstanceStore.js'

export interface MigrationEntry {
  at: number
  fromVersion: number
  toVersion: number
  fromHash: string
  toHash: string
  carriedMeters: string[]
  newMeters: string[]
  droppedMeters: Record<string, number>
  reArmed: boolean
}

export async function migrateInstance(
  instance: LoopInstance,
  newCharter: Charter,
  opts?: { wakeStore?: WakeStore; projectDir?: string },
): Promise<MigrationEntry> {
  const { record, paths, ledger } = instance
  if (newCharter.id !== record.charterId) {
    throw new Error(
      `migrate refuses a different charter id ('${newCharter.id}' vs '${record.charterId}') — create a new loop instead`,
    )
  }
  if (newCharter.version <= record.charterVersion) {
    throw new Error(
      `migrate needs a NEWER version (instance at v${record.charterVersion}, got v${newCharter.version})`,
    )
  }
  if (record.status !== 'idle' && record.status !== 'paused_attention') {
    throw new Error(`cannot migrate while '${record.status}' — wait for idle or a paused escalation`)
  }

  const frozen = freezeCharter(newCharter) // throws with instructive errors
  const toHash = createHash('sha256').update(JSON.stringify(frozen)).digest('hex')

  // Meter carry-over by name.
  const progress = await ledger.readProgress()
  const newMeterNames = new Set(frozen.meters.map(m => m.name))
  const carried: Record<string, number> = {}
  const dropped: Record<string, number> = {}
  for (const [name, value] of Object.entries(progress.meters)) {
    if (newMeterNames.has(name)) carried[name] = value
    else dropped[name] = value
  }
  for (const name of newMeterNames) carried[name] ??= 0

  const entry: MigrationEntry = {
    at: Date.now(),
    fromVersion: record.charterVersion,
    toVersion: frozen.version,
    fromHash: record.charterHash,
    toHash,
    carriedMeters: Object.keys(carried).filter(n => n in progress.meters),
    newMeters: [...newMeterNames].filter(n => !(n in progress.meters)),
    droppedMeters: dropped,
    reArmed: record.status === 'paused_attention',
  }

  // Order: audit first (append-only), then the swap, then progress/status.
  await ledger.appendJsonl(join(paths.ledgerDir, 'migrations.jsonl'), entry)
  await atomicWriteJson(paths.frozenCharter, frozen)
  instance.charter = frozen
  instance.record = {
    ...record,
    charterVersion: frozen.version,
    charterHash: toHash,
    updatedAt: Date.now(),
  }
  await atomicWriteJson(paths.instanceJson, instance.record)
  await ledger.writeProgress({ ...progress, meters: carried, updatedAt: Date.now() })

  if (entry.reArmed) {
    await setInstanceStatus(instance, 'idle', `migrated to v${frozen.version} (human ack)`)
    const wakeStore = opts?.wakeStore ?? new WakeStore(opts?.projectDir ?? paths.root)
    await wakeStore.schedule({ loopId: record.instanceId, kind: 'timer', fireAt: Date.now() })
  } else {
    await setInstanceStatus(instance, 'idle', `migrated to v${frozen.version}`)
  }
  return entry
}
