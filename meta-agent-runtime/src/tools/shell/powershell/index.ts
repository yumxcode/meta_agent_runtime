import { execFile } from 'child_process'
import { promisify } from 'util'
import type { MetaAgentTool, ToolCallContext, ToolResult } from '../../../core/types.js'
import { loadToolPrompt } from '../../util.js'

const execFileAsync = promisify(execFile)

export async function createPowerShellTool(): Promise<MetaAgentTool> {
  const description = await loadToolPrompt(import.meta.url)
  return {
    name: 'powershell',
    description,
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'PowerShell command' },
        timeout_ms: { type: 'number', description: 'Timeout ms. Default: 30000' },
      },
      required: ['command'],
    },
    async call(input: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolResult> {
      if (process.platform !== 'win32') return { content: 'Error: PowerShell is only available on Windows', isError: true }
      const command = input['command'] as string
      const timeoutMs = typeof input['timeout_ms'] === 'number' ? input['timeout_ms'] : 30000
      if (!command) return { content: 'Error: command is required', isError: true }
      try {
        const { stdout, stderr } = await execFileAsync('powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', command],
          { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024, signal: ctx.abortSignal })
        const parts: string[] = []
        if (stdout) parts.push(stdout)
        if (stderr) parts.push(`STDERR:\n${stderr}`)
        return { content: parts.join('\n') || '(no output)', isError: false }
      } catch (err: unknown) {
        const e = err as { stdout?: string; stderr?: string; code?: number; message?: string }
        return { content: [e.stdout, e.stderr && `STDERR:\n${e.stderr}`, `Exit: ${e.code}`].filter(Boolean).join('\n') || String(err), isError: true }
      }
    },
  }
}
