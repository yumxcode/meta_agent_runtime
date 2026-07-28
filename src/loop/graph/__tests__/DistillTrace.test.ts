import { mkdtemp, readFile, readdir, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createFileDistillTraceStore, renderTraceOutput } from '../index.js'

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'distill-trace-'))
}

describe('Distill run trace', () => {
  it('writes artifacts and an append-only timeline under .loop/distill/run-*', async () => {
    const projectDir = await workspace()
    const trace = createFileDistillTraceStore(projectDir, new Date('2026-07-28T10:00:00.000Z'))

    expect(trace.dir).toContain(join('.loop', 'distill', 'run-2026-07-28T10-00-00-000Z'))

    await trace.event({ phase: 'compiler', attempt: 1, outcome: 'unparseable' })
    await trace.event({ phase: 'compiler', attempt: 2, outcome: 'frozen' })
    await trace.artifact('compiler.r0.a2.graph.json', '{"id":"g"}')

    const files = (await readdir(trace.dir)).sort()
    expect(files).toEqual(['compiler.r0.a2.graph.json', 'timeline.jsonl'])

    const lines = (await readFile(join(trace.dir, 'timeline.jsonl'), 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(2)
    const first = JSON.parse(lines[0]!) as Record<string, unknown>
    expect(first.outcome).toBe('unparseable')
    expect(typeof first.at).toBe('string')
    expect(JSON.parse(lines[1]!).outcome).toBe('frozen')
  })

  it('never throws when the run directory cannot be written', async () => {
    const projectDir = await workspace()
    await chmod(projectDir, 0o500)
    const trace = createFileDistillTraceStore(projectDir)
    // Tracing is diagnostic only; a read-only workspace must not convert a
    // recoverable Distill attempt into a hard failure.
    await expect(trace.event({ phase: 'architect' })).resolves.toBeUndefined()
    await expect(trace.artifact('x.json', '{}')).resolves.toBeUndefined()
    await chmod(projectDir, 0o700)
  })

  it('keeps host-built artifact names inside the run directory', async () => {
    const projectDir = await workspace()
    const trace = createFileDistillTraceStore(projectDir)
    await trace.artifact('../escape.json', '{}')
    // Separators are flattened and the leading dots collapsed, so the write
    // lands inside the run directory instead of a sibling.
    expect(await readdir(trace.dir)).toEqual(['__escape.json'])
  })

  it('renders string, structured and absent model output for diagnosis', () => {
    expect(renderTraceOutput('raw text')).toBe('raw text')
    expect(renderTraceOutput({ a: 1 })).toBe('{\n  "a": 1\n}')
    expect(renderTraceOutput(undefined)).toBe('(no output)')
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => renderTraceOutput(cyclic)).not.toThrow()
  })
})
