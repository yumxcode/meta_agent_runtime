import { describe, it, expect } from 'vitest'
import { buildCompactPrompt } from '../CompactPrompt.js'

// The auto profile = agentic 9 sections + an Autonomous Ledger (section 10).
describe('CompactPrompt auto profile', () => {
  it('auto profile includes the 9 agentic sections plus the Autonomous Ledger', () => {
    const prompt = buildCompactPrompt(undefined, 'auto')
    expect(prompt).toContain('## 1. 主要请求与意图')
    expect(prompt).toContain('## 9. 可选的下一步')
    expect(prompt).toContain('自主执行账本')
    expect(prompt).toContain('已派发子代理')
    expect(prompt).toContain('不可逆变更')
  })

  it('agentic profile does NOT include the Autonomous Ledger', () => {
    const prompt = buildCompactPrompt(undefined, 'agentic')
    expect(prompt).not.toContain('自主执行账本')
  })
})
