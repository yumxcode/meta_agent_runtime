import { execFile } from 'child_process'
import { promisify } from 'util'
import type { MetaAgentTool, ToolCallContext, ToolResult } from '../../../core/types.js'
import { dynamicDescription } from '../../util.js'

const execFileAsync = promisify(execFile)
const MAX_OUT = 100 * 1024

export async function createBashTool(): Promise<MetaAgentTool> {
  // Dynamic description: tells the model to prefer sibling tools over shell
  // equivalents — but only lists the ones actually registered in the session.
  // Mirrors CC's BashTool.prompt() which injects tool names at resolution time.
  const description = dynamicDescription(import.meta.url, (base, ctx) => {
    const hints: string[] = []
    if (ctx.toolNames.has('grep'))          hints.push('- Search file contents: use `grep` tool (NOT rg/grep commands)')
    if (ctx.toolNames.has('glob'))          hints.push('- Find files by pattern: use `glob` tool (NOT find/ls)')
    if (ctx.toolNames.has('read_file'))     hints.push('- Read files: use `read_file` tool (NOT cat/head/tail)')
    if (ctx.toolNames.has('edit_file'))     hints.push('- Edit files: use `edit_file` tool (NOT sed/awk)')
    if (ctx.toolNames.has('write_file'))    hints.push('- Write files: use `write_file` tool (NOT echo >/tee)')
    if (ctx.toolNames.has('notebook_edit')) hints.push('- Edit Jupyter cells: use `notebook_edit` tool')
    return hints.length
      ? `${base}\n\nPrefer these tools over shell equivalents when available:\n${hints.join('\n')}`
      : base
  })
  return {
    name: 'bash',
    description,
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Bash command to execute' },
        timeout_ms: { type: 'number', description: 'Timeout ms. Default: 30000, max: 120000' },
        cwd: { type: 'string', description: 'Working directory. Default: process.cwd()' },
      },
      required: ['command'],
    },
    async call(input: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolResult> {
      const command = input['command'] as string
      const timeoutMs = Math.min(typeof input['timeout_ms'] === 'number' ? input['timeout_ms'] : 30000, 120000)
      const cwd = (input['cwd'] as string | undefined) ?? process.cwd()
      if (!command) return { content: 'Error: command is required', isError: true }
      const trunc = (s: string) => s.length > MAX_OUT ? s.slice(0, MAX_OUT) + `\n[Truncated — ${s.length} bytes]` : s
      try {
        const { stdout, stderr } = await execFileAsync('bash', ['-c', command], {
          timeout: timeoutMs, cwd, maxBuffer: MAX_OUT * 2,
          signal: ctx.abortSignal, env: process.env as NodeJS.ProcessEnv,
        })
        const parts: string[] = []
        if (stdout) parts.push(trunc(stdout))
        if (stderr) parts.push(`STDERR:\n${trunc(stderr)}`)
        return { content: parts.join('\n') || '(no output)', isError: false }
      } catch (err: unknown) {
        const e = err as { killed?: boolean; stdout?: string; stderr?: string; code?: number; message?: string }
        if (e.killed) return { content: `Command timed out after ${timeoutMs}ms`, isError: true }
        const parts: string[] = []
        if (e.stdout) parts.push(e.stdout)
        if (e.stderr) parts.push(`STDERR:\n${e.stderr}`)
        if (e.code !== undefined) parts.push(`Exit code: ${e.code}`)
        return { content: parts.join('\n') || e.message || String(err), isError: true }
      }
    },
  }
}
