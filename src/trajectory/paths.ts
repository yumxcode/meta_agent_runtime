import { join } from 'node:path'
import { META_AGENT_HOME } from '../core/metaAgentHome.js'

export interface TrajectoryPathsOptions {
  rootDir?: string
}

export function trajectoryHome(options: TrajectoryPathsOptions = {}): string {
  return options.rootDir ?? META_AGENT_HOME
}

export function trajectoriesRoot(options: TrajectoryPathsOptions = {}): string {
  return join(trajectoryHome(options), 'trajectories')
}

export function trajectoryDir(trajectoryId: string, options: TrajectoryPathsOptions = {}): string {
  return join(trajectoriesRoot(options), trajectoryId)
}

export function trajectoryFile(trajectoryId: string, options: TrajectoryPathsOptions = {}): string {
  return join(trajectoryDir(trajectoryId, options), 'trajectory.jsonl')
}

export function trajectoryLeaseFile(trajectoryId: string, options: TrajectoryPathsOptions = {}): string {
  return join(trajectoryDir(trajectoryId, options), 'writer.lock')
}

export function trajectoryHealthFile(trajectoryId: string, options: TrajectoryPathsOptions = {}): string {
  return join(trajectoryDir(trajectoryId, options), 'health.json')
}

export function trajectoryIndexDir(options: TrajectoryPathsOptions = {}): string {
  return join(trajectoryHome(options), 'index')
}

export function trajectoryIndexFile(options: TrajectoryPathsOptions = {}): string {
  return join(trajectoryIndexDir(options), 'trajectories.json')
}

/** Legacy dead projection cursor removed in A3 remediation; clean reindex deletes it if present. */
export function legacyTrajectoryProjectionStateFile(options: TrajectoryPathsOptions = {}): string {
  return join(trajectoryIndexDir(options), 'projection-state.json')
}

export function trajectoryTelemetryStateFile(options: TrajectoryPathsOptions = {}): string {
  return join(trajectoryIndexDir(options), 'trajectory-telemetry.json')
}

export function trajectoryParityStateFile(options: TrajectoryPathsOptions = {}): string {
  return join(trajectoryIndexDir(options), 'trajectory-parity.json')
}
