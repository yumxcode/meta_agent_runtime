/**
 * ISubAgentDispatcher — minimal interface for spawning and querying sub-agents.
 *
 * Tool factory functions (`createRunAgentTool`, `createExperimentDispatchTool`,
 * etc.) accept this interface rather than the concrete `SubAgentBridge` class.
 * This decouples the tools layer from the sub-agent session lifecycle:
 *
 *   Tools layer  →  ISubAgentDispatcher  ←  SubAgentBridge (implements)
 *
 * Benefits:
 *   - Tools can be unit-tested with a lightweight stub.
 *   - A future alternate dispatcher (e.g. remote sub-agent runner) is a
 *     drop-in replacement without touching any tool code.
 *   - The tools layer no longer imports the concrete SubAgentBridge class,
 *     keeping the dependency graph clean.
 */
export {};
//# sourceMappingURL=ISubAgentDispatcher.js.map