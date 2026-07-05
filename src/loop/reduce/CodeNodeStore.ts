/**
 * CodeNodeStore — content-addressed store for frozen deterministic code
 * artifacts (spec §7 迁移清单, D3). Relocated verbatim from core/auto_orch on
 * v1 retirement; only the persist import path changed.
 */
import { createHash } from 'crypto'
import { readFile } from 'fs/promises'
import { join, resolve, relative } from 'path'
import { atomicWriteFile, atomicWriteJson } from '../../infra/persist/index.js'

export interface CodeNodeArtifact {
  schemaVersion: '1.0'
  nodeId: string
  sourceHash: string
  codeRef: string
  createdAt: number
  note?: string
}

export function hashCodeSource(source: string): string {
  return createHash('sha256').update(source, 'utf-8').digest('hex')
}

function rootDir(projectDir: string): string {
  return join(resolve(projectDir), '.meta-agent', 'auto_orch')
}

function codeDir(projectDir: string): string {
  return join(rootDir(projectDir), 'code_nodes')
}

export function codeRefForHash(hash: string): string {
  return `code_nodes/${hash}.mjs`
}

export function resolveCodeRef(projectDir: string, codeRef: string): string {
  const root = rootDir(projectDir)
  const abs = resolve(root, codeRef)
  const rel = relative(root, abs)
  if (rel.startsWith('..') || rel === '' || rel.startsWith('/')) {
    throw new Error(`codeRef escapes auto_orch root: ${codeRef}`)
  }
  return abs
}

export async function writeCodeNodeArtifact(
  projectDir: string,
  nodeId: string,
  source: string,
  note?: string,
): Promise<CodeNodeArtifact> {
  const sourceHash = hashCodeSource(source)
  const codeRef = codeRefForHash(sourceHash)
  const sourcePath = join(codeDir(projectDir), `${sourceHash}.mjs`)
  const metaPath = join(codeDir(projectDir), `${sourceHash}.json`)
  const now = Date.now()
  await atomicWriteFile(sourcePath, source)
  const artifact: CodeNodeArtifact = {
    schemaVersion: '1.0',
    nodeId,
    sourceHash,
    codeRef,
    createdAt: now,
    note,
  }
  await atomicWriteJson(metaPath, artifact)
  return artifact
}

export async function readCodeNodeSource(
  projectDir: string,
  codeRef: string,
  expectedHash: string,
): Promise<{ source: string; path: string }> {
  const path = resolveCodeRef(projectDir, codeRef)
  const source = await readFile(path, 'utf-8')
  const actual = hashCodeSource(source)
  if (actual !== expectedHash) {
    throw new Error(`code node hash mismatch: expected ${expectedHash}, got ${actual}`)
  }
  return { source, path }
}
