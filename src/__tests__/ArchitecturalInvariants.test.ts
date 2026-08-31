/**
 * Architectural invariants — the enforcing half of conventions that were
 * previously maintained by care alone.
 *
 * Every check here corresponds to a bug class that has already cost this
 * codebase a review cycle:
 *
 *   1. IMPORT CYCLES — the dependency graph is currently acyclic at file level.
 *      That is not a natural state for 400+ files; it was maintained
 *      deliberately, and nothing was checking it. An ESM value-import cycle
 *      does not fail to compile — it fails at runtime, intermittently, as a
 *      TDZ `undefined` at whichever module happened to be evaluated first.
 *
 *   2. child_process REACH — v0.8.16 found that `cron_create` spawned a shell
 *      with none of the bash tool's five protections, purely because it did not
 *      go through the place where they live. The remediation added
 *      `infra/exec/runShellCommand.ts` and recommended a lint rule to stop the
 *      next one. The rule was never added; six months later the same shape
 *      recurred in the git paths (full `process.env` inherited, output
 *      unredacted). This is that rule.
 *
 *   3. TOOL NAME COLLISIONS — tool registries are `Map<string, Tool>`, so two
 *      tools sharing a name means the later registration silently replaces the
 *      earlier one. `progress_note` has two unrelated implementations today;
 *      they happen never to be assembled together, and nothing enforced that.
 *
 *   4. PERMISSION DECLARATION COVERAGE — `findWorkspaceViolation` inspects only
 *      the fields a tool names (`cwdField` / `commandField` / `pathFields`). A
 *      mutating tool that names none of them passes the jail without a single
 *      path being examined, and `sensitive` defaults to false so no approval
 *      fires either. Identical in shape to the v0.8.16 name-gating bug.
 */

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname, resolve, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) {
      if (entry === '__tests__') continue
      walk(p, out)
    } else if (entry.endsWith('.ts')) {
      out.push(p)
    }
  }
  return out
}

const SOURCE_FILES = walk(SRC)

/**
 * Resolve a relative import specifier to a source file, mirroring the
 * `moduleResolution: bundler` + `.js`-extension-means-`.ts` convention.
 */
function resolveSpecifier(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null
  const base = resolve(dirname(fromFile), spec).replace(/\.js$/, '.ts')
  if (SOURCE_FILES.includes(base)) return base
  const asIndex = base.replace(/\.ts$/, '') + sep + 'index.ts'
  return SOURCE_FILES.includes(asIndex) ? asIndex : null
}

/**
 * Value (non-type) relative imports for one file.
 *
 * Type-only imports are excluded deliberately: they are erased before the
 * module graph exists at runtime, so they cannot produce a TDZ cycle. Both
 * spellings are handled — the statement-level `import type {…}` and the
 * specifier-level `import { type X }` where every specifier is a type.
 */
function valueImports(file: string): string[] {
  const src = readFileSync(file, 'utf-8')
  const out: string[] = []

  /**
   * The clause between `import`/`export` and `from` must match an actual import
   * clause: a braced specifier list, `* as ns`, a bare default binding, or a
   * default combined with either. Spelling it out matters — a permissive
   * `[\s\S]*?` looks equivalent but silently swallows whole regions of a file:
   * `export type Foo = …` matches `export` + `type `, the lazy body then runs
   * forward to the NEXT statement's `from`, and that genuine import is both
   * consumed and misclassified as type-only. This test shipped with that bug
   * and reported a clean graph for a file that had a real cycle in it.
   */
  const CLAUSE = String.raw`(?:\{[^{}]*\}|\*[ \t]+as[ \t]+[A-Za-z_$][\w$]*|[A-Za-z_$][\w$]*(?:[ \t]*,[ \t]*(?:\{[^{}]*\}|\*[ \t]+as[ \t]+[A-Za-z_$][\w$]*))?)`
  const re = new RegExp(
    String.raw`(?:^|\n)[ \t]*(?:import|export)[ \t\r\n]+(type[ \t]+)?(${CLAUSE})[ \t\r\n]*from[ \t]*['"]([^'"]+)['"]`,
    'g',
  )

  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    if (m[1]) continue                       // `import type { … } from`
    const clause = m[2] ?? ''
    const braced = clause.match(/\{([^{}]*)\}/)
    if (braced) {
      const specifiers = braced[1]!.split(',').map(s => s.trim()).filter(Boolean)
      const hasDefaultOrNamespace = /^\s*[A-Za-z_$][\w$]*\s*,|\*[ \t]+as/.test(clause)
      if (specifiers.length > 0 && !hasDefaultOrNamespace &&
          specifiers.every(s => s.startsWith('type '))) {
        continue                             // every specifier is `type X`
      }
    }
    const resolved = resolveSpecifier(file, m[3]!)
    if (resolved) out.push(resolved)
  }

  // Side-effect imports (`import './register.js'`) have no clause at all but
  // still evaluate the module, so they are edges too.
  const bare = /(?:^|\n)[ \t]*import[ \t]+['"]([^'"]+)['"]/g
  while ((m = bare.exec(src)) !== null) {
    const resolved = resolveSpecifier(file, m[1]!)
    if (resolved) out.push(resolved)
  }
  return out
}

describe('architectural invariants', () => {
  // ── 1. No value-import cycles ──────────────────────────────────────────────
  it('has no runtime import cycles between source files', () => {
    const graph = new Map<string, string[]>()
    for (const f of SOURCE_FILES) graph.set(f, valueImports(f))

    // Tarjan. Iterative rather than recursive: the graph is ~1800 edges deep
    // enough that a recursive DFS can blow the stack in a worker.
    let index = 0
    const idx = new Map<string, number>()
    const low = new Map<string, number>()
    const onStack = new Set<string>()
    const stack: string[] = []
    const cycles: string[][] = []

    for (const root of SOURCE_FILES) {
      if (idx.has(root)) continue
      const work: Array<{ node: string; edge: number }> = [{ node: root, edge: 0 }]
      idx.set(root, index); low.set(root, index); index++
      stack.push(root); onStack.add(root)

      while (work.length > 0) {
        const frame = work[work.length - 1]!
        const edges = graph.get(frame.node) ?? []
        if (frame.edge < edges.length) {
          const next = edges[frame.edge++]!
          if (!idx.has(next)) {
            idx.set(next, index); low.set(next, index); index++
            stack.push(next); onStack.add(next)
            work.push({ node: next, edge: 0 })
          } else if (onStack.has(next)) {
            low.set(frame.node, Math.min(low.get(frame.node)!, idx.get(next)!))
          }
        } else {
          work.pop()
          const parent = work[work.length - 1]
          if (parent) low.set(parent.node, Math.min(low.get(parent.node)!, low.get(frame.node)!))
          if (low.get(frame.node) === idx.get(frame.node)) {
            const component: string[] = []
            let popped: string
            do {
              popped = stack.pop()!
              onStack.delete(popped)
              component.push(popped)
            } while (popped !== frame.node)
            if (component.length > 1) cycles.push(component)
          }
        }
      }
    }

    const rendered = cycles.map(c => c.map(f => relative(SRC, f)).sort().join(' ↔ '))
    expect(rendered, 'new import cycle(s) introduced').toEqual([])
  })

  // ── 2. child_process is reachable only from the hardened entry points ──────
  it('confines child_process to infra/exec plus a recorded allowlist', () => {
    /**
     * Each entry is a decision, not an oversight. Removing one means proving
     * the call site needs neither the credential filter nor output redaction.
     */
    const ALLOWED = new Map<string, string>([
      ['infra/exec/runShellCommand.ts', 'the hardened shell entry point itself'],
      ['infra/exec/runGit.ts', 'the hardened git entry point itself'],
      // The persistent-session counterpart of runShellCommand. It cannot route
      // THROUGH runShellCommand — that function spawns, waits for close, and
      // returns, which is exactly the lifecycle a session must not have — so it
      // is a second hardened entry point rather than a caller of the first. It
      // applies the same five protections at its own spawn site (cwd jail via
      // resolveJailedCwd, buildChildEnv, sandbox wrapExec, own process group,
      // redactSecrets on every read); ShellSessionStore.test.ts asserts each.
      ['infra/exec/ShellSessionStore.ts', 'the hardened persistent-shell entry point itself'],
      ['tools/mcp/mcpConfigFile.ts', 'stdio MCP servers; uses buildChildEnv("filtered")'],
      ['tools/fs/grep/index.ts', 'fixed argv (rg); no shell, no model-controlled argv'],
      ['cli/mcpAppsHost.ts', 'MCP Apps host process; config-controlled argv'],
      [
        'cli/tui/TaskManager.ts',
        'trusted same-runtime worker; fixed argv, exact durable wake id, explicit buildChildEnv("inherit")',
      ],
      ['sandbox/detect.ts', 'capability probes (sandbox-exec / bwrap --version), 3s timeout'],
    ])

    const offenders: string[] = []
    for (const f of SOURCE_FILES) {
      const src = readFileSync(f, 'utf-8')
      if (!/from\s+['"](?:node:)?child_process['"]/.test(src)) continue
      const rel = relative(SRC, f).split(sep).join('/')
      if (!ALLOWED.has(rel)) offenders.push(rel)
    }

    expect(
      offenders,
      'child_process imported outside infra/exec. Route the call through ' +
      'runShellCommand (model-supplied command strings) or runGit (git), or add ' +
      'an entry to ALLOWED above stating why neither applies.',
    ).toEqual([])
  })

  // ── 3. Tool names are unique within any assembled toolset ─────────────────
  it('never assembles two tools under the same name', async () => {
    const { createStandardTools } = await import('../tools/index.js')

    // Every include-combination a caller can actually request, plus the
    // autonomous variant, since it swaps the UI tool group.
    const cases: Array<{ label: string; tools: { name: string }[] }> = [
      { label: 'standard', tools: await createStandardTools() },
      { label: 'auto', tools: await createStandardTools({ mode: 'auto' }) },
    ]

    for (const { label, tools } of cases) {
      const seen = new Map<string, number>()
      for (const t of tools) seen.set(t.name, (seen.get(t.name) ?? 0) + 1)
      const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([n]) => n)
      expect(dupes, `duplicate tool names in the "${label}" toolset — the ` +
        'registry is a Map, so the later registration silently wins').toEqual([])
    }
  })

  it('records every tool name that has more than one implementation', () => {
    /**
     * Two factories may legitimately produce the same model-facing name when
     * they are never assembled together (checked above). Listing them here
     * makes that a recorded decision instead of a coincidence, so the next
     * person who wires robotics tools into a session that also has the UI tool
     * group finds this note first.
     */
    const KNOWN_POLYMORPHIC = new Set([
      // tools/ui/progress_note (session note, shown in the UI) vs
      // robotics/tools/progress_note (writes to the robotics project store,
      // surfaced in the R5 resume section). RoboticsSession deliberately does
      // NOT register createUiTools(), so only one is ever live.
      'progress_note',
    ])

    const byName = new Map<string, string[]>()
    for (const f of SOURCE_FILES) {
      if (!/\/tools\//.test(f.split(sep).join('/'))) continue
      const src = readFileSync(f, 'utf-8')
      for (const m of src.matchAll(/^\s{2,6}name:\s*'([a-z][a-z0-9_]*)',$/gm)) {
        const rel = relative(SRC, f).split(sep).join('/')
        const list = byName.get(m[1]!) ?? []
        if (!list.includes(rel)) list.push(rel)
        byName.set(m[1]!, list)
      }
    }

    const unexpected = [...byName.entries()]
      .filter(([name, files]) => files.length > 1 && !KNOWN_POLYMORPHIC.has(name))
      .map(([name, files]) => `${name}: ${files.join(', ')}`)

    expect(unexpected, 'a tool name gained a second implementation — either ' +
      'rename it or add it to KNOWN_POLYMORPHIC with the reason the two are ' +
      'never assembled together').toEqual([])
  })

  // ── 4. Mutating tools subscribe to the workspace jail ─────────────────────
  it('gives every mutating tool something for the workspace jail to scan', async () => {
    const { createStandardTools } = await import('../tools/index.js')
    const tools = await createStandardTools()

    /**
     * Tools that mutate state but genuinely accept no path and no command.
     * They write to a fixed directory under an id this codebase sanitises, so
     * there is nothing for the path scan to look at. Recorded rather than
     * silently tolerated — see warnIfJailIsInert in PermissionPolicy.ts.
     */
    const NO_PATH_BY_DESIGN = new Set([
      'memory_write',    // queues a proposal; filename passes sanitizeFilename()
      'memory_delete',   // queues a deletion; id must match an existing entry
      'cron_delete',     // job id, not a path
      'todo_write',      // session-scoped store
      'skill',           // skill name resolved against a registry
      'exit_plan_mode',
      'enter_plan_mode',

      // apply_patch: its paths live INSIDE the patch document, not in a
      // declarable field. `pathFields: ['patch']` would hand the jail a whole
      // multi-file diff to interpret as one path; `commandField: 'patch'` would
      // run sensitive-command detection over patch CONTENT, so patching any
      // shell script containing `rm -rf build/` would prompt. Instead the tool
      // resolves every add/update/delete/move target through
      // resolveInsideWorkspace itself, BEFORE planning any write, and refuses
      // the whole patch on the first escape. ApplyPatchTool.test.ts covers both
      // the file path and the move target.
      'apply_patch',

      // write_stdin / close_session: the jail applies when a SESSION is opened
      // (exec_session declares both cwdField and commandField). These two
      // address an already-jailed, already-sandboxed session by id. write_stdin
      // deliberately carries no commandField because its payload is arbitrary
      // stdin — a REPL expression, a password, a keypress — and scanning that
      // as a shell command produces false positives without adding protection.
      'write_stdin',
      'close_session',
    ])

    const inert: string[] = []
    for (const tool of tools) {
      const p = tool.permission
      if (!p) continue
      if (p.category !== 'write' && p.category !== 'execute') continue
      if (p.cwdField || p.commandField || p.pathFields?.length) continue
      if (NO_PATH_BY_DESIGN.has(tool.name)) continue
      inert.push(tool.name)
    }

    expect(inert, 'these tools declare a mutating category but name no ' +
      'cwdField / commandField / pathFields, so the workspace jail scans ' +
      'nothing for them. Declare the field, or add the tool to ' +
      'NO_PATH_BY_DESIGN with the reason it takes neither.').toEqual([])
  })
})
