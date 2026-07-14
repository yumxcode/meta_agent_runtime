import { createHash } from 'crypto'
import { createRequire } from 'module'
import { readFile } from 'fs/promises'
import { isAbsolute, join, resolve } from 'path'
import { pathToFileURL } from 'url'
import { ScenarioRegistry } from './ScenarioRegistry.js'
import type { ScenarioPluginV1 } from './ScenarioPlugin.js'

/**
 * Load only explicitly configured trusted modules. There is intentionally no
 * node_modules scanning or implicit project-code execution.
 */
export async function loadScenarioPlugins(
  specifiers: readonly string[],
  options: { projectDir: string; base?: ScenarioRegistry },
): Promise<ScenarioRegistry> {
  const registry = options.base?.clone() ?? new ScenarioRegistry()
  for (const specifier of specifiers) {
    const target = await resolveModuleTarget(specifier, options.projectDir)
    const digest = createHash('sha256').update(await readFile(target.file)).digest('hex')
    const actualIntegrity = `sha256:${digest}`
    // Cache-bust local ESM by content. Otherwise a file edited and reloaded in
    // the same host process can return old module code paired with a new hash.
    const moduleId = target.local
      ? `${pathToFileURL(target.file).href}?scenarioIntegrity=${digest}`
      : target.moduleId
    const loaded = await import(moduleId) as Record<string, unknown>
    const exported = loaded['scenarioPlugin'] ?? loaded['default'] ?? loaded['scenarioPlugins']
    const plugins = Array.isArray(exported) ? exported : [exported]
    if (plugins.some(plugin => !plugin || typeof plugin !== 'object')) {
      throw new Error(`Scenario plugin module '${specifier}' must export scenarioPlugin, scenarioPlugins, or default`)
    }
    for (const value of plugins) {
      let plugin = value as ScenarioPluginV1
      if (plugin.manifest) {
        if (plugin.manifest.integrity.startsWith('sha256:') &&
            plugin.manifest.integrity !== actualIntegrity) {
          throw new Error(
            `Scenario plugin '${plugin.manifest.id}' integrity mismatch: ` +
            `declared ${plugin.manifest.integrity}, actual ${actualIntegrity}`,
          )
        }
        // The loader, never executable plugin code, owns the frozen identity.
        plugin = { ...plugin, manifest: { ...plugin.manifest, integrity: actualIntegrity } }
      }
      registry.register(plugin)
    }
  }
  return registry
}

function isLocalSpecifier(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../') || isAbsolute(specifier)
}

async function resolveModuleTarget(
  specifier: string,
  projectDir: string,
): Promise<{ moduleId: string; file: string; local: boolean }> {
  if (isLocalSpecifier(specifier)) {
    const file = resolve(projectDir, specifier)
    return { moduleId: pathToFileURL(file).href, file, local: true }
  }
  // Bare packages must resolve relative to the operator's workspace, not to
  // the runtime package that happens to host ScenarioLoader.
  const requireFromProject = createRequire(pathToFileURL(join(projectDir, 'package.json')).href)
  const file = requireFromProject.resolve(specifier)
  return { moduleId: pathToFileURL(file).href, file, local: false }
}
