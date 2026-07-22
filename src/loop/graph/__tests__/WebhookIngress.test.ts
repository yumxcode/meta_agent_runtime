import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createGitHubWebhookIngress, createHmacWebhookIngress, type GraphExternalEventInput } from '../../index.js'

describe('webhook ingress reference adapters', () => {
  it('authenticates and normalizes a GitHub delivery before calling the Kernel boundary', async () => {
    const secret = 'test-secret'
    const body = JSON.stringify({ number: 42, repository: { full_name: 'openai/example' }, action: 'closed' })
    const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
    let delivered: GraphExternalEventInput | undefined
    const ingress = createGitHubWebhookIngress({
      secret,
      async deliverEvent(event) {
        delivered = event
        return {
          event: { schemaVersion: 'graph-external-event-1.0', id: 'event-1', ...event, status: 'consumed', createdAt: 1 },
          resumed: 1,
          duplicate: false,
        }
      },
    })
    const response = await ingress.handle({
      method: 'POST', body,
      headers: {
        'x-hub-signature-256': signature,
        'x-github-delivery': 'delivery-1',
        'x-github-event': 'pull_request',
      },
    })
    expect(response.status).toBe(202)
    expect(response.body).toMatchObject({ accepted: true, resumed: 1, eventId: 'event-1' })
    expect(delivered).toMatchObject({
      name: 'github.pull_request', source: 'github', deliveryId: 'delivery-1',
      correlation: { repository: 'openai/example', number: 42 },
    })
  })

  it('rejects invalid signatures and oversized payloads before mapping/delivery', async () => {
    let deliveries = 0
    const ingress = createHmacWebhookIngress({
      secret: 'secret', maxPayloadBytes: 4,
      mapEvent: () => ({ name: 'never' }),
      async deliverEvent() { deliveries++; throw new Error('must not run') },
    })
    expect((await ingress.handle({ body: '{}', headers: { 'x-hub-signature-256': 'bad' } })).status).toBe(401)
    expect((await ingress.handle({ body: '12345', headers: { 'x-hub-signature-256': 'bad' } })).status).toBe(413)
    expect(deliveries).toBe(0)
  })

  it('returns retryable 503 when durable event delivery fails', async () => {
    const secret = 'secret'
    const body = '{}'
    const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
    const ingress = createHmacWebhookIngress({
      secret,
      mapEvent: () => ({ name: 'job.completed', source: 'test', deliveryId: 'one' }),
      async deliverEvent() { throw new Error('lock timeout') },
    })
    const response = await ingress.handle({ body, headers: { 'x-hub-signature-256': signature } })
    expect(response.status).toBe(503)
    expect(response.body.error).toContain('lock timeout')
  })
})
