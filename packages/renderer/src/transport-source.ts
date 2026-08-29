/**
 * Canonical registry-kind ↔ chamber source-id mapping.
 *
 * Registry/status IPC keys stay raw (`id`); every browser-facing N-ctx and
 * reverse-proxy key is `<kind>-<id>`. v2 (design 17 §2.1): the canonical
 * source ids are `dsh-<id>` / `gateway-<id>`; `ssh-<id>` remains accepted as
 * the LEGACY spelling of the dsh kind (deep links and older persisted source
 * ids keep working, design 17 §2.2). Keeping the conversion in one pure
 * module prevents a legacy fallback from silently routing a gateway instance
 * through `/api/i/ssh-*`.
 */

import type { TransportKind } from './global.d.ts'

/** Canonical source-id prefixes (design 17 §2.1): `dsh-<id>` / `gateway-<id>`. */
const SOURCE_PREFIXES = ['dsh-', 'gateway-'] as const

/** `ssh-<id>` — the legacy spelling of the dsh kind (design 17 §2.2): parsed
 *  for deep links and older persisted source ids, never produced for v2
 *  specs. */
const LEGACY_SSH_PREFIX = 'ssh-'

/** v2 target kinds (design 17 §2.1), mirroring the desktop TARGET_KINDS. */
const TARGET_KINDS = ['dsh', 'gateway'] as const

/** Legacy source-id input remains parseable even though normalized registry
 * specs crossing IPC now use TransportKind (`dsh | gateway`) exclusively. */
type LegacyTransportKind = 'ssh'
type KindedInstance = { id: string; kind: TransportKind | LegacyTransportKind }

const RAW_INSTANCE_ID_PATTERN = /^(?!local$)[a-zA-Z0-9_-]{1,64}$/

export function sourceIdForTransport(kind: TransportKind | LegacyTransportKind, rawId: string): string {
  // v2 (design 17 §2.1): the kind must be a TARGET_KINDS member. The legacy
  // 'ssh' spelling — accepted only for legacy deep-link/source-id callers —
  // is the one carve-out: it
  // produces the legacy `ssh-<id>` source id, which the control plane still
  // routes as a dsh-kind alias (design 17 §2.2). Anything else is refused
  // loudly so a future unknown kind can never masquerade as a routable id.
  if (kind !== 'ssh' && !(TARGET_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`invalid transport kind ${JSON.stringify(kind)}`)
  }
  if (!RAW_INSTANCE_ID_PATTERN.test(rawId)) {
    throw new Error(`invalid transport instance id ${JSON.stringify(rawId)}`)
  }
  return `${kind}-${rawId}`
}

export function sourceIdForInstance(instance: KindedInstance): string {
  return sourceIdForTransport(instance.kind, instance.id)
}

/** Raw registry id from a remote source id; null for local/malformed ids.
 *  Recognizes the canonical `dsh-`/`gateway-` prefixes AND the legacy `ssh-`
 *  spelling (design 17 §2.2 — deep links keep working). */
export function rawInstanceIdFromSourceId(sourceId: string): string | null {
  for (const prefix of SOURCE_PREFIXES) {
    if (sourceId.startsWith(prefix)) {
      const rawId = sourceId.slice(prefix.length)
      return RAW_INSTANCE_ID_PATTERN.test(rawId) ? rawId : null
    }
  }
  if (sourceId.startsWith(LEGACY_SSH_PREFIX)) {
    const rawId = sourceId.slice(LEGACY_SSH_PREFIX.length)
    return RAW_INSTANCE_ID_PATTERN.test(rawId) ? rawId : null
  }
  return null
}

/** Resolve a raw deep-link/IPC id through the live registry kind. */
export function sourceIdForRawInstance(rawId: string, instances: readonly KindedInstance[]): string | null {
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
