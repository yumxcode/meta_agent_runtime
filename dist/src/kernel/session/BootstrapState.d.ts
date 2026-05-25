/**
 * BootstrapState — lightweight session identity (sessionId, cwd, etc.)
 * Mirrors CC's bootstrap/state.ts but without the global singleton pattern.
 */
export interface BootstrapState {
    sessionId: string;
    cwd: string;
    projectRoot: string;
}
export declare function createBootstrapState(cwd?: string, sessionId?: string): BootstrapState;
//# sourceMappingURL=BootstrapState.d.ts.map