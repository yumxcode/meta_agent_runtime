/**
 * Model config file — global, user-editable model selection.
 *
 * Lets users pin which models the runtime uses without setting env vars or CLI
 * flags on every invocation.
 *
 * GROUPED format (preferred):
 *
 *   {
 *     "LLM": {
 *       "mainModel":     "glm-5.2",       // primary interaction model
 *       "fallbackModel": "glm-4.7",       // used when the primary lacks a feature
 *       "flashModel":    "glm-4.5-air",   // fast side-calls (mode / memory / enrichments)
 *       "compactModel":  "glm-5.2",       // high-context compact summarisation
 *       "apiKey":        "…",             // optional — overrides env detection
 *       "baseURL":       "https://open.bigmodel.cn/api/anthropic"
 *     },
 *     "web_search": {
 *       "tavilyApiKey":  "tvly-…"         // preferred web_search provider
 *     }
 *   }
 *
 * LEGACY flat format (all the same keys at the top level) is still accepted;
 * grouped values win when both are present. Internally everything is
 * flattened into the same ModelConfigFile shape, so consumers are unchanged.
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
  /** Model used specifically for compact summarisation. Defaults to flashModel. */
  compactModel?: string
  /** API key override — bypasses env-var detection when set. */
  apiKey?: string
  /** Provider base URL override. */
  baseURL?: string
  /**
   * Tavily API key for the web_search tool (preferred search provider).
   * Equivalent to setting TAVILY_API_KEY in the environment; the env var wins
   * when both are present.
   */
  tavilyApiKey?: string
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

const STRING_FIELDS = ['mainModel', 'fallbackModel', 'flashModel', 'compactModel', 'apiKey', 'baseURL', 'tavilyApiKey'] as const

let _cache: ModelConfigFile | null = null
let _warned = false

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Coerce arbitrary parsed JSON into a validated ModelConfigFile.
 *
 * Accepts BOTH layouts:
 *   - grouped (preferred): { "LLM": {model/credential fields}, "web_search": {tavilyApiKey} }
 *   - legacy flat:         all fields at the top level
 * Grouped values take precedence over flat ones when both exist.
 */
function sanitize(raw: unknown, sourcePath: string): ModelConfigFile {
  if (!isRecord(raw)) {
    warnOnce(`meta-agent: ${sourcePath} must contain a JSON object — ignoring.`)
    return {}
  }
  const llm = isRecord(raw['LLM']) ? raw['LLM'] : {}
  const webSearch = isRecord(raw['web_search']) ? raw['web_search'] : {}
  // Flatten: legacy top-level fields first, grouped fields override.
  const merged: Record<string, unknown> = { ...raw, ...llm, ...webSearch }

  const out: ModelConfigFile = {}
  for (const field of STRING_FIELDS) {
    const v = merged[field]
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
