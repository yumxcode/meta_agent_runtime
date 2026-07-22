import { createHmac, timingSafeEqual } from 'node:crypto'
import type { GraphExternalEventDeliveryResult, GraphExternalEventInput, JsonValue } from '../graph/spec/GraphTypes.js'
import { isJsonValue } from '../graph/runtime/GraphJson.js'

export interface WebhookIngressRequest {
  method?: string
  headers: Readonly<Record<string, string | string[] | undefined>>
  body: string | Uint8Array
}

export interface WebhookIngressResponse {
  status: number
  body: {
    accepted: boolean
    duplicate?: boolean
    resumed?: number
    eventId?: string
    error?: string
  }
}

export type WebhookEventMapper = (input: {
  headers: Readonly<Record<string, string>>
  payload: JsonValue
}) => GraphExternalEventInput

export interface HmacWebhookIngressOptions {
  secret: string
  deliverEvent(event: GraphExternalEventInput): Promise<GraphExternalEventDeliveryResult>
  mapEvent: WebhookEventMapper
  signatureHeader?: string
  signaturePrefix?: string
  algorithm?: 'sha256' | 'sha1'
  maxPayloadBytes?: number
}

/** Framework-neutral HMAC webhook ingress. Authentication and size checks run before JSON parsing. */
export function createHmacWebhookIngress(options: HmacWebhookIngressOptions): {
  handle(request: WebhookIngressRequest): Promise<WebhookIngressResponse>
} {
  if (!options.secret) throw new Error('webhook ingress secret must not be empty')
  const algorithm = options.algorithm ?? 'sha256'
  const signatureHeader = (options.signatureHeader ?? 'x-hub-signature-256').toLowerCase()
  const signaturePrefix = options.signaturePrefix ?? `${algorithm}=`
  const maxPayloadBytes = options.maxPayloadBytes ?? 1024 * 1024
  return {
    async handle(request): Promise<WebhookIngressResponse> {
      if ((request.method ?? 'POST').toUpperCase() !== 'POST') return rejected(405, 'method must be POST')
      const bytes = typeof request.body === 'string' ? Buffer.from(request.body, 'utf8') : Buffer.from(request.body)
      if (bytes.byteLength > maxPayloadBytes) return rejected(413, `payload exceeds ${maxPayloadBytes} bytes`)
      const headers = normalizeHeaders(request.headers)
      const supplied = headers[signatureHeader]
      if (!supplied || !verifyHmac(bytes, supplied, options.secret, algorithm, signaturePrefix)) {
        return rejected(401, 'invalid webhook signature')
      }
      let payload: unknown
      try { payload = JSON.parse(bytes.toString('utf8')) } catch { return rejected(400, 'payload is not valid JSON') }
      if (!isJsonValue(payload)) return rejected(400, 'payload is not a JSON value')
      let event: GraphExternalEventInput
      try { event = options.mapEvent({ headers, payload }) } catch (error) { return rejected(422, message(error)) }
      try {
        const delivered = await options.deliverEvent(event)
        return {
          status: delivered.duplicate ? 200 : 202,
          body: {
            accepted: true,
            duplicate: delivered.duplicate,
            resumed: delivered.resumed,
            eventId: delivered.event.id,
          },
        }
      } catch (error) {
        // A non-2xx response tells webhook providers to retry the same deliveryId.
        return rejected(503, `event delivery failed: ${message(error)}`)
      }
    },
  }
}

export function createGitHubWebhookIngress(options: {
  secret: string
  deliverEvent(event: GraphExternalEventInput): Promise<GraphExternalEventDeliveryResult>
  maxPayloadBytes?: number
}): ReturnType<typeof createHmacWebhookIngress> {
  return createHmacWebhookIngress({
    secret: options.secret,
    deliverEvent: options.deliverEvent,
    maxPayloadBytes: options.maxPayloadBytes,
    signatureHeader: 'x-hub-signature-256',
    signaturePrefix: 'sha256=',
    algorithm: 'sha256',
    mapEvent: ({ headers, payload }) => {
      const deliveryId = headers['x-github-delivery']
      const githubEvent = headers['x-github-event']
      if (!deliveryId) throw new Error('missing x-github-delivery header')
      if (!githubEvent) throw new Error('missing x-github-event header')
      return {
        name: `github.${githubEvent}`,
        source: 'github',
        deliveryId,
        correlation: githubCorrelation(payload),
        payload,
      }
    },
  })
}

function githubCorrelation(payload: JsonValue): JsonValue | undefined {
  if (!isObject(payload)) return undefined
  const repository = isObject(payload.repository) && typeof payload.repository.full_name === 'string'
    ? payload.repository.full_name
    : undefined
  const number = typeof payload.number === 'number' && Number.isFinite(payload.number) ? payload.number : undefined
  if (repository !== undefined && number !== undefined) return { repository, number }
  if (repository !== undefined) return repository
  return undefined
}

function normalizeHeaders(headers: WebhookIngressRequest['headers']): Record<string, string> {
  const normalized: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === 'string') normalized[name.toLowerCase()] = value
    else if (Array.isArray(value) && value.length) normalized[name.toLowerCase()] = value[0]!
  }
  return normalized
}

function verifyHmac(body: Buffer, supplied: string, secret: string, algorithm: 'sha256' | 'sha1', prefix: string): boolean {
  const expected = `${prefix}${createHmac(algorithm, secret).update(body).digest('hex')}`
  const left = Buffer.from(supplied, 'utf8')
  const right = Buffer.from(expected, 'utf8')
  return left.length === right.length && timingSafeEqual(left, right)
}

function rejected(status: number, error: string): WebhookIngressResponse {
  return { status, body: { accepted: false, error } }
}

function isObject(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
