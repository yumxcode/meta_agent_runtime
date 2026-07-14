import {
  SCENARIO_PLUGIN_API_VERSION,
  type FrozenScenarioPluginRef,
  type ScenarioDefinition,
  type ScenarioPluginV1,
  type ScenarioRuntime,
} from './ScenarioPlugin.js'

export class ScenarioPluginError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ScenarioPluginError'
  }
}

/** Instance-owned registry: callers can compose different trusted plugin sets. */
export class ScenarioRegistry {
  private readonly plugins = new Map<string, ScenarioPluginV1>()

  constructor(plugins: readonly ScenarioPluginV1[] = []) {
    for (const plugin of plugins) this.register(plugin)
  }

  register(plugin: ScenarioPluginV1): this {
    validatePlugin(plugin)
    if (this.plugins.has(plugin.manifest.id)) {
      throw new ScenarioPluginError(`Scenario '${plugin.manifest.id}' is already registered`)
    }
    // Snapshot registration metadata so later caller mutation cannot silently
    // change the identity or execution plan pinned into a live instance.
    const frozen: ScenarioPluginV1 = Object.freeze({
      manifest: Object.freeze({ ...plugin.manifest }),
      definition: Object.freeze({
        ...plugin.definition,
        artifactGateIds: Object.freeze([...plugin.definition.artifactGateIds]),
        mandatoryArtifactGateIds: Object.freeze([...plugin.definition.mandatoryArtifactGateIds]),
        gateBindings: Object.freeze(plugin.definition.gateBindings.map(binding => Object.freeze({ ...binding }))),
      }),
      runtime: Object.freeze({ ...plugin.runtime }),
    })
    this.plugins.set(plugin.manifest.id, frozen)
    return this
  }

  plugin(id: string): ScenarioPluginV1 | undefined {
    return this.plugins.get(id)
  }

  require(id: string): ScenarioPluginV1 {
    const plugin = this.plugin(id)
    if (!plugin) throw new ScenarioPluginError(`Scenario '${id}' is not registered`)
    return plugin
  }

  definition(id: string): ScenarioDefinition | undefined {
    return this.plugin(id)?.definition
  }

  runtime(id: string): ScenarioRuntime {
    return this.require(id).runtime
  }

  reference(id: string): FrozenScenarioPluginRef {
    const { manifest } = this.require(id)
    return {
      id: manifest.id,
      apiVersion: manifest.apiVersion,
      version: manifest.version,
      integrity: manifest.integrity,
    }
  }

  assertCompatible(reference: FrozenScenarioPluginRef): ScenarioPluginV1 {
    const plugin = this.require(reference.id)
    const actual = plugin.manifest
    if (actual.apiVersion !== reference.apiVersion || actual.version !== reference.version ||
        actual.integrity !== reference.integrity) {
      throw new ScenarioPluginError(
        `Scenario '${reference.id}' plugin mismatch: instance requires ` +
        `api=${reference.apiVersion} version=${reference.version} integrity=${reference.integrity}; ` +
        `loaded api=${actual.apiVersion} version=${actual.version} integrity=${actual.integrity}`,
      )
    }
    return plugin
  }

  ids(): string[] {
    return [...this.plugins.keys()].sort()
  }

  clone(): ScenarioRegistry {
    return new ScenarioRegistry([...this.plugins.values()])
  }
}

function validatePlugin(plugin: ScenarioPluginV1): void {
  if (!plugin || typeof plugin !== 'object') throw new ScenarioPluginError('Scenario plugin must be an object')
  const manifest = plugin.manifest
  if (!manifest || manifest.apiVersion !== SCENARIO_PLUGIN_API_VERSION) {
    throw new ScenarioPluginError(
      `Scenario plugin API must be ${SCENARIO_PLUGIN_API_VERSION} (got ${String(manifest?.apiVersion)})`,
    )
  }
  if (!manifest.id || manifest.id !== plugin.definition?.id || manifest.id !== plugin.runtime?.id) {
    throw new ScenarioPluginError('Scenario plugin manifest, definition and runtime IDs must match')
  }
  if (!manifest.version?.trim()) throw new ScenarioPluginError(`Scenario '${manifest.id}' needs a version`)
  if (!manifest.integrity?.trim()) throw new ScenarioPluginError(`Scenario '${manifest.id}' needs an integrity identity`)
  const definition = plugin.definition
  const runtime = plugin.runtime
  if (typeof definition.artifacts !== 'function' ||
      !Array.isArray(definition.artifactGateIds) ||
      !Array.isArray(definition.mandatoryArtifactGateIds) ||
      !Array.isArray(definition.gateBindings) ||
      typeof definition.allowAdditionalArtifacts !== 'boolean') {
    throw new ScenarioPluginError(`Scenario '${manifest.id}' has an invalid definition`)
  }
  if (typeof runtime.producerOutputContract !== 'function' ||
      typeof runtime.runProducerGate !== 'function' ||
      typeof runtime.harvestPreface !== 'function' ||
      typeof runtime.renderReport !== 'function') {
    throw new ScenarioPluginError(`Scenario '${manifest.id}' is missing required runtime hooks`)
  }
  const optionalHooks = [
    'buildCapsuleView', 'judgeContractExtension', 'artifactGate',
    'prepareEventWait', 'reconcileReadModel',
  ] as const
  for (const hook of optionalHooks) {
    if (runtime[hook] !== undefined && typeof runtime[hook] !== 'function') {
      throw new ScenarioPluginError(`Scenario '${manifest.id}' runtime hook '${hook}' must be a function`)
    }
  }
}
