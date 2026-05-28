/**
 * createRoboticsRuntimeContext — factory for the robotics VV + paging stack.
 *
 * Assembles all robotics-specific intelligence components into a single
 * cohesive stack:
 *
 *   FlashClient              ← shared flash-model client (one Anthropic instance)
 *   ExperiencePatternChecker ← flash-ranked failure pattern awareness (warn only)
 *   OOMChecker               ← order-of-magnitude sanity check
 *   PhysicsConstraintChecker ← hard physics bounds
 *   NoopProvenanceTracker    ← VV hooks run, but NO provenance recording or annotation
 *   RuntimeContext           ← wraps VVHookChain + JobManager + NoopProvenanceTracker
 *   QueryAnalyzer            ← flash-based intent analysis for pre-loading
 *
 * Why NoopProvenanceTracker:
 *   ProvenanceTracker is a campaign-mode concept — it records every simulation
 *   result to disk so DOE audit trails are complete.  In robotics mode the tools
 *   (progress_note, experience_search, git_diff, …) are control/orchestration
 *   operations, not simulation computations.  Provenance recording adds disk I/O
 *   on every tool call and injects "[provenance: prov-xxx]" into every tool result,
 *   polluting the context with irrelevant tokens.  The VV hooks still run — only
 *   the recording and annotation steps are suppressed.
 *
 * Extension for other modes:
 *   Campaign → createCampaignRuntimeContext() with real ProvenanceTracker
 *   Agentic  → plain runtimeContext (no VV hooks needed)
 */

import { FlashClient } from '../core/flash/FlashClient.js'
import { createRuntimeContext } from '../runtime/RuntimeContext.js'
import { VVHookChain } from '../validation/VVHookChain.js'
import { OOMChecker } from '../validation/built-in/OOMChecker.js'
import { PhysicsConstraintChecker } from '../validation/built-in/PhysicsConstraintChecker.js'
import { ExperiencePatternChecker } from '../validation/built-in/FailurePatternChecker.js'
import { ExperienceSource } from '../context/sources/ExperienceSource.js'
import { QueryAnalyzer } from '../context/QueryAnalyzer.js'
import { ProvenanceTracker } from '../provenance/ProvenanceTracker.js'
import type { ProvenanceId, ProvenanceInput, ProvenanceRecord, ProvenanceFilter } from '../provenance/types.js'
import type { ExperienceStore } from './ExperienceStore.js'
import type { ContextPager } from '../context/ContextPager.js'
import type { RuntimeContext } from '../runtime/RuntimeContext.js'
import type { MetaAgentConfig } from '../core/config.js'

// ─────────────────────────────────────────────────────────────────────────────
// NoopProvenanceTracker
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A ProvenanceTracker that does nothing.
 *
 * Used in robotics mode to let the VV hook chain run without recording results
 * to disk or annotating tool outputs with "[provenance: prov-xxx]".
 *
 * `record()` returns a stable empty ID — instrumentTool appends it to the tool
 * result but it's suppressed at the caller (AgenticSession) level by checking
 * whether the tracker is a noop instance.
 *
 * Actually instrumentTool always appends the prov suffix — so instead we return
 * an empty string from record() and filter it out in instrumentTool via the
 * `skipProvenanceAnnotation` flag exposed through RuntimeContext.
 */
class NoopProvenanceTracker extends ProvenanceTracker {
  // Pass a dummy sessionId — no files are ever created
  constructor() { super('__noop__') }

  override async record(_input: ProvenanceInput): Promise<ProvenanceId> {
    return ''   // empty ID → instrumentTool skips annotation when id is ''
  }
  override async get(_id: ProvenanceId): Promise<ProvenanceRecord | null> { return null }
  override async list(_filter?: ProvenanceFilter): Promise<ProvenanceRecord[]> { return [] }
  override async chain(_id: ProvenanceId): Promise<ProvenanceRecord[]> { return [] }
  override async findByInputHash(_hash: string): Promise<ProvenanceRecord[]> { return [] }
  override async findDuplicate(_input: unknown): Promise<ProvenanceRecord | null> { return null }
  override async summary(_id: ProvenanceId): Promise<string> { return '' }
}

// ─────────────────────────────────────────────────────────────────────────────
// Options
// ─────────────────────────────────────────────────────────────────────────────

export interface RoboticsRuntimeContextOptions {
  sessionId: string
  /** Used by FlashClient to resolve API key and flash model identifier */
  config: Pick<MetaAgentConfig, 'apiKey' | 'baseURL' | 'model'>
  experienceStore: ExperienceStore
  contextPager: ContextPager
}

// ─────────────────────────────────────────────────────────────────────────────
// Result
// ─────────────────────────────────────────────────────────────────────────────

export interface RoboticsRuntimeContextResult {
  /** Pass this to AgenticSession via MetaAgentConfig.runtimeContext */
  runtimeContext: RuntimeContext
  /** Use in RoboticsSession.submit() to analyze query intent */
  queryAnalyzer: QueryAnalyzer
  /** Expose for testing and cache management */
  flashClient: FlashClient
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export function createRoboticsRuntimeContext(
  opts: RoboticsRuntimeContextOptions,
): RoboticsRuntimeContextResult {
  // Single FlashClient shared across all components in this session.
  // Avoids creating multiple Anthropic client instances.
  const flashClient = new FlashClient(opts.config)

  const experienceSource = new ExperienceSource(opts.experienceStore)

  // Build the VV hook chain.
  // Hook registration ORDER matters — hooks run sequentially:
  //   1. FailurePatternChecker: advisory warning (never aborts)
  //   2. OOMChecker + PhysicsConstraintChecker: output validation
  const chain = new VVHookChain()
  chain.register(new ExperiencePatternChecker(experienceSource, flashClient, opts.contextPager))
  chain.register(new OOMChecker())
  chain.register(new PhysicsConstraintChecker())

  const runtimeContext = createRuntimeContext({
    sessionId: opts.sessionId,
    vvChain: chain,
    provenanceTracker: new NoopProvenanceTracker(),
  })

  const queryAnalyzer = new QueryAnalyzer(flashClient)

  return { runtimeContext, queryAnalyzer, flashClient }
}
