import { describe, it, expect } from 'vitest'
import {
  modelSupportsVision,
  getVisionLimits,
  effectiveEdgePixels,
  getModelCapabilities,
} from '../registry.js'

describe('vision capability resolution', () => {
  it('recognises the models that actually take images', () => {
    expect(modelSupportsVision('glm-5.3-flash')).toBe(true)
    expect(modelSupportsVision('deepseek-v4-flash-vision-exp')).toBe(true)
    expect(modelSupportsVision('claude-opus-4-6')).toBe(true)
  })

  it('does NOT extend DeepSeek vision to the rest of the family', () => {
    // Every non-vision DeepSeek model answers a request containing an image
    // with `400 This model does not support image`. A family-level opt-in would
    // turn a routine `--model deepseek-v4-pro` into a hard failure, so the
    // capability stays pinned to the exact table entry.
    expect(modelSupportsVision('deepseek-v4-pro')).toBe(false)
    expect(modelSupportsVision('deepseek-v4-flash')).toBe(false)
    expect(modelSupportsVision('deepseek-chat')).toBe(false)
  })

  it('resolves the vision entry over the shorter prefix that it extends', () => {
    // 'deepseek-v4-flash-vision-exp' and 'deepseek-v4-flash' differ only by a
    // suffix, and the difference between them is a 400 rather than a
    // degradation — longest-prefix matching has to win here.
    expect(getModelCapabilities('deepseek-v4-flash-vision-exp').vision).toBe(true)
    expect(getModelCapabilities('deepseek-v4-flash').vision).toBe(false)
  })

  it('extends GLM vision by family rule from 5.3 onward but not below', () => {
    // Native multimodality arrived with 5.3 and is a line property from there,
    // so an unreleased glm-5.4 or glm-6 must resolve without a code change.
    expect(modelSupportsVision('glm-5.4')).toBe(true)
    expect(modelSupportsVision('glm-6')).toBe(true)
    expect(modelSupportsVision('glm-5.2')).toBe(false)
    expect(modelSupportsVision('glm-4.6')).toBe(false)
  })

  it('treats an unknown model as text-only rather than assuming', () => {
    expect(modelSupportsVision('some-unreleased-model')).toBe(false)
    expect(modelSupportsVision(undefined)).toBe(false)
  })
})

describe('vision limits', () => {
  it("carries DeepSeek published per-request figures", () => {
    const limits = getVisionLimits('deepseek-v4-flash-vision-exp')
    expect(limits.maxImagesPerRequest).toBe(600)
    expect(limits.maxImageBytes).toBe(32 * 1024 * 1024)
    expect(limits.maxEdgePixels).toBe(8192)
    expect(limits.imageTokenCeiling).toBe(384)
  })

  it("halves the edge cap once a request reaches the DeepSeek 15-image threshold", () => {
    // The cap is not a constant: an image that passes on its own can fail
    // purely because of what it was batched with.
    const limits = getVisionLimits('deepseek-v4-flash-vision-exp')
    expect(effectiveEdgePixels(limits, 14)).toBe(8192)
    expect(effectiveEdgePixels(limits, 15)).toBe(4096)
    expect(effectiveEdgePixels(limits, 40)).toBe(4096)
  })

  it('leaves the cap alone for providers that publish no downgrade rule', () => {
    const limits = getVisionLimits('glm-5.3-flash')
    expect(effectiveEdgePixels(limits, 1)).toBe(limits.maxEdgePixels)
    expect(effectiveEdgePixels(limits, 100)).toBe(limits.maxEdgePixels)
  })

  it('falls back to conservative limits for a model that names none', () => {
    // A too-low cap produces a clear local error; a too-high one produces a
    // late 400 on an already-uploaded payload. Err low.
    const limits = getVisionLimits('mystery-model')
    expect(limits.maxImagesPerRequest).toBeLessThanOrEqual(20)
    expect(limits.acceptsImageUrl).toBe(false)
  })
})
