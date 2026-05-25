import { RoboticsProjectStore } from '../../persistence/RoboticsProjectStore.js';
const PAPER_SEARCH_SYSTEM = `\
You are a PaperSearchAgent specializing in robotics and control systems research.
Your task is to search for, read, and synthesize academic papers on the given topic.

Search strategy:
1. Use web_fetch to search arXiv (https://arxiv.org/search/?searchtype=all&query=<keywords>)
2. Search Semantic Scholar (https://api.semanticscholar.org/graph/v1/paper/search?query=<keywords>)
3. Focus on papers from the last 3 years unless foundational work is requested
4. Read abstracts and conclusions thoroughly; only read full papers if critical

For each paper found, extract:
- Title, authors, year, arXiv ID / DOI
- Key contribution in ≤ 3 sentences
- Relevance to the search query
- Any quantitative results (benchmarks, success rates, etc.)

Return a structured JSON block at the end:
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

Also call experience_write to record the literature survey as an experience entry.
`;
export function createPaperSearchTool(bridge, projectDir) {
    return {
        name: 'paper_search',
        description: 'Dispatch a PaperSearchAgent sub-agent to survey academic literature on a robotics topic. ' +
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
        async call(input, ctx) {
            const query = String(input['query'] ?? '');
            const focus = input['focus'];
            const minPapers = input['min_papers'] ?? 5;
            const maxTurns = input['max_turns'] ?? 40;
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
            ].join('\n');
            try {
                const record = await bridge.spawnSubAgent({
                    config: {
                        taskDescription,
                        allowedTools: ['web_fetch', 'web_search', 'experience_write'],
                        maxTurns,
                    },
                    abortSignal: ctx.abortSignal,
                });
                await RoboticsProjectStore.registerSubAgentTask(projectDir, {
                    taskId: record.taskId,
                    role: 'paper_search',
                    title: `Paper search: ${query.slice(0, 50)}`,
                    spawnedAt: Date.now(),
                });
                const awaitCompletion = input['await_completion'] !== false; // default true
                if (awaitCompletion) {
                    let status = record.status;
                    while (!['completed', 'failed', 'cancelled'].includes(status)) {
                        await new Promise(r => setTimeout(r, 2_000));
                        const latest = await bridge.getStatus(record.taskId);
                        status = latest?.status ?? 'failed';
                    }
                    const final = await bridge.getStatus(record.taskId);
                    await RoboticsProjectStore.completeSubAgentTask(projectDir, record.taskId);
                    if (final?.status === 'completed') {
                        return { content: `📚 Paper search complete.\n\n${final.result ?? ''}`, isError: false };
                    }
                    return {
                        content: `Paper search ${final?.status ?? 'failed'}. Task ID: ${record.taskId}`,
                        isError: true,
                    };
                }
                return {
                    content: `📚 Paper search dispatched (task: ${record.taskId}). Use get_sub_agent_status to check progress.`,
                    isError: false,
                };
            }
            catch (err) {
                return { content: `paper_search failed: ${String(err)}`, isError: true };
            }
        },
    };
}
//# sourceMappingURL=index.js.map