import { readFile, stat } from 'fs/promises'

export const MAX_ARTIFACT_DRAFT_BYTES = 8 * 1024 * 1024
export const MAX_ARTIFACT_DRAFT_TOTAL_BYTES = 32 * 1024 * 1024

export async function readBoundedArtifactText(path: string): Promise<{ text: string; bytes: number }> {
  const size = (await stat(path)).size
  if (size > MAX_ARTIFACT_DRAFT_BYTES) {
    throw new Error(`Artifact draft exceeds ${MAX_ARTIFACT_DRAFT_BYTES} bytes`)
  }
  const text = await readFile(path, 'utf-8')
  const bytes = Buffer.byteLength(text, 'utf-8')
  if (bytes > MAX_ARTIFACT_DRAFT_BYTES) {
    throw new Error(`Artifact draft exceeds ${MAX_ARTIFACT_DRAFT_BYTES} bytes`)
  }
  return { text, bytes }
}
