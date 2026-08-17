import { afterEach, describe, expect, it, vi } from 'vitest'
import { McpAppsBrowserHost } from '../../../cli/mcpAppsHost.js'
import { createMcpCallTool } from '../mcp_call/index.js'
import {
  MCP_APP_HTML_MIME_TYPE,
  getMcpAppPresenter,
  mcpAppsClientCapabilities,
  registerMcpClient,
  setMcpAppPresenter,
  unregisterMcpClient,
  type McpClient,
} from '../registry.js'

afterEach(() => {
  setMcpAppPresenter(undefined)
  unregisterMcpClient('apps-test')
})

function fakeClient(): McpClient {
  return {
    async listTools() {
      return [
        {
          name: 'show_dashboard',
          inputSchema: { type: 'object' },
          _meta: { ui: { resourceUri: 'ui://test/dashboard' } },
        },
        {
          name: 'refresh_dashboard',
          inputSchema: { type: 'object' },
          _meta: { ui: { visibility: ['app'] } },
        },
      ]
    },
    async callTool(name, input) {
      return {
        content: [],
        structuredContent: { name, input, value: 42 },
        _meta: { privateForView: true },
      }
    },
    async readResource(uri) {
      return {
        contents: [{
          uri,
          mimeType: MCP_APP_HTML_MIME_TYPE,
          text: '<!doctype html><script>window.parent.postMessage({jsonrpc:"2.0",id:1,method:"ui/initialize",params:{appInfo:{name:"test",version:"1"},appCapabilities:{},protocolVersion:"2026-01-26"}},"*")</script>',
        }],
      }
    },
  }
}

describe('MCP Apps protocol integration', () => {
  it('advertises the extension only while a presenter is installed', () => {
    expect(mcpAppsClientCapabilities()).toEqual({})
    setMcpAppPresenter({ present: vi.fn() })
    expect(mcpAppsClientCapabilities()).toEqual({
      extensions: {
        'io.modelcontextprotocol/ui': { mimeTypes: [MCP_APP_HTML_MIME_TYPE] },
      },
    })
  })

  it('keeps structuredContent as the CLI fallback and presents linked UI', async () => {
    const client = fakeClient()
    const present = vi.fn(async () => undefined)
    registerMcpClient('apps-test', client)
    setMcpAppPresenter({ present })
    const tool = await createMcpCallTool()
    const result = await tool.call(
      { server_name: 'apps-test', tool_name: 'show_dashboard', tool_input: { q: 'x' } },
      { sessionId: 's', agentId: 'a', abortSignal: new AbortController().signal },
    )
    expect(result.isError).toBe(false)
    expect(result.content).toContain('"value":42')
    expect(result.content).toContain('MCP App rendered')
    expect(present).toHaveBeenCalledOnce()
  })

  it('does not expose app-only tools to model calls', async () => {
    registerMcpClient('apps-test', fakeClient())
    const tool = await createMcpCallTool()
    const result = await tool.call(
      { server_name: 'apps-test', tool_name: 'refresh_dashboard', tool_input: {} },
      { sessionId: 's', agentId: 'a', abortSignal: new AbortController().signal },
    )
    expect(result.isError).toBe(true)
    expect(result.content).toContain('app-only')
  })
})

describe('local MCP Apps browser host', () => {
  it('serves sandboxed HTML and brokers same-server app tool calls', async () => {
    const client = fakeClient()
    const host = new McpAppsBrowserHost({ port: 0, openBrowser: false })
    const info = await host.start()
    try {
      await host.present({
        serverName: 'apps-test',
        tool: (await client.listTools())[0]!,
        toolInput: { initial: true },
        toolResult: { content: [], structuredContent: { value: 1 } },
        resourceUri: 'ui://test/dashboard',
        client,
      })

      const parsed = new URL(info.url)
      const token = new URLSearchParams(parsed.hash.slice(1)).get('token')!
      const origin = parsed.origin
      const shell = await (await fetch(origin)).text()
      expect(shell).toContain('sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads"')
      expect(shell).not.toContain('allow-same-origin')
      expect((await fetch(`${origin}/state`)).status).toBe(401)

      const stateResponse = await fetch(`${origin}/state?token=${token}`)
      const state = await stateResponse.json() as { presentation: { id: string; appPath: string } }
      const appResponse = await fetch(`${origin}${state.presentation.appPath}`)
      expect(appResponse.status).toBe(200)
      expect(appResponse.headers.get('content-security-policy')).toContain("default-src 'none'")
      expect(await appResponse.text()).toContain('ui/initialize')

      const rpcResponse = await fetch(`${origin}/rpc?token=${token}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          presentationId: state.presentation.id,
          message: {
            jsonrpc: '2.0', id: 7, method: 'tools/call',
            params: { name: 'refresh_dashboard', arguments: { page: 2 } },
          },
        }),
      })
      const rpc = await rpcResponse.json() as { result?: { structuredContent?: Record<string, unknown> } }
      expect(rpc.result?.structuredContent).toMatchObject({ name: 'refresh_dashboard', value: 42 })
    } finally {
      await host.close()
    }
    expect(getMcpAppPresenter()).toBeUndefined()
  })
})
