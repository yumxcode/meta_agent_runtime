import { execFile } from 'child_process'
import { promisify } from 'util'
import { createHash } from 'crypto'
import { isAbsolute, relative, resolve, sep } from 'path'
import { stat } from 'fs/promises'
import type { MetaAgentTool, ToolResult } from '../../core/types.js'
import { parseWriteScope, relativePathError } from '../security/PathSafety.js'
import { HostSchedulerCoordinator } from '../host/HostSchedulerCoordinator.js'
import { ensureWorkspaceIdentity } from '../workspace/WorkspaceIdentity.js'

const execFileAsync = promisify(execFile)

/**
 * Host-owned VCS lane. It stages only Charter writeScope roots, commits them,
 * and pushes the current branch to one frozen remote. The worker never receives
 * direct write access to `.git`.
 */
export function makeVcsPublishTool(input: {
  projectDir: string
  writeScope: string[]
  remote?: string
  instanceId?: string
  hostCoordinator?: HostSchedulerCoordinator
}): MetaAgentTool {
  const remote = input.remote ?? 'origin'
  const roots = [...new Set(input.writeScope.map(scope => parseWriteScope(scope).root))]
  return {
    name: 'vcs_publish',
    description:
      `Stage only the exact changed files named in paths (each must be inside Charter writeScope), ` +
      `commit them, and push the current branch to '${remote}'. ` +
      'Use this instead of git add/commit/push; direct .git writes are blocked.',
    isConcurrencySafe: false,
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Non-empty commit message.' },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Exact workspace-relative files changed by this round; directories and globs are forbidden.',
        },
      },
      required: ['message', 'paths'],
    },
    async call(raw): Promise<ToolResult> {
      const message = typeof raw['message'] === 'string' ? raw['message'].trim() : ''
      if (!message) return { content: 'Error: message is required', isError: true }
      const requested = Array.isArray(raw['paths'])
        ? [...new Set(raw['paths'].filter((value): value is string => typeof value === 'string'))]
        : []
      if (requested.length === 0 || requested.length > 100) {
        return { content: 'Error: paths must contain 1..100 exact workspace-relative files', isError: true }
      }
      if (roots.length === 0) {
        return { content: 'Error: vcs_publish requires a non-empty Charter writeScope', isError: true }
      }
      const badPath = requested.find(path => {
        if (relativePathError(path) || /[*?[\]{}]/.test(path) || path.endsWith('/')) return true
        const target = resolve(input.projectDir, path)
        return !roots.some(root => pathIsUnder(target, resolve(input.projectDir, root)))
      })
      if (badPath) {
        return { content: `Error: path '${badPath}' is not an exact file inside Charter writeScope`, isError: true }
      }
      for (const path of requested) {
        try {
          if ((await stat(resolve(input.projectDir, path))).isDirectory()) {
            return { content: `Error: path '${path}' is a directory; list exact files`, isError: true }
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            return {
              content: `Error: cannot inspect path '${path}': ${error instanceof Error ? error.message : String(error)}`,
              isError: true,
            }
          }
          // A missing path may be a tracked deletion; git add below decides.
        }
      }
      let gitLease: Awaited<ReturnType<HostSchedulerCoordinator['acquireResources']>> = null
      let gitLeaseHeartbeat: ReturnType<typeof setInterval> | null = null
      try {
        const branch = (await git(input.projectDir, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim()
        if (!branch) throw new Error('detached HEAD cannot be published')
        const remoteUrl = (await git(input.projectDir, ['remote', 'get-url', remote])).trim()
        if (!remoteUrl) throw new Error(`remote '${remote}' has no URL`)
        const workspace = await ensureWorkspaceIdentity(input.projectDir)
        const coordinator = input.hostCoordinator ?? new HostSchedulerCoordinator()
        const descriptiveResource = `git:${canonicalRemoteIdentity(remoteUrl)}#${branch}`
        const resourceId = /^[A-Za-z0-9][A-Za-z0-9._:/@#=+-]{0,511}$/.test(descriptiveResource)
          ? descriptiveResource
          : `git:${createHash('sha256')
          .update(`${canonicalRemoteIdentity(remoteUrl)}\n${branch}`)
          .digest('hex').slice(0, 32)}`
        gitLease = await coordinator.acquireResources({
          workspaceId: workspace.workspaceId,
          instanceId: input.instanceId ?? '$vcs-publish',
        }, [{ id: resourceId, mode: 'exclusive' }], new AbortController().signal)
        gitLeaseHeartbeat = setInterval(() => {
          void gitLease?.heartbeat().catch(() => undefined)
        }, coordinator.heartbeatIntervalMs)
        gitLeaseHeartbeat.unref?.()
        await git(input.projectDir, ['add', '--', ...requested])
        const staged = await gitExit(input.projectDir, ['diff', '--cached', '--quiet', '--', ...requested])
        if (staged === 1) await git(input.projectDir, ['commit', '-m', message, '--', ...requested], 120_000)
        else if (staged !== 0) throw new Error(`git diff --cached failed with exit ${staged}`)
        const commit = (await git(input.projectDir, ['rev-parse', 'HEAD'])).trim()
        const remoteHead = (await git(input.projectDir, ['ls-remote', '--heads', remote, `refs/heads/${branch}`])).trim()
        if (remoteHead) {
          await git(input.projectDir, ['fetch', '--no-tags', remote, `refs/heads/${branch}`], 120_000)
          const fastForward = await gitExit(input.projectDir, ['merge-base', '--is-ancestor', 'FETCH_HEAD', commit])
          if (fastForward === 1) throw new Error(`remote ${remote}/${branch} advanced; refusing non-fast-forward publish`)
          if (fastForward !== 0) throw new Error(`could not verify fast-forward against ${remote}/${branch}`)
        }
        await git(input.projectDir, ['push', remote, `${branch}:${branch}`], 120_000)
        return {
          content: JSON.stringify({ status: staged === 1 ? 'committed_and_pushed' : 'pushed_existing_head', remote, branch, commit }),
          isError: false,
        }
      } catch (error) {
        return {
          content: `Error: vcs_publish failed: ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
        }
      } finally {
        if (gitLeaseHeartbeat) clearInterval(gitLeaseHeartbeat)
        await gitLease?.release().catch(() => undefined)
      }
    },
  }
}

function canonicalRemoteIdentity(value: string): string {
  try {
    const url = new URL(value)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString().replace(/\/$/, '')
  } catch {
    // SCP-like git syntax. Strip a possible user prefix; the result is hashed
    // before persistence, so neither credentials nor repository names are exposed.
    return value.replace(/^[^@/]+@/, '').replace(/\/$/, '')
  }
}

function pathIsUnder(target: string, root: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

async function git(cwd: string, args: string[], timeout = 30_000): Promise<string> {
  try {
    const result = await execFileAsync('git', args, { cwd, timeout, maxBuffer: 1024 * 1024 })
    return result.stdout
  } catch (error) {
    const detail = error as Error & { stderr?: string }
    throw new Error(`${args.slice(0, 2).join(' ')}: ${detail.stderr?.trim() || detail.message}`)
  }
}

async function gitExit(cwd: string, args: string[]): Promise<number> {
  try {
    await execFileAsync('git', args, { cwd, timeout: 30_000, maxBuffer: 64 * 1024 })
    return 0
  } catch (error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'number') return code
    throw error
  }
}
