import { describe, expect, it } from 'vitest'
import { buildR1Section } from '../dynamicSections.js'

describe('robotics dynamic sections', () => {
  it('teaches single-agent mode to use serial context-isolated helpers only', async () => {
    const section = buildR1Section('go2', () => 'single')
    const prompt = await section.compute()

    expect(prompt).toContain('串行、阻塞式、隔离上下文')
    expect(prompt).toContain('`paper_search`：允许在 single 模式使用')
    expect(prompt).toContain('不要在 single 模式把它设成 `await_completion=false`')
    expect(prompt).toContain('`spawn_sub_agent` / `experiment_dispatch`：single 模式不暴露')
  })

  it('teaches multi-agent fan-out/fan-in without forcing synchronous dispatch', async () => {
    const section = buildR1Section('go2', () => 'multi')
    const prompt = await section.compute()

    expect(prompt).toContain('### 并行派发与等待屏障')
    expect(prompt).toContain('await_completion=false')
    expect(prompt).toContain('不要把多个派发都设为 `await_completion=true`')
    expect(prompt).toContain('get_sub_agent_status')
    expect(prompt).toContain('completed` / `failed` / `cancelled')
  })
})
