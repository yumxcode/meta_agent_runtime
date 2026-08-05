/**
 * cli/mcpInstructions — lazily-registered MCP server instructions (D5).
 *
 * Module state rather than a parameter because makeRouter() needs it and sits
 * far from the entry point. Registration is deferred until a command will
 * actually start an LLM session, so `--help`, `--version` and pure `loop`
 * subcommands stay usable while an optional MCP endpoint is down.
 *
 * Extracted from cli/index.ts.
 */
import { loadMcpConfig, buildMcpServerInstructions } from '../tools/mcp/index.js'
import type { McpServerInstruction } from '../core/dynamicPrompt.js'

/**
 * Process-wide MCP server instructions for D5 injection.
 * Populated once at startup after all MCP clients are registered.
 * makeRouter() reads this to inject into cfg.mcpServers.
 */
let _mcpServerInstructions: McpServerInstruction[] = []
let _mcpInstructionsReady = false

/**
 * Register MCP clients only when a command will actually start an LLM session.
 * Help, version, validation failures, and pure `loop` commands must stay local
 * and usable while an optional MCP endpoint is down.
 */
export async function ensureMcpServerInstructions(): Promise<void> {
  if (_mcpInstructionsReady) return
  _mcpInstructionsReady = true
  loadMcpConfig()
  _mcpServerInstructions = await buildMcpServerInstructions()
}

/** Instructions gathered by ensureMcpServerInstructions(); empty until then. */
export function getMcpServerInstructions(): McpServerInstruction[] {
  return _mcpServerInstructions
}
