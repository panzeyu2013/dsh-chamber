/**
 * Canonical registry-kind ↔ chamber source-id mapping.
 *
 * Registry/status IPC keys stay raw (`id`); every browser-facing N-ctx and
 * reverse-proxy key is `<kind>-<id>`. Keeping the conversion in one pure
 * module prevents an SSH fallback from silently routing a gateway instance
 * through `/api/i/ssh-*`.
 */

import type { SshInstanceSpec, TransportKind } from './global.d.ts'

const SOURCE_PREFIXES = ['ssh-', 'gateway-'] as const
const RAW_INSTANCE_ID_PATTERN = /^(?!local$)[a-zA-Z0-9_-]{1,64}$/

export function sourceIdForTransport(kind: TransportKind, rawId: string): string {
  if (kind !== 'ssh' && kind !== 'gateway') {
    throw new Error(`invalid transport kind ${JSON.stringify(kind)}`)
  }
  if (!RAW_INSTANCE_ID_PATTERN.test(rawId)) {
    throw new Error(`invalid transport instance id ${JSON.stringify(rawId)}`)
  }
  return `${kind}-${rawId}`
}

export function sourceIdForInstance(instance: Pick<SshInstanceSpec, 'id' | 'kind'>): string {
  return sourceIdForTransport(instance.kind, instance.id)
}

/** Raw registry id from a remote source id; null for local/malformed ids. */
export function rawInstanceIdFromSourceId(sourceId: string): string | null {
  for (const prefix of SOURCE_PREFIXES) {
    if (sourceId.startsWith(prefix)) {
      const rawId = sourceId.slice(prefix.length)
      return RAW_INSTANCE_ID_PATTERN.test(rawId) ? rawId : null
    }
  }
  return null
}

/** Resolve a raw deep-link/IPC id through the live registry kind. */
export function sourceIdForRawInstance(rawId: string, instances: readonly Pick<SshInstanceSpec, 'id' | 'kind'>[]): string | null {
  if (rawId === 'local') return 'local'
  const instance = instances.find(candidate => candidate.id === rawId)
  return instance === undefined ? null : sourceIdForInstance(instance)
}

export function isChamberSourceId(sourceId: string | undefined): boolean {
  return sourceId === undefined
    || sourceId === 'local'
    || rawInstanceIdFromSourceId(sourceId) !== null
}

export function instanceBasePath(sourceId: string): string {
  // `undefined` is valid only for the chamber boot knob (the vendor default
  // boot). It is never a routable instance id; keep this runtime guard even
  // though TypeScript callers already pass `string`.
  if (typeof sourceId !== 'string' || !isChamberSourceId(sourceId)) {
    throw new Error(`invalid chamber source id ${JSON.stringify(sourceId)}`)
  }
  return `/api/i/${sourceId}`
}
