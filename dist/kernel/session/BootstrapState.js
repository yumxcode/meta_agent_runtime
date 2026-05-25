/**
 * BootstrapState — lightweight session identity (sessionId, cwd, etc.)
 * Mirrors CC's bootstrap/state.ts but without the global singleton pattern.
 */
export function createBootstrapState(cwd, sessionId) {
    return {
        sessionId: sessionId ?? crypto.randomUUID(),
        cwd: cwd ?? process.cwd(),
        projectRoot: cwd ?? process.cwd(),
    };
}
//# sourceMappingURL=BootstrapState.js.map