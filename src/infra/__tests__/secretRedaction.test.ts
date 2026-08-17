import { describe, it, expect } from 'vitest'
import { redactSecrets } from '../redaction/secretRedaction.js'

describe('redactSecrets — value-shaped credentials', () => {
  it('redacts a BARE GitHub token with no surrounding name', () => {
    // The regression this exists for: GITHUB_TOKEN is deliberately forwarded to
    // child processes, and the old name-based rules only matched `NAME=value`,
    // so `echo $GITHUB_TOKEN` printed the raw token straight into model context.
    const out = redactSecrets('ghp_abcdefghijklmnopqrstuvwxyz0123456789')
    expect(out).not.toContain('ghp_abcdefghij')
    expect(out).toContain('[REDACTED]')
  })

  it('covers the other common issuer shapes', () => {
    const cases = [
      'github_pat_11ABCDEFG0abcdefghijklmnop',
      'glpat-abcdefghijklmnopqrst',
      'sk-ant-api03-abcdefghijklmnopqrstuvwx',
      'AKIAIOSFODNN7EXAMPLE',
      'xoxb-123456789012-abcdefghijkl',
    ]
    for (const secret of cases) {
      expect(redactSecrets(`value: ${secret}`), secret).not.toContain(secret)
    }
  })

  it('redacts credentials embedded in a URL', () => {
    const out = redactSecrets('remote https://user:s3cr3t-token@github.com/o/r.git')
    expect(out).not.toContain('s3cr3t-token')
    expect(out).toContain('https://[REDACTED]@github.com')
  })

  it('still redacts NAME=value for providers it has never heard of', () => {
    // The old rule hard-coded a prefix list, so an unknown provider leaked.
    const out = redactSecrets('SOMEVENDOR_API_KEY=abc123xyz')
    expect(out).toContain('SOMEVENDOR_API_KEY=[REDACTED]')
    expect(out).not.toContain('abc123xyz')
  })

  it('redacts GH_TOKEN / GIT_TOKEN, which the old prefix list omitted', () => {
    expect(redactSecrets('GH_TOKEN=abc123def456')).toContain('[REDACTED]')
    expect(redactSecrets('GIT_TOKEN=abc123def456')).toContain('[REDACTED]')
  })

  it('redacts json/yaml credential fields', () => {
    const out = redactSecrets('{"api_key": "supersecretvalue", "password": "hunter2"}')
    expect(out).not.toContain('supersecretvalue')
    expect(out).not.toContain('hunter2')
  })

  it('leaves ordinary output alone', () => {
    const text = 'Build succeeded in 3.2s\n42 tests passed\nhttps://example.com/docs'
    expect(redactSecrets(text)).toBe(text)
  })

  it('is a no-op on empty input', () => {
    expect(redactSecrets('')).toBe('')
  })
})
