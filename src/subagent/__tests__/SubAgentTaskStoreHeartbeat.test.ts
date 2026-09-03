import { afterEach, describe, expect, it } from 'vitest'
import {
  cleanupTask,
  readTask,
  touchTaskHeartbeat,
  writeTask,
} from '../SubAgentTaskStore.js'
import { DEFAULT_SUB_AGENT_CONFIG, makeSubAgentTaskId, type SubAgentRecord } from '../types.js'

const taskIds: string[] = []

function task(status: SubAgentRecord['status']): SubAgentRecord {
  const taskId = makeSubAgentTaskId()
  taskIds.push(taskId)
  return {
    schemaVersion: '1.0',
    taskId,
    parentSessionId: 'heartbeat-test',
    status,
    config: { ...DEFAULT_SUB_AGENT_CONFIG, taskDescription: 'test heartbeat' },
    createdAt: 1,
    pendingHumanApproval: false,
  }
}

afterEach(async () => {
  await Promise.all(taskIds.splice(0).map(taskId => cleanupTask(taskId)))
})

describe('sub-agent heartbeat persistence', () => {
  it('updates running tasks', async () => {
    const record = task('running')
    await writeTask(record)
    await touchTaskHeartbeat(record.taskId, 12_345)
    expect((await readTask(record.taskId))?.lastHeartbeatAt).toBe(12_345)
  })

  it('never revives or mutates terminal tasks', async () => {
    const record = task('completed')
    record.completedAt = 10
    await writeTask(record)
    expect(await touchTaskHeartbeat(record.taskId, 12_345)).toBeNull()
    expect(await readTask(record.taskId)).toEqual(record)
  })

  it('rejects path-like task ids at the flat-file store boundary', async () => {
    const unsafe = '../../config' as SubAgentRecord['taskId']
    expect(await readTask(unsafe)).toBeNull()
    await expect(writeTask({ ...task('queued'), taskId: unsafe })).rejects.toThrow(
      /Invalid sub-agent task id/,
    )
    await expect(cleanupTask(unsafe)).resolves.toBeUndefined()
  })
})
