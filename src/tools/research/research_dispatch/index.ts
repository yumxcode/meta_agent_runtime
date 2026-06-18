/**
 * research_dispatch — synchronous research sub-agent with disk-persisted deliverable.
 *
 * Context-isolation design ("result on disk + handle in context"):
 *   1. The sub-agent runs search → fetch → extract → synthesize in its OWN
 *      context. Paper full texts and raw fetches NEVER enter the main agent.
 *   2. The deliverable (report.md + sources.md) is written to
 *      <projectDir>/.meta-agent/research/<taskId>/ and registered in index.json
 *      (project-level → reusable across sessions).
 *   3. The main agent receives only a small handle: one-line conclusion +
 *      report path. Post-compaction, the deterministic anchors
 *      (buildResearchArtifactAnchors) tell the model to re-READ the report
 *      file rather than re-RUN the research (soft constraint, no dedupe).
 *
 * Synchronous by design: blocks until the sub-agent reaches terminal state.
 * Wall-clock cap: 10 minutes (RESEARCH_MAX_DURATION_MS).
 * Shared by robotics and agentic modes — only ISubAgentDispatcher is required.
 */

import type { MetaAgentTool, ToolResult } from '../../../core/types.js'
import type { ISubAgentDispatcher } from '../../../subagent/ISubAgentDispatcher.js'
import { ResearchStore } from '../../../research/ResearchStore.js'

export const RESEARCH_MAX_DURATION_MS = 600_000 // 10 minutes
const POLL_INTERVAL_MS = 2_000
const DEFAULT_MAX_TURNS = 60
const CONCLUSION_HANDLE_MAX = 300

const RESEARCH_AGENT_SYSTEM = `\
You are a ResearchAgent. Your job: search the literature/web on the given question,
read the relevant sources IN FULL where needed, extract exactly what the
extraction_spec asks for, and synthesize a self-contained report.

Search strategy:
1. DISCOVER sources with web_search (or MCP search via list_mcp_resources + mcp_call).
   Do NOT guess search-page URLs — they block bots and 404.
2. READ sources with web_fetch. Stable endpoints:
   - arXiv HTML:       https://arxiv.org/html/<id>          (best for full text)
   - arXiv API:        https://export.arxiv.org/api/query?search_query=all:<kw>
   - OpenAlex:         https://api.openalex.org/works?search=<kw>&per-page=10
   - Semantic Scholar: https://api.semanticscholar.org/graph/v1/paper/search?query=<kw>
3. Follow the extraction_spec EXACTLY — if it asks for formulas/weights/tables,
   extract the actual values, not paraphrases. Mark anything you could not
   verify as [unverified].

Deliverable — you MUST finish by calling return_result with:
- summary: ≤5 sentence prose conclusion of the whole research.
- data: {
    "conclusion":       "<one-line bottom line, ≤300 chars>",
    "report_markdown":  "<the FULL self-contained report in markdown — structure:
                         ## Question / ## Key Findings / ## Per-Source Details
                         (one section per source with the extracted content) /
                         ## Synthesis & Recommendation>",
    "sources_markdown": "<markdown list: every source consulted — title, year,
                         URL/arXiv id, one-line takeaway, plus short raw excerpts
                         that back the key extracted values>",
    "papers_covered":   <number of sources actually read>
  }
The report must be SELF-CONTAINED: a reader with no access to your context must
get everything from report_markdown alone. It will be saved to disk and re-read
later instead of re-running this research — completeness now saves a full re-run.
If you run low on time/turns, call return_result EARLY with what you have and
state explicitly in the report which parts are incomplete.
Calling return_result is what delivers your work — never skip it.`

interface ResearchData {
  conclusion?: string
  report_markdown?: string
  sources_markdown?: string
  papers_covered?: number
}

function clipLine(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`
}

function parseResearchData(output: unknown): ResearchData {
  if (!output || typeof output !== 'object') return {}
  const o = output as Record<string, unknown>
  return {
    conclusion: typeof o['conclusion'] === 'string' ? o['conclusion'] : undefined,
    report_markdown: typeof o['report_markdown'] === 'string' ? o['report_markdown'] : undefined,
    sources_markdown: typeof o['sources_markdown'] === 'string' ? o['sources_markdown'] : undefined,
    papers_covered: typeof o['papers_covered'] === 'number' ? o['papers_covered'] : undefined,
  }
}

export interface ResearchDispatchOptions {
  dispatcher: ISubAgentDispatcher
  projectDir: string
  sessionId: string
  /** Extra tool names to allow in the sub-agent (e.g. 'experience_write'). */
  extraAllowedTools?: string[]
}

export function createResearchDispatchTool(opts: ResearchDispatchOptions): MetaAgentTool {
  const store = new ResearchStore(opts.projectDir)

  return {
    name: 'research_dispatch',
    abortSupport: 'cooperative',
    permission: { category: 'state', checkpointBoundary: 'both' },
    // Opt out of the kernel per-tool timeout: this tool blocks on the
    // sub-agent, which is bounded by its own 10-min wall-clock cap.
    timeoutMs: 0,
    description:
      'Dispatch a ResearchAgent sub-agent to research a question: it searches, reads sources in full, ' +
      'extracts per your extraction_spec, and synthesizes a report — all in an ISOLATED context, so large ' +
      'paper/web content never enters your context. The report is SAVED TO DISK and you get back a one-line ' +
      'conclusion + report path. Use this for ALL literature/paper research instead of fetching papers yourself. ' +
      'After a compaction, re-READ the saved report file (read_file) — do NOT dispatch the same research again. ' +
      'Synchronous: blocks until done (up to 10 minutes).',
    inputSchema: {
      type: 'object',
      required: ['question'],
      properties: {
        question: {
          type: 'string',
          description: 'The research question (e.g. "minimal reward design for bipedal humanoid walking — what approaches exist?")',
        },
        extraction_spec: {
          type: 'string',
          description: 'EXACTLY what to extract from each source (e.g. "every reward term: formula, weight/scale, and ablation result"). The more precise, the more useful the report.',
        },
        scope: {
          type: 'string',
          description: 'Optional scope constraints: number of papers, year range, source preferences.',
        },
        max_turns: {
          type: 'number',
          description: `Max sub-agent turns (default ${DEFAULT_MAX_TURNS}).`,
        },
      },
    },
    async call(input, ctx): Promise<ToolResult> {
      const question = String(input['question'] ?? '').trim()
      if (!question) return { content: 'Error: question is required', isError: true }
      const extractionSpec = input['extraction_spec'] as string | undefined
      const scope = input['scope'] as string | undefined
      const maxTurns = (input['max_turns'] as number | undefined) ?? DEFAULT_MAX_TURNS

      const taskDescription = [
        '# Research Task',
        '',
        `## Question\n${question}`,
        ...(extractionSpec ? [`\n## Extraction Spec\n${extractionSpec}`] : []),
        ...(scope ? [`\n## Scope\n${scope}`] : []),
        '',
        RESEARCH_AGENT_SYSTEM,
      ].join('\n')

      try {
        const record = await opts.dispatcher.spawnSubAgent({
          config: {
            taskDescription,
            allowedTools: [
              'web_search', 'web_fetch', 'mcp_call', 'list_mcp_resources',
              'return_result',
              ...(opts.extraAllowedTools ?? []),
            ],
            maxTurns,
            maxDurationMs: RESEARCH_MAX_DURATION_MS,
          },
          abortSignal: ctx.abortSignal,
        })

        // ── Synchronous wait (sub-agent enforces the 10-min wall clock) ──────
        let status = record.status
        while (!['completed', 'failed', 'cancelled'].includes(status)) {
          if (ctx.abortSignal?.aborted) break
          await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
          const latest = await opts.dispatcher.getStatus(record.taskId)
          status = latest?.status ?? 'failed'
        }
        const final = await opts.dispatcher.getStatus(record.taskId)

        // ── Persist whatever deliverable came back (full or partial) ─────────
        const data = parseResearchData(final?.result?.output)
        const summaryText = final?.result?.summary?.trim() ?? ''
        const reportMarkdown = data.report_markdown?.trim() || summaryText
        const completed = final?.status === 'completed'

        if (!reportMarkdown) {
          return {
            content:
              `Research ${final?.status ?? 'failed'} with no usable deliverable.` +
              `${final?.result?.error ? ` Error: ${final.result.error}` : ''} Task ID: ${record.taskId}`,
            isError: true,
          }
        }

        const entry = await store.saveResult({
          taskId: record.taskId,
          question,
          status: completed ? 'success' : 'partial',
          conclusion: data.conclusion || clipLine(summaryText || reportMarkdown, CONCLUSION_HANDLE_MAX),
          reportMarkdown,
          sourcesMarkdown: data.sources_markdown,
          papersCovered: data.papers_covered,
          sessionId: opts.sessionId,
        })

        // ── Handle, not payload: this is ALL the main agent sees ────────────
        const statusLine = completed
          ? '🔬 Research complete.'
          : `🔬 Research returned PARTIAL results (${final?.status}${final?.result?.error ? `: ${final.result.error}` : ''}).`
        return {
          content: [
            statusLine,
            '',
            `Conclusion: ${entry.conclusion}`,
            ...(entry.papersCovered !== undefined ? [`Sources read: ${entry.papersCovered}`] : []),
            '',
            `Report saved: ${entry.reportPath}`,
            ...(entry.sourcesPath ? [`Sources list: ${entry.sourcesPath}`] : []),
            '',
            '→ For details, read_file the report (it is durable and survives compaction).',
            '→ Do NOT re-run this research or fetch these papers yourself.',
            ...(completed ? [] : ['→ To continue the incomplete parts, dispatch a NEW research_dispatch scoped to what the report marks as missing.']),
            `Task ID: ${record.taskId}`,
          ].join('\n'),
          isError: false,
        }
      } catch (err) {
        return { content: `research_dispatch failed: ${String(err)}`, isError: true }
      }
    },
  }
}
