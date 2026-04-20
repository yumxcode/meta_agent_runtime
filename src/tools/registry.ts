/**
 * Tool Registry
 *
 * Central singleton for registering, discovering, and dispatching tools.
 * Thread-safe via promise-based serialization of the registry map.
 */

import type { ToolEntry, ToolDefinition, ToolContext, Toolset, ToolFilterContext } from '../types.js';
import { okObservation, errorObservation, parseObservation } from '../types.js';
export type { ToolHandler } from '../types.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function matchesGlob(pattern: string, name: string): boolean {
  if (pattern === '*') return true;
  if (!pattern.includes('*')) return pattern === name;
  const re = new RegExp('^' + pattern.split('*').map((s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  return re.test(name);
}

// ---------------------------------------------------------------------------
// Lightweight JSON Schema validator
//
// Covers the subset of JSON Schema that LLMs actually violate:
//   • missing required properties
//   • basic scalar type mismatches (string / number / integer / boolean / array / object)
//   • enum membership
//
// We deliberately skip deep nested validation and $ref resolution to keep the
// implementation O(n) and dependency-free. Real validation can be layered on
// top via a custom ToolEntry.checkFn or by swapping out the validator below.
// ---------------------------------------------------------------------------

import type { JSONSchema } from '../types.js';

type ValidationError = { path: string; message: string };

function validateSchema(
  value: unknown,
  schema: JSONSchema,
  path = '',
): ValidationError[] {
  const errors: ValidationError[] = [];
  const label = path || '(root)';

  // --- type check ---
  if (schema.type) {
    const t = schema.type as string;
    const actual = Array.isArray(value) ? 'array' : typeof value;
    let ok = true;
    if (t === 'integer') ok = typeof value === 'number' && Number.isInteger(value);
    else if (t === 'array') ok = Array.isArray(value);
    else if (t === 'object') ok = typeof value === 'object' && value !== null && !Array.isArray(value);
    else ok = actual === t;

    if (!ok) {
      errors.push({
        path: label,
        message: `expected type "${t}", got "${Array.isArray(value) ? 'array' : typeof value}"`,
      });
      // Type mismatch → skip property-level checks to avoid cascading noise
      return errors;
    }
  }

  // --- enum check ---
  if (schema.enum !== undefined) {
    const allowed = schema.enum as unknown[];
    if (!allowed.some((v) => v === value)) {
      errors.push({
        path: label,
        message: `must be one of [${allowed.map((v) => JSON.stringify(v)).join(', ')}], got ${JSON.stringify(value)}`,
      });
    }
  }

  // --- object: required + properties ---
  if (schema.type === 'object' || schema.properties) {
    const obj = value as Record<string, unknown>;

    // required fields
    for (const req of schema.required ?? []) {
      if (!(req in obj) || obj[req] === undefined || obj[req] === null) {
        errors.push({ path: path ? `${path}.${req}` : req, message: 'required field is missing' });
      }
    }

    // recurse into declared properties
    if (schema.properties) {
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (key in obj && obj[key] !== undefined) {
          const child = validateSchema(obj[key], propSchema as JSONSchema, path ? `${path}.${key}` : key);
          errors.push(...child);
        }
      }
    }
  }

  // --- array: items ---
  if ((schema.type === 'array' || Array.isArray(value)) && schema.items && Array.isArray(value)) {
    (value as unknown[]).forEach((item, i) => {
      const child = validateSchema(item, schema.items as JSONSchema, `${label}[${i}]`);
      errors.push(...child);
    });
  }

  return errors;
}

/**
 * Validate tool call args against the tool's parameter schema.
 * Returns a human-readable error string, or null if valid.
 */
function validateToolArgs(
  toolName: string,
  args: Record<string, unknown>,
  schema: JSONSchema,
): string | null {
  const errors = validateSchema(args, schema);
  if (errors.length === 0) return null;
  const lines = errors.map((e) => `  • ${e.path}: ${e.message}`).join('\n');
  return `[Validation Error] Tool "${toolName}" received invalid arguments:\n${lines}\nPlease fix the parameters and retry.`;
}

// ---------------------------------------------------------------------------
// Registry class
// ---------------------------------------------------------------------------

export class ToolRegistry {
  private static _instance: ToolRegistry | null = null;

  private _tools: Map<string, ToolEntry> = new Map();

  private constructor() {}

  static getInstance(): ToolRegistry {
    if (!ToolRegistry._instance) {
      ToolRegistry._instance = new ToolRegistry();
    }
    return ToolRegistry._instance;
  }

  /** Reset singleton (useful for testing). */
  static reset(): void {
    ToolRegistry._instance = null;
  }

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  /**
   * Register a tool with the registry.
   * If a tool with the same name is already registered it will be overwritten.
   */
  register(entry: ToolEntry): void {
    // Run availability check
    if (entry.checkFn && !entry.checkFn()) {
      return; // prerequisites not met, skip
    }
    this._tools.set(entry.name, entry);
  }

  /** Register multiple tools at once. */
  registerMany(entries: ToolEntry[]): void {
    for (const entry of entries) this.register(entry);
  }

  /** Remove a tool from the registry. */
  unregister(name: string): void {
    this._tools.delete(name);
  }

  // -------------------------------------------------------------------------
  // Discovery
  // -------------------------------------------------------------------------

  /** Get all registered tool entries. */
  getAll(): ToolEntry[] {
    return Array.from(this._tools.values());
  }

  /** Get a single tool entry by name, or undefined. */
  get(name: string): ToolEntry | undefined {
    return this._tools.get(name);
  }

  /** Check whether a tool is registered. */
  has(name: string): boolean {
    return this._tools.has(name);
  }

  /**
   * Get tool definitions (schemas) for a filtered set of toolsets.
   *
   * @param enabledToolsets  If provided, only include tools in these toolsets.
   * @param disabledToolsets If provided, exclude tools in these toolsets.
   * @param filterCtx        Optional Feature Gate + permission context.
   *                         Tools whose `condition(filterCtx)` returns false are excluded.
   *                         Tools denied by the permission config are also excluded.
   */
  getDefinitions(
    enabledToolsets?: Toolset[],
    disabledToolsets?: Toolset[],
    filterCtx?: ToolFilterContext,
  ): ToolDefinition[] {
    return Array.from(this._tools.values())
      .filter((entry) => this._filterEntry(entry, enabledToolsets, disabledToolsets, filterCtx))
      .map((entry) => entry.definition);
  }

  /**
   * Get ToolEntry objects for a filtered set of toolsets (includes handlers).
   */
  getEntries(
    enabledToolsets?: Toolset[],
    disabledToolsets?: Toolset[],
    filterCtx?: ToolFilterContext,
  ): ToolEntry[] {
    return Array.from(this._tools.values()).filter((entry) =>
      this._filterEntry(entry, enabledToolsets, disabledToolsets, filterCtx),
    );
  }

  private _filterEntry(
    entry: ToolEntry,
    enabledToolsets?: Toolset[],
    disabledToolsets?: Toolset[],
    filterCtx?: ToolFilterContext,
  ): boolean {
    // Toolset whitelist / blacklist
    if (enabledToolsets && enabledToolsets.length > 0) {
      if (!enabledToolsets.includes(entry.toolset)) return false;
    }
    if (disabledToolsets && disabledToolsets.length > 0) {
      if (disabledToolsets.includes(entry.toolset)) return false;
    }
    // Feature Gate: condition function
    if (filterCtx && entry.condition) {
      if (!entry.condition(filterCtx)) return false;
    }
    // Permission Gate: pre-filter always_deny tools from the LLM's view
    if (filterCtx?.permissions) {
      const permCfg = filterCtx.permissions;
      // Resolve using default config rules
      const rules = permCfg.rules ?? [];
      for (const rule of rules) {
        if (matchesGlob(rule.tool, entry.name)) {
          if (rule.level === 'always_deny') return false;
          break;
        }
      }
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Dispatch
  // -------------------------------------------------------------------------

  /**
   * Execute a tool by name with the given arguments.
   *
   * Always returns a serialised {@link Observation} JSON string — never throws
   * for handler-level failures. Only throws if the tool name is not registered
   * (a programming error, not a runtime failure).
   *
   * Pipeline:
   *   1. JSON-Schema validation → errorObservation('validation_error') on failure
   *   2. Handler invocation    → execution errors caught → errorObservation('execution_error')
   *   3. Truncation            → okObservation with metadata.truncated when limit exceeded
   *   4. Success               → okObservation
   */
  async dispatch(
    name: string,
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<string> {
    const entry = this._tools.get(name);
    if (!entry) {
      // Programming error — tool was requested but never registered
      throw new Error(`Tool not found: "${name}"`);
    }

    // Step 1: Schema validation
    const validationError = validateToolArgs(name, args, entry.definition.parameters);
    if (validationError) {
      return errorObservation(validationError, 'validation_error');
    }

    // Step 2: Invoke handler — catch execution errors so caller always gets an Observation
    let raw: string | import('../types.js').Observation;
    try {
      raw = await entry.handler(args, context);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return errorObservation(`Tool "${name}" threw an error: ${msg}`, 'execution_error');
    }

    // Step 3: Handler may return a pre-built Observation (e.g. with staleness metadata).
    // In that case, still enforce truncation on its content field.
    const maxChars = entry.maxResultSizeChars;
    if (typeof raw === 'object') {
      if (maxChars && raw.content.length > maxChars) {
        return okObservation(raw.content.slice(0, maxChars), {
          ...raw.metadata,
          truncated: true,
          omitted_chars: raw.content.length - maxChars,
        });
      }
      return JSON.stringify(raw);
    }

    // Step 4: Plain string — enforce truncation
    if (maxChars && raw.length > maxChars) {
      const cut = raw.slice(0, maxChars);
      const omitted = raw.length - maxChars;
      return okObservation(cut, { truncated: true, omitted_chars: omitted });
    }

    // Step 5: Success
    return okObservation(raw);
  }

  // _truncate is kept for potential direct use by tests/utilities
  private _truncate(result: string, maxChars?: number): string {
    if (!maxChars || result.length <= maxChars) return result;
    const cut = result.slice(0, maxChars);
    const omitted = result.length - maxChars;
    return `${cut}\n\n[... ${omitted.toLocaleString()} characters truncated by maxResultSizeChars limit ...]`;
  }

  /** List all registered tool names. */
  listNames(): string[] {
    return Array.from(this._tools.keys());
  }

  /** List all unique toolsets. */
  listToolsets(): Toolset[] {
    const sets = new Set<Toolset>();
    for (const entry of this._tools.values()) sets.add(entry.toolset);
    return Array.from(sets);
  }
}

// ---------------------------------------------------------------------------
// Convenience module-level functions (delegates to singleton)
// ---------------------------------------------------------------------------

export const registry = ToolRegistry.getInstance();

export function registerTool(entry: ToolEntry): void {
  ToolRegistry.getInstance().register(entry);
}

export function registerTools(entries: ToolEntry[]): void {
  ToolRegistry.getInstance().registerMany(entries);
}

export function dispatchTool(
  name: string,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<string> {
  return ToolRegistry.getInstance().dispatch(name, args, context);
}

// ---------------------------------------------------------------------------
// Parallel execution helper
// ---------------------------------------------------------------------------

/** Names of tools that are safe to run concurrently. */
const PARALLEL_SAFE_TOOLS = new Set([
  'read_file',
  'search_files',
  'web_search',
  'web_fetch',
  'memory_read',
  'todo_list',
]);

export function isParallelSafe(name: string): boolean {
  const entry = ToolRegistry.getInstance().get(name);
  if (entry?.parallelSafe !== undefined) return entry.parallelSafe;
  return PARALLEL_SAFE_TOOLS.has(name);
}

export interface ToolCallRequest {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolCallResult {
  id: string;
  name: string;
  result: string;
  error: boolean;
  durationMs: number;
}

/**
 * Execute a batch of tool calls, running parallel-safe tools concurrently
 * and serializing the rest.
 *
 * @param permissionCheck  Optional async gate called BEFORE each tool dispatch.
 *   Return false to block execution — the tool receives a structured denial
 *   result (error: true) so the LLM can see it was blocked, not broken.
 *   This is where `ask` and `always_deny` runtime checks are enforced.
 */
export async function executeToolBatch(
  calls: ToolCallRequest[],
  context: ToolContext,
  maxConcurrency = 4,
  onStart?: (name: string, args: Record<string, unknown>) => void,
  onComplete?: (name: string, result: string, durationMs: number) => void,
  permissionCheck?: (name: string, args: Record<string, unknown>) => Promise<boolean>,
): Promise<ToolCallResult[]> {
  const reg = ToolRegistry.getInstance();

  // Helper: run a single call with permission gate + dispatch.
  // dispatch() now catches handler errors internally and always returns an Observation string.
  // The only remaining throw from dispatch() is "tool not found" (programming error).
  async function runOne(call: ToolCallRequest): Promise<ToolCallResult> {
    // --- Permission check (runs before onStart so denied calls don't appear
    //     as "started" in the UI) ---
    if (permissionCheck) {
      const allowed = await permissionCheck(call.name, call.args);
      if (!allowed) {
        const denied = errorObservation(
          `Tool "${call.name}" was blocked by the permission policy. Do not retry without user approval.`,
          'permission_denied',
        );
        onComplete?.(call.name, denied, 0);
        return { id: call.id, name: call.name, result: denied, error: true, durationMs: 0 };
      }
    }

    onStart?.(call.name, call.args);
    const start = Date.now();
    try {
      const result = await reg.dispatch(call.name, call.args, context);
      const durationMs = Date.now() - start;
      // Derive error flag from the Observation envelope — no more fragile string-prefix checks
      const isError = parseObservation(result)?.status === 'error';
      onComplete?.(call.name, result, durationMs);
      return { id: call.id, name: call.name, result, error: isError, durationMs };
    } catch (err) {
      // Only "tool not found" reaches here; wrap it for consistency
      const durationMs = Date.now() - start;
      const result = errorObservation(
        `Tool "${call.name}" could not be dispatched: ${(err as Error).message}`,
        'execution_error',
      );
      onComplete?.(call.name, result, durationMs);
      return { id: call.id, name: call.name, result, error: true, durationMs };
    }
  }

  // Separate parallel-safe and sequential calls
  const parallelCalls = calls.filter((c) => isParallelSafe(c.name));
  const sequentialCalls = calls.filter((c) => !isParallelSafe(c.name));

  const results = new Map<string, ToolCallResult>();

  // Sequential tools — one at a time (includes permission check per call)
  for (const call of sequentialCalls) {
    results.set(call.id, await runOne(call));
  }

  // Parallel-safe tools — concurrent with p-limit
  const { default: pLimit } = await import('p-limit');
  const limit = pLimit(maxConcurrency);

  await Promise.all(
    parallelCalls.map((call) =>
      limit(async () => {
        results.set(call.id, await runOne(call));
      }),
    ),
  );

  // Return in original call order
  return calls.map((c) => results.get(c.id)!);
}
