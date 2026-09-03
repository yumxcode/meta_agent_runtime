import { createHash } from 'crypto'
import { readFile } from 'fs/promises'
import { join, resolve } from 'path'
import { atomicWriteFile } from '../infra/persist/index.js'
import { resolveInsideWorkspace } from '../tools/fs/workspaceGuard.js'
import type { SubAgentTaskId } from './types.js'

export interface SubAgentResultArtifact {
  outputPath: string
  outputLength: number
  outputBytes: number
  outputSha256: string
  outputPathScope: 'caller_workspace'
  outputPathLifetime: 'workspace_lifetime'
}

function artifactFileName(taskId: SubAgentTaskId): string {
  const readable = taskId.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'subtask'
  const suffix = createHash('sha256').update(taskId).digest('hex').slice(0, 8)
  return `${readable}-${suffix}.json`
}

/**
 * Materialize only the authoritative output payload inside the caller's
 * workspace. The global task record is deliberately never exposed: it also
 * contains config/system-prompt fields and may contain an explicitly supplied
 * API key.
 */
export async function exportSubAgentResultArtifact(
  taskId: SubAgentTaskId,
  output: unknown,
  workspaceRoot: string,
): Promise<SubAgentResultArtifact | undefined> {
  if (output === undefined) return undefined
  const serialized = JSON.stringify(output, null, 2)
  if (serialized === undefined) return undefined
  const root = resolve(workspaceRoot)
  const requestedPath = join(
    root,
    '.meta-agent',
    'auto',
    'subagent-results',
    artifactFileName(taskId),
  )
  const guarded = resolveInsideWorkspace(requestedPath, root)
  if (!guarded.ok) {
    throw new Error('Refusing to export sub-agent output outside the caller workspace.')
  }
  const outputPath = guarded.path
  // Status polling is frequent. Avoid a temp-file write + rename when the
  // deterministic artifact already contains the same output.
  const existing = await readFile(outputPath, 'utf8').catch(() => undefined)
  if (existing !== serialized) await atomicWriteFile(outputPath, serialized)
  return {
    outputPath,
    outputLength: serialized.length,
    outputBytes: Buffer.byteLength(serialized, 'utf8'),
    outputSha256: createHash('sha256').update(serialized, 'utf8').digest('hex'),
    outputPathScope: 'caller_workspace',
    outputPathLifetime: 'workspace_lifetime',
  }
}

export function serializeSubAgentOutput(output: unknown): string | undefined {
  if (output === undefined) return undefined
  try {
    return JSON.stringify(output, null, 2)
  } catch {
    return undefined
  }
}
