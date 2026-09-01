import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseTaskActivityLog, readTaskActivityLog } from '../TaskActivityLog.js'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('managed task activity parsing', () => {
  it('coalesces streaming text and summarizes operational events', () => {
    const raw = [
      { type: 'auto_scheduler', message: '[auto-scheduler] resume s1 (w1, attempt 1)' },
      { type: 'thinking_delta', delta: 'one' },
      { type: 'thinking_delta', delta: 'two' },
      { type: 'text', text: '正在检查' },
      { type: 'text', text: '训练结果。' },
      { type: 'tool_use', toolName: 'exec_command', toolInput: { cmd: 'npm test' } },
      { type: 'tool_result', content: '93 tests passed', isError: false },
      { type: 'result', subtype: 'parked', isError: false, numTurns: 4, durationMs: 12_000,
        totalCostUsd: 0.12, stopReason: 'parked', parkRequest: { reason: '等待评估结果' } },
    ].map(event => JSON.stringify(event)).join('\n')

    const feed = parseTaskActivityLog(raw)
    expect(feed.entries.filter(entry => entry.kind === 'thinking')).toHaveLength(1)
    expect(feed.entries).toContainEqual({ kind: 'agent', text: '正在检查训练结果。' })
    expect(feed.entries.find(entry => entry.kind === 'tool')?.text).toContain('exec_command')
    expect(feed.entries.find(entry => entry.kind === 'tool-result')?.text).toBe('93 tests passed')
    expect(feed.entries.at(-1)?.text).toContain('任务已停放')
    expect(feed.entries.at(-1)?.text).toContain('等待评估结果')
  })

  it('strips terminal control sequences from model and raw output', () => {
    const feed = parseTaskActivityLog([
      JSON.stringify({ type: 'text', text: '\u001b[2Junsafe\u001b]0;title\u0007visible' }),
      '\u001b[31mraw failure\u001b[0m',
    ].join('\n'))
    const rendered = feed.entries.map(entry => entry.text).join(' ')
    expect(rendered).toContain('unsafevisible')
    expect(rendered).toContain('raw failure')
    expect(rendered).not.toContain('\u001b')
  })

  it('reads only a bounded suffix and drops the partial first line', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'task-activity-'))
    dirs.push(dir)
    const path = join(dir, 'worker.log')
    await writeFile(path, `${'x'.repeat(2_000)}\n${JSON.stringify({ type: 'text', text: 'latest activity' })}\n`)

    const feed = await readTaskActivityLog(path, 1_024)
    expect(feed.truncated).toBe(true)
    expect(feed.entries).toEqual([{ kind: 'agent', text: 'latest activity' }])
  })

  it('waits for an in-progress final JSON event instead of showing it as an error', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'task-activity-'))
    dirs.push(dir)
    const path = join(dir, 'worker.log')
    await writeFile(path,
      `${JSON.stringify({ type: 'text', text: 'complete' })}\n{"type":"tool_result","content":`,
    )

    const feed = await readTaskActivityLog(path)
    expect(feed.entries).toEqual([{ kind: 'agent', text: 'complete' }])
  })

  // ── non-JSON lines ──────────────────────────────────────────────────────────
  //
  // The worker's stdout AND stderr share this file with the NDJSON event log
  // (`stdio: ['ignore', logFd, logFd]`), so raw text lines are expected, not
  // exceptional. Every one of them used to render as a red ✗.
  describe('raw stdio lines are not automatically errors', () => {
    it('shows the sandbox-active notice as status, not error', () => {
      const feed = parseTaskActivityLog(
        '[meta-agent/sandbox:subtask-a8a79c4c] sandbox active — macos/sandbox-exec workspace=/ws\n',
      )
      expect(feed.entries[0]?.kind).toBe('status')
    })

    it('shows the credential-deny-lifted warning as status, not error', () => {
      const feed = parseTaskActivityLog(
        '[sandbox] credential-deny-lifted: /Users/u/.config/gh — Default credential protection removed.\n',
      )
      expect(feed.entries[0]?.kind).toBe('status')
    })

    it('still surfaces unrecognised output, as a warning rather than silence', () => {
      const feed = parseTaskActivityLog('TypeError: undefined is not a function\n')
      expect(feed.entries[0]?.kind).toBe('warning')
      expect(feed.entries[0]?.text).toContain('TypeError')
    })

    it('does not let a bracketed prefix in ordinary text pass as a notice', () => {
      const feed = parseTaskActivityLog('[worker] something exploded\n')
      expect(feed.entries[0]?.kind).toBe('warning')
    })
  })
})
