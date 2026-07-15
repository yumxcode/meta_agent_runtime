import type {
  ArtifactPublishSpec,
  CompiledLaneDataAccessSpec,
  CompiledDataPlaneRef,
  ContextSectionSpec,
  DataPlaneSpec,
  DataPlaneViewSpec,
  LoopGraphSpec,
  WorkspaceBindingSpec,
  WorkspaceProjectionSpec,
} from './GraphTypes.js'

/** Compile Distill-authored logical planes into the fixed physical Graph ABI. */
export function compileDataPlanes(spec: LoopGraphSpec): LoopGraphSpec & {
  compiledDataPlanes?: Record<string, CompiledDataPlaneRef>
  compiledLaneDataAccess?: Record<string, CompiledLaneDataAccessSpec>
} {
  if (!Object.keys(spec.dataPlanes ?? {}).length) return clone(spec)
  const graph = clone(spec) as LoopGraphSpec & {
    compiledDataPlanes?: Record<string, CompiledDataPlaneRef>
    compiledLaneDataAccess?: Record<string, CompiledLaneDataAccessSpec>
  }
  graph.artifacts = { ...(graph.artifacts ?? {}) }
  graph.evidenceViews = { ...(graph.evidenceViews ?? {}) }
  graph.artifactViews = { ...(graph.artifactViews ?? {}) }
  graph.workspaceBindings = { ...(graph.workspaceBindings ?? {}) }
  graph.compiledDataPlanes = {}
  graph.compiledLaneDataAccess = {}

  for (const [planeId, plane] of Object.entries(graph.dataPlanes ?? {})) {
    const ref: CompiledDataPlaneRef = { backend: plane.backend, trust: plane.trust }
    if (plane.backend === 'record') {
      const channel = physicalPlaneId(planeId)
      graph.artifacts[channel] = {
        kind: plane.recordKind,
        ...(plane.schema ? { schema: plane.schema } : {}),
        admission: plane.admission,
        ...(plane.retention?.maxItems !== undefined ? { maxItems: plane.retention.maxItems } : {}),
      }
      ref.physicalId = channel
    } else if (plane.backend === 'workspace') {
      const binding = physicalPlaneId(planeId)
      graph.workspaceBindings[binding] = compileWorkspaceBinding(plane.binding, graph)
      ref.physicalId = binding
    }
    graph.compiledDataPlanes[planeId] = ref
  }

  for (const [viewId, view] of Object.entries(graph.dataViews ?? {})) {
    const plane = requirePlane(graph, view.plane)
    if (plane.backend !== 'record') continue
    const physicalView = physicalViewId(viewId)
    const declaration = {
      channels: [physicalPlaneId(view.plane)],
      ...(view.statuses ? { statuses: view.statuses } : {}),
      ...(view.maxItems !== undefined ? { maxItems: view.maxItems } : {}),
    }
    if (plane.recordKind === 'evidence') graph.evidenceViews[physicalView] = declaration
    else graph.artifactViews[physicalView] = declaration
  }

  for (const [laneId, lane] of Object.entries(graph.lanes)) {
    graph.compiledLaneDataAccess[laneId] = {
      readViews: (lane.dataAccess?.read ?? []).flatMap(grant => (grant.views ?? viewsForPlane(graph, grant.plane)).map(viewId => {
        const view = graph.dataViews?.[viewId]
        const plane = view ? requirePlane(graph, view.plane) : requirePlane(graph, grant.plane)
        return {
          view: physicalViewId(viewId),
          backend: plane.backend,
          ...(plane.backend === 'record' ? { physicalId: physicalViewId(viewId) }
            : plane.backend === 'workspace' ? { physicalId: physicalPlaneId(grant.plane) } : {}),
        }
      })),
      publishChannels: (lane.dataAccess?.publish ?? []).map(physicalPlaneId),
      writeBindings: (lane.dataAccess?.write ?? []).map(physicalPlaneId),
    }
  }

  graph.nodes = Object.fromEntries(Object.entries(graph.nodes).map(([nodeId, node]) => {
    const next = clone(node)
    if (next.type === 'agent' && next.context) {
      next.context.sections = next.context.sections.map(section => compileContextSection(section, graph))
    }
    if (next.publishes) next.publishes = next.publishes.map(publication => compilePublication(publication, graph))
    return [nodeId, next]
  }))
  return graph
}

export function physicalPlaneId(id: string): string { return `dp_${id}` }
export function physicalViewId(id: string): string { return `dv_${id}` }

function compileContextSection(section: ContextSectionSpec, graph: LoopGraphSpec): ContextSectionSpec {
  if (section.provider !== 'builtin/data-plane-view@1') return section
  const viewId = configString(section.config, 'view')
  const view = graph.dataViews?.[viewId]
  if (!view) throw new Error(`unknown Data View '${viewId}'`)
  const plane = requirePlane(graph, view.plane)
  switch (plane.backend) {
    case 'state': return {
      ...section,
      provider: 'builtin/state@1',
      config: { keys: view.stateKeys ?? plane.stateKeys },
    }
    case 'record': return {
      ...section,
      provider: plane.recordKind === 'evidence' ? 'builtin/evidence-view@1' : 'builtin/artifact-view@1',
      config: { view: physicalViewId(viewId) },
    }
    case 'journal': return {
      ...section,
      provider: 'builtin/journal-view@1',
      config: {
        eventTypes: view.eventTypes ?? plane.eventTypes ?? [],
        ...(view.maxItems !== undefined ? { maxItems: view.maxItems } : {}),
      },
    }
    case 'workspace': return {
      ...section,
      provider: 'builtin/workspace-binding@1',
      config: { binding: physicalPlaneId(view.plane) },
    }
  }
}

function compilePublication(publication: ArtifactPublishSpec, graph: LoopGraphSpec): ArtifactPublishSpec {
  if (!publication.plane) return publication
  const plane = requirePlane(graph, publication.plane)
  if (plane.backend !== 'record') throw new Error(`Data Plane '${publication.plane}' is not publishable record storage`)
  const { plane: _plane, ...rest } = publication
  return { ...rest, channel: physicalPlaneId(publication.plane) }
}

function compileWorkspaceBinding(binding: WorkspaceBindingSpec, graph: LoopGraphSpec): WorkspaceBindingSpec {
  const projection = binding.projection
  if (projection?.kind !== 'data_view') return binding
  return { ...binding, projection: compileWorkspaceProjection(projection, graph) }
}

function compileWorkspaceProjection(projection: Extract<WorkspaceProjectionSpec, { kind: 'data_view' }>, graph: LoopGraphSpec): WorkspaceProjectionSpec {
  const view = graph.dataViews?.[projection.view]
  if (!view) throw new Error(`unknown Data View '${projection.view}'`)
  const plane = requirePlane(graph, view.plane)
  switch (plane.backend) {
    case 'state': return { kind: 'state', keys: view.stateKeys ?? plane.stateKeys }
    case 'record': return {
      kind: plane.recordKind === 'evidence' ? 'evidence_view' : 'artifact_view',
      view: physicalViewId(projection.view),
      ...(projection.record ? { record: projection.record } : {}),
      ...(projection.flattenArrays !== undefined ? { flattenArrays: projection.flattenArrays } : {}),
    }
    case 'journal': return {
      kind: 'journal',
      eventTypes: view.eventTypes ?? plane.eventTypes,
      ...(projection.record === 'content' ? { record: 'event' as const } : projection.record ? { record: projection.record as 'event' | 'envelope' } : {}),
    }
    case 'workspace': throw new Error(`Workspace Data View '${projection.view}' cannot be a materialization source`)
  }
}

function requirePlane(graph: LoopGraphSpec, id: string): DataPlaneSpec {
  const plane = graph.dataPlanes?.[id]
  if (!plane) throw new Error(`unknown Data Plane '${id}'`)
  return plane
}

function viewsForPlane(graph: LoopGraphSpec, planeId: string): string[] {
  return Object.entries(graph.dataViews ?? {}).filter(([, view]) => view.plane === planeId).map(([viewId]) => viewId)
}

function configString(config: ContextSectionSpec['config'], key: string): string {
  if (!config || typeof config !== 'object' || Array.isArray(config) || typeof config[key] !== 'string') {
    throw new Error(`data-plane-view config.${key} must be a string`)
  }
  return config[key]
}

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T }
