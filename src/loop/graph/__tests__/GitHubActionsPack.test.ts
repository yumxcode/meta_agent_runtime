import { describe, expect, it, vi } from 'vitest'
import {
  GITHUB_ACTIONS_RESOLVE_RUN_EFFECT,
  GITHUB_ACTIONS_WATCH_RUN_EFFECT,
  GitHubActionsApiError,
  createDefaultGraphRuntimeCatalog,
  freezeLoopGraph,
  createGitHubActionsCapabilityPack,
  createGitHubActionsResolveRunProvider,
  createGitHubActionsWatchRunProvider,
  createGitHubRestActionsClient,
  type GitHubActionsClient,
  type GitHubWorkflowRun,
} from '../index.js'

const baseRun: GitHubWorkflowRun = {
  id: 42,
  workflowId: 7,
  runNumber: 9,
  runAttempt: 1,
  headSha: 'abc1234567890',
  headBranch: 'feature',
  event: 'push',
  status: 'queued',
  conclusion: null,
  htmlUrl: 'https://github.com/acme/repo/actions/runs/42',
}

describe('GitHub Actions Capability Pack', () => {
  it('keeps the default Effect registry empty and registers only explicit generic capabilities', async () => {
    const catalog = createDefaultGraphRuntimeCatalog()
    expect(catalog.effects.manifests()).toEqual([])

    const pack = createGitHubActionsCapabilityPack({ client: fakeClient() })
    catalog.packs.registerManifest(pack.manifest)
    await pack.register(catalog)
    catalog.packs.registerScenarios(pack.manifest, pack.scenarios ?? [])

    expect(catalog.effects.manifests().map(item => `${item.id}@${item.version}`)).toEqual([
      GITHUB_ACTIONS_RESOLVE_RUN_EFFECT,
      GITHUB_ACTIONS_WATCH_RUN_EFFECT,
    ])
    expect(catalog.packs.scenarios()[0]).toMatchObject({
      id: 'github-actions-remote-job',
      suggestedCapabilities: [GITHUB_ACTIONS_RESOLVE_RUN_EFFECT, GITHUB_ACTIONS_WATCH_RUN_EFFECT],
    })
  })

  it('lets a frozen graph bind declared Effect output fields into the next Effect', async () => {
    const catalog = createDefaultGraphRuntimeCatalog()
    const pack = createGitHubActionsCapabilityPack({ client: fakeClient(), integrity: 'test:github-actions-pack-v1' })
    catalog.packs.registerManifest(pack.manifest)
    await pack.register(catalog)
    catalog.packs.registerScenarios(pack.manifest, pack.scenarios ?? [])

    const frozen = freezeLoopGraph({
      schemaVersion: 'graph-2.0',
      id: 'github_actions_chain',
      version: 1,
      goal: 'Resolve and observe one exact workflow run.',
      state: {},
      lanes: {},
      capabilityPacks: [catalog.packs.require(pack.manifest)],
      nodes: {
        resolve: {
          type: 'effect',
          effect: GITHUB_ACTIONS_RESOLVE_RUN_EFFECT,
          timeoutMs: 300_000,
          inputs: {
            repository: { literal: 'acme/repo' },
            workflow: { literal: 'ci.yml' },
            headSha: { literal: baseRun.headSha },
          },
        },
        watch: {
          type: 'effect',
          effect: GITHUB_ACTIONS_WATCH_RUN_EFFECT,
          timeoutMs: 3_600_000,
          inputs: {},
        },
        done: { type: 'terminal', status: 'done' },
        failed: { type: 'terminal', status: 'failed' },
      },
      transitions: [
        {
          id: 'resolved',
          from: 'resolve',
          to: {
            node: 'watch',
            inputs: {
              repository: { literal: 'acme/repo' },
              runId: { ref: '$output.id' },
              expectedHeadSha: { ref: '$output.headSha' },
            },
          },
        },
        { id: 'resolve_failed', from: 'resolve', on: 'failure', to: 'failed' },
        { id: 'watched', from: 'watch', to: 'done' },
        { id: 'watch_failed', from: 'watch', on: 'failure', to: 'failed' },
      ],
      entrypoints: [{ id: 'start', node: 'resolve' }],
      limits: { maxTotalActivations: 8, maxLiveActivations: 2, maxWallTimeMs: 4_000_000 },
      concurrency: { maxActivations: 1, maxPerNode: 1, stateConsistency: 'commit_latest' },
    }, catalog, 1)

    expect(frozen.capabilityLock.effects.map(item => `${item.id}@${item.version}`)).toEqual([
      GITHUB_ACTIONS_RESOLVE_RUN_EFFECT,
      GITHUB_ACTIONS_WATCH_RUN_EFFECT,
    ])
  })

  it('resolves an exact workflow/head SHA only after it appears', async () => {
    let runs: GitHubWorkflowRun[] = []
    const client = fakeClient({ listWorkflowRuns: async () => runs })
    const provider = createGitHubActionsResolveRunProvider(client)
    const receipt = await provider.submit({
      repository: 'acme/repo',
      workflow: 'ci.yml',
      headSha: baseRun.headSha,
      branch: 'feature',
      event: 'push',
    }, 'resolve-1')

    await expect(provider.inspect!(receipt)).resolves.toEqual({ status: 'pending' })
    runs = [baseRun]
    await expect(provider.inspect!(receipt)).resolves.toMatchObject({
      status: 'succeeded',
      output: {
        schemaVersion: 'github-actions-run-1.0',
        id: 42,
        headSha: baseRun.headSha,
        status: 'queued',
        conclusion: null,
      },
    })
  })

  it('fails closed on ambiguous runs unless an explicit selection policy is supplied', async () => {
    const newer = { ...baseRun, id: 43 }
    const client = fakeClient({ listWorkflowRuns: async () => [newer, baseRun] })
    const provider = createGitHubActionsResolveRunProvider(client)

    const unique = await provider.submit({
      repository: 'acme/repo', workflow: 'ci.yml', headSha: baseRun.headSha,
    }, 'unique')
    await expect(provider.inspect!(unique)).resolves.toEqual({
      status: 'failed',
      error: 'workflow run identity is ambiguous; matched run IDs: 42, 43',
    })

    const newest = await provider.submit({
      repository: 'acme/repo', workflow: 'ci.yml', headSha: baseRun.headSha, selection: 'newest',
    }, 'newest')
    await expect(provider.inspect!(newest)).resolves.toMatchObject({
      status: 'succeeded',
      output: { id: 43 },
    })
  })

  it('fails closed when the API returns a run outside the requested SHA/branch identity', async () => {
    const client = fakeClient({
      listWorkflowRuns: async () => [{ ...baseRun, headSha: 'wrong-sha' }],
    })
    const provider = createGitHubActionsResolveRunProvider(client)
    const receipt = await provider.submit({
      repository: 'acme/repo',
      workflow: 'ci.yml',
      headSha: baseRun.headSha,
      branch: 'feature',
    }, 'identity')
    await expect(provider.inspect!(receipt)).resolves.toEqual({
      status: 'failed',
      error: 'GitHub Actions API returned run(s) outside the requested identity: 42',
    })
  })

  it('watches one exact run ID and returns failure conclusion as raw data', async () => {
    let run = baseRun
    const client = fakeClient({ getWorkflowRun: async () => run })
    const provider = createGitHubActionsWatchRunProvider(client)
    const receipt = await provider.submit({
      repository: 'acme/repo',
      runId: 42,
      expectedHeadSha: baseRun.headSha,
      expectedWorkflowId: 7,
    }, 'watch-42')

    await expect(provider.inspect!(receipt)).resolves.toEqual({ status: 'pending' })
    run = { ...baseRun, status: 'completed', conclusion: 'failure', runAttempt: 2 }
    await expect(provider.inspect!(receipt)).resolves.toMatchObject({
      status: 'succeeded',
      output: { id: 42, status: 'completed', conclusion: 'failure', runAttempt: 2 },
    })
  })

  it('rejects provenance mismatch and treats only retryable API errors as pending', async () => {
    const mismatch = createGitHubActionsWatchRunProvider(fakeClient())
    const receipt = await mismatch.submit({
      repository: 'acme/repo', runId: 42, expectedHeadSha: 'different-sha',
    }, 'watch-mismatch')
    await expect(mismatch.inspect!(receipt)).resolves.toMatchObject({
      status: 'failed',
      error: expect.stringContaining('head SHA mismatch'),
    })

    const retryable = createGitHubActionsWatchRunProvider(fakeClient({
      getWorkflowRun: async () => { throw new GitHubActionsApiError('rate limited', 429, true) },
    }))
    await expect(retryable.inspect!(await retryable.submit({
      repository: 'acme/repo', runId: 42,
    }, 'retry'))).resolves.toEqual({ status: 'pending' })

    const fatal = createGitHubActionsWatchRunProvider(fakeClient({
      getWorkflowRun: async () => { throw new GitHubActionsApiError('forbidden', 403, false) },
    }))
    await expect(fatal.inspect!(await fatal.submit({
      repository: 'acme/repo', runId: 42,
    }, 'fatal'))).resolves.toEqual({ status: 'failed', error: 'forbidden' })
  })
})

describe('GitHub Actions REST client', () => {
  it('uses exact head_sha filters, versioned headers, and refuses token-forwarding redirects', async () => {
    const request = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({
      total_count: 1,
      workflow_runs: [{
        id: 42,
        workflow_id: 7,
        run_number: 9,
        run_attempt: 1,
        head_sha: baseRun.headSha,
        head_branch: 'feature',
        event: 'push',
        status: 'queued',
        conclusion: null,
        html_url: baseRun.htmlUrl,
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const client = createGitHubRestActionsClient({
      token: 'secret',
      fetch: request as typeof fetch,
    })

    await expect(client.listWorkflowRuns({
      repository: 'acme/repo',
      workflow: 'ci.yml',
      headSha: baseRun.headSha,
      branch: 'feature',
      event: 'push',
    })).resolves.toMatchObject([{ id: 42, headSha: baseRun.headSha }])

    const [url, init] = request.mock.calls[0]!
    const parsed = new URL(String(url))
    expect(parsed.pathname).toBe('/repos/acme/repo/actions/workflows/ci.yml/runs')
    expect(parsed.searchParams.get('head_sha')).toBe(baseRun.headSha)
    expect(parsed.searchParams.get('branch')).toBe('feature')
    expect(parsed.searchParams.get('event')).toBe('push')
    expect(init?.redirect).toBe('error')
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer secret')
    expect(new Headers(init?.headers).get('x-github-api-version')).toBe('2026-03-10')
  })

  it('classifies rate limits/server failures as retryable and malformed success payloads as fatal', async () => {
    const limited = createGitHubRestActionsClient({
      fetch: (async () => new Response('slow down', {
        status: 403,
        headers: { 'x-ratelimit-remaining': '0' },
      })) as typeof fetch,
    })
    await expect(limited.getWorkflowRun('acme/repo', 42)).rejects.toMatchObject({
      status: 403,
      retryable: true,
    })

    const malformed = createGitHubRestActionsClient({
      fetch: (async () => new Response(JSON.stringify({ id: 42 }), { status: 200 })) as typeof fetch,
    })
    await expect(malformed.getWorkflowRun('acme/repo', 42)).rejects.toMatchObject({
      status: 200,
      retryable: false,
    })
  })
})

function fakeClient(overrides: Partial<GitHubActionsClient> = {}): GitHubActionsClient {
  return {
    async listWorkflowRuns() { return [baseRun] },
    async getWorkflowRun() { return baseRun },
    ...overrides,
  }
}
