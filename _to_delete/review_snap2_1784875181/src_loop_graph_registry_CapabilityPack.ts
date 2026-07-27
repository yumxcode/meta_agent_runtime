import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { FrozenCapabilityRef } from '../spec/GraphTypes.js'
import type { JsonValue } from '../spec/GraphTypes.js'
import type { CapabilityRegistry, EffectProvider, FunctionProvider, ReducerProvider } from './CapabilityRegistry.js'

export const GRAPH_CAPABILITY_PACK_API_VERSION = 'graph-pack-v1' as const

export interface CapabilityPackTarget {
  functions: CapabilityRegistry<FunctionProvider>
  reducers: CapabilityRegistry<ReducerProvider>
  effects: CapabilityRegistry<EffectProvider>
}

export interface GraphCapabilityPackV1 {
  apiVersion: typeof GRAPH_CAPABILITY_PACK_API_VERSION
  manifest: FrozenCapabilityRef & { description?: string }
  register(target: CapabilityPackTarget): void | Promise<void>
  /** Advisory compiler knowledge; it never adds Kernel node types or fixed topology. */
  scenarios?: GraphScenarioGuidance[]
}

export interface GraphScenarioGuidance {
  id: string
  description: string
  /** Principles and domain constraints, not a mandatory graph template. */
  guidance: string[]
  suggestedCapabilities?: string[]
  /** Optional partial examples shown as inspiration, never copied by Kernel. */
  graphFragments?: Array<{ id: string; description: string; fragment: JsonValue }>
}

export interface RegisteredGraphScenarioGuidance extends GraphScenarioGuidance {
  pack: FrozenCapabilityRef
}

export class CapabilityPackRegistry {
  private readonly manifestsByKey = new Map<string, FrozenCapabilityRef>()
  private readonly scenariosByKey = new Map<string, RegisteredGraphScenarioGuidance>()

  registerManifest(manifest: FrozenCapabilityRef): void {
    const key = `${manifest.id}@${manifest.version}`
    const existing = this.manifestsByKey.get(key)
    if (existing && existing.integrity !== manifest.integrity) throw new Error(`Capability Pack '${key}' integrity conflict`)
    // Pack authoring metadata (for example description) is advisory and is not
    // part of the executable FrozenCapabilityRef ABI. Strip it at registration
    // so catalog listings can be copied into a Graph without leaking unknown
    // executable fields.
    this.manifestsByKey.set(key, {
      id: manifest.id,
      version: manifest.version,
      integrity: manifest.integrity,
    })
  }

  has(reference: Pick<FrozenCapabilityRef, 'id' | 'version' | 'integrity'>): boolean {
    return this.manifestsByKey.get(`${reference.id}@${reference.version}`)?.integrity === reference.integrity
  }

  require(reference: Pick<FrozenCapabilityRef, 'id' | 'version' | 'integrity'>): FrozenCapabilityRef {
    const found = this.manifestsByKey.get(`${reference.id}@${reference.version}`)
    if (!found) throw new Error(`Capability Pack '${reference.id}@${reference.version}' is not loaded`)
    if (found.integrity !== reference.integrity) throw new Error(`Capability Pack '${reference.id}@${reference.version}' integrity mismatch`)
    return { ...found }
  }

  list(): FrozenCapabilityRef[] {
    return [...this.manifestsByKey.values()].map(item => ({ ...item })).sort((a, b) => `${a.id}@${a.version}`.localeCompare(`${b.id}@${b.version}`))
  }

  registerScenarios(pack: FrozenCapabilityRef, scenarios: GraphScenarioGuidance[]): void {
    for (const scenario of scenarios) {
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(scenario.id)) throw new Error(`Scenario guidance id '${scenario.id}' is invalid`)
      if (!scenario.description?.trim() || !Array.isArray(scenario.guidance) || scenario.guidance.some(item => !item.trim())) {
        throw new Error(`Scenario guidance '${scenario.id}' requires a description and non-empty guidance`)
      }
      if ((scenario.graphFragments?.length ?? 0) > 8) throw new Error(`Scenario guidance '${scenario.id}' has more than 8 graph fragments`)
      for (const fragment of scenario.graphFragments ?? []) {
        if (!fragment.id?.trim() || !fragment.description?.trim()) throw new Error(`Scenario guidance '${scenario.id}' has an invalid graph fragment`)
        if (Buffer.byteLength(JSON.stringify(fragment.fragment), 'utf8') > 65_536) throw new Error(`Scenario guidance '${scenario.id}' graph fragment '${fragment.id}' exceeds 65536 bytes`)
      }
      const key = `${pack.id}@${pack.version}:${scenario.id}`
      if (this.scenariosByKey.has(key)) throw new Error(`duplicate Scenario guidance '${key}'`)
      this.scenariosByKey.set(key, {
        ...scenario,
        guidance: [...scenario.guidance],
        ...(scenario.graphFragments ? { graphFragments: structuredClone(scenario.graphFragments) } : {}),
        pack: { ...pack },
      })
    }
  }

  scenarios(): RegisteredGraphScenarioGuidance[] {
    return [...this.scenariosByKey.values()].map(item => ({
      ...item,
      guidance: [...item.guidance],
      ...(item.graphFragments ? { graphFragments: structuredClone(item.graphFragments) } : {}),
      pack: { ...item.pack },
    }))
      .sort((a, b) => `${a.pack.id}:${a.id}`.localeCompare(`${b.pack.id}:${b.id}`))
  }
}

/** Load trusted local Pack modules. Distill only sees capabilities registered here. */
export async function loadGraphCapabilityPacks(input: {
  modulePaths: string[]
  target: CapabilityPackTarget
  registry: CapabilityPackRegistry
  allowedRoots: string[]
}): Promise<GraphCapabilityPackV1[]> {
  const loaded: GraphCapabilityPackV1[] = []
  for (const rawPath of input.modulePaths) {
    const path = await realpath(resolve(rawPath))
    const allowed = await Promise.all(input.allowedRoots.map(root => realpath(resolve(root)).catch(() => resolve(root))))
    if (!allowed.some(root => isUnder(path, root))) throw new Error(`Capability Pack path '${path}' is outside allowed roots`)
    const bytes = await readFile(path)
    const integrity = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
    const module = await import(`${pathToFileURL(path).href}?integrity=${integrity.slice(-16)}`) as Record<string, unknown>
    const pack = (module.default ?? module.pack) as GraphCapabilityPackV1 | undefined
    if (!pack || pack.apiVersion !== GRAPH_CAPABILITY_PACK_API_VERSION || typeof pack.register !== 'function') {
      throw new Error(`module '${path}' does not export a ${GRAPH_CAPABILITY_PACK_API_VERSION} Capability Pack`)
    }
    if (pack.manifest.integrity !== 'loader' && pack.manifest.integrity !== integrity) {
      throw new Error(`Capability Pack '${pack.manifest.id}' file integrity does not match its manifest`)
    }
    const resolvedPack: GraphCapabilityPackV1 = { ...pack, manifest: { ...pack.manifest, integrity } }
    input.registry.registerManifest(resolvedPack.manifest)
    await pack.register(input.target)
    input.registry.registerScenarios(resolvedPack.manifest, pack.scenarios ?? [])
    loaded.push(resolvedPack)
  }
  return loaded
}

function isUnder(path: string, root: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}
