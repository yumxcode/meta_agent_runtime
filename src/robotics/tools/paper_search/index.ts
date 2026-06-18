import type { MetaAgentTool, ToolResult } from '../../../core/types.js'
import type { ISubAgentDispatcher } from "../../../subagent/ISubAgentDispatcher.js"
import { RoboticsProjectStore } from '../../persistence/RoboticsProjectStore.js'

const PAPER_SEARCH_SYSTEM = `\
You are a PaperSearchAgent specializing in robotics and control systems research.
Your task is to search for, read, and synthesize academic papers on the given topic.

Search strategy:
1. To DISCOVER sources, use the web_search tool — do NOT guess search-page URLs
   like github.com/search and fetch them; those block bots and 404.
2. If an MCP search server is connected, prefer it: call list_mcp_resources first to
   discover available servers/tools, then use mcp_call to run searches.
3. To READ a specific page or query a JSON API, use web_fetch on stable endpoints:
   - OpenAlex:         https://api.openalex.org/works?search=<keywords>&per-page=10
   - Semantic Scholar: https://api.semanticscholar.org/graph/v1/paper/search?query=<keywords>
   - arXiv:            https://export.arxiv.org/api/query?search_query=all:<keywords>
   - GitHub repos:     https://api.github.com/search/repositories?q=<keywords>&sort=stars
4. Focus on papers from the last 3 years unless foundational work is requested
5. Read abstracts and conclusions thoroughly; only read full papers if critical

For each paper found, extract:
- Title, authors, year, arXiv ID / DOI
- Key contribution in ≤ 3 sentences
- Relevance to the search query
- Any quantitative results (benchmarks, success rates, etc.)

When you are done, submit your findings with the return_result tool. Put a short
prose summary in "summary" and the structured survey in "data" using this shape:
\`\`\`json
{
  "papers": [
    {
      "id": "<arxiv_id or doi>",
      "title": "...",
      "year": 2024,
      "keyContribution": "...",
      "relevance": "high" | "medium" | "low",
      "metrics": { "<metric>": "<value>" }
    }
  ],
  "synthesis": "<overall synthesis of the field — what approaches exist, what works, what's open>",
  "recommendation": "<which approach best fits the user's requirements and why>"
}
\`\`\`
Calling return_result is what hands your survey back to the main agent — do not skip it.

Also call experience_write to propose the literature survey as a pending experience entry.
The main session user must approve it with /experience review before it is committed.
`

export function createPaperSearchTool(
  bridge: ISubAgentDispatcher,
  projectDir: string,
  sessionId: string,
): MetaAgentTool {
  return {
    name: 'paper_search',
    abortSupport: 'cooperative',
    // Opt out of the kernel's per-tool timeout: this tool blocks while awaiting
    // the PaperSearchAgent sub-agent, which is bounded by its own 5-min cap.
    timeoutMs: 0,
    description:
      'Dispatch a PaperSearchAgent sub-agent to survey academic literature on a robotics topic. ' +
      'The agent searches arXiv and Semantic Scholar, synthesizes findings, and returns a structured summary. ' +
      'Use this at the start of algorithm development to ground your work in existing research.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: {
          type: 'string',
          description: 'Search query (e.g. "CPG locomotion quadruped 2024", "SLAM dynamic environment")',
        },
        focus: {
          type: 'string',
          description: 'Additional focus or constraints (e.g. "focus on RL-based methods", "compare against model-based")',
        },
        min_papers: {
          type: 'number',
          description: 'Minimum number of papers to find (default 5)',
        },
        await_completion: {
          type: 'boolean',
          description: 'Wait for completion (default true for paper searches)',
        },
        max_turns: {
          type: 'number',
          description: 'Max agent turns (default 40)',
        },
      },
    },
    async call(input, ctx): Promise<ToolResult> {
      const query = String(input['query'] ?? '')
      const focus = input['focus'] as string | undefined
      const minPapers = (input['min_papers'] as number | undefined) ?? 5
      const maxTurns = (input['max_turns'] as number | undefined) ?? 40

      const taskDescription = [
        `# Paper Search Task`,
        ``,
        `## Query\n${query}`,
        ...(focus ? [`\n## Additional Focus\n${focus}`] : []),
        ``,
        `## Requirements`,
        `- Find at least ${minPapers} relevant papers`,
        `- Prioritize papers from 2022–2025`,
        `- Synthesize findings and make a concrete recommendation`,
        ``,
        PAPER_SEARCH_SYSTEM,
      ].join('\n')

      try {
        const record = await bridge.spawnSubAgent({
          config: {
            taskDescription,
            allowedTools: ['web_search', 'web_fetch', 'mcp_call', 'list_mcp_resources', 'experience_write', 'return_result'],
            maxTurns,
            maxDurationMs: 300_000,
          },
          abortSignal: ctx.abortSignal,
        })

        await RoboticsProjectStore.registerSubAgentTask(projectDir, sessionId, {
          taskId: record.taskId,
          role: 'paper_search',
          title: `Paper search: ${query.slice(0, 50)}`,
          spawnedAt: Date.now(),
        })

        const awaitCompletion = input['await_completion'] !== false  // default true

        if (awaitCompletion) {
          let status = record.status
          while (!['completed', 'failed', 'cancelled'].includes(status)) {
            if (ctx.abortSignal?.aborted) { status = 'cancelled'; break }
            await new Promise(r => setTimeout(r, 2_000))
            const latest = await bridge.getStatus(record.taskId)
            status = latest?.status ?? 'failed'
          }
          const final = await bridge.getStatus(record.taskId)
          await RoboticsProjectStore.completeSubAgentTask(projectDir, sessionId, record.taskId)

          if (final?.status === 'completed') {
            const summary = final.result?.summary ?? ''
            return {
              content: `📚 Paper search complete.\n\n${summary}\n\nTask ID: ${record.taskId}`,
              isError: false,
            }
          }
          const partialSummary = final?.result?.summary
          if (partialSummary?.trim()) {
            const finalStatus = final?.status ?? 'failed'
            const finalError = final?.result?.error
            const error = finalError ? `\n\nStatus: ${finalStatus}. Error: ${finalError}` : `\n\nStatus: ${finalStatus}.`
            return {
              content: `📚 Paper search returned partial results before stopping.\n\n${partialSummary}${error}\nTask ID: ${record.taskId}`,
              isError: false,
            }
          }
          return {
            content: `Paper search ${final?.status ?? 'failed'}. Task ID: ${record.taskId}`,
            isError: true,
          }
        }

        return {
          content: `📚 Paper search dispatched (task: ${record.taskId}). Use get_sub_agent_status to check progress.`,
          isError: false,
        }
      } catch (err) {
        return { content: `paper_search failed: ${String(err)}`, isError: true }
      }
    },
  }
}
