/**
 * Canonical registry-kind ↔ chamber source-id mapping.
 *
 * Registry/status IPC keys stay raw (`id`); every browser-facing N-ctx and reverse-proxy key is
 * `<kind>-<id>`: canonical `dsh-<id>` / `gateway-<id>`, with `ssh-<id>` accepted as the LEGACY
 * spelling of the dsh kind (deep links and older persisted source ids keep working). Keeping the
 * conversion in one pure module prevents a legacy fallback from silently routing a gateway
 * instance through `/api/i/ssh-*`.
 */

import { linkReady } from '@dsh-chamber/dsh-chamber-client-core'
import type { HealthResponse } from './api.ts'
import type { SshInstanceSpec, SshStatusProjection, TransportKind } from './global.d.ts'

/** Canonical source-id prefixes: `dsh-<id>` / `gateway-<id>`. */
const SOURCE_PREFIXES = ['dsh-', 'gateway-'] as const

/** `ssh-<id>` — legacy spelling of the dsh kind: parsed for deep links and older persisted ids, never produced for v2 specs. */
const LEGACY_SSH_PREFIX = 'ssh-'

/** Target kinds, mirroring the desktop TARGET_KINDS. */
const TARGET_KINDS = ['dsh', 'gateway'] as const

/** Legacy source-id input remains parseable even though normalized IPC specs use TransportKind exclusively. */
type LegacyTransportKind = 'ssh'
export type KindedInstance = { id: string; kind: TransportKind | LegacyTransportKind }

// Raw source-id grammar (dsh-<id>/gateway-<id>/ssh-<id>): the wire authority is desktop
// transport-provider.ts INSTANCE_ID_PATTERN (every provider validates through it);
// open-in capabilities.ts INSTANCE_ID mirrors the same bytes. Do not drift.
const RAW_INSTANCE_ID_PATTERN = /^(?!local$)[a-zA-Z0-9_-]{1,64}$/

export function sourceIdForTransport(kind: TransportKind | LegacyTransportKind, rawId: string): string {
  // The kind must be a TARGET_KINDS member; the legacy 'ssh' carve-out (legacy deep-link callers)
  // produces `ssh-<id>`, which the control plane still routes as a dsh-kind alias. Anything else is
  // refused loudly so a future unknown kind can never masquerade as a routable id.
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

/** Raw registry id from a remote source id; null for local/malformed. Recognizes the canonical
 *  `dsh-`/`gateway-` prefixes AND the legacy `ssh-` spelling (deep links keep working). */
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
  // `undefined` is valid only for the chamber boot knob (vendor default boot), never a routable id;
  // keep the runtime guard even though TypeScript callers already pass `string`.
  if (typeof sourceId !== 'string' || !isChamberSourceId(sourceId)) {
    throw new Error(`invalid chamber source id ${JSON.stringify(sourceId)}`)
  }
  return `/api/i/${sourceId}`
}

/** 本地托管 dsh 的可服务状态：`degraded` 仍在服务（design 02 §3.5），必须与
 *  control-plane 的 `isServiceableLocalState` 同表；`starting/restarting` 不可服务。 */
export function isServiceableLocalStatus(status: string | undefined): boolean {
  return status === 'ready' || status === 'degraded'
}

/** 实例可被聚合轮询：对齐反代契约——本地 `ready|degraded` 放行，其它状态显式 503；
 *  远程传输仍只认 `ready`（degraded 是重连相位，不是可服务事实）。 */
export function instanceConnected(
  kind: 'local' | TransportKind,
  health: HealthResponse | null,
  remoteStatus: Record<string, SshStatusProjection>,
  instanceId: string,
): boolean {
  if (kind === 'local') {
    return isServiceableLocalStatus(health?.dsh?.status)
  }
  const status = remoteStatus[instanceId]
  // A registry kind switch and its IPC pushes are separate messages: a briefly-stale READY
  // projection from the old provider is not proof the replacement provider is ready.
  return status?.kind === kind && status.phase === 'ready'
}

export interface StatusAcceptanceInput {
  /** Raw registry id (the status store key), never a chamber source id. */
  id: string
  projection: SshStatusProjection | null
  /** The rows installed AT WRITE TIME — never a snapshot captured before the await. */
  instances: readonly SshInstanceSpec[]
  /** The source id the writer captured before its await (its live/owner proof). Absent:
   *  the source id is resolved from the write-time row. */
  expectedSourceId?: string
  live: ReadonlySet<string>
  ownerHeld: boolean
}

/**
 * Mechanism acceptance for a transport status write (design 06 §4.8): a late projection may
 * only land on the row that is installed AT WRITE TIME. A projection from a replaced transport
 * mechanism (ssh↔http) carries the old mechanism, and comparing it with the current row is the
 * one discriminator the wire already offers. Same-mechanism reconnect churn has NO wire
 * discriminator — documented residual (未证实可达), not defended here by a new projection field.
 *
 * The owner/live proof stays the caller's (captured before the await): this function only
 * decides the write, it does not capture anything.
 */
export function statusWriteAccepted({
  id, projection, instances, expectedSourceId, live, ownerHeld,
}: StatusAcceptanceInput): boolean {
  if (projection === null || !ownerHeld) return false
  const row = instances.find(candidate => candidate.id === id)
  if (row === undefined) return false
  // Replaced mechanism: an old provider's READY is not proof for the replacement row.
  if (projection.transport !== row.transport) return false
  const sourceId = expectedSourceId ?? sourceIdForInstance(row)
  return sourceIdForTransport(projection.kind, id) === sourceId && live.has(sourceId)
}

/**
 * The ready / link-down / not-ready partition every aggregate decision gate consumes
 * (design 06 §4.8): a remote transport must first pass the kind+phase gate
 * (`instanceConnected`, which also rejects a stale old-provider READY after a kind switch)
 * and then `linkReady`. A ready link whose sub-state is down is PARKED — it is neither
 * refreshable nor "not connected": the not-connected reset prunes snapshots/runtime facts,
 * which a link blip must never do ("链路不可用 ≠ 断开"). `suspect` still forwards (design
 * 27 I3). Local has no transport link: the serving health table is its whole reading.
 */
export function partitionSourceReachability(
  health: HealthResponse | null,
  remoteStatus: Record<string, SshStatusProjection>,
  remoteInstances: readonly SshInstanceSpec[],
): { ready: string[]; linkDown: string[]; notReady: string[] } {
  const ready: string[] = []
  const linkDown: string[] = []
  const notReady: string[] = []
  if (isServiceableLocalStatus(health?.dsh?.status)) ready.push('local')
  else notReady.push('local')
  for (const instance of remoteInstances) {
    const sourceId = sourceIdForInstance(instance)
    if (!instanceConnected(instance.kind, health, remoteStatus, instance.id)) notReady.push(sourceId)
    else if (!linkReady(remoteStatus[instance.id])) linkDown.push(sourceId)
    else ready.push(sourceId)
  }
  return { ready, linkDown, notReady }
}
