export type GitHubWorkflowRunSelection = 'unique' | 'oldest' | 'newest'

export interface GitHubWorkflowRunQuery {
  repository: string
  workflow: string | number
  headSha: string
  branch?: string
  event?: string
  created?: string
}

export interface GitHubWorkflowRun {
  id: number
  workflowId?: number
  runNumber?: number
  runAttempt?: number
  headSha: string
  headBranch?: string
  event?: string
  status: string
  conclusion: string | null
  htmlUrl?: string
  createdAt?: string
  updatedAt?: string
}

export interface GitHubActionsClient {
  listWorkflowRuns(query: GitHubWorkflowRunQuery): Promise<GitHubWorkflowRun[]>
  getWorkflowRun(repository: string, runId: number): Promise<GitHubWorkflowRun>
}

export interface GitHubRestActionsClientOptions {
  token?: string
  baseUrl?: string
  apiVersion?: string
  userAgent?: string
  fetch?: typeof fetch
}

export class GitHubActionsApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message)
    this.name = 'GitHubActionsApiError'
  }
}

/**
 * Minimal GitHub Actions REST client used by the optional Capability Pack.
 *
 * It intentionally exposes only read operations. Code publication, workflow
 * dispatch, artifact interpretation, and project-specific scoring remain
 * outside the generic Graph mechanism.
 */
export function createGitHubRestActionsClient(options: GitHubRestActionsClientOptions = {}): GitHubActionsClient {
  const request = options.fetch ?? globalThis.fetch
  if (typeof request !== 'function') throw new Error('GitHub Actions REST client requires fetch')
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? 'https://api.github.com')
  const apiVersion = options.apiVersion ?? '2026-03-10'
  const userAgent = options.userAgent ?? '@meta-agent/runtime'

  const call = async (path: string): Promise<unknown> => {
    let response: Response
    try {
      response = await request(`${baseUrl}${path}`, {
        method: 'GET',
        redirect: 'error',
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': apiVersion,
          'User-Agent': userAgent,
          ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        },
      })
    } catch (error) {
      throw new GitHubActionsApiError(`GitHub Actions request failed: ${message(error)}`, 0, true)
    }
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 500)
      const rateLimited = response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0'
      const retryable = rateLimited || response.status === 408 || response.status === 429 || response.status >= 500
      throw new GitHubActionsApiError(
        `GitHub Actions API ${response.status}${detail ? `: ${detail}` : ''}`,
        response.status,
        retryable,
      )
    }
    try {
      return await response.json()
    } catch (error) {
      throw new GitHubActionsApiError(`GitHub Actions API returned invalid JSON: ${message(error)}`, response.status, false)
    }
  }

  return {
    async listWorkflowRuns(query): Promise<GitHubWorkflowRun[]> {
      const { owner, repo } = parseRepository(query.repository)
      const params = new URLSearchParams({ head_sha: requireNonEmpty(query.headSha, 'headSha'), per_page: '100' })
      if (query.branch) params.set('branch', query.branch)
      if (query.event) params.set('event', query.event)
      if (query.created) params.set('created', query.created)
      const workflow = typeof query.workflow === 'number'
        ? requirePositiveInteger(query.workflow, 'workflow')
        : encodeURIComponent(requireNonEmpty(query.workflow, 'workflow'))
      const payload = await call(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows/${workflow}/runs?${params}`)
      if (!isRecord(payload) || !Array.isArray(payload.workflow_runs)) {
        throw new GitHubActionsApiError('GitHub Actions list response is missing workflow_runs', 200, false)
      }
      return payload.workflow_runs.map((item, index) => parseWorkflowRun(item, `workflow_runs[${index}]`))
    },

    async getWorkflowRun(repository, runId): Promise<GitHubWorkflowRun> {
      const { owner, repo } = parseRepository(repository)
      const id = requirePositiveInteger(runId, 'runId')
      const payload = await call(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${id}`)
      return parseWorkflowRun(payload, 'workflow_run')
    },
  }
}

function parseWorkflowRun(value: unknown, at: string): GitHubWorkflowRun {
  try {
    if (!isRecord(value)) throw new Error(`${at} must be an object`)
    const id = requirePositiveInteger(value.id, `${at}.id`)
    const headSha = requireNonEmpty(value.head_sha, `${at}.head_sha`)
    const status = requireNonEmpty(value.status, `${at}.status`)
    const conclusion = value.conclusion === null || typeof value.conclusion === 'string'
      ? value.conclusion
      : undefined
    if (conclusion === undefined) throw new Error(`${at}.conclusion must be a string or null`)
    return {
      id,
      headSha,
      status,
      conclusion,
      ...optionalInteger(value.workflow_id, 'workflowId'),
      ...optionalInteger(value.run_number, 'runNumber'),
      ...optionalInteger(value.run_attempt, 'runAttempt'),
      ...optionalString(value.head_branch, 'headBranch'),
      ...optionalString(value.event, 'event'),
      ...optionalString(value.html_url, 'htmlUrl'),
      ...optionalString(value.created_at, 'createdAt'),
      ...optionalString(value.updated_at, 'updatedAt'),
    }
  } catch (error) {
    if (error instanceof GitHubActionsApiError) throw error
    throw new GitHubActionsApiError(message(error), 200, false)
  }
}

function optionalInteger(value: unknown, key: string): Record<string, number> {
  return Number.isInteger(value) && Number(value) > 0 ? { [key]: Number(value) } : {}
}

function optionalString(value: unknown, key: string): Record<string, string> {
  return typeof value === 'string' && value.length > 0 ? { [key]: value } : {}
}

function normalizeBaseUrl(raw: string): string {
  const url = new URL(raw)
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new Error('GitHub Actions baseUrl must use HTTPS (HTTP is allowed only for localhost tests)')
  }
  url.pathname = url.pathname.replace(/\/+$/, '')
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

function parseRepository(value: string): { owner: string; repo: string } {
  const parts = requireNonEmpty(value, 'repository').split('/')
  if (parts.length !== 2 || parts.some(part => !part.trim())) throw new Error("repository must be 'owner/repo'")
  const repo = parts[1]!.replace(/\.git$/, '')
  if (!repo) throw new Error("repository must be 'owner/repo'")
  return { owner: parts[0]!, repo }
}

function requireNonEmpty(value: unknown, at: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${at} must be a non-empty string`)
  return value.trim()
}

function requirePositiveInteger(value: unknown, at: string): number {
  if (!Number.isInteger(value) || Number(value) <= 0) throw new Error(`${at} must be a positive integer`)
  return Number(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
