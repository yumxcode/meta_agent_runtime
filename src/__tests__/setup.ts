/**
 * Global vitest setup — isolate every test run from the developer's real
 * ~/.meta-agent home and from any locally-present config.json.
 *
 * `META_AGENT_HOME` is exported to the worker via `test.env` in
 * vitest.config.ts, so by the time this file (and the stores it imports) load,
 * `metaAgentHome.ts` has already captured the temp dir. Here we additionally:
 *
 *   1. Pin the model-config candidate paths to ONLY the isolated home, dropping
 *      the legacy `~/.claude/meta-agent/config.json` fallback that would
 *      otherwise let the developer's machine state bleed into tests (the
 *      web_search / compact-model failures the review flagged).
 *   2. Reset the process-wide model-config cache after every test so one test's
 *      load() can't pin stale config for the next.
 */
import { afterEach } from 'vitest'
import { join } from 'node:path'
import { META_AGENT_HOME } from '../core/metaAgentHome.js'
import { setModelConfigPathsForTest, resetModelConfigFileCache } from '../core/modelConfigFile.js'

// Restrict config discovery to the isolated home (no legacy ~/.claude fallback).
setModelConfigPathsForTest([join(META_AGENT_HOME, 'config.json')])

afterEach(() => {
  resetModelConfigFileCache()
})
