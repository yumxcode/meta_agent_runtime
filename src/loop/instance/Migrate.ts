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
 *     human ack: the charter was amended in response to the report);
 *   • re-arm RESETS the meters behind the fired escalation (onResume.resetMeters,
 *     defaulting to the meters the tripwire's expression references) — otherwise
 *     the same tripwire would re-fire on the next round's ROUTE and the loop
 *     would pause again without doing any work.
 */
import { createHash } from 'crypto'
import { dirname, join } from 'path'
import { atomicWriteJson } from '../../infra/persist/index.js'
import type { Charter, FrozenCharter } from '../charter/CharterTypes.js'
import { freezeCharter } from '../charter/CharterValidate.js'
import { collectRefs } from '../expr/Expr.js'
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
  /** Meters zeroed by the re-arm (empty when not re-arming). */
  resetMeters: string[]
}

/**
 * Which meters must be zeroed so the fired escalation cannot instantly re-fire.
 * Explicit onResume.resetMeters wins; default = identifiers referenced by the
 * fired tripwire's expression, intersected with the meters. When the fired
 * index is unknown (pre-v3 instance records), every escalate tripwire counts.
 */
export function reArmResetTargets(
  charter: FrozenCharter,
  meterNames: ReadonlySet<string>,
  firedIndex: number | undefined,
): string[] {
  const targets = new Set<string>()
  const indices = firedIndex !== undefined
    ? [firedIndex]
    : charter.tripwires.flatMap((tw, i) => (tw.then.act === 'escalate' ? [i] : []))
  for (const i of indices) {
    const action = charter.tripwires[i]?.then
    if (!action || action.act !== 'escalate') continue
    const names = action.onResume?.resetMeters
      ?? (charter.frozen.tripwireAsts[i] ? collectRefs(charter.frozen.tripwireAsts[i]!) : [])
    for (const name of names) if (meterNames.has(name)) targets.add(name)
  }
  return [...targets]
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
  if (record.status === 'paused_manual') {
    // Migrating a manually-paused instance would end with status 'idle' but its
    // wakes cancelled — a frozen loop nothing re-arms. Resume first.
    throw new Error("cannot migrate while 'paused_manual' — run `loop resume` first")
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

  // Re-arm reset: computed against the OLD charter (the one whose tripwire
  // fired), applied to whatever carried over into the new meter set.
  const reArming = record.status === 'paused_attention'
  const resetMeters = reArming
    ? reArmResetTargets(instance.charter, newMeterNames, record.lastEscalation?.tripwireIndex)
    : []
  for (const name of resetMeters) carried[name] = 0

  const entry: MigrationEntry = {
    at: Date.now(),
    fromVersion: record.charterVersion,
    toVersion: frozen.version,
    fromHash: record.charterHash,
    toHash,
    carriedMeters: Object.keys(carried).filter(n => n in progress.meters),
    newMeters: [...newMeterNames].filter(n => !(n in progress.meters)),
    droppedMeters: dropped,
    reArmed: reArming,
    resetMeters,
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
  // The escalation is acknowledged by this migration — clear its marker.
  if (reArming) delete instance.record.lastEscalation
  await atomicWriteJson(paths.instanceJson, instance.record)
  // Re-arm also clears the terminal-ish progress status: the offending meters
  // were just reset, and the next round's ROUTE recomputes the truth anyway.
  await ledger.writeProgress({
    ...progress,
    meters: carried,
    ...(reArming ? { status: 'healthy' as const } : {}),
    updatedAt: Date.now(),
  })

  if (entry.reArmed) {
    await setInstanceStatus(instance, 'idle', `migrated to v${frozen.version} (human ack)`)
    // Fallback workspace = two levels above the instance root
    // (<workspace>/.loop/<id>): a WakeStore rooted at paths.root would write
    // wakes into <instance>/.loop/wakes, which no scheduler ever scans — the
    // re-armed loop would never wake.
    const wakeStore = opts?.wakeStore ?? new WakeStore(opts?.projectDir ?? dirname(dirname(paths.root)))
    await wakeStore.schedule({ loopId: record.instanceId, kind: 'timer', fireAt: Date.now() })
  } else {
    await setInstanceStatus(instance, 'idle', `migrated to v${frozen.version}`)
  }
  return entry
}
