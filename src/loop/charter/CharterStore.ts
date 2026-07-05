/**
 * CharterStore — versioned charter persistence (spec C2; PlanStore pattern).
 *
 * Layout: `<root>/charters/<id>/v<NNNN>/charter.json` + `latest.json` pointer.
 * Saving is APPEND-ONLY: a new save under an existing id becomes version+1;
 * existing versions are immutable (D9 — running instances freeze their own
 * snapshot anyway, but the library itself also never rewrites history).
 */
import { join, resolve } from 'path'
import { atomicWriteJson, ensureDir, readJsonFile } from '../../infra/persist/index.js'
import type { Charter } from './CharterTypes.js'
import { validateCharter } from './CharterValidate.js'

export interface CharterRef {
  charterId: string
  version: number
  path: string
}

interface LatestPointer {
  charterId: string
  version: number
  updatedAt: number
}

export class CharterStore {
  private readonly root: string

  /** Default root: `<projectDir>/.loop/charters`. */
  constructor(projectDir: string, opts?: { dir?: string }) {
    this.root = opts?.dir ?? join(resolve(projectDir), '.loop', 'charters')
  }

  private charterDir(id: string): string {
    return join(this.root, id)
  }

  private versionPath(id: string, version: number): string {
    return join(this.charterDir(id), `v${String(version).padStart(4, '0')}`, 'charter.json')
  }

  private latestPath(id: string): string {
    return join(this.charterDir(id), 'latest.json')
  }

  /**
   * Save a charter as the next version of its id. The caller-provided
   * `version` field is OVERWRITTEN by the store — versioning is the store's
   * job, not the author's (prevents gaps/collisions).
   */
  async save(charter: Charter): Promise<CharterRef> {
    const errs = validateCharter({ ...charter, version: 1 })
    if (errs.length > 0) throw new Error(`refusing to save invalid charter:\n- ${errs.join('\n- ')}`)
    const latest = await readJsonFile<LatestPointer>(this.latestPath(charter.id))
    const version = (latest?.version ?? 0) + 1
    const stamped: Charter = { ...charter, version }
    const path = this.versionPath(charter.id, version)
    await ensureDir(join(this.charterDir(charter.id), `v${String(version).padStart(4, '0')}`))
    await atomicWriteJson(path, stamped)
    await atomicWriteJson(this.latestPath(charter.id), {
      charterId: charter.id,
      version,
      updatedAt: Date.now(),
    } satisfies LatestPointer)
    return { charterId: charter.id, version, path }
  }

  async load(id: string, version?: number): Promise<Charter | null> {
    const v = version ?? (await readJsonFile<LatestPointer>(this.latestPath(id)))?.version
    if (!v) return null
    return readJsonFile<Charter>(this.versionPath(id, v))
  }

  async latestVersion(id: string): Promise<number | null> {
    return (await readJsonFile<LatestPointer>(this.latestPath(id)))?.version ?? null
  }
}
