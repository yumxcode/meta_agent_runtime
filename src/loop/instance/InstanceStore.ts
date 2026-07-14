/**
 * InstanceStore — loop instantiation and status transitions (spec §2 阶段二).
 *
 * `createInstance` is the pure-code act the design doc promises: validate +
 * freeze the charter (D9), lay down the ledger skeleton, register the first
 * wake. Idempotent: creating an instanceId that already exists is a no-op
 * returning the existing record (re-running a provisioning script is safe).
 */
import { createHash } from 'crypto'
import { mkdir, readdir } from 'fs/promises'
import { join, resolve } from 'path'
import { atomicWriteJson, readJsonFile, withFileLock } from '../../infra/persist/index.js'
import type { Charter, FrozenCharter } from '../charter/CharterTypes.js'
import { freezeCharter, normalizeFrozenCharterForRuntime } from '../charter/CharterValidate.js'
import { Ledger, withBuiltinSchemas } from '../ledger/LedgerApi.js'
import { WakeStore } from '../wake/WakeStore.js'
import { preflightCharterCapabilities } from '../security/CapabilityPreflight.js'
import {
  instancePaths,
  type InstancePaths,
  type LoopInstanceId,
  type LoopInstanceRecord,
  type LoopInstanceStatus,
} from '../types.js'
import { ensureWorkspaceIdentity, withWorkspaceOperationLock } from '../workspace/WorkspaceIdentity.js'
import { defaultScenarioRegistry } from '../scenarios/BuiltinScenarioPlugins.js'
import type { ScenarioRegistry } from '../scenarios/ScenarioRegistry.js'
import { completePendingMigration } from './MigrationRecovery.js'

export interface CreateInstanceInput {
  projectDir: string
  charter: Charter
  /** Stable id (idempotency key). Default: `<charterId>-v<version>`. */
  instanceId?: LoopInstanceId
  /** First wake time. Default: now (run immediately). */
  firstFireAt?: number
  wakeStore?: WakeStore
  /** Trusted Scenario plugins available to validation and future resumes. */
  scenarios?: ScenarioRegistry
}

export interface LoopInstance {
  record: LoopInstanceRecord
  charter: FrozenCharter
  paths: InstancePaths
  ledger: Ledger
  scenarios: ScenarioRegistry
}

export async function createInstance(input: CreateInstanceInput): Promise<LoopInstance> {
  return withWorkspaceOperationLock(input.projectDir, () => createInstanceUnlocked(input))
}

async function createInstanceUnlocked(input: CreateInstanceInput): Promise<LoopInstance> {
  const scenarios = input.scenarios ?? defaultScenarioRegistry
  const instanceId = input.instanceId ?? `${input.charter.id}-v${input.charter.version}`
  const paths = instancePaths(input.projectDir, instanceId)
  const workspace = await ensureWorkspaceIdentity(input.projectDir)

  await completePendingMigration(paths)
  const existing = await readJsonFile<LoopInstanceRecord>(paths.instanceJson)
  if (existing) return loadInstanceFrom(
    paths, await bindRecordToWorkspace(paths, existing, workspace.workspaceId), scenarios,
  )

  const frozen = freezeCharter(input.charter, scenarios)   // throws on invalid charter
  await preflightCharterCapabilities(frozen, input.projectDir)
  const charterHash = createHash('sha256').update(JSON.stringify(frozen)).digest('hex')

  for (const dir of [
    paths.ledgerDir, paths.draftsDir, paths.scratchDir, paths.inboxDir,
    paths.processedDir, paths.eventsDir, paths.reportsDir,
  ]) {
    await mkdir(dir, { recursive: true })
  }
  await atomicWriteJson(paths.frozenCharter, frozen)

  const ledger = withBuiltinSchemas(new Ledger(paths), paths)
  await ledger.writeProgress({
    schemaVersion: 4,
    iteration: 0,
    meters: Object.fromEntries(frozen.meters.map(m => [m.name, 0])),
    status: 'healthy',
    objectiveBestValue: null,
    totalCostUsd: 0,
    updatedAt: Date.now(),
  })
  const record: LoopInstanceRecord = {
    schemaVersion: '1.0',
    workspaceId: workspace.workspaceId,
    instanceId,
    charterId: frozen.id,
    charterVersion: frozen.version,
    charterHash,
    // The WORKSPACE the loop operates on (the field's documented meaning) —
    // NOT the instance dir (paths.root), which is derivable from it.
    projectDir: resolve(input.projectDir),
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
  return { record, charter: frozen, paths, ledger, scenarios }
}

export async function loadInstance(
  projectDir: string,
  instanceId: LoopInstanceId,
  scenarios: ScenarioRegistry = defaultScenarioRegistry,
): Promise<LoopInstance | null> {
  const paths = instancePaths(projectDir, instanceId)
  await completePendingMigration(paths)
  const record = await readJsonFile<LoopInstanceRecord>(paths.instanceJson)
  if (!record) return null
  const workspace = await ensureWorkspaceIdentity(projectDir)
  return loadInstanceFrom(paths, await bindRecordToWorkspace(paths, record, workspace.workspaceId), scenarios)
}

async function bindRecordToWorkspace(
  paths: InstancePaths,
  record: LoopInstanceRecord,
  workspaceId: string,
): Promise<LoopInstanceRecord> {
  if (record.workspaceId && record.workspaceId !== workspaceId) {
    throw new Error(
      `instance ${record.instanceId} belongs to workspace '${record.workspaceId}', ` +
      `but the current workspace identity is '${workspaceId}'; run loop workspace-fork only on an intentional copy`,
    )
  }
  if (record.workspaceId === workspaceId) return record
  return withFileLock(paths.instanceJson, async () => {
    const latest = await readJsonFile<LoopInstanceRecord>(paths.instanceJson) ?? record
    if (latest.workspaceId && latest.workspaceId !== workspaceId) {
      throw new Error(`instance ${latest.instanceId} workspace identity changed concurrently`)
    }
    const migrated = { ...latest, workspaceId, updatedAt: Date.now() }
    await atomicWriteJson(paths.instanceJson, migrated)
    return migrated
  })
}

async function loadInstanceFrom(
  paths: InstancePaths,
  record: LoopInstanceRecord,
  scenarios: ScenarioRegistry,
): Promise<LoopInstance> {
  const charter = await readJsonFile<FrozenCharter>(paths.frozenCharter)
  if (!charter) throw new Error(`instance ${record.instanceId} is missing its frozen charter`)
  const actualHash = createHash('sha256').update(JSON.stringify(charter)).digest('hex')
  if (actualHash !== record.charterHash) {
    throw new Error(
      `instance ${record.instanceId} frozen charter hash mismatch: ` +
      `record=${record.charterHash} actual=${actualHash}`,
    )
  }
  const normalized = normalizeFrozenCharterForRuntime(charter, scenarios)
  if (normalized.frozen.scenarioPlugin) scenarios.assertCompatible(normalized.frozen.scenarioPlugin)
  return {
    record,
    // Pre-v3 frozen snapshots carry legacy tripwire actions; normalize on every
    // load (deterministic, in-memory only — the on-disk snapshot/hash is untouched).
    charter: normalized,
    paths,
    ledger: withBuiltinSchemas(new Ledger(paths), paths),
    scenarios,
  }
}

export interface SetStatusOpts {
  /**
   * Validate — under the file lock, against DISK state — that the transition
   * starts from one of these statuses. This closes the CLI-vs-daemon race
   * where e.g. `loop pause` reads 'idle', the daemon flips to 'running', and
   * the pause blindly overwrites it (and is then silently undone at the round
   * boundary). Throws when the on-disk status disagrees.
   */
  expectFrom?: readonly LoopInstanceStatus[]
  /** Atomically set (object) or clear (null) the escalation marker with this write. */
  lastEscalation?: LoopInstanceRecord['lastEscalation'] | null
}

export async function setInstanceStatus(
  instance: LoopInstance,
  status: LoopInstanceStatus,
  reason?: string,
  opts?: SetStatusOpts,
): Promise<void> {
  await withFileLock(instance.paths.instanceJson, async () => {
    if (opts?.expectFrom) {
      const disk = await readJsonFile<LoopInstanceRecord>(instance.paths.instanceJson)
      if (disk) instance.record = disk // adopt the freshest truth before validating
      if (!opts.expectFrom.includes(instance.record.status)) {
        throw new Error(
          `refusing status transition to '${status}': instance is '${instance.record.status}' ` +
          `on disk (expected ${opts.expectFrom.join('|')})`,
        )
      }
    }
    const next: LoopInstanceRecord = {
      ...instance.record,
      status,
      statusReason: reason,
      updatedAt: Date.now(),
    }
    if (opts && 'lastEscalation' in opts) {
      if (opts.lastEscalation === null) delete next.lastEscalation
      else if (opts.lastEscalation) next.lastEscalation = opts.lastEscalation
    }
    instance.record = next
    await atomicWriteJson(instance.paths.instanceJson, next)
  })
}

/**
 * Enumerate every loop instance record in a workspace by scanning
 * `<projectDir>/.loop/<id>/instance.json`. Instances must be discoverable from
 * DISK, never from the wake store: an event-waiting loop legitimately has no
 * wake records at all.
 */
export async function listInstanceRecords(projectDir: string): Promise<LoopInstanceRecord[]> {
  const root = join(resolve(projectDir), '.loop')
  let entries: string[]
  try {
    entries = await readdir(root)
  } catch {
    return []
  }
  const out: LoopInstanceRecord[] = []
  for (const id of entries.sort()) {
    if (id === 'charters' || id === 'wakes' || id.startsWith('daemon.lock')) continue
    const record = await readJsonFile<LoopInstanceRecord>(instancePaths(projectDir, id).instanceJson)
    if (record) out.push(record)
  }
  return out
}
