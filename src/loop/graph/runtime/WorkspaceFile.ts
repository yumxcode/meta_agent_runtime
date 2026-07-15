import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { atomicWriteFile } from '../../../infra/persist/index.js'
import type { JsonValue, LoopGraphSpec, WorkspaceBindingSpec } from '../spec/GraphTypes.js'
import { isJsonValue, validateShape } from './GraphJson.js'

export interface WorkspaceFileSnapshot {
  path: string
  content: JsonValue
  bytes: number
  sha256: string
}

export async function readWorkspaceBindingFile(root: string, binding: WorkspaceBindingSpec): Promise<WorkspaceFileSnapshot | undefined> {
  const path = await safeWorkspacePath(root, binding.path, false)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
  const content = parseWorkspaceFile(raw, binding.format, binding.path)
  return {
    path: binding.path,
    content,
    bytes: Buffer.byteLength(raw, 'utf8'),
    sha256: createHash('sha256').update(raw).digest('hex'),
  }
}

export async function materializeWorkspaceBindingFile(
  root: string,
  binding: WorkspaceBindingSpec,
  projected: JsonValue,
): Promise<void> {
  const path = await safeWorkspacePath(root, binding.path, true)
  let value = projected
  if (binding.format === 'jsonl' && (binding.appendOnly || binding.direction === 'bidirectional')) {
    const existing = await readWorkspaceBindingFile(root, binding)
    const prior = existing?.content
    const priorRecords = Array.isArray(prior) ? prior : prior === undefined ? [] : [prior]
    const projectedRecords = Array.isArray(projected) ? projected : [projected]
    const seen = new Set(priorRecords.map(item => JSON.stringify(item)))
    const merged = [...priorRecords]
    for (const item of projectedRecords) {
      const key = JSON.stringify(item)
      if (!seen.has(key)) { seen.add(key); merged.push(item) }
    }
    value = merged
  }
  await atomicWriteFile(path, encodeWorkspaceFile(value, binding.format))
}

/** Seed declared State keys once, before graph_created, from an existing JSON projection. */
export async function hydrateInitialStateFromWorkspace(
  projectRoot: string,
  graph: LoopGraphSpec,
  defaults: Record<string, JsonValue>,
): Promise<Record<string, JsonValue>> {
  const values = { ...defaults }
  for (const [name, binding] of Object.entries(graph.workspaceBindings ?? {})) {
    if (!binding.initializeState || binding.initializeState === 'graph_defaults') continue
    const snapshot = await readWorkspaceBindingFile(projectRoot, binding)
    if (!snapshot) {
      if (binding.initializeState === 'workspace_required') {
        throw new Error(`Workspace Binding '${name}' requires initial State file '${binding.path}'`)
      }
      continue
    }
    if (!isRecord(snapshot.content)) throw new Error(`Workspace Binding '${name}' initial State must be a JSON object`)
    const projection = binding.projection
    if (projection?.kind !== 'state') throw new Error(`Workspace Binding '${name}' initial State requires a state projection`)
    for (const key of projection.keys ?? Object.keys(graph.state)) {
      if (!(key in snapshot.content)) {
        if (binding.initializeState === 'workspace_required') throw new Error(`Workspace Binding '${name}' is missing State '${key}'`)
        continue
      }
      const next = snapshot.content[key]!
      const errors = validateShape(next, graph.state[key]!.type, `$state.${key}`)
      if (errors.length) throw new Error(`Workspace Binding '${name}' has invalid initial State: ${errors.join('; ')}`)
      values[key] = next
    }
  }
  return values
}

export function parseWorkspaceFile(raw: string, format: WorkspaceBindingSpec['format'], path = 'workspace file'): JsonValue {
  if (format === 'text' || format === 'markdown') return raw
  if (format === 'json') {
    const value = JSON.parse(raw) as unknown
    if (!isJsonValue(value)) throw new Error(`${path} contains a non-JSON value`)
    return value
  }
  const records: JsonValue[] = []
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    if (!line.trim()) continue
    let value: unknown
    try { value = JSON.parse(line) } catch (error) {
      throw new Error(`${path}:${index + 1} is invalid JSON: ${message(error)}`)
    }
    if (!isJsonValue(value)) throw new Error(`${path}:${index + 1} contains a non-JSON value`)
    records.push(value)
  }
  return records
}

function encodeWorkspaceFile(value: JsonValue, format: WorkspaceBindingSpec['format']): string {
  if (format === 'text' || format === 'markdown') {
    return typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`
  }
  if (format === 'json') return `${JSON.stringify(value, null, 2)}\n`
  const records = Array.isArray(value) ? value : [value]
  return records.length ? `${records.map(item => JSON.stringify(item)).join('\n')}\n` : ''
}

async function safeWorkspacePath(root: string, workspacePath: string, createParent: boolean): Promise<string> {
  const absoluteRoot = await realpath(resolve(root))
  const target = resolve(absoluteRoot, workspacePath)
  if (!isUnder(target, absoluteRoot)) throw new Error(`workspace binding path '${workspacePath}' escapes its workspace`)
  const parent = dirname(target)
  if (createParent) await mkdir(parent, { recursive: true })
  let realParent: string
  try { realParent = await realpath(parent) } catch (error) {
    if (!isMissing(error)) throw error
    return target
  }
  if (!isUnder(realParent, absoluteRoot)) throw new Error(`workspace binding path '${workspacePath}' traverses a symlink outside its workspace`)
  try {
    const stat = await lstat(target)
    if (stat.isSymbolicLink()) throw new Error(`workspace binding path '${workspacePath}' must not be a symbolic link`)
  } catch (error) {
    if (!isMissing(error)) throw error
  }
  return target
}

function isUnder(path: string, root: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === 'ENOENT'
}

function isRecord(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }
