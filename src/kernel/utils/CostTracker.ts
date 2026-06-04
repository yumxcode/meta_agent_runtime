/**
 * CostTracker — per-session cumulative cost calculation.
 *
 * Pricing is sourced from the Provider Registry (single source of truth), so
 * adding a model/provider needs no change here.
 */
import type { TokenUsage } from '../types/TokenUsage.js'
import { getModelPricing } from '../../providers/registry.js'

export function calcCostUsd(usage: TokenUsage, model: string): number {
  const r = getModelPricing(model)
  return (
    usage.inputTokens     * r.input      +
    usage.outputTokens    * r.output     +
    usage.cacheReadTokens * r.cacheRead  +
    usage.cacheWriteTokens * r.cacheWrite
  ) / 1_000_000
}
