/**
 * ConfigService — the single, layered configuration system.
 *
 * Before this module there were TWO disconnected config stores: resolveConfig()
 * read the global `~/.meta-agent/config.json` while the `config` tool wrote a
 * separate `<cwd>/.meta-agent/settings.json` the runtime never read — so a user
 * who set a model via the tool saw no effect. ConfigService unifies them into
 * ONE file name (`config.json`) read across three layers:
 *
 *   1. global   — `$META_AGENT_HOME/config.json`            (lowest precedence)
 *   2. project  — `<projectDir>/.meta-agent/config.json`
 *   3. session  — in-process overrides set during a run     (highest precedence)
 *
 * More-specific layers win per field: session > project > global. The `config`
 * tool writes to one of these layers (default: project), so its writes feed the
 * SAME merge resolveConfig() consumes — closing the old disconnect.
 *
 * Two views over the same layers:
 *   - loadModelConfig()  → normalized {mainModel, …, apiKey, baseURL, tavily…}
 *     for resolveConfig() (grouped/flat handled per layer, then merged).
 *   - get/set/delete/list → raw nested key/value access for the `config` tool
 *     (arbitrary keys like `ui.theme` are preserved; model fields live under
 *     `LLM.*` / `web_search.*`, matching the file schema).
 *
 * The global layer delegates to modelConfigFile (so its cache + test path hooks
 * stay authoritative); project/session are owned here.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import {
  loadModelConfigFile,
  normalizeModelConfig,
  modelConfigCandidatePaths,
  resetModelConfigFileCache,
  type ModelConfigFile,
} from '../modelConfigFile.js'

export type ConfigScope = 'global' | 'project' | 'session'
const CONFIG_FILENAME = 'config.json'

/** Process-wide session overlay (highest precedence, never persisted). */
let _session: Record<string, unknown> = {}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Resolved global config path — shares modelConfigFile's (test-overridable) path. */
function globalConfigPath(): string {
  return modelConfigCandidatePaths()[0] ?? join('.meta-agent', CONFIG_FILENAME)
}

function projectConfigPath(projectDir: string): string {
  return join(projectDir, '.meta-agent', CONFIG_FILENAME)
}

function scopePath(scope: 'global' | 'project', projectDir?: string): string {
  if (scope === 'global') return globalConfigPath()
  if (!projectDir) throw new Error('project scope requires a projectDir')
  return projectConfigPath(projectDir)
}

function readRawFile(path: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {} // missing / malformed — treated as empty (loaders warn separately)
  }
}

function writeRawFile(path: string, data: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf8')
}

/** Deep-merge plain objects; later sources win per leaf. Arrays/scalars replace. */
function deepMerge(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(overlay)) {
    const prev = out[k]
    out[k] = isRecord(prev) && isRecord(v) ? deepMerge(prev, v) : v
  }
  return out
}

// ── Nested key helpers (dot-notation) ────────────────────────────────────────

function getNested(obj: Record<string, unknown>, key: string): unknown {
  let cur: unknown = obj
  for (const p of key.split('.')) {
    if (!isRecord(cur)) return undefined
    cur = cur[p]
  }
  return cur
}

function setNested(obj: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split('.')
  let cur: Record<string, unknown> = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i]!
    if (!isRecord(cur[p])) cur[p] = {}
    cur = cur[p] as Record<string, unknown>
  }
  cur[parts[parts.length - 1]!] = value
}

function deleteNested(obj: Record<string, unknown>, key: string): boolean {
  const parts = key.split('.')
  let cur: Record<string, unknown> = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i]!
    if (!isRecord(cur[p])) return false
    cur = cur[p] as Record<string, unknown>
  }
  const last = parts[parts.length - 1]!
  if (!(last in cur)) return false
  delete cur[last]
  return true
}

// ── Raw merged view ──────────────────────────────────────────────────────────

/** Raw object for one scope. Global uses modelConfigFile's resolved path. */
function readScopeRaw(scope: ConfigScope, projectDir?: string): Record<string, unknown> {
  if (scope === 'session') return _session
  return readRawFile(scopePath(scope, projectDir))
}

/** Deep-merged raw config across all layers (global → project → session). */
export function loadMergedRaw(opts: { projectDir?: string } = {}): Record<string, unknown> {
  let merged = readRawFile(globalConfigPath())
  if (opts.projectDir) merged = deepMerge(merged, readRawFile(projectConfigPath(opts.projectDir)))
  return deepMerge(merged, _session)
}

// ── Normalized model-config view (for resolveConfig) ─────────────────────────

/**
 * Merge the normalized model config across layers. Each layer is normalized
 * INDEPENDENTLY (so grouped/flat is resolved within a file) and then merged
 * per-field with session > project > global precedence.
 */
export function loadModelConfig(opts: { projectDir?: string } = {}): ModelConfigFile {
  const global = loadModelConfigFile() // cached + test-overridable
  const project = opts.projectDir
    ? normalizeModelConfig(readRawFile(projectConfigPath(opts.projectDir)), 'project config.json')
    : {}
  const session = normalizeModelConfig(_session, 'session config')
  return { ...global, ...project, ...session }
}

// ── Tool-facing operations ───────────────────────────────────────────────────

/** Effective (merged) value for a key, or the value within a single scope. */
export function getValue(
  key: string,
  opts: { projectDir?: string; scope?: ConfigScope } = {},
): unknown {
  const source = opts.scope
    ? readScopeRaw(opts.scope, opts.projectDir)
    : loadMergedRaw({ projectDir: opts.projectDir })
  return getNested(source, key)
}

/** Set a key in a scope (default: project). Persists files; mutates session in-memory. */
export function setValue(
  key: string,
  value: unknown,
  opts: { projectDir?: string; scope?: ConfigScope } = {},
): void {
  const scope = opts.scope ?? 'project'
  if (scope === 'session') {
    setNested(_session, key, value)
    return
  }
  const path = scopePath(scope, opts.projectDir)
  const raw = readRawFile(path)
  setNested(raw, key, value)
  writeRawFile(path, raw)
  if (scope === 'global') resetModelConfigFileCache() // next loadModelConfigFile() re-reads
}

/** Delete a key from a scope (default: project). Returns whether it existed. */
export function deleteValue(
  key: string,
  opts: { projectDir?: string; scope?: ConfigScope } = {},
): boolean {
  const scope = opts.scope ?? 'project'
  if (scope === 'session') return deleteNested(_session, key)
  const path = scopePath(scope, opts.projectDir)
  const raw = readRawFile(path)
  const found = deleteNested(raw, key)
  if (found) {
    writeRawFile(path, raw)
    if (scope === 'global') resetModelConfigFileCache()
  }
  return found
}

/** Merged effective config, or a single scope's raw object when scope is given. */
export function listValues(
  opts: { projectDir?: string; scope?: ConfigScope } = {},
): Record<string, unknown> {
  return opts.scope ? readScopeRaw(opts.scope, opts.projectDir) : loadMergedRaw(opts)
}

// ── Test hooks ───────────────────────────────────────────────────────────────

/** Clear the in-memory session overlay (use in tests / between sessions). */
export function clearSessionConfig(): void {
  _session = {}
}
