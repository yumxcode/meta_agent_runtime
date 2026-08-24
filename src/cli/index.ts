/**
 * meta-agent CLI — entry point.
 *
 * This file does one job: parse argv and dispatch to the right runner. Every
 * other concern lives in a sibling module:
 *
 *   args.ts            flag parsing, CliOptions, help text
 *   term.ts            colours, sanitised output, thinking-meter registry
 *   env.ts             `meta-agent env` report (incl. the sandbox backend)
 *   keys.ts            API-key sanitising / validation
 *   limits.ts          turn-count defaults shared by args and router
 *   prompts.ts         readline question plumbing, workspace confirmation
 *   hardware.ts        robotics hardware-profile selection
 *   guards.ts          interactive sensitive-operation confirmation
 *   router.ts          CliOptions → SessionRouter
 *   stream.ts          rendering one model turn
 *   sessionFlow.ts     resume picker, snapshots, auto-continuation arming
 *   sideCalls.ts       flash-model calls the CLI makes for its own UI
 *   transcript.ts      message → display-string helpers
 *   mcpInstructions.ts lazily-registered MCP server instructions
 *   repl.ts            the interactive loop
 *   singleTurn.ts      one-shot / auto-scheduler / attached-auto paths
 *   commands/          review, deletion, team, loop subcommands
 *
 * Usage:
 *   meta-agent [options] [prompt]
 *
 * Interactive REPL (no prompt given):
 *   meta-agent
 *   meta-agent --mode agentic
 *
 * Single-turn (prompt given):
 *   meta-agent "what is Pareto optimality?"
 *   meta-agent --mode campaign "run a DOE sweep"
 *
 * Run `meta-agent --help` for the full option list (see args.ts).
 */

import { mkdirSync } from 'node:fs'
import { red, yellow, terminalText, installBrokenPipeGuards } from './term.js'
import { parseCliArgs } from './args.js'
import { sanitizeEnvKeys, assertApiKeyConfigured } from './keys.js'
import { getMissingBwrapWarning } from './bwrapCheck.js'
import { ensureMcpServerInstructions } from './mcpInstructions.js'
import { runLoopCommand } from './commands/loop.js'
import { runSteerCommand } from './commands/steer.js'
import { runTasksCommand } from './commands/tasks.js'
import { runSessionsCommand, runTrajectoryCommand } from './commands/trajectory.js'
import { runReviewerCommand } from './commands/reviewer.js'
import { runRepl } from './repl.js'
import { runSingleTurn, runAttachedAuto, runAutoSchedulerCommand } from './singleTurn.js'
import { McpAppsBrowserHost } from './mcpAppsHost.js'

async function main(): Promise<void> {
  // Before anything writes: make `| head` / `| less`-and-quit a clean exit
  // rather than `Fatal: write EPIPE`.
  installBrokenPipeGuards()
  // Sanitize env-var API keys once so detectProvider() receives clean values
  sanitizeEnvKeys()
  const opts = parseCliArgs()
  const bwrapWarning = getMissingBwrapWarning()
  if (bwrapWarning) {
    process.stderr.write(`${yellow(bwrapWarning)}\n`)
  }
  // Loop runtime dispatch first: its pure-code subcommands (list/inspect/…) must
  // work without an API key; runLoopCommand asserts the key only when it needs a
  // backend (tick/distill/loop-scheduler).
  if (opts.loopCommand) {
    // `steer` is pure local I/O (it writes a file another process picks up), so
    // it must work without a provider key — you steer a run that is already
    // burning tokens elsewhere, often from a second terminal.
    if (opts.loopCommand.name === 'steer') {
      await runSteerCommand(opts)
      return
    }
    // `tasks` is read-only and must work with no provider key configured — it
    // is the thing you reach for when something has gone wrong, and demanding
    // credentials to LOOK at task state would be exactly backwards.
    if (opts.loopCommand.name === 'tasks') {
      await runTasksCommand(opts)
      return
    }
    if (opts.loopCommand.name === 'trajectory') {
      await runTrajectoryCommand(opts)
      return
    }
    if (opts.loopCommand.name === 'sessions') {
      await runSessionsCommand(opts)
      return
    }
    if (opts.loopCommand.name === 'reviewer') {
      await runReviewerCommand(opts)
      return
    }
    if (opts.loopCommand.name === 'auto-scheduler') {
      assertApiKeyConfigured(opts)
      await runAutoSchedulerCommand(opts)
      return
    }
    await runLoopCommand(opts)
    return
  }

  assertApiKeyConfigured(opts)
  if (opts.attached && opts.mode !== 'auto') {
    throw new Error('--attached is supported only with --mode auto (or --yolo).')
  }
  if (opts.attached && opts.prompt === null) {
    throw new Error('--attached requires a one-shot prompt.')
  }
  let mcpAppsHost: McpAppsBrowserHost | undefined
  if (opts.mcpApps) {
    mcpAppsHost = new McpAppsBrowserHost({
      port: opts.mcpAppsPort,
      openBrowser: opts.mcpAppsOpen,
    })
    const info = await mcpAppsHost.start()
    const suffix = info.browserOpened ? ' (opened in browser)' : ''
    process.stderr.write(`MCP Apps host: ${info.url}${suffix}\n`)
    // `process.exit()` in the interactive REPL bypasses async finally blocks, so
    // the finally below is not enough on its own. An `exit` handler only runs
    // SYNCHRONOUS work — the previous `void mcpAppsHost?.close()` here scheduled
    // a promise that could never settle, i.e. it did nothing at all. closeSync()
    // tears the listener and its SSE streams down in-line, which does work.
    const host = mcpAppsHost
    process.once('exit', () => host.closeSync())
  }

  try {
    // Start the browser host first: MCP initialization then advertises the
    // io.modelcontextprotocol/ui extension to connected servers.
    await ensureMcpServerInstructions()

    if (opts.prompt !== null) {
      if (opts.sessionDir) mkdirSync(opts.sessionDir, { recursive: true })
      if (opts.attached) {
        await runAttachedAuto(opts)
      } else {
        await runSingleTurn(opts)
      }
    } else {
      if (opts.sessionDir) {
        console.error(red('Error: --session-dir is only supported for one-shot prompt runs.'))
        process.exit(1)
      }
      await runRepl(opts)
    }
  } finally {
    await mcpAppsHost?.close()
  }
}

main().catch(err => {
  console.error(red(`Fatal: ${terminalText(err instanceof Error ? err.message : String(err))}`))
  process.exit(1)
})
