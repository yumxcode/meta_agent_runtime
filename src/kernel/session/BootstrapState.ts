/**
 * BootstrapState — lightweight session identity (sessionId, cwd, etc.)
 * Mirrors CC's bootstrap/state.ts but without the global singleton pattern.
 */

export interface BootstrapState {
  sessionId: string
  cwd: string
  projectRoot: string
}

export function createBootstrapState(cwd?: string, sessionId?: string): BootstrapState {
  return {
    sessionId: sessionId ?? crypto.randomUUID(),
    cwd: cwd ?? process.cwd(),
    projectRoot: cwd ?? process.cwd(),
  }
}
