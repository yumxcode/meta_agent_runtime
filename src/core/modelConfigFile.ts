/**
 * Model config file — global, user-editable model selection.
 *
 * Lets users pin which models the runtime uses without setting env vars or CLI
 * flags on every invocation.  Three selection points plus optional credentials:
 *
 *   {
 *     "mainModel":     "glm-5.1",       // primary interaction model
 *     "fallbackModel": "glm-4.6",       // used when the primary lacks a feature
 *     "flashModel":    "glm-4.5-air",   // fast side-calls (compact / mode / memory)
 *     "apiKey":        "…",             // optional — overrides env detection
 *     "baseURL":       "https://open.bigmodel.cn/api/anthropic"  // optional
 *   }
 *
 * Location (global only, first existing file wins):
 *   1. ~/.meta-agent/config.json          (primary — matches memory/subtasks dir)
 *   2. ~/.claude/meta-agent/config.json   (legacy fallback — pre-migration data)
 *
 * Precedence applied by resolveConfig(): config file > CLI flags > built-in
 * provider defaults.  All fields are optional; an absent / malformed file is
 * treated as empty (a single parse warning is emitted to stderr).
 */

import { readFileSync } from 'fs'
import { homedir } from 'os'
import { META_AGENT_HOME } from './metaAgentHome.js'
import { join } from 'path'

export interface ModelConfigFile {
  /** Primary interaction model. Maps to MetaAgentConfig.model. */
  mainModel?: string
  /** Fallback model when the primary cannot satisfy a request. */
  fallbackModel?: string
  /** Fast auxiliary model for side-calls. */
  flashModel?: string
  /** API key override — bypasses env-var detection when set. */
  apiKey?: string
  /** Provider base URL override. */
  baseURL?: string
}

let _pathsOverride: string[] | null = null

/** Candidate paths, highest priority first. */
export function modelConfigCandidatePaths(): string[] {
  if (_pathsOverride !== null) return _pathsOverride
  const home = homedir()
  return [
    join(META_AGENT_HOME, 'config.json'),
    join(home, '.claude', 'meta-agent', 'config.json'),
  ]
}

/** Test hook — override candidate paths. Pass null to restore the defaults. */
export function setModelConfigPathsForTest(paths: string[] | null): void {
  _pathsOverride = paths
  resetModelConfigFileCache()
}

const STRING_FIELDS = ['mainModel', 'fallbackModel', 'flashModel', 'apiKey', 'baseURL'] as const

let _cache: ModelConfigFile | null = null
let _warned = false

/** Coerce arbitrary parsed JSON into a validated ModelConfigFile (string fields only). */
function sanitize(raw: unknown, sourcePath: string): ModelConfigFile {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    warnOnce(`meta-agent: ${sourcePath} must contain a JSON object — ignoring.`)
    return {}
  }
  const obj = raw as Record<string, unknown>
  const out: ModelConfigFile = {}
  for (const field of STRING_FIELDS) {
    const v = obj[field]
    if (v === undefined || v === null) continue
    if (typeof v !== 'string' || v.trim() === '') {
      warnOnce(`meta-agent: ${sourcePath} field "${field}" must be a non-empty string — ignoring it.`)
      continue
    }
    out[field] = v.trim()
  }
  return out
}

function warnOnce(msg: string): void {
  if (_warned) return
  _warned = true
  try { process.stderr.write(`${msg}\n`) } catch { /* ignore */ }
}

/**
 * Load and cache the global model config file.
 *
 * Reads the first existing candidate path.  Missing files are not an error
 * (returns {}).  A malformed file emits a single stderr warning and returns {}.
 * Result is cached process-wide; call resetModelConfigFileCache() in tests.
 */
export function loadModelConfigFile(): ModelConfigFile {
  if (_cache !== null) return _cache
  for (const path of modelConfigCandidatePaths()) {
    let text: string
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      continue // file not present at this path — try next
    }
    try {
      _cache = sanitize(JSON.parse(text), path)
    } catch {
      warnOnce(`meta-agent: failed to parse ${path} (invalid JSON) — ignoring.`)
      _cache = {}
    }
    return _cache
  }
  _cache = {}
  return _cache
}

/** Test hook — drop the cached config so the next load() re-reads from disk. */
export function resetModelConfigFileCache(): void {
  _cache = null
  _warned = false
}
