export interface McpClient {
  callTool(toolName: string, toolInput: Record<string, unknown>): Promise<{ content: Array<{ type: string; text?: string }> }>
  listTools(): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>>
  listResources?(): Promise<Array<{ uri: string; name?: string; description?: string; mimeType?: string }>>
  readResource?(uri: string): Promise<{ contents: Array<{ uri: string; text?: string; blob?: string }> }>
}

export const mcpClients = new Map<string, McpClient>()

export function registerMcpClient(serverName: string, client: McpClient): void {
  mcpClients.set(serverName, client)
}

export function unregisterMcpClient(serverName: string): void {
  const client = mcpClients.get(serverName)
  mcpClients.delete(serverName)
  closeClient(client)
}

/**
 * Shut down every registered MCP client.
 *
 * Stdio clients now hold a LONG-LIVED server process (previously one process
 * was spawned and discarded per RPC, so there was nothing to clean up). Without
 * this, `npx …` servers would outlive the CLI as orphans, holding ports and
 * file locks. Call it from process-exit cleanup.
 */
export function disposeMcpClients(): void {
  const clients = [...mcpClients.values()]
  mcpClients.clear()
  for (const client of clients) closeClient(client)
}

function closeClient(client: McpClient | undefined): void {
  const closable = client as { close?: () => void } | undefined
  try { closable?.close?.() } catch { /* shutdown is best-effort */ }
}

export function getRegisteredMcpServers(): string[] {
  return [...mcpClients.keys()]
}
