// @meta-agent/cc-kernel — type declarations
// Re-export key types from CC source for TypeScript consumers.

export declare class QueryEngine {
  constructor(config: import('./types').QueryEngineConfig): void
  submitMessage(prompt: string, options?: { uuid?: string; isMeta?: boolean }): AsyncGenerator<any, void, unknown>
  interrupt(): void
  getMessages(): readonly any[]
  getSessionId(): string
}

export declare function ask(params: any): AsyncGenerator<any, void, unknown>
export declare function getDefaultAppState(): any
export declare function createStore<T>(initialState: T, onChange?: any): any
export declare function getEmptyToolPermissionContext(): any
export declare function getSessionId(): string
export declare function setOriginalCwd(cwd: string): void
export declare function setProjectRoot(root: string): void
export declare function getOriginalCwd(): string
export declare function isSessionPersistenceDisabled(): boolean
export declare function setSessionPersistenceDisabled(disabled: boolean): void
export declare function cloneFileStateCache(cache: any): any
export declare function createFileStateCacheWithSizeLimit(size: number): any
export declare function hasPermissionsToUseTool(...args: any[]): Promise<any>
export declare function enableConfigs(): void
