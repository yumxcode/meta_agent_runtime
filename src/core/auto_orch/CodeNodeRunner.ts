import { spawn } from 'child_process'
import type { OrchNode } from './LoopIR.js'
import type { OrchVerdict } from './Verdict.js'
import { readCodeNodeSource } from './CodeNodeStore.js'
import { reviewCodeNodeSource } from './CodeNodeAuthor.js'

export interface CodeNodeRunnerOptions {
  /** Root the code's api.state reads/writes against (integration tree when a
   * run workspace is active, otherwise the main workspace). */
  projectDir: string
  /**
   * Root that holds the frozen code artifacts (.meta-agent/auto_orch/code_nodes).
   * Artifacts always live in the MAIN workspace — the integration tree excludes
   * .meta-agent — so this differs from projectDir when a run workspace is active.
   * Defaults to projectDir.
   */
  codeRoot?: string
}

const DEFAULT_TIMEOUT_MS = 3_000
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024

const WRAPPER_SOURCE = String.raw`
import { mkdir, readFile, rename, writeFile, appendFile } from 'fs/promises'
import { dirname, resolve, relative } from 'path'
import { randomUUID } from 'crypto'
import { pathToFileURL } from 'url'

console.log = (...args) => console.error(...args)
console.info = (...args) => console.error(...args)
console.warn = (...args) => console.error(...args)

const payload = JSON.parse(await readStdin())
const root = resolve(payload.projectDir)
const caps = new Set(payload.capabilities || [])

function assertCap(cap) {
  if (!caps.has(cap)) throw new Error('missing capability: ' + cap)
}

function safeReadPath(p) {
  if (typeof p !== 'string' || !p) throw new Error('path must be a non-empty string')
  const abs = resolve(root, p)
  const rel = relative(root, abs).replace(/\\/g, '/')
  if (rel.startsWith('..') || rel === '' || rel.startsWith('/')) throw new Error('path escapes projectDir: ' + p)
  return abs
}

function safeWritePath(p) {
  const abs = safeReadPath(p)
  const rel = relative(root, abs).replace(/\\/g, '/')
  if (!rel.startsWith('state/')) throw new Error('api.state write path must be under state/: ' + p)
  return abs
}

async function atomicWrite(path, contents) {
  await mkdir(dirname(path), { recursive: true })
  const tmp = path + '.' + randomUUID().slice(0, 8) + '.tmp'
  await writeFile(tmp, contents, 'utf-8')
  await rename(tmp, path)
}

const api = {
  nowIso: payload.nowIso,
  state: {
    async readJson(path) {
      assertCap('state.read')
      return JSON.parse(await readFile(safeReadPath(path), 'utf-8'))
    },
    async writeJson(path, value) {
      assertCap('state.write')
      await atomicWrite(safeWritePath(path), JSON.stringify(value, null, 2))
    },
    async appendJsonl(path, value) {
      assertCap('jsonl.append')
      const abs = safeWritePath(path)
      await mkdir(dirname(abs), { recursive: true })
      await appendFile(abs, JSON.stringify(value) + '\n', 'utf-8')
    },
    async readText(path) {
      assertCap('state.read')
      return readFile(safeReadPath(path), 'utf-8')
    },
    async writeText(path, value) {
      assertCap('state.write')
      await atomicWrite(safeWritePath(path), String(value))
    }
  },
  log(level, event, detail) {
    console.error(JSON.stringify({ level, event, detail }))
  }
}

try {
  const mod = await import(pathToFileURL(payload.codePath).href + '?v=' + encodeURIComponent(payload.sourceHash))
  if (typeof mod.main !== 'function') throw new Error('module does not export main')
  const result = await mod.main(payload.input || {}, api)
  process.stdout.write(JSON.stringify({ ok: true, result }))
} catch (err) {
  process.stdout.write(JSON.stringify({ ok: false, error: err && err.message ? err.message : String(err) }))
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let s = ''
    process.stdin.setEncoding('utf-8')
    process.stdin.on('data', chunk => { s += chunk })
    process.stdin.on('end', () => resolve(s))
    process.stdin.on('error', reject)
  })
}
`

export class CodeNodeRunner {
  constructor(private readonly opts: CodeNodeRunnerOptions) {}

  async run(node: OrchNode, signal: AbortSignal): Promise<OrchVerdict> {
    if (!node.codeRef || !node.sourceHash) {
      return { action: 'branch', label: 'error', note: `code node ${node.id} is not materialized` }
    }
    try {
      const { source, path } = await readCodeNodeSource(
        this.opts.codeRoot ?? this.opts.projectDir,
        node.codeRef,
        node.sourceHash,
      )
      const reviewErrors = reviewCodeNodeSource(source)
      if (reviewErrors.length) {
        return { action: 'branch', label: 'error', note: `code node ${node.id} failed review: ${reviewErrors.join('; ')}` }
      }
      const payload = {
        projectDir: this.opts.projectDir,
        codePath: path,
        sourceHash: node.sourceHash,
        input: node.input ?? {},
        capabilities: node.capabilities ?? [],
        nowIso: new Date().toISOString(),
      }
      const raw = await runWrapper(payload, {
        signal,
        timeoutMs: node.codeBounds?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxOutputBytes: node.codeBounds?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      })
      const out = JSON.parse(raw) as { ok?: boolean; result?: unknown; error?: string }
      if (!out.ok) return { action: 'branch', label: 'error', note: out.error ?? 'code node failed' }
      const verdict = parseVerdict(out.result)
      if (!verdict) return { action: 'branch', label: 'error', note: `code node ${node.id} returned an invalid verdict` }
      return verdict
    } catch (err) {
      return { action: 'branch', label: 'error', note: err instanceof Error ? err.message : String(err) }
    }
  }
}

function parseVerdict(value: unknown): OrchVerdict | null {
  if (!value || typeof value !== 'object') return null
  const obj = value as Record<string, unknown>
  const action = obj['action']
  if (!['continue', 'inject', 'reject', 'branch', 'done', 'abort'].includes(String(action))) return null
  const verdict: OrchVerdict = { action: action as OrchVerdict['action'] }
  if (typeof obj['label'] === 'string') verdict.label = obj['label']
  if (typeof obj['note'] === 'string') verdict.note = obj['note']
  if (Array.isArray(obj['messages'])) verdict.messages = obj['messages'].map(String)
  if (obj['data'] && typeof obj['data'] === 'object') verdict.data = obj['data'] as Record<string, unknown>
  return verdict
}

function runWrapper(
  payload: unknown,
  opts: { signal: AbortSignal; timeoutMs: number; maxOutputBytes: number },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--input-type=module', '-e', WRAPPER_SOURCE],
      { stdio: ['pipe', 'pipe', 'pipe'], env: {}, cwd: '/' },
    )
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(new Error(`code node timed out after ${opts.timeoutMs}ms`))
    }, opts.timeoutMs)
    const abort = () => {
      child.kill('SIGKILL')
      finish(new Error('code node aborted'))
    }
    opts.signal.addEventListener('abort', abort, { once: true })
    child.stdout.setEncoding('utf-8')
    child.stderr.setEncoding('utf-8')
    child.stdout.on('data', chunk => {
      stdout += chunk
      if (Buffer.byteLength(stdout, 'utf-8') > opts.maxOutputBytes) {
        child.kill('SIGKILL')
        finish(new Error(`code node stdout exceeded ${opts.maxOutputBytes} bytes`))
      }
    })
    child.stderr.on('data', chunk => {
      stderr += chunk
      if (Buffer.byteLength(stderr, 'utf-8') > opts.maxOutputBytes) {
        child.kill('SIGKILL')
        finish(new Error(`code node stderr exceeded ${opts.maxOutputBytes} bytes`))
      }
    })
    child.on('error', finish)
    child.on('close', code => {
      if (code !== 0) finish(new Error(`code node exited ${code}: ${stderr.slice(0, 1000)}`))
      else finish(null)
    })
    child.stdin.end(JSON.stringify(payload))

    function finish(err: Error | null): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal.removeEventListener('abort', abort)
      if (err) reject(err)
      else resolve(stdout)
    }
  })
}
