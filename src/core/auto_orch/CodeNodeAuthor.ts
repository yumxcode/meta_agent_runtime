import type { ISubAgentDispatcher } from '../../subagent/ISubAgentDispatcher.js'
import type { OrchNode, OrchPlan } from './LoopIR.js'
import { spawnAndWait } from './reviewer.js'
import { readCodeNodeSource, writeCodeNodeArtifact } from './CodeNodeStore.js'

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
你是 auto_orch 的 code_author。你的任务是为一个或多个确定性 code 节点生成 JavaScript ESM 源码。

硬性契约：
- 只输出一个 JSON 代码块；单节点按任务要求输出 {"source":"...","note":"..."}，批量节点按任务要求输出 {"nodes":[{"id":"...","source":"...","note":"..."}]}。
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
  const nodes: OrchNode[] = [...plan.nodes]
  const pendingAuthored: Array<{ index: number; node: OrchNode }> = []

  for (let index = 0; index < plan.nodes.length; index++) {
    const node = plan.nodes[index]
    if (!node) continue
    if (node.kind !== 'code') {
      continue
    }
    if (node.codeRef && node.sourceHash) {
      try {
        await readCodeNodeSource(deps.projectDir, node.codeRef, node.sourceHash)
        continue
      } catch {
        // Saved plans can outlive their local code artifact directory. Re-freeze
        // the node from codeSpec instead of failing later at execution time.
      }
    }

    const builtin = builtinCodeNodeSource(node)
    if (builtin) {
      const outcome = await freezeAuthoredNode(node, builtin, deps).catch(err => ({
        error: err instanceof Error ? err.message : String(err),
      }))
      if ('error' in outcome) {
        errors.push(`code node[${node.id}] materialization failed: ${outcome.error}`)
      } else {
        nodes[index] = outcome.node
        materialized++
      }
      continue
    }

    pendingAuthored.push({ index, node })
  }

  if (pendingAuthored.length === 1) {
    const item = pendingAuthored[0]!
    const outcome = await authorAndFreezeSingle(item.node, deps, signal)
    if (!outcome.ok) errors.push(outcome.error)
    else {
      nodes[item.index] = outcome.node
      materialized++
    }
  } else if (pendingAuthored.length > 1) {
    const batch = await authorCodeNodesBatch(pendingAuthored.map(item => item.node), deps, signal).catch(() => null)
    const remaining: Array<{ index: number; node: OrchNode; previousErrors: string[] }> = []

    if (batch) {
      for (const item of pendingAuthored) {
        const authored = batch.get(item.node.id)
        if (!authored) {
          remaining.push({ ...item, previousErrors: ['batch code_author did not return this node'] })
          continue
        }
        const reviewErrors = reviewCodeNodeSource(authored.source)
        if (reviewErrors.length) {
          remaining.push({ ...item, previousErrors: reviewErrors })
          continue
        }
        const outcome = await freezeAuthoredNode(item.node, authored, deps).catch(err => ({
          error: err instanceof Error ? err.message : String(err),
        }))
        if ('error' in outcome) {
          remaining.push({ ...item, previousErrors: [outcome.error] })
        } else {
          nodes[item.index] = outcome.node
          materialized++
        }
      }
    } else {
      for (const item of pendingAuthored) {
        remaining.push({ ...item, previousErrors: ['batch code_author unavailable'] })
      }
    }

    for (const item of remaining) {
      const outcome = await authorAndFreezeSingle(item.node, deps, signal, item.previousErrors)
      if (!outcome.ok) errors.push(outcome.error)
      else {
        nodes[item.index] = outcome.node
        materialized++
      }
    }
  }

  return { plan: { ...plan, nodes }, materialized, errors }
}

async function authorAndFreezeSingle(
  node: OrchNode,
  deps: CodeNodeMaterializeDeps,
  signal: AbortSignal,
  initialErrors: string[] = [],
): Promise<{ ok: true; node: OrchNode } | { ok: false; error: string }> {
  let nextNode = node
  try {
    let previousErrors: string[] = initialErrors
    for (let attempt = 1; attempt <= 3; attempt++) {
      let authored: { source: string; note?: string }
      try {
        authored = await authorCodeNode(node, deps, signal, previousErrors)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        previousErrors = [message]
        if (attempt === 3) throw err
        continue
      }
      const reviewErrors = reviewCodeNodeSource(authored.source)
      if (reviewErrors.length) {
        previousErrors = reviewErrors
        if (attempt === 3) return { ok: false, error: `code node[${node.id}] failed review: ${reviewErrors.join('; ')}` }
        continue
      }
      nextNode = (await freezeAuthoredNode(node, authored, deps)).node
      break
    }
  } catch (err) {
    return { ok: false, error: `code node[${node.id}] materialization failed: ${err instanceof Error ? err.message : String(err)}` }
  }
  return { ok: true, node: nextNode }
}

async function freezeAuthoredNode(
  node: OrchNode,
  authored: { source: string; note?: string },
  deps: CodeNodeMaterializeDeps,
): Promise<{ node: OrchNode }> {
  const artifact = await writeCodeNodeArtifact(deps.projectDir, node.id, authored.source, authored.note)
  return {
    node: {
      ...node,
      codeRef: artifact.codeRef,
      sourceHash: artifact.sourceHash,
    },
  }
}

async function authorCodeNodesBatch(
  nodes: OrchNode[],
  deps: CodeNodeMaterializeDeps,
  signal: AbortSignal,
): Promise<Map<string, { source: string; note?: string }>> {
  const rec = await spawnAndWait(
    deps.dispatcher,
    {
      taskDescription: buildBatchAuthorTask(nodes),
      systemPrompt: CODE_AUTHOR_SYSTEM,
      allowedTools: [],
      maxTurns: Math.min(24, Math.max(10, nodes.length * 3)),
      maxBudgetUsd: Math.min(1.2, Math.max(0.4, nodes.length * 0.18)),
      requireHumanApproval: false,
      useEventDriven: false,
      pollIntervalMs: 500,
      checkpointEveryNTurns: 0,
      internal: true,
      workspaceMode: 'shared_readonly',
    },
    signal,
    { pollMs: 500, maxWaitMs: 12 * 60 * 1000 },
  )
  const summary = rec?.result?.summary
  if (rec?.status !== 'completed' || !summary) throw new Error('batch code_author unavailable')
  const parsed = parseBatchAuthorOutput(summary)
  if (!parsed.size) throw new Error('batch code_author returned no parseable nodes JSON')
  return parsed
}

function buildBatchAuthorTask(nodes: OrchNode[]): string {
  return [
    '为下面的多个 auto_orch code 节点批量生成确定性 JavaScript ESM 源码。',
    '',
    '必须只输出一个 JSON 代码块，格式如下：',
    '{"nodes":[{"id":"node_id","source":"export async function main(input, api) { ... }","note":"..."}]}',
    '',
    '每个输入节点都必须返回一项，id 必须完全一致。source 的安全契约与 system prompt 相同。',
    '',
    '【节点列表】',
    JSON.stringify(nodes.map(node => ({
      id: node.id,
      taskDescription: node.taskDescription,
      codeSpec: node.codeSpec ?? {},
      input: node.input ?? {},
      capabilities: node.capabilities ?? [],
    })), null, 2),
  ].join('\n')
}

function parseBatchAuthorOutput(text: string): Map<string, { source: string; note?: string }> {
  const out = new Map<string, { source: string; note?: string }>()
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map(m => m[1] ?? '')
  const candidates = fences.length ? fences : [text]
  for (let i = candidates.length - 1; i >= 0; i--) {
    const raw = candidates[i]?.trim()
    if (!raw) continue
    try {
      const obj = JSON.parse(raw) as unknown
      const entries = batchEntries(obj)
      if (!entries.length) continue
      for (const entry of entries) {
        if (typeof entry.id !== 'string' || typeof entry.source !== 'string') continue
        out.set(entry.id, {
          source: entry.source,
          note: typeof entry.note === 'string' ? entry.note : undefined,
        })
      }
      if (out.size) return out
    } catch {
      // next candidate
    }
  }
  return out
}

function batchEntries(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.filter(isRecord)
  if (!isRecord(value)) return []
  const nodes = value['nodes']
  if (Array.isArray(nodes)) return nodes.filter(isRecord)
  return Object.entries(value)
    .filter(([, entry]) => isRecord(entry) && typeof entry['source'] === 'string')
    .map(([id, entry]) => ({ id, ...(entry as Record<string, unknown>) }))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
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

function buildAuthorTask(node: OrchNode, previousErrors: string[] = []): string {
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
  if (previousErrors.length) {
    lines.push(
      '',
      '【上一版输出未通过物化/安全审查】',
      previousErrors.join('; '),
      '',
      '请重新生成完整 source。若需要写 updated_at/日志时间戳，使用 api.nowIso，不要使用 Date.now() 或 new Date()。',
      '必须只输出一个 JSON 代码块，形如 {"source":"...","note":"..."}。',
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

function builtinCodeNodeSource(node: OrchNode): { source: string; note?: string } | null {
  if (!isReportWriterNode(node)) return null
  const inputs = (node.codeSpec?.inputs ?? []).filter(isStatePath)
  const outputs = (node.codeSpec?.outputs ?? []).filter(isStatePath)
  const reportPath = outputs.find(p => p.endsWith('.md') || p.endsWith('.txt')) ?? `state/${node.id}.md`
  const title = reportTitle(node)
  const source = `\
export async function main(input, api) {
  const inputs = ${JSON.stringify(inputs)}
  const reportPath = ${JSON.stringify(reportPath)}
  const title = ${JSON.stringify(title)}
  const sections = []
  for (const path of inputs) {
    try {
      let value
      if (path.endsWith('.json')) value = await api.state.readJson(path)
      else value = await api.state.readText(path)
      sections.push('## ' + path + '\\n\\n' + formatValue(value))
    } catch (err) {
      sections.push('## ' + path + '\\n\\nUnavailable: ' + errorMessage(err))
    }
  }
  const body = '# ' + title + '\\n\\nGenerated at: ' + api.nowIso + '\\n\\n' + (sections.join('\\n\\n') || 'No declared inputs.')
  await api.state.writeText(reportPath, body + '\\n')
  return { action: 'branch', label: 'ok', data: { reportPath } }
}

function formatValue(value) {
  if (typeof value === 'string') return value
  return '~~~json\\n' + JSON.stringify(value, null, 2) + '\\n~~~'
}

function errorMessage(err) {
  return err && err.message ? String(err.message) : String(err)
}
`
  return { source, note: `built-in report writer for ${node.id}` }
}

function isReportWriterNode(node: OrchNode): boolean {
  if (node.kind !== 'code') return false
  const id = node.id.toLowerCase()
  const description = `${node.taskDescription} ${node.codeSpec?.description ?? ''}`.toLowerCase()
  const labels = new Set(node.codeSpec?.labels ?? [])
  const writesReport = (node.codeSpec?.outputs ?? []).some(p => isStatePath(p) && /\.(md|txt)$/i.test(p))
  const reportLike = id.includes('report') || id.includes('completion') || description.includes('report')
  return labels.has('ok') && (writesReport || reportLike)
}

function isStatePath(value: unknown): value is string {
  return typeof value === 'string' && !!value && !value.startsWith('/') && !value.includes('..')
}

function reportTitle(node: OrchNode): string {
  const id = node.id.toLowerCase()
  if (id.includes('attention')) return 'Attention Required Report'
  if (id.includes('completion')) return 'Completion Report'
  if (id.includes('error')) return 'Error Report'
  return 'Auto Orch Report'
}
