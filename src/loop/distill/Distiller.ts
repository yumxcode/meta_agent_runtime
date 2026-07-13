/** One-shot, human-reviewed natural-language → Charter distillation. */
import type { ISubAgentDispatcher } from '../../subagent/ISubAgentDispatcher.js'
import { spawnAndWait } from '../seatSpawn.js'
import type { Charter } from '../charter/CharterTypes.js'
import { validateCharter } from '../charter/CharterValidate.js'
import {
  DISTILLER_SYSTEM,
  buildDistillerSystem,
  type DistillerPromptCatalog,
} from './DistillerPrompt.js'
import { listAllSkillNames } from '../../tools/system/skill/index.js'

export { DISTILLER_SYSTEM, buildDistillerSystem, type DistillerPromptCatalog }

export interface DistillResult {
  charter: Charter
  taskSpec: string
  attempts: number
}

export interface DistillDeps {
  dispatcher: ISubAgentDispatcher
  signal?: AbortSignal
  maxAttempts?: number
  /** Actual host registry catalog; prevents the model inventing adapters. */
  promptCatalog?: DistillerPromptCatalog
  projectDir?: string
}

export async function distillCharter(doc: string, deps: DistillDeps): Promise<DistillResult> {
  const maxAttempts = deps.maxAttempts ?? 3
  const signal = deps.signal ?? new AbortController().signal
  const discoveredSkills = deps.projectDir
    ? await listAllSkillNames(deps.projectDir, 'simple_auto')
    : []
  const systemPrompt = deps.promptCatalog || discoveredSkills.length > 0
    ? buildDistillerSystem({ ...deps.promptCatalog, skillNames: deps.promptCatalog?.skillNames ?? discoveredSkills })
    : DISTILLER_SYSTEM
  let lastErrors: string[] = []
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const task = [
      attempt > 1
        ? `你上一次的章程未通过校验，必须修复：\n- ${lastErrors.join('\n- ')}\n请输出修正后的完整 charter。`
        : null,
      '【loop 需求描述】',
      doc,
    ].filter(Boolean).join('\n\n')

    const rec = await spawnAndWait(
      deps.dispatcher,
      {
        taskDescription: task,
        systemPrompt,
        allowedTools: ['read_file', 'grep', 'glob'],
        maxTurns: 20,
        maxBudgetUsd: 1.5,
        requireHumanApproval: false,
        useEventDriven: false,
        pollIntervalMs: 500,
        checkpointEveryNTurns: 0,
      },
      signal,
    )
    const parsed = parseDistillOutput(rec?.result?.output, rec?.result?.summary)
    if (!parsed) {
      const status = rec?.status ?? 'no-record'
      const success = rec?.result?.success
      const err = String(rec?.result?.error ?? '').replace(/\s+/g, ' ').trim().slice(0, 600)
      const said = String(rec?.result?.summary ?? '').replace(/\s+/g, ' ').trim().slice(0, 400)
      const outKind = rec?.result?.output === undefined ? 'output=undefined' : `output=${typeof rec?.result?.output}`
      lastErrors = [
        `no parseable {charter, taskSpec} (sub-agent status=${status}, success=${success}, ${outKind}). ` +
        `sub-agent error: ${err || '(none)'}. sub-agent said: ${said || '(empty)'}`,
      ]
      continue
    }
    const errs = validateCharter(parsed.charter)
    if (errs.length === 0) return { charter: parsed.charter, taskSpec: parsed.taskSpec, attempts: attempt }
    lastErrors = errs
  }
  throw new Error(`distiller failed after ${maxAttempts} attempts:\n- ${lastErrors.join('\n- ')}`)
}

export function parseDistillOutput(
  output: unknown,
  summary?: string,
): { charter: Charter; taskSpec: string } | null {
  const candidates: unknown[] = [output]
  if (typeof output === 'string') {
    candidates.push(tryJson(output))
    candidates.push(...extractJsonObjects(output))
  }
  if (summary) candidates.push(...extractJsonObjects(summary))
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
    const obj = candidate as Record<string, unknown>
    const charter = obj['charter']
    if (charter && typeof charter === 'object') {
      return {
        charter: charter as Charter,
        taskSpec: typeof obj['taskSpec'] === 'string' ? obj['taskSpec'] : '',
      }
    }
  }
  return null
}

/** Extract top-level balanced JSON objects from prose while respecting strings. */
function extractJsonObjects(source: string): unknown[] {
  const out: unknown[] = []
  for (let i = 0; i < source.length; i++) {
    if (source[i] !== '{') continue
    let depth = 0, inString = false, escaped = false
    for (let j = i; j < source.length; j++) {
      const char = source[j]!
      if (inString) {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === '"') inString = false
        continue
      }
      if (char === '"') inString = true
      else if (char === '{') depth++
      else if (char === '}' && --depth === 0) {
        const value = tryJson(source.slice(i, j + 1))
        if (value !== null) out.push(value)
        i = j
        break
      }
    }
  }
  return out
}

function tryJson(source: string): unknown {
  try { return JSON.parse(source.trim()) } catch { return null }
}
