import { rm } from 'fs/promises'
import { join } from 'path'
import { atomicWriteJson, readJsonFile, withFileLock } from '../../infra/persist/index.js'
import type { FrozenCharter } from '../charter/CharterTypes.js'
import { Ledger, type ProgressView } from '../ledger/LedgerApi.js'
import type { InstancePaths, LoopInstanceRecord } from '../types.js'

export interface MigrationRecoveryMarker {
  schemaVersion: '1.0'
  migrationId: string
  frozenCharter: FrozenCharter
  record: LoopInstanceRecord
  progress: ProgressView
  audit: Record<string, unknown> & { migrationId: string }
  createdAt: number
}

export async function writeMigrationMarker(
  paths: InstancePaths,
  marker: MigrationRecoveryMarker,
): Promise<void> {
  await atomicWriteJson(paths.migrationPendingJson, marker)
}

/** Complete every migration write idempotently, then remove the intent. */
export async function completePendingMigration(paths: InstancePaths): Promise<boolean> {
  const marker = await readJsonFile<MigrationRecoveryMarker>(paths.migrationPendingJson)
  if (!marker) return false
  if (marker.schemaVersion !== '1.0' || !marker.migrationId ||
      marker.audit?.migrationId !== marker.migrationId) {
    throw new Error(`invalid migration recovery marker at ${paths.migrationPendingJson}`)
  }
  await withFileLock(paths.migrationPendingJson, async () => {
    const current = await readJsonFile<MigrationRecoveryMarker>(paths.migrationPendingJson)
    if (!current) return
    const ledger = new Ledger(paths)
    const audits = await ledger.readJsonl<{ migrationId?: string }>(
      join(paths.ledgerDir, 'migrations.jsonl'),
    )
    if (!audits.some(entry => entry.migrationId === current.migrationId)) {
      await ledger.appendJsonl(join(paths.ledgerDir, 'migrations.jsonl'), current.audit)
    }
    await atomicWriteJson(paths.frozenCharter, current.frozenCharter)
    await atomicWriteJson(paths.instanceJson, current.record)
    await atomicWriteJson(paths.progressJson, current.progress)
    await rm(paths.migrationPendingJson, { force: true })
  }, { staleMs: 5 * 60_000, timeoutMs: 60_000 })
  return true
}
