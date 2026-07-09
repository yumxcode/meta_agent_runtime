/**
 * InstanceStore — loop instantiation and status transitions (spec §2 阶段二).
 *
 * `createInstance` is the pure-code act the design doc promises: validate +
 * freeze the charter (D9), lay down the ledger skeleton, register the first
 * wake. Idempotent: creating an instanceId that already exists is a no-op
 * returning the existing record (re-running a provisioning script is safe).
 */
import { createHash } from 'crypto'
import { mkdir } from 'fs/promises'
import { atomicWriteJson, readJsonFile } from '../../infra/persist/index.js'
import type { Charter, FrozenCharter } from '../charter/CharterTypes.js'
import { freezeCharter, normalizeCharter } from '../charter/CharterValidate.js'
import { Ledger, withBuiltinSchemas } from '../ledger/LedgerApi.js'
import { WakeStore } from '../wake/WakeStore.js'
import {
  instancePaths,
  type InstancePaths,
  type LoopInstanceId,
  type LoopInstanceRecord,
  type LoopInstanceStatus,
} from '../types.js'

export interface CreateInstanceInput {
  projectDir: string
  charter: Charter
  /** Stable id (idempotency key). Default: `<charterId>-v<version>`. */
  instanceId?: LoopInstanceId
  /** First wake time. Default: now (run immediately). */
  firstFireAt?: number
  wakeStore?: WakeStore
}

export interface LoopInstance {
  record: LoopInstanceRecord
  charter: FrozenCharter
  paths: InstancePaths
  ledger: Ledger
}

export async function createInstance(input: CreateInstanceInput): Promise<LoopInstance> {
  const instanceId = input.instanceId ?? `${input.charter.id}-v${input.charter.version}`
  const paths = instancePaths(input.projectDir, instanceId)

  const existing = await readJsonFile<LoopInstanceRecord>(paths.instanceJson)
  if (existing) return loadInstanceFrom(paths, existing)

  const frozen = freezeCharter(input.charter)   // throws on invalid charter
  const charterHash = createHash('sha256').update(JSON.stringify(frozen)).digest('hex')

  for (const dir of [paths.ledgerDir, paths.draftsDir, paths.inboxDir, paths.processedDir, paths.eventsDir, paths.reportsDir]) {
    await mkdir(dir, { recursive: true })
  }
  await atomicWriteJson(paths.frozenCharter, frozen)

  const ledger = withBuiltinSchemas(new Ledger(paths), paths)
  await ledger.writeProgress({
    iteration: 0,
    meters: Object.fromEntries(frozen.meters.map(m => [m.name, 0])),
    status: 'healthy',
    bestMetric: null,
    totalFindings: 0,
    totalCostUsd: 0,
    updatedAt: Date.now(),
  })
  await ledger.replaceJson(paths.directionsJson, { directions: [] })

  const record: LoopInstanceRecord = {
    schemaVersion: '1.0',
    instanceId,
    charterId: frozen.id,
    charterVersion: frozen.version,
    charterHash,
    projectDir: paths.root,
    status: 'idle',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  await atomicWriteJson(paths.instanceJson, record)

  const wakeStore = input.wakeStore ?? new WakeStore(input.projectDir)
  await wakeStore.schedule({
    loopId: instanceId,
    kind: 'timer',
    fireAt: input.firstFireAt ?? Date.now(),
  })
  return { record, charter: frozen, paths, ledger }
}

export async function loadInstance(
  projectDir: string,
  instanceId: LoopInstanceId,
): Promise<LoopInstance | null> {
  const paths = instancePaths(projectDir, instanceId)
  const record = await readJsonFile<LoopInstanceRecord>(paths.instanceJson)
  if (!record) return null
  return loadInstanceFrom(paths, record)
}

async function loadInstanceFrom(paths: InstancePaths, record: LoopInstanceRecord): Promise<LoopInstance> {
  const charter = await readJsonFile<FrozenCharter>(paths.frozenCharter)
  if (!charter) throw new Error(`instance ${record.instanceId} is missing its frozen charter`)
  return {
    record,
    // Pre-v3 frozen snapshots carry legacy tripwire actions; normalize on every
    // load (deterministic, in-memory only — the on-disk snapshot/hash is untouched).
    charter: normalizeCharter(charter),
    paths,
    ledger: withBuiltinSchemas(new Ledger(paths), paths),
  }
}

export async function setInstanceStatus(
  instance: LoopInstance,
  status: LoopInstanceStatus,
  reason?: string,
): Promise<void> {
  instance.record = {
    ...instance.record,
    status,
    statusReason: reason,
    updatedAt: Date.now(),
  }
  await atomicWriteJson(instance.paths.instanceJson, instance.record)
}
