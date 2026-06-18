import { afterEach, describe, expect, it } from 'vitest'
import { createHash, randomUUID } from 'crypto'
import { readFile, rm } from 'fs/promises'
import { join } from 'path'
import { META_AGENT_HOME } from '../../core/metaAgentHome.js'
import { RoboticsProjectStore } from '../persistence/RoboticsProjectStore.js'
import type { RoboticsProjectState } from '../types.js'

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function bucketFor(projectDir: string): string {
  const hash = createHash('sha1').update(projectDir).digest('hex').slice(0, 16)
  return join(META_AGENT_HOME, 'robotics', 'projects', hash)
}

describe('RoboticsProjectStore concurrency and history bounds', () => {
  it('serialises mutations and archives completed task IDs beyond the latest 50', async () => {
    const projectDir = `/tmp/robotics-project-${randomUUID()}`
    const sessionId = `session-${randomUUID()}`
    cleanup.push(bucketFor(projectDir))
    const state: RoboticsProjectState = {
      schemaVersion: '1.0',
      sessionId,
      projectDir,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      progressNotes: [],
      activeSubAgentTasks: [],
      completedSubAgentTaskIds: [],
      git: { enabled: false, mainBranch: 'main', subAgentBranches: {}, forkPoints: {} },
    }
    await RoboticsProjectStore.save(state)

    await Promise.all([
      ...Array.from({ length: 20 }, (_, i) =>
        RoboticsProjectStore.appendProgress(projectDir, sessionId, `note-${i}`)),
      ...Array.from({ length: 60 }, (_, i) =>
        RoboticsProjectStore.completeSubAgentTask(projectDir, sessionId, `task-${i}`)),
    ])

    const persisted = await RoboticsProjectStore.findBySession(projectDir, sessionId)
    expect(persisted?.progressNotes).toHaveLength(15)
    expect(persisted?.completedSubAgentTaskIds).toHaveLength(50)
    expect(new Set(persisted?.completedSubAgentTaskIds).size).toBe(50)

    const archive = await readFile(
      join(bucketFor(projectDir), sessionId, 'completed-subagents.jsonl'),
      'utf-8',
    )
    const archived = archive.trim().split('\n').map(line => JSON.parse(line) as { taskId: string })
    expect(archived).toHaveLength(10)
    expect(new Set(archived.map(item => item.taskId)).size).toBe(10)
  })
})
