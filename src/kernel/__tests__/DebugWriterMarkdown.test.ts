/**
 * DebugWriter markdown twin — `--debug` writes a content-only .md file with
 * the request (system prompt + messages) and the accumulated response.
 */
import { describe, it, expect } from 'vitest'
import { mkdtemp, readdir, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { DebugWriter } from '../api/DebugWriter.js'

async function readMd(root: string, sessionId: string): Promise<string> {
  const dir = join(root, sessionId)
  const files = await readdir(dir)
  const md = files.find(f => f.endsWith('.md'))
  expect(md, `expected a .md file, got: ${files.join(', ')}`).toBeDefined()
  return readFile(join(dir, md!), 'utf-8')
}

describe('DebugWriter markdown twin', () => {
  it('renders an Anthropic-shape request and streamed response as content-only markdown', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debug-md-'))
    try {
      const writer = await DebugWriter.open('sess-a', 'claude-sonnet-4-6', true, root)
      expect(writer).not.toBeNull()

      await writer!.writeRequest({
        model: 'claude-sonnet-4-6',
        system: '你是 X1 机器人调参助手',
        messages: [
          { role: 'user', content: [{ type: 'text', text: '帮我看看落地抖动' }] },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: '我先读曲线' },
              { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'logs/run-42/curve.csv' } },
            ],
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 't1', content: 't,vz\n0.00,1.82' }],
          },
        ],
        apiKey: 'sk-SECRET',
      })

      // Simulate the normalized stream: thinking → text → tool_use
      writer!.recordStreamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } })
      writer!.recordStreamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '先看阻尼' } })
      writer!.recordStreamEvent({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } })
      writer!.recordStreamEvent({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '建议 damping=0.42' } })
      writer!.recordStreamEvent({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'b1', name: 'bash', input: {} } })
      writer!.recordStreamEvent({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"cmd":"python analyze.py"}' } })
      writer!.recordStreamEvent({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null } })
      await writer!.close()

      const md = await readMd(root, 'sess-a')
      // Request side — content only
      expect(md).toContain('System Prompt')
      expect(md).toContain('你是 X1 机器人调参助手')
      expect(md).toContain('帮我看看落地抖动')
      expect(md).toContain('tool_use → `read_file`')
      expect(md).toContain('logs/run-42/curve.csv')
      expect(md).toContain('tool_result ← `t1`')
      // tool output is fenced so its content can't break the doc structure
      expect(md).toContain('```text\nt,vz\n0.00,1.82\n```')
      expect(md).not.toContain('sk-SECRET')
      // It must not be a JSON dump of the envelope
      expect(md).not.toContain('"messages"')
      // Response side
      expect(md).toContain('📥 LLM 返回')
      expect(md).toContain('> 先看阻尼')           // thinking rendered as blockquote
      expect(md).toContain('建议 damping=0.42')
      expect(md).toContain('tool_use → `bash`')
      expect(md).toContain('python analyze.py')
      expect(md).toContain('stop_reason：`tool_use`')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('renders an OpenAI/DeepSeek-shape request (system inside messages, string content)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debug-md-'))
    try {
      const writer = await DebugWriter.open('sess-b', 'deepseek-v4-pro', true, root)
      await writer!.writeRequest({
        model: 'deepseek-v4-pro',
        messages: [
          { role: 'system', content: 'system 指令文本' },
          { role: 'user', content: '用户问题' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: 'c1', function: { name: 'bash', arguments: '{"cmd":"ls"}' } }],
          },
          { role: 'tool', tool_call_id: 'c1', content: 'file-a file-b' },
        ],
      })
      await writer!.close()

      const md = await readMd(root, 'sess-b')
      expect(md).toContain('system 指令文本')
      expect(md).toContain('用户问题')
      expect(md).toContain('tool_use → `bash`')
      expect(md).toContain('tool_result ← `c1`')
      expect(md).toContain('file-a file-b')
      // empty response → placeholder, not a crash
      expect(md).toContain('(no content received)')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('tool output containing ``` fences cannot break the document structure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debug-md-'))
    try {
      const writer = await DebugWriter.open('sess-c', 'm', true, root)
      const evil = '代码示例：\n```python\nprint(1)\n```\n结束'
      await writer!.writeRequest({
        model: 'm',
        messages: [
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't9', content: evil }] },
        ],
      })
      await writer!.close()

      const md = await readMd(root, 'sess-c')
      // The wrapper fence must be longer than the inner ``` run
      expect(md).toContain('````text')
      expect(md).toContain('```python')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
