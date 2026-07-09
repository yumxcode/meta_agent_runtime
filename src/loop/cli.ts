/**
 * loop CLI handlers (spec T1.7) — `meta-agent loop <cmd>`.
 *
 * Pure-code commands (create/list/inspect/inbox) need no LLM backend.
 * `tick` takes an injected dispatcher — the host CLI passes the same backend
 * dispatcher it builds for orch-scheduler; tests pass a scripted one.
 * Handlers return text (the host prints), never call process.exit.
 */
import { readFile, readdir, writeFile, mkdir } from 'fs/promises'
import { join, resolve } from 'path'
import type { ISubAgentDispatcher } from '../subagent/ISubAgentDispatcher.js'
import type { Charter } from './charter/CharterTypes.js'
import { CharterStore } from './charter/CharterStore.js'
import { createInstance, loadInstance } from './instance/InstanceStore.js'
import { migrateInstance } from './instance/Migrate.js'
import { distillCharter } from './distill/Distiller.js'
import { WakeStore } from './wake/WakeStore.js'
import { tickOnce, runUntilQuiescent } from './runner.js'
import { instancePaths, renderRoute, type LoopInstanceRecord } from './types.js'

export interface LoopCliDeps {
  projectDir: string
  /** Required only for `tick`. */
  dispatcher?: ISubAgentDispatcher
  signal?: AbortSignal
  /** Live per-round/seat progress for `tick` (CLI renders it). */
  observer?: (event: import('./kernel/LoopKernel.js').LoopEvent) => void
}

export async function runLoopCli(argv: string[], deps: LoopCliDeps): Promise<string> {
  const [cmd, ...rest] = argv
  switch (cmd) {
    case 'create': return cmdCreate(rest, deps)
    case 'list': return cmdList(deps)
    case 'inspect': return cmdInspect(rest, deps)
    case 'inbox': return cmdInbox(rest, deps)
    case 'tick': return cmdTick(rest, deps)
    case 'distill': return cmdDistill(rest, deps)
    case 'migrate': return cmdMigrate(rest, deps)
    default:
      return [
        'Usage: meta-agent loop <command>',
        '  distill <需求.md> [--out charter.draft.json]  Distill a requirement doc into a charter draft (needs backend)',
        '  create <charter.json> [--id <instanceId>]   Validate+freeze charter, init ledger, schedule first wake',
        '  migrate <instanceId> [--version N]          Migrate a live instance to a newer charter version',
        '  list                                        List loop instances in this workspace',
        '  inspect <instanceId>                        Status + progress + recent rounds',
        '  inbox <instanceId> <message…>               Drop feedback for the next round',
        '  tick [--until-quiescent]                    Claim due wakes and run rounds (needs backend)',
      ].join('\n')
  }
}

async function cmdDistill(rest: string[], deps: LoopCliDeps): Promise<string> {
  if (!deps.dispatcher) throw new Error('loop distill needs a backend dispatcher')
  const file = rest.find(a => !a.startsWith('--'))
  if (!file) throw new Error('loop distill: requirement doc path required')
  const out = flagValue(rest, '--out') ?? 'charter.draft.json'
  const doc = await readFile(resolve(deps.projectDir, file), 'utf-8')
  const result = await distillCharter(doc, { dispatcher: deps.dispatcher, signal: deps.signal })
  await writeFile(resolve(deps.projectDir, out), JSON.stringify(result.charter, null, 2), 'utf-8')
  if (result.taskSpec) {
    await writeFile(resolve(deps.projectDir, 'task_spec.draft.md'), result.taskSpec, 'utf-8')
  }
  return [
    `charter draft written to ${out} (validated, ${result.attempts} attempt(s))`,
    `review it, then approve by running: meta-agent loop create ${out}`,
  ].join('\n')
}

async function cmdMigrate(rest: string[], deps: LoopCliDeps): Promise<string> {
  const id = rest.find(a => !a.startsWith('--'))
  if (!id) throw new Error('loop migrate: instanceId required')
  const instance = await loadInstance(deps.projectDir, id)
  if (!instance) return `instance ${id} not found`
  const store = new CharterStore(deps.projectDir)
  const versionFlag = flagValue(rest, '--version')
  const version = versionFlag ? Number(versionFlag) : undefined
  const charter = await store.load(instance.record.charterId, version)
  if (!charter) return `charter ${instance.record.charterId}${version ? `@v${version}` : ''} not found in library`
  const entry = await migrateInstance(instance, charter, {
    wakeStore: new WakeStore(deps.projectDir),
    projectDir: deps.projectDir,
  })
  return [
    `migrated ${id}: v${entry.fromVersion} → v${entry.toVersion}`,
    `meters carried: ${entry.carriedMeters.join(', ') || '(none)'}; new: ${entry.newMeters.join(', ') || '(none)'}; ` +
      `dropped: ${Object.keys(entry.droppedMeters).join(', ') || '(none)'}`,
    entry.reArmed ? 're-armed from paused_attention (human ack recorded); next round scheduled' : 'instance idle',
  ].join('\n')
}

async function cmdCreate(rest: string[], deps: LoopCliDeps): Promise<string> {
  const file = rest.find(a => !a.startsWith('--'))
  if (!file) throw new Error('loop create: charter file path required')
  const idFlag = flagValue(rest, '--id')
  const raw = await readFile(resolve(deps.projectDir, file), 'utf-8')
  const charter = JSON.parse(raw) as Charter

  // Save into the charter library (versioned), then instantiate that version.
  const store = new CharterStore(deps.projectDir)
  const ref = await store.save(charter)
  const saved = (await store.load(ref.charterId, ref.version))!
  const instance = await createInstance({
    projectDir: deps.projectDir,
    charter: saved,
    instanceId: idFlag,
  })
  return [
    `charter ${ref.charterId}@v${ref.version} saved`,
    `instance ${instance.record.instanceId} created (status: ${instance.record.status})`,
    `first wake scheduled — run: meta-agent loop tick`,
  ].join('\n')
}

async function cmdList(deps: LoopCliDeps): Promise<string> {
  const loopRoot = join(resolve(deps.projectDir), '.loop')
  let entries: string[]
  try {
    entries = await readdir(loopRoot)
  } catch {
    return '(no loop instances)'
  }
  const lines: string[] = []
  for (const id of entries.sort()) {
    if (id === 'charters' || id === 'wakes') continue
    const record = await readInstanceRecord(deps.projectDir, id)
    if (!record) continue
    lines.push(
      `${record.instanceId}  ${record.status}` +
      (record.statusReason ? `  (${record.statusReason})` : '') +
      `  charter=${record.charterId}@v${record.charterVersion}`,
    )
  }
  return lines.length ? lines.join('\n') : '(no loop instances)'
}

async function cmdInspect(rest: string[], deps: LoopCliDeps): Promise<string> {
  const id = rest[0]
  if (!id) throw new Error('loop inspect: instanceId required')
  const instance = await loadInstance(deps.projectDir, id)
  if (!instance) return `instance ${id} not found`
  const view = await instance.ledger.readView(10)
  const wakes = (await new WakeStore(deps.projectDir).list())
    .filter(w => w.loopId === id && (w.status === 'pending' || w.status === 'claimed'))
  return [
    `instance: ${id}  status: ${instance.record.status}` +
      (instance.record.statusReason ? ` (${instance.record.statusReason})` : ''),
    `charter: ${instance.record.charterId}@v${instance.record.charterVersion}  hash: ${instance.record.charterHash.slice(0, 12)}`,
    `progress: iteration=${view.progress.iteration} status=${view.progress.status} ` +
      `meters=${JSON.stringify(view.progress.meters)} best=${view.progress.bestMetric ?? 'null'} ` +
      `findings=${view.findingsCount} cost=$${view.progress.totalCostUsd.toFixed(2)}`,
    `wakes: ${wakes.map(w => `${w.kind}@${new Date(w.fireAt).toISOString()}[${w.status}]`).join(', ') || '(none)'}`,
    '',
    'recent rounds:',
    ...view.lastRounds.map(r =>
      `  #${r.round} [${r.mode}] route=${renderRoute(r.route)} retries=${r.correctiveRetries} cost=$${r.costUsd.toFixed(2)}`),
  ].join('\n')
}

async function cmdInbox(rest: string[], deps: LoopCliDeps): Promise<string> {
  const [id, ...messageParts] = rest
  const message = messageParts.join(' ').trim()
  if (!id || !message) throw new Error('loop inbox: instanceId and message required')
  const record = await readInstanceRecord(deps.projectDir, id)
  if (!record) return `instance ${id} not found`
  const paths = instancePaths(deps.projectDir, id)
  await mkdir(paths.inboxDir, { recursive: true })
  const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`
  await writeFile(join(paths.inboxDir, name), JSON.stringify({ message, at: Date.now() }), 'utf-8')
  return `inbox message queued for ${id} — it takes effect in the next round's capsule`
}

async function cmdTick(rest: string[], deps: LoopCliDeps): Promise<string> {
  if (!deps.dispatcher) {
    throw new Error('loop tick needs a backend dispatcher (host CLI wires this; see orch-scheduler bootstrap)')
  }
  const tickDeps = { dispatcher: deps.dispatcher, projectDir: deps.projectDir, signal: deps.signal, observer: deps.observer }
  if (rest.includes('--until-quiescent')) {
    const results = await runUntilQuiescent(tickDeps)
    const total = results.reduce((n, r) => n + r.claimed, 0)
    return `ran ${total} round(s) across ${results.length} tick(s); now quiescent`
  }
  const result = await tickOnce(tickDeps)
  if (result.claimed === 0) return 'no wakes due'
  return result.outcomes
    .map(o => o.outcome
      ? `${o.loopId}: round ${o.outcome.round} [${o.outcome.mode}] route=${o.outcome.route} status=${o.outcome.status}`
      : `${o.loopId}: ERROR ${o.error}`)
    .join('\n')
}

// ── helpers ───────────────────────────────────────────────────────────────────

async function readInstanceRecord(projectDir: string, id: string): Promise<LoopInstanceRecord | null> {
  try {
    const raw = await readFile(instancePaths(projectDir, id).instanceJson, 'utf-8')
    return JSON.parse(raw) as LoopInstanceRecord
  } catch {
    return null
  }
}

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}
