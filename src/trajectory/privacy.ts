import { createHash } from 'node:crypto'
import { redactSecrets } from '../infra/redaction/secretRedaction.js'
import type { TrajectoryItem } from './types.js'

const MAX_TEXT_CHARS = 64 * 1024
const MAX_TOOL_SUMMARY_CHARS = 16 * 1024
const SENSITIVE_KEYS = /^(api[_-]?key|authorization|password|passwd|secret|access[_-]?token|refresh[_-]?token|private[_-]?key)$/i

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function clip(value: string, limit: number): string {
  if (value.length <= limit) return redactSecrets(value)
  const digest = sha256(value)
  return `${redactSecrets(value.slice(0, limit))}\n[truncated; sha256=${digest}; chars=${value.length}]`
}

function sanitize(value: unknown, key = '', depth = 0): unknown {
  if (depth > 64) return '[max-depth]'
  if (SENSITIVE_KEYS.test(key)) return '[REDACTED]'
  if (typeof value === 'string') {
    return clip(value, key === 'outputSummary' ? MAX_TOOL_SUMMARY_CHARS : MAX_TEXT_CHARS)
  }
  if (value === null || typeof value !== 'object') return value
  if (value instanceof Uint8Array) {
    return { omitted: true, sha256: sha256(value), bytes: value.byteLength, encoding: 'binary' }
  }
  if (Array.isArray(value)) {
    return value
      .map(item => sanitize(item, key, depth + 1))
      .filter(item => item !== undefined)
  }
  const input = value as Record<string, unknown>
  if (input['type'] === 'thinking' || input['type'] === 'redacted_thinking') return undefined
  if (input['type'] === 'image' || input['type'] === 'image_url') {
    const raw = JSON.stringify(input)
    return { type: input['type'], omitted: true, sha256: sha256(raw), bytes: Buffer.byteLength(raw) }
  }
  const output: Record<string, unknown> = {}
  for (const [childKey, child] of Object.entries(input)) {
    const sanitized = sanitize(child, childKey, depth + 1)
    if (sanitized !== undefined) output[childKey] = sanitized
  }
  return output
}

export function sanitizeTrajectoryItem(item: TrajectoryItem): TrajectoryItem {
  return sanitize(item) as TrajectoryItem
}

export function summarizeOutput(value: string): { outputSummary: string; outputHash: string } {
  return {
    outputSummary: clip(value, MAX_TOOL_SUMMARY_CHARS),
    outputHash: sha256(value),
  }
}
