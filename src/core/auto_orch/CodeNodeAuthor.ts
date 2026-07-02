import type { ISubAgentDispatcher } from '../../subagent/ISubAgentDispatcher.js'
import type { OrchNode, OrchPlan } from './LoopIR.js'
import { spawnAndWait } from './reviewer.js'
import { writeCodeNodeArtifact } from './CodeNodeStore.js'

export interface CodeNodeMaterializeDeps {
  dispatcher: ISubAgentDispatcher
  projectDir: string
}

export interface CodeNodeMaterializeResult {
  plan: OrchPlan
  materialized: number
  errors: string[]
}

const CODE_AUTHOR_SYSTEM = `\
你是 auto_orch 的 code_author。你的任务是为一个确定性 code 节点生成 JavaScript ESM 源码。

硬性契约：
- 只输出一个 JSON 代码块：{"source":"...","note":"..."}。
- source 必须导出 async function main(input, api) 或 function main(input, api)。
- 不要 import/require 任何模块；不要访问 process、globalThis、eval、Function、网络、shell、计时器或随机数。
- 所有状态读写只能通过 api.state.readJson/writeJson/appendJsonl/readText/writeText。
- 如需当前 ISO 时间戳，只能读取 api.nowIso 字符串；禁止使用 Date.now() 或 new Date()。
- 返回值必须是 OrchVerdict JSON 对象，如 {"action":"branch","label":"healthy","data":{...}}。
- 遇到输入缺失或状态不合法，返回 {"action":"branch","label":"error","note":"..."}，不要抛未处理异常。
`

const FORBIDDEN_CODE_PATTERNS: RegExp[] = [
  /\bimport\s+/,
  /\brequire\s*\(/,
  /\bchild_process\b/,
  /\bprocess\b/,
  /\bglobalThis\b/,
  /\beval\s*\(/,
  /\bFunction\s*\(/,
  /\bfetch\s*\(/,
  /\bXMLHttpRequest\b/,
  /\bsetTimeout\b/,
  /\bsetInterval\b/,
  /\bMath\.random\b/,
  /\bDate\.now\b/,
  /\bnew\s+Date\b/,
]

export function reviewCodeNodeSource(source: string): string[] {
  const errs: string[] = []
  if (!source.trim()) errs.push('source is empty')
  if (source.length > 20_000) errs.push('source exceeds 20000 characters')
  if (!/export\s+(async\s+)?function\s+main\s*\(/.test(source)) {
    errs.push('source must export function main(input, api)')
  }
  for (const pattern of FORBIDDEN_CODE_PATTERNS) {
    if (pattern.test(source)) errs.push(`source uses forbidden construct: ${pattern.source}`)
  }
  return errs
}

export async function materializeCodeNodes(
  plan: OrchPlan,
  deps: CodeNodeMaterializeDeps,
  signal: AbortSignal,
): Promise<CodeNodeMaterializeResult> {
  const errors: string[] = []
  let materialized = 0
  const nodes: OrchNode[] = []

  for (const node of plan.nodes) {
    if (node.kind !== 'code' || (node.codeRef && node.sourceHash)) {
      nodes.push(node)
      continue
    }
    let nextNode = node
    try {
      let previousReviewErrors: string[] = []
      for (let attempt = 1; attempt <= 2; attempt++) {
        const authored = await authorCodeNode(node, deps, signal, previousReviewErrors)
        const reviewErrors = reviewCodeNodeSource(authored.source)
        if (reviewErrors.length) {
          previousReviewErrors = reviewErrors
          if (attempt === 2) errors.push(`code node[${node.id}] failed review: ${reviewErrors.join('; ')}`)
          continue
        }
        const artifact = await writeCodeNodeArtifact(deps.projectDir, node.id, authored.source, authored.note)
        nextNode = {
          ...node,
          codeRef: artifact.codeRef,
          sourceHash: artifact.sourceHash,
        }
        materialized++
        break
      }
    } catch (err) {
      errors.push(`code node[${node.id}] materialization failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    nodes.push(nextNode)
  }

  return { plan: { ...plan, nodes }, materialized, errors }
}

async function authorCodeNode(
  node: OrchNode,
  deps: CodeNodeMaterializeDeps,
  signal: AbortSignal,
  previousReviewErrors: string[] = [],
): Promise<{ source: string; note?: string }> {
  const rec = await spawnAndWait(
    deps.dispatcher,
    {
      taskDescription: buildAuthorTask(node, previousReviewErrors),
      systemPrompt: CODE_AUTHOR_SYSTEM,
      allowedTools: [],
      maxTurns: 8,
      maxBudgetUsd: 0.3,
      requireHumanApproval: false,
      useEventDriven: false,
      pollIntervalMs: 500,
      checkpointEveryNTurns: 0,
      internal: true,
      workspaceMode: 'shared_readonly',
    },
    signal,
    { pollMs: 500, maxWaitMs: 8 * 60 * 1000 },
  )
  const summary = rec?.result?.summary
  if (rec?.status !== 'completed' || !summary) throw new Error('code_author unavailable')
  const parsed = parseAuthorOutput(summary)
  if (!parsed) throw new Error('code_author returned no parseable source JSON')
  return parsed
}

function buildAuthorTask(node: OrchNode, previousReviewErrors: string[] = []): string {
  const lines = [
    '为下面的 auto_orch code 节点生成确定性 JavaScript 源码。',
    '',
    '【节点 id】',
    node.id,
    '',
    '【节点任务】',
    node.taskDescription,
    '',
    '【codeSpec】',
    JSON.stringify(node.codeSpec ?? {}, null, 2),
    '',
    '【input 示例/常量】',
    JSON.stringify(node.input ?? {}, null, 2),
    '',
    '【capabilities】',
    JSON.stringify(node.capabilities ?? [], null, 2),
  ]
  if (previousReviewErrors.length) {
    lines.push(
      '',
      '【上一版源码未通过安全审查】',
      previousReviewErrors.join('; '),
      '',
      '请重新生成完整 source。若需要写 updated_at/日志时间戳，使用 api.nowIso，不要使用 Date.now() 或 new Date()。',
    )
  }
  return lines.join('\n')
}

function parseAuthorOutput(text: string): { source: string; note?: string } | null {
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map(m => m[1] ?? '')
  const candidates = fences.length ? fences : [text]
  for (let i = candidates.length - 1; i >= 0; i--) {
    const raw = candidates[i]?.trim()
    if (!raw) continue
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>
      if (typeof obj['source'] !== 'string') continue
      return {
        source: obj['source'],
        note: typeof obj['note'] === 'string' ? obj['note'] : undefined,
      }
    } catch {
      // next candidate
    }
  }
  return null
}
