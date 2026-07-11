import { afterAll, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { META_AGENT_HOME } from '../metaAgentHome.js'
import { SessionStore } from '../SessionStore.js'
import { JobStore } from '../../jobs/JobStore.js'
import { DebugWriter } from '../../kernel/api/DebugWriter.js'
import { readSkill } from '../../tools/system/skill/index.js'

const id = `home-coverage-${randomUUID()}`

afterAll(async () => {
  await SessionStore.deleteSession(id)
  await Promise.all([
    rm(join(META_AGENT_HOME, 'jobs', id), { recursive: true, force: true }),
    rm(join(META_AGENT_HOME, 'debug', id), { recursive: true, force: true }),
    rm(join(META_AGENT_HOME, 'skills', `${id}.md`), { force: true }),
  ])
})

describe('META_AGENT_HOME coverage', () => {
  it('routes Session, Job, Debug and Skill state through the configured root', async () => {
    await SessionStore.append(id, {
      mode: 'agentic', startTime: 1, lastActivity: Date.now(), messageCount: 1,
      firstPrompt: 'home coverage',
    }, [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }], 0)
    expect(existsSync(join(META_AGENT_HOME, 'sessions', id, 'history.jsonl'))).toBe(true)

    const jobs = new JobStore(id)
    await jobs.save({
      jobId: 'generic-home-coverage' as never,
      toolName: 'test', domain: 'generic', fidelityLevel: 0, input: {},
      status: 'submitted', metrics: { submittedAt: Date.now() },
      agentId: 'test', sessionId: id,
    })
    expect(existsSync(join(META_AGENT_HOME, 'jobs', id, 'generic-home-coverage.json'))).toBe(true)

    const writer = await DebugWriter.open(id, 'test-model', true)
    await writer?.close()
    expect(existsSync(join(META_AGENT_HOME, 'debug', id))).toBe(true)

    await mkdir(join(META_AGENT_HOME, 'skills'), { recursive: true })
    await writeFile(join(META_AGENT_HOME, 'skills', `${id}.md`), '# test skill\nfrom configured home')
    expect(await readSkill(id, process.cwd(), 'agentic')).toContain('configured home')
  })
})
