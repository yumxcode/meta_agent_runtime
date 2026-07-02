import { createHash } from 'crypto'
import { appendFile, readdir } from 'fs/promises'
import { join, resolve } from 'path'
import { atomicWriteJson, ensureDir, ensureParentDir, readJsonFile } from '../persist/index.js'
import type { OrchPlan } from './LoopIR.js'
import type { PlanRunResult } from './PlanRunner.js'

export interface AutoOrchStoredPlanRef {
  planId: string
  version: number
  dir: string
}

export interface AutoOrchPlanManifest {
  schemaVersion: '1.0'
  planId: string
  version: number
  goalHash: string
  goalPreview: string
  source: 'planner' | 'saved' | 'fallback'
  approvedByUser: boolean
  approvedAt: number
  materializedAt?: number
  latestRunAt?: number
  note?: string
}

export interface AutoOrchLoadedPlan {
  ref: AutoOrchStoredPlanRef
  manifest: AutoOrchPlanManifest
  plan: OrchPlan
}

function plansRoot(projectDir: string): string {
  return join(resolve(projectDir), '.meta-agent', 'auto_orch', 'plans')
}

function planRoot(projectDir: string, planId: string): string {
  return join(plansRoot(projectDir), planId)
}

function versionDir(projectDir: string, planId: string, version: number): string {
  return join(planRoot(projectDir, planId), `v${String(version).padStart(4, '0')}`)
}

function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex')
}

function safePlanId(value: string | undefined, goal: string): string {
  const fromPlan = (value ?? '').trim().toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  return fromPlan || `plan-${hashText(goal).slice(0, 12)}`
}

async function nextVersion(projectDir: string, planId: string): Promise<number> {
  try {
    const entries = await readdir(planRoot(projectDir, planId))
    const versions = entries
      .map(e => /^v(\d+)$/.exec(e)?.[1])
      .filter((v): v is string => !!v)
      .map(v => Number.parseInt(v, 10))
      .filter(Number.isFinite)
    return versions.length ? Math.max(...versions) + 1 : 1
  } catch {
    return 1
  }
}

export async function saveApprovedAutoOrchPlan(
  projectDir: string,
  input: {
    goal: string
    plan: OrchPlan
    source: 'planner' | 'saved' | 'fallback'
    approvedByUser: boolean
    note?: string
  },
): Promise<AutoOrchStoredPlanRef> {
  const planId = safePlanId(input.plan.id, input.goal)
  const version = await nextVersion(projectDir, planId)
  const dir = versionDir(projectDir, planId, version)
  await ensureDir(dir)

  const manifest: AutoOrchPlanManifest = {
    schemaVersion: '1.0',
    planId,
    version,
    goalHash: hashText(input.goal),
    goalPreview: input.goal.slice(0, 500),
    source: input.source,
    approvedByUser: input.approvedByUser,
    approvedAt: Date.now(),
    note: input.note,
  }

  await atomicWriteJson(join(dir, 'approved.plan.json'), input.plan)
  await atomicWriteJson(join(dir, 'manifest.json'), manifest)
  await atomicWriteJson(join(planRoot(projectDir, planId), 'latest.json'), { planId, version })
  await atomicWriteJson(join(plansRoot(projectDir), 'latest.json'), { planId, version })
  await appendPlanLog(projectDir, planId, {
    event: 'approved',
    at: manifest.approvedAt,
    version,
    approvedByUser: input.approvedByUser,
    source: input.source,
    note: input.note,
  })
  return { planId, version, dir }
}

export async function saveMaterializedAutoOrchPlan(
  projectDir: string,
  ref: AutoOrchStoredPlanRef,
  plan: OrchPlan,
): Promise<void> {
  const manifestPath = join(ref.dir, 'manifest.json')
  const manifest = await readJsonFile<AutoOrchPlanManifest>(manifestPath)
  const materializedAt = Date.now()
  await atomicWriteJson(join(ref.dir, 'materialized.plan.json'), plan)
  if (manifest) await atomicWriteJson(manifestPath, { ...manifest, materializedAt })
  await appendPlanLog(projectDir, ref.planId, { event: 'materialized', at: materializedAt, version: ref.version })
}

export async function appendAutoOrchPlanRun(
  projectDir: string,
  ref: AutoOrchStoredPlanRef,
  run: PlanRunResult,
): Promise<void> {
  const at = Date.now()
  const record = {
    at,
    version: ref.version,
    status: run.status,
    costUsd: run.costUsd,
    visitedPath: run.visitedPath,
    note: run.note,
  }
  await appendJsonl(join(ref.dir, 'runs.jsonl'), record)
  await appendPlanLog(projectDir, ref.planId, { event: 'run', ...record })
  const manifestPath = join(ref.dir, 'manifest.json')
  const manifest = await readJsonFile<AutoOrchPlanManifest>(manifestPath)
  if (manifest) await atomicWriteJson(manifestPath, { ...manifest, latestRunAt: at })
}

export async function loadAutoOrchPlan(projectDir: string, refText: string): Promise<AutoOrchLoadedPlan | null> {
  const parsed = await resolvePlanRef(projectDir, refText)
  if (!parsed) return null
  const manifestPath = join(parsed.dir, 'manifest.json')
  const manifest = await readJsonFile<AutoOrchPlanManifest>(manifestPath)
  if (!manifest) return null
  const approved = await readJsonFile<OrchPlan>(join(parsed.dir, 'approved.plan.json'))
  const materialized = await readJsonFile<OrchPlan>(join(parsed.dir, 'materialized.plan.json'))
  const plan = approved ?? materialized
  if (!plan) return null
  return { ref: parsed, manifest, plan }
}

async function resolvePlanRef(projectDir: string, refText: string): Promise<AutoOrchStoredPlanRef | null> {
  const raw = refText.trim()
  if (!raw) return null
  if (raw === 'latest') {
    const latest = await readJsonFile<{ planId?: string; version?: number }>(join(plansRoot(projectDir), 'latest.json'))
    if (!latest?.planId || !latest.version) return null
    return { planId: latest.planId, version: latest.version, dir: versionDir(projectDir, latest.planId, latest.version) }
  }
  const match = /^([^@/]+)(?:@v?(\d+))?$/.exec(raw)
  if (!match) return null
  const planId = safePlanId(match[1], raw)
  let version = match[2] ? Number.parseInt(match[2], 10) : 0
  if (!version) {
    const latest = await readJsonFile<{ version?: number }>(join(planRoot(projectDir, planId), 'latest.json'))
    version = latest?.version ?? 0
  }
  if (!version) return null
  return { planId, version, dir: versionDir(projectDir, planId, version) }
}

async function appendPlanLog(projectDir: string, planId: string, value: Record<string, unknown>): Promise<void> {
  await appendJsonl(join(planRoot(projectDir, planId), 'review_log.jsonl'), value)
}

async function appendJsonl(path: string, value: unknown): Promise<void> {
  await ensureParentDir(path)
  await appendFile(path, JSON.stringify(value) + '\n', 'utf-8')
}
