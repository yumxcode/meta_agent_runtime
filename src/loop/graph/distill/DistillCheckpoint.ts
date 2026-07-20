import { createHash } from 'node:crypto'
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import type { LoopBlueprint, LoopConstraintLedger } from './DistillDesign.js'

export interface DistillCheckpointSource {
  requirement: string
  projectDir: string
}

export interface DistillArchitectCheckpoint {
  schemaVersion: 'distill-architect-checkpoint-1.0'
  source: { requirement: string; projectDir: string; sha256: string }
  constraints: LoopConstraintLedger
  design: LoopBlueprint
  savedAt: number
}

export interface DistillCheckpointStore {
  load(source: DistillCheckpointSource): Promise<DistillArchitectCheckpoint | null>
  save(source: DistillCheckpointSource, value: Pick<DistillArchitectCheckpoint, 'constraints' | 'design'>): Promise<void>
  clear(): Promise<void>
}

/** One foreground Distill checkpoint per workspace. It stores only the accepted
 * semantic contract; final Graph artifacts remain atomic and authoritative. */
export function createFileDistillCheckpointStore(projectDir: string): DistillCheckpointStore {
  const path = resolve(projectDir, '.loop', 'distill', 'architect.checkpoint.json')
  return {
    async load(source) {
      const current = await sourceIdentity(source).catch(() => null)
      if (!current) return null
      try {
        const parsed = JSON.parse(await readFile(path, 'utf8')) as DistillArchitectCheckpoint
        if (parsed.schemaVersion !== 'distill-architect-checkpoint-1.0') return null
        if (parsed.source.projectDir !== current.projectDir || parsed.source.requirement !== current.requirement || parsed.source.sha256 !== current.sha256) return null
        return parsed
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        return null
      }
    },
    async save(source, value) {
      const identity = await sourceIdentity(source)
      const checkpoint: DistillArchitectCheckpoint = {
        schemaVersion: 'distill-architect-checkpoint-1.0',
        source: identity,
        constraints: structuredClone(value.constraints),
        design: structuredClone(value.design),
        savedAt: Date.now(),
      }
      await mkdir(dirname(path), { recursive: true })
      const temporary = `${path}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`
      await writeFile(temporary, JSON.stringify(checkpoint, null, 2), 'utf8')
      await rename(temporary, path)
    },
    async clear() { await rm(path, { force: true }) },
  }
}

async function sourceIdentity(source: DistillCheckpointSource): Promise<DistillArchitectCheckpoint['source']> {
  const projectDir = await realpath(resolve(source.projectDir))
  const requirementPath = await realpath(resolve(projectDir, source.requirement))
  const rel = relative(projectDir, requirementPath)
  if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) throw new Error('Distill requirement must be inside the project workspace')
  const bytes = await readFile(requirementPath)
  return {
    projectDir,
    requirement: source.requirement,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
}
