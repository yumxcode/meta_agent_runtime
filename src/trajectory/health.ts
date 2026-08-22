import { chmod } from 'node:fs/promises'
import { atomicWriteJson, readJsonFile } from '../infra/persist/index.js'
import { trajectoryHealthFile, type TrajectoryPathsOptions } from './paths.js'

export interface TrajectoryHealth {
  schemaVersion: 'trajectory-health-1.0'
  canonicalDegraded: boolean
  projectionDegraded: boolean
  updatedAt: number
  lastError?: string
}

export async function readTrajectoryHealth(
  trajectoryId: string,
  options: TrajectoryPathsOptions = {},
): Promise<TrajectoryHealth> {
  return await readJsonFile<TrajectoryHealth>(trajectoryHealthFile(trajectoryId, options), {
    tolerateUnreadable: true,
  }) ?? {
    schemaVersion: 'trajectory-health-1.0',
    canonicalDegraded: false,
    projectionDegraded: false,
    updatedAt: 0,
  }
}

export async function writeTrajectoryHealth(
  trajectoryId: string,
  health: Omit<TrajectoryHealth, 'schemaVersion' | 'updatedAt'>,
  options: TrajectoryPathsOptions = {},
): Promise<void> {
  const file = trajectoryHealthFile(trajectoryId, options)
  await atomicWriteJson(file, {
    schemaVersion: 'trajectory-health-1.0',
    ...health,
    updatedAt: Date.now(),
  } satisfies TrajectoryHealth)
  await chmod(file, 0o600)
}
