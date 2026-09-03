import type { MetaAgentTool } from '../core/types.js'

const WORKSPACE_MUTATION_TOOL_NAMES = new Set([
  'apply_patch',
  'append_file',
  'bash',
  'edit_file',
  'exec_session',
  'notebook_edit',
  'powershell',
  'write_file',
])

/**
 * Whether a resolved tool can materially change files in the task workspace.
 *
 * The permission declaration is authoritative for built-ins and extensions.
 * The small name fallback keeps compatibility with older/custom registries
 * that registered the standard mutation tools before permission metadata was
 * mandatory.
 */
export function isWorkspaceMutationTool(tool: MetaAgentTool): boolean {
  return tool.permission?.category === 'write' ||
    WORKSPACE_MUTATION_TOOL_NAMES.has(tool.name)
}

export function resolvedWorkspaceMutationTools(
  allowedTools: readonly string[] | undefined,
  registry: ReadonlyMap<string, MetaAgentTool>,
  extraTools: readonly MetaAgentTool[] = [],
): MetaAgentTool[] {
  const resolved = (allowedTools ?? [])
    .map(name => registry.get(name))
    .filter((tool): tool is MetaAgentTool => tool !== undefined)
  return [...resolved, ...extraTools].filter(isWorkspaceMutationTool)
}
