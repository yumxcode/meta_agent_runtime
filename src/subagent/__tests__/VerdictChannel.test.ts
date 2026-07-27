/**
 * Judge sub-agents must be parsable whichever output channel they pick.
 *
 * `SubAgentRunner` always injects `return_result`, whose description tells the
 * model to use it "instead of relying on your chat text", while the judge
 * rubrics historically demanded a trailing JSON block. The runtime only read
 * the text channel, so a model that obeyed the tool produced an unparsable
 * verdict → the gate retried the whole judge (30 turns / $1 each) and then
 * halted the auto run. These tests pin both channels.
 */
import { describe, it, expect } from 'vitest'
import {
  buildVerdictOutputProtocol,
  readVerdictChannels,
  parseFromVerdictChannels,
} from '../verdictChannel.js'
import { parseVerdict, buildJudgeRubric } from '../../core/auto/verify/VerifyJudge.js'
import { parseDriftVerdict } from '../../core/auto/learn/DriftAgent.js'
import { parseRoleVerdict, roleSystemPrompt } from '../../core/roles/reviewer.js'
import type { SubAgentRecord } from '../types.js'

function record(result: Partial<NonNullable<SubAgentRecord['result']>> | null): SubAgentRecord {
  return {
    ...(result ? { result: result as NonNullable<SubAgentRecord['result']> } : {}),
  } as SubAgentRecord
}

describe('buildVerdictOutputProtocol', () => {
  it('names return_result as the primary channel and the JSON block as fallback', () => {
    const text = buildVerdictOutputProtocol('{ "done": true }')
    expect(text).toContain('return_result')
    expect(text).toContain('data')
    expect(text).toContain('{ "done": true }')
  })

  it('is embedded in all three judge rubrics', () => {
    const rubrics = [
      buildJudgeRubric(['read_file', 'grep', 'glob', 'bash']),
      buildJudgeRubric(['read_file', 'grep', 'glob']),
      roleSystemPrompt('security-reviewer', 'no secrets in source'),
    ]
    for (const r of rubrics) {
      expect(r, 'rubric must advertise the injected return_result tool').toContain('return_result')
    }
  })
})

describe('readVerdictChannels', () => {
  it('prefers the structured return_result payload over the summary text', () => {
    const channels = readVerdictChannels(record({
      output: { done: true, unfinished: [] },
      summary: 'looks good to me',
    }))
    expect(channels).toHaveLength(2)
    expect(JSON.parse(channels[0]!)).toEqual({ done: true, unfinished: [] })
    expect(channels[1]).toBe('looks good to me')
  })

  it('accepts a JSON string payload as-is', () => {
    expect(readVerdictChannels(record({ output: '{"done":false}' }))[0]).toBe('{"done":false}')
  })

  it('returns nothing for an empty or absent result', () => {
    expect(readVerdictChannels(record(null))).toEqual([])
    expect(readVerdictChannels(null)).toEqual([])
    expect(readVerdictChannels(record({ summary: '   ' }))).toEqual([])
  })

  it('falls through to text when the payload cannot be serialized', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic['self'] = cyclic
    const channels = readVerdictChannels(record({ output: cyclic, summary: 'fallback text' }))
    expect(channels).toEqual(['fallback text'])
  })
})

describe('parseFromVerdictChannels — verify judge', () => {
  const verdictJson = { done: false, unfinished: ['写单元测试'], evidence: ['src/a.ts:12'] }

  it('parses a verdict handed back through return_result.data', () => {
    const parsed = parseFromVerdictChannels(
      record({ output: verdictJson, summary: '还差单元测试' }),
      parseVerdict,
    )
    expect(parsed).toMatchObject({ done: false, unfinished: ['写单元测试'] })
  })

  it('parses a verdict left as a trailing JSON block in the chat text', () => {
    const parsed = parseFromVerdictChannels(
      record({ summary: `核查完毕。\n\n\`\`\`json\n${JSON.stringify(verdictJson)}\n\`\`\`` }),
      parseVerdict,
    )
    expect(parsed).toMatchObject({ done: false, unfinished: ['写单元测试'] })
  })

  it('parses the runner-composed summary+data shape return_result produces', () => {
    // _summaryFor() renders `summary\n\n```json\n<data>\n```` when the tool was called.
    const composed = `已完成核查\n\n\`\`\`json\n${JSON.stringify(verdictJson, null, 2)}\n\`\`\``
    expect(parseFromVerdictChannels(record({ summary: composed }), parseVerdict))
      .toMatchObject({ done: false })
  })

  it('returns null when neither channel carries a verdict', () => {
    expect(parseFromVerdictChannels(record({ summary: '我觉得差不多了' }), parseVerdict)).toBeNull()
  })
})

describe('parseFromVerdictChannels — drift and role judges', () => {
  it('handles drift verdicts on both channels', () => {
    const v = { drifted: true, severity: 'major', corrective: ['回到主线'], note: 'n' }
    expect(parseFromVerdictChannels(record({ output: v }), parseDriftVerdict))
      .toMatchObject({ drifted: true, severity: 'major' })
    expect(parseFromVerdictChannels(
      record({ summary: `\`\`\`json\n${JSON.stringify(v)}\n\`\`\`` }),
      parseDriftVerdict,
    )).toMatchObject({ drifted: true })
  })

  it('handles role verdicts on both channels', () => {
    const v = { label: 'fail', messages: ['缺少输入校验'], note: 'n' }
    expect(parseFromVerdictChannels(record({ output: v }), parseRoleVerdict))
      .toMatchObject({ label: 'fail', messages: ['缺少输入校验'] })
    expect(parseFromVerdictChannels(
      record({ summary: `结论如下\n\`\`\`json\n${JSON.stringify(v)}\n\`\`\`` }),
      parseRoleVerdict,
    )).toMatchObject({ label: 'fail' })
  })
})
