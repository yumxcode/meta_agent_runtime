import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FlashClient } from '../../core/flash/FlashClient.js'
import { ExperienceStore } from '../ExperienceStore.js'
import { ExperiencePendingStore } from '../ExperiencePendingStore.js'
import { createExperienceWriteTool } from '../tools/experience_write/index.js'

const tempDirs: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'meta-agent-expwrite-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

function validInput(problem: string) {
  return {
    domain: 'general',
    title: 'Repeated title',
    problem,
    solution: 'Use a bounded validation procedure.',
    success: false,
    outcome_summary: 'Validation found a bounded failure mode.',
  }
}

describe('experience_write tool', () => {
  it('rejects invalid input before queueing pending experiences', async () => {
    const dir = await tempDir()
    const pending = new ExperiencePendingStore(dir, await tempDir())
    const tool = createExperienceWriteTool(new ExperienceStore(dir), pending)

    const result = await tool.call({ ...validInput('Problem'), success: 'no' }, {})

    expect(result.isError).toBe(true)
    expect(pending.count).toBe(0)
    await pending.flush()
  })

  it('uses content-derived principle cache keys, not title-only keys', async () => {
    const dir = await tempDir()
    const pending = new ExperiencePendingStore(dir, await tempDir())
    const flash = {
      query: vi.fn().mockResolvedValue('Bound risk before running expensive experiments.'),
    } as unknown as FlashClient
    const tool = createExperienceWriteTool(new ExperienceStore(dir), pending, flash)

    await tool.call(validInput('First problem'), {})
    await tool.call(validInput('Second problem'), {})

    const calls = (flash.query as ReturnType<typeof vi.fn>).mock.calls
    expect(calls).toHaveLength(2)
    expect(calls[0][0].cacheKey).not.toBe(calls[1][0].cacheKey)
    expect(pending.count).toBe(2)
    await pending.flush()
  })
})
