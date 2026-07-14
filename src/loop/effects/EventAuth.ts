import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'crypto'
import { chmod, mkdir } from 'fs/promises'
import { join } from 'path'
import { metaAgentPath } from '../../infra/metaAgentHome.js'
import { atomicWriteJson, readJsonFile, withFileLock } from '../../infra/persist/index.js'
import { hashArtifactContent } from '../artifacts/ArtifactProtocol.js'
import type { LoopInstance } from '../instance/InstanceStore.js'
import type { InstancePaths } from '../types.js'
import { EffectLedger } from './EffectLedger.js'

interface EventAuthSecret {
  schemaVersion: '1.0'
  keyId: string
  secret: string
  createdAt: number
}

export interface AuthenticatedEffectEvent {
  schemaVersion: '1.0'
  keyId: string
  workspaceId: string
  instanceId: string
  issuedAt: number
  expiresAt: number
  nonce: string
  /** Identity asserted by the trusted host-side signer. */
  principal: string
  roles: string[]
  effectKey: string
  verdict: string
  data?: unknown
  signature: string
}

export async function ensureEventAuthSecret(paths: InstancePaths): Promise<void> {
  const secretPath = eventAuthSecretPath(paths)
  await mkdir(metaAgentPath('loop', 'event-auth'), { recursive: true, mode: 0o700 })
  await chmod(metaAgentPath('loop', 'event-auth'), 0o700).catch(() => undefined)
  await withFileLock(secretPath, async () => {
    if (await readJsonFile<EventAuthSecret>(secretPath)) return
    await atomicWriteJson(secretPath, {
      schemaVersion: '1.0', keyId: `event-${randomUUID()}`,
      secret: randomBytes(32).toString('base64url'), createdAt: Date.now(),
    } satisfies EventAuthSecret)
    await chmod(secretPath, 0o600).catch(() => undefined)
  })
}

export async function signEffectEvent(
  instance: LoopInstance,
  input: {
    principal: string; roles: readonly string[]; effectKey: string; verdict: string;
    data?: unknown; issuedAt?: number; expiresAt?: number; nonce?: string
  },
): Promise<AuthenticatedEffectEvent> {
  const principal = input.principal.trim()
  const roles = [...new Set(input.roles.map(role => role.trim()).filter(Boolean))].sort()
  const nonce = input.nonce ?? randomUUID()
  const effectKey = input.effectKey.trim()
  const verdict = input.verdict.trim()
  if (!principal || principal.length > 256) throw new Error('authenticated effect event principal must be 1..256 characters')
  if (roles.length === 0 || roles.length > 32 || roles.some(role => role.length > 128)) {
    throw new Error('authenticated effect event requires 1..32 bounded roles')
  }
  if (!effectKey || effectKey.length > 512) throw new Error('authenticated effect event effectKey must be 1..512 characters')
  if (!verdict || verdict.length > 128) throw new Error('authenticated effect event verdict must be 1..128 characters')
  if (!safeNonce(nonce)) throw new Error('authenticated effect event nonce is invalid')
  const issuedAt = input.issuedAt ?? Date.now()
  if (!Number.isFinite(issuedAt)) throw new Error('authenticated effect event issuedAt must be finite')
  const effect = await new EffectLedger(instance.ledger, instance.paths).get(effectKey)
  const expiresAt = input.expiresAt ?? effect?.deadlineAt ?? issuedAt + 10 * 60_000
  if (!Number.isFinite(expiresAt) || expiresAt <= issuedAt) {
    throw new Error('authenticated effect event expiresAt must be finite and after issuedAt')
  }
  await ensureEventAuthSecret(instance.paths)
  const secret = await requireSecret(instance.paths)
  const event = {
    schemaVersion: '1.0' as const, keyId: secret.keyId,
    workspaceId: requireWorkspaceId(instance), instanceId: instance.record.instanceId,
    issuedAt, expiresAt, nonce,
    principal, roles,
    effectKey, verdict,
    ...(input.data === undefined ? {} : { data: input.data }),
  }
  return { ...event, signature: signature(secret.secret, event) }
}

/** Trusted host entry point: sign and atomically enqueue an authenticated event. */
export async function writeAuthenticatedEffectEvent(
  instance: LoopInstance,
  input: Parameters<typeof signEffectEvent>[1],
): Promise<{ event: AuthenticatedEffectEvent; path: string }> {
  const event = await signEffectEvent(instance, input)
  await mkdir(instance.paths.eventsDir, { recursive: true })
  const path = join(instance.paths.eventsDir, `authenticated-${event.nonce}.json`)
  await atomicWriteJson(path, event)
  return { event, path }
}

export async function verifyEffectEvent(
  instance: LoopInstance,
  value: unknown,
  now = Date.now(),
): Promise<{ ok: true; event: AuthenticatedEffectEvent } | { ok: false; reason: string }> {
  if (!value || typeof value !== 'object') return { ok: false, reason: 'event must be an object' }
  const event = value as Partial<AuthenticatedEffectEvent>
  if (event.schemaVersion !== '1.0' || typeof event.keyId !== 'string' ||
      typeof event.workspaceId !== 'string' || typeof event.instanceId !== 'string' ||
      typeof event.issuedAt !== 'number' || typeof event.expiresAt !== 'number' ||
      typeof event.nonce !== 'string' || !safeNonce(event.nonce) ||
      typeof event.principal !== 'string' || !event.principal.trim() || event.principal.length > 256 ||
      !Array.isArray(event.roles) || event.roles.length === 0 || event.roles.length > 32 ||
      !event.roles.every(role => typeof role === 'string' && role.trim() && role.length <= 128) ||
      typeof event.effectKey !== 'string' || !event.effectKey || event.effectKey.length > 512 ||
      typeof event.verdict !== 'string' || !event.verdict || event.verdict.length > 128 ||
      typeof event.signature !== 'string') return { ok: false, reason: 'invalid authenticated event schema' }
  const workspaceId = requireWorkspaceId(instance)
  if (event.workspaceId !== workspaceId || event.instanceId !== instance.record.instanceId) {
    return { ok: false, reason: 'authenticated event workspace/instance scope mismatch' }
  }
  if (event.issuedAt > now + 5 * 60_000) return { ok: false, reason: 'event issuedAt is too far in the future' }
  if (now > event.expiresAt) return { ok: false, reason: 'authenticated event has expired' }
  let secret: EventAuthSecret
  try {
    secret = await requireSecret(instance.paths)
  } catch {
    return { ok: false, reason: 'instance has no authenticated-event signing key' }
  }
  if (event.keyId !== secret.keyId) return { ok: false, reason: 'unknown event keyId' }
  const expected = signature(secret.secret, {
    schemaVersion: event.schemaVersion, keyId: event.keyId,
    workspaceId: event.workspaceId, instanceId: event.instanceId,
    issuedAt: event.issuedAt, expiresAt: event.expiresAt,
    nonce: event.nonce, principal: event.principal, roles: event.roles,
    effectKey: event.effectKey, verdict: event.verdict,
    ...(event.data === undefined ? {} : { data: event.data }),
  })
  const actualBytes = Buffer.from(event.signature)
  const expectedBytes = Buffer.from(expected)
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
    return { ok: false, reason: 'event signature mismatch' }
  }
  return { ok: true, event: event as AuthenticatedEffectEvent }
}

interface EventNonceFile {
  schemaVersion: '1.0'
  /** nonce → expiresAt. Entries are pruned once expired (bounded growth). */
  nonces: Record<string, number>
}

function eventNoncePath(paths: InstancePaths): string {
  // Lives in ledgerDir: kernel-only territory, denied to the worker sandbox.
  return join(paths.ledgerDir, 'event-nonces.json')
}

/**
 * Consume an authenticated event's nonce exactly once. Returns false when the
 * nonce was already consumed (replayed signed event). Expired entries are
 * pruned on each write, so the file stays bounded by the events in flight
 * inside their expiry windows.
 */
export async function consumeEventNonce(
  instance: LoopInstance,
  event: Pick<AuthenticatedEffectEvent, 'nonce' | 'expiresAt'>,
  now = Date.now(),
): Promise<boolean> {
  const path = eventNoncePath(instance.paths)
  return withFileLock(path, async () => {
    const file = await readJsonFile<EventNonceFile>(path)
    const nonces: Record<string, number> = {}
    for (const [nonce, expiresAt] of Object.entries(file?.nonces ?? {})) {
      if (typeof expiresAt === 'number' && expiresAt > now) nonces[nonce] = expiresAt
    }
    if (event.nonce in nonces) return false
    nonces[event.nonce] = event.expiresAt
    await atomicWriteJson(path, { schemaVersion: '1.0', nonces } satisfies EventNonceFile)
    return true
  })
}

async function requireSecret(paths: InstancePaths): Promise<EventAuthSecret> {
  const secret = await readJsonFile<EventAuthSecret>(eventAuthSecretPath(paths))
  if (!secret || secret.schemaVersion !== '1.0' || !secret.keyId || !secret.secret) {
    throw new Error(`instance is missing a valid authenticated-event secret`)
  }
  return secret
}

function signature(secret: string, event: Omit<AuthenticatedEffectEvent, 'signature'>): string {
  const body = [
    event.schemaVersion, event.keyId, event.workspaceId, event.instanceId,
    String(event.issuedAt), event.nonce,
    String(event.expiresAt), event.principal, JSON.stringify(event.roles), event.effectKey, event.verdict,
    hashArtifactContent(event.data ?? null),
  ].join('\n')
  return createHmac('sha256', secret).update(body).digest('base64url')
}

function requireWorkspaceId(instance: LoopInstance): string {
  if (!instance.record.workspaceId) throw new Error(`instance ${instance.record.instanceId} has no workspace identity`)
  return instance.record.workspaceId
}

/** Secret deliberately lives outside the worker-visible instance workspace. */
export function eventAuthSecretPath(paths: InstancePaths): string {
  const instanceScope = createHash('sha256').update(paths.root).digest('hex')
  return metaAgentPath('loop', 'event-auth', `${instanceScope}.json`)
}

function safeNonce(value: string): boolean {
  return /^[A-Za-z0-9_-]{8,128}$/.test(value)
}
