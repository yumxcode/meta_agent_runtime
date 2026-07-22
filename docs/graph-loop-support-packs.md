# Graph Loop Support Packs

The support packs add evidence, external contracts, and read-only operations around `durable-graph-v2`. They do not change Graph ABI, Kernel tick/commit/wake semantics, instance schema, or journal events.

## Evidence Pack

`createGraphEvidenceScenarios()` returns three source GraphSpecs:

- `bounded-research`: raw-fact convergence routing and paused review;
- `continuous-operations`: event/timeout monitoring with only a live Activation cap;
- `long-training-supervision`: Effect submission, durable callback wait, and human review.

The fixtures use only existing Agent/Effect/Wait/Terminal primitives. Freeze them against the same runtime catalog used by the deployment.

`runGraphSoak(driver, options)` is a clock-driven harness. The driver can wrap a real `GraphKernel`, a scheduler runner, or a storage migration. Chaos rules support restart before/after a tick and intentionally skipped ticks without adding test hooks to Kernel.

```ts
const report = await runGraphSoak(driver, {
  steps: 50_000,
  startAt: 0,
  stepMs: 60_000,
  chaos: [{
    id: 'restart-at-100',
    action: 'restart-after-tick',
    when: context => context.phase === 'after' && context.step === 100,
  }],
  invariants: [context => {
    if (context.snapshot.liveActivations > 8) throw new Error('live set escaped its bound')
  }],
})
```

## External Contract Pack

### Effect Provider conformance

`runEffectProviderConformance` tests provider behavior through an externally-visible operation counter. Receipt equality alone is deliberately insufficient because an unsafe provider can return equal receipts after repeating a side effect.

```ts
const report = await runEffectProviderConformance(provider, {
  input: { job: 'training' },
  idempotencyKey: 'campaign-42',
  readSideEffectCount: () => externalSystem.operationCount(),
  settle: receipt => externalSystem.finish(receipt),
})
assertEffectProviderConformance(report)
```

The suite checks manifest intent, JSON receipts, same-key idempotency, distinct-key independence, and the optional inspect state machine. It does not modify `EffectProvider` or Effect execution semantics.

### Webhook ingress

`createHmacWebhookIngress` is framework-neutral. It checks method, payload size, and HMAC before parsing JSON, maps the request to `GraphExternalEventInput`, then calls the supplied durable `deliverEvent` boundary. Delivery failures return HTTP 503 so the source can retry with the same delivery ID.

`createGitHubWebhookIngress` is the reference mapping for GitHub headers and `github.<event>` names. Pull request/issue-like payloads use `{repository, number}` correlation when available.

`createGraphEventDelivery` is the public bridge from that ingress boundary to one Graph instance. It opens the frozen graph with the supplied Runtime catalog, records/consumes the event through `GraphKernel`, and writes an immediate `event` wake when work is resumed. Event and wake records live in separate durable stores, so a failure between them is repaired on source-scoped redelivery: a consumed event whose resumed Activation is still `ready` gets a replacement wake without a second event consumption.

```ts
const deliverEvent = createGraphEventDelivery({
  projectDir,
  instanceId: 'code-review-v1',
  // Pass catalog when the graph was frozen with external capability packs.
})
const ingress = createGitHubWebhookIngress({
  secret: process.env.GITHUB_WEBHOOK_SECRET!,
  deliverEvent,
})

// Register this route before app.use(express.json()).
app.post('/webhooks/github', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
  const response = await ingress.handle({
    method: req.method,
    headers: req.headers,
    body: req.body,
  })
  res.status(response.status).json(response.body)
})
```

Express routes must use `express.raw({ type: 'application/json' })` before any JSON middleware because HMAC covers the original bytes. The adapter does not start an HTTP server. Applications remain responsible for TLS, network rate limits, secret rotation, choosing the target `instanceId`, and returning the adapter response through their web framework.

## Operator Pack

The following commands preserve their existing human output and add versioned JSON with `--json`:

```bash
meta-agent loop list --json
meta-agent loop inspect <instanceId> --json
meta-agent loop timeline <instanceId> --json
meta-agent loop disk <instanceId> --json
meta-agent loop events <instanceId> --status pending --json
```

Schemas are `loop-list-1.0`, `loop-inspect-1.0`, `loop-timeline-1.0`, `loop-disk-1.0`, and `loop-events-1.0`. `events` is read-only: it neither consumes nor replays inbox records.

`buildLoopReliabilityProfile` derives a facts-only `loop-reliability-profile-1.0` document from a frozen graph plus optional deployment evidence. Unknown ingress, Effect conformance, durability, or retention remains explicit; there is no aggregate production-readiness score.

`diagnoseLoop` derives operator cards from instance/state/activation/event/wake snapshots. It does not pause, resume, consume events, schedule wakes, or write journal records.

`loop disk --json` reports current checkpoint bytes, projection/intent/event file counts, loose journal bytes, and average bytes per loose journal record. These are point-in-time capacity facts; growth rate requires collecting multiple samples externally.
