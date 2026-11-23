/**
 * ActiveRegistration —— sidecar 侧活动代理注册的唯一提交入口（C 切片）。
 *
 * 一次提交 = 两阶段：先按 manager 的 live 事实做校验（ready / transportGen /
 * 墓碑），并对 gateway 目标做认证 fail-closed 判定；再调
 * plane.registerInstanceTransport（未抛 = 代理已接受——其全部校验都在首个变更
 * 之前，见 instance-proxy），最后**一次**发布记录。记录是代理拨号五元组
 * （url / socketPath / authority / spkiPin / headers）的唯一真相：续签、复验、
 * 手动同步都只读它，不再各自现读 live 事实（消除跨代混拼与镜像漂移）。
 *
 * 不变量：同 targetKey = health-only（零次重注册——重注册会撤销全部在途
 * HTTP/WS）；撤销幂等并留墓碑，拒绝同/更旧 transportGen 的迟到 register；记录
 * 持有认证头但只经 commit（写面）与 snapshotForSync（读面）暴露。
 *
 * 纯 Node 叶：无 electron、无 control-plane 实现 import（PlaneHandle 只作类型），
 * 管理器/凭据/会话/日志全部注入。
 */
import type { PlaneHandle } from '@dsh-chamber/control-plane'
import { describeError } from './describe-error.ts'
import {
  gatewayRegistrationAuthHeaders, gatewaySessionScopeForConnection,
  type GatewayRegistrationAuthProof, type GatewaySessionManager,
} from './gateway-session.ts'
import { gatewaySessionOriginForUrl, gatewayTunnelAuthority } from './gateway-session-refresh.ts'
import { sanitizeErrorText } from './sanitize-error.ts'
import { connectionIdForRawInstance } from './transport-identity.ts'
import {
  applyTransportRegistration, registrationKey, sanitizedRegistrationHeaders,
} from './transport-registration.ts'
import type { TransportInstanceSpec } from './transport-provider.ts'

/** Link-health sub-state of one transport: the control-plane's
 *  `RegistrationHealth` union, restated here because the package does not
 *  re-export it on the PlaneHandle surface. The `setInstanceTransportHealth` call
 *  below is the compile-time lockstep check against the canonical union. */
export type RegistrationHealth = 'healthy' | 'suspect' | 'down'

/** One committed registration's dial + auth descriptor. All five fields MUST come
 *  from the same transport incarnation (the wiring test asserts the lockstep). */
export interface RegistrationFacts {
  readonly url: string
  readonly transport: 'ssh' | 'http'
  readonly socketPath?: string
  readonly authority?: string
  readonly spkiPin?: string
  /** Sanitized auth headers (authorization / cookie) — main-process memory only,
   *  reachable through snapshotForSync only (never through snapshot/logs). */
  readonly headers?: Record<string, string>
}

export type RegistrationState = 'committed'

/** One committed registration (the credential-bearing record type). */
export interface ActiveRegistration {
  readonly id: string
  readonly connectionId: string
  readonly state: RegistrationState
  /** Registry-monotonic publication number: +1 only on a REAL (re)registration;
   *  a health-only update keeps it, so an in-flight manual sync may continue. */
  readonly recordGen: number
  readonly targetKey: string
  /** Gateway session scope (exact connection/target generation); undefined for dsh. */
  readonly scope: string | undefined
  readonly facts: RegistrationFacts
  readonly health: RegistrationHealth
  /** The manager tunnel generation this record was committed for (tombstone axis). */
  readonly transportGen: number
}

/** The non-secret view: the record with the auth headers dropped. */
export interface ActiveRegistrationView {
  readonly id: string
  readonly connectionId: string
  readonly state: RegistrationState
  readonly recordGen: number
  readonly targetKey: string
  readonly scope: string | undefined
  readonly facts: Omit<RegistrationFacts, 'headers'>
  readonly health: RegistrationHealth
  readonly transportGen: number
}

/** Manager-side live facts for one raw instance id (read-only). */
export interface LiveRegistrationState {
  readonly spec: TransportInstanceSpec
  /** State-object identity: a same-id delete/re-add creates a NEW object, so a
   *  tombstone only fences generations of the SAME incarnation (numeric transport
   *  generations restart with a new state; a re-created registration must never be
   *  blocked by that reuse). */
  readonly incarnation: object
  /** Tunnel incarnation number (transport-manager tunnelEpoch). */
  readonly transportGen: number
  /** The shell-core proxy transport mapping of spec.transport. */
  readonly transport: 'ssh' | 'http'
  /** Ready dial/health facts; null while the transport is not ready. */
  readonly ready: {
    readonly url: string
    readonly socketPath: string | null
    readonly health: RegistrationHealth
  } | null
}

/** The manager read surface the production live-facts adapter needs (structural:
 *  the transport manager satisfies it; tests inject a plain object). */
export interface RegistrationManagerReader {
  status(id: string): { phase: string; link?: { state: RegistrationHealth } } | null
  listInstances(): readonly TransportInstanceSpec[]
  readyUrl(id: string): string | null
  readySocketPath(id: string): string | null
  getAttemptFacts(id: string): { state: object; tunnelEpoch: number } | null
}

/** Production live-facts reader over the manager's documented reads (pure adapter,
 *  no state). `proxyTransport` is the ONE shell-core mapping, injected so this leaf
 *  stays independent of the shell assembly (no import edge into shell-core). */
export function createRegistrationLiveFacts(
  sm: RegistrationManagerReader,
  proxyTransport: (transport: TransportInstanceSpec['transport']) => 'ssh' | 'http',
): (id: string) => LiveRegistrationState | null {
  return (id) => {
    const spec = sm.listInstances().find(instance => instance.id === id)
    const attempt = sm.getAttemptFacts(id)
    if (spec === undefined || attempt === null) return null
    const status = sm.status(id)
    const url = status?.phase === 'ready' ? sm.readyUrl(id) : null
    return {
      spec,
      incarnation: attempt.state,
      transportGen: attempt.tunnelEpoch,
      transport: proxyTransport(spec.transport),
      ready: url === null
        ? null
        : { url, socketPath: sm.readySocketPath(id), health: status?.link?.state ?? 'healthy' },
    }
  }
}

export type RevokeReason = 'leave-ready' | 'auth-failed' | 'removed'

/** THE commit entry's requests: register (also degrades to health-only), the pure
 *  health path, and an idempotent revoke. */
export type CommitRequest =
  | { readonly kind: 'register'; readonly id: string; readonly transportGen: number }
  | { readonly kind: 'health'; readonly id: string; readonly transportGen: number }
  | { readonly kind: 'revoke'; readonly id: string; readonly reason: RevokeReason }

export type CommitRefusal = 'not-ready' | 'stale-generation' | 'proxy-rejected' | 'internal-error'

export type CommitOutcome =
  | { readonly ok: true; readonly action: 'registered' | 'health-only'; readonly registration: ActiveRegistrationView }
  | {
      readonly ok: true
      readonly action: 'revoked'
      readonly reason: RevokeReason
      /** Fail-closed facts for the caller's bounded auth recovery (null = nothing to recover). */
      readonly recovery: { readonly url: string; readonly scope: string | undefined } | null
    }
  | { readonly ok: false; readonly reason: CommitRefusal; readonly error?: string }

export interface ActiveRegistrationRegistry {
  /** THE write entry: synchronous two-phase commit (accept → publish), single tick. */
  commit(request: CommitRequest): CommitOutcome
  /** Non-secret snapshot of the committed record (headers dropped). */
  snapshot(id: string): ActiveRegistrationView | undefined
  /** Credential-bearing read for the manual sync at the caller's recorded
   *  generation: undefined when the registration was replaced/revoked. */
  snapshotForSync(id: string, recordGen: number): ActiveRegistration | undefined
  /** The generation the sync entry reads first (it then hands it to snapshotForSync). */
  currentRecordGen(id: string): number | undefined
  /** Exit leg: clear records and tombstones (plane teardown stays the disconnect leg's job). */
  dispose(): void
}

export interface ActiveRegistrationDeps {
  plane(): PlaneHandle | null
  live(id: string): LiveRegistrationState | null
  tokenFor(id: string): string | null
  passwordFor(id: string): string | null
  sessions: Pick<GatewaySessionManager, 'cachedCookie' | 'registrationAuthProof'>
  /** Non-secret warn sink (never a header/cookie value). */
  warn?(message: string): void
}

type AuthorizedGrant = {
  readonly ok: true
  readonly headers?: Record<string, string>
  readonly tunnelAuthority?: string
  readonly scope?: string
}

type AuthorizedFacts = AuthorizedGrant | { readonly ok: false; readonly scope: string | undefined }

interface ReadyFacts {
  readonly url: string
  readonly socketPath: string | null
  readonly health: RegistrationHealth
}

function viewOf(record: ActiveRegistration): ActiveRegistrationView {
  return {
    id: record.id,
    connectionId: record.connectionId,
    state: record.state,
    recordGen: record.recordGen,
    targetKey: record.targetKey,
    scope: record.scope,
    facts: {
      url: record.facts.url,
      transport: record.facts.transport,
      ...(record.facts.socketPath === undefined ? {} : { socketPath: record.facts.socketPath }),
      ...(record.facts.authority === undefined ? {} : { authority: record.facts.authority }),
      ...(record.facts.spkiPin === undefined ? {} : { spkiPin: record.facts.spkiPin }),
    },
    health: record.health,
    transportGen: record.transportGen,
  }
}

export function createActiveRegistrationRegistry(deps: ActiveRegistrationDeps): ActiveRegistrationRegistry {
  const records = new Map<string, ActiveRegistration>()
  const tombstones = new Map<string, { incarnation: object; transportGen: number }>()
  /** The incarnation each PUBLISHED record was committed for. The tombstone must fence
   *  the revoked RECORD's incarnation, not the manager's live one: an auto-recovery may
   *  already have replaced the state object (new incarnation, numeric generation back at
   *  1) before the old shell's leave-ready revoke lands, and fencing the live incarnation
   *  would then refuse the new incarnation's legitimate low-generation register. */
  const recordIncarnations = new Map<string, object>()
  let nextRecordGen = 0

  const warn = (message: string): void => deps.warn?.(message)

  /** The gateway auth admission (fail-closed): a password target may register only
   *  with the exact scoped cookie proven by verifyUp; a configured bearer is an
   *  independent OR-principal. Mirrors the ready-edge decision verbatim. */
  function authorizationFor(live: LiveRegistrationState, ready: ReadyFacts): AuthorizedFacts {
    if (live.spec.kind !== 'gateway') return { ok: true }
    const token = deps.tokenFor(live.spec.id)
    const password = deps.passwordFor(live.spec.id)
    const tunnelAuthority = live.spec.transport === 'ssh'
      ? gatewayTunnelAuthority(live.spec.remotePort)
      : undefined
    const scope = gatewaySessionScopeForConnection(live.spec)
    let cookie: string | null = null
    let proof: GatewayRegistrationAuthProof | null = null
    if (password !== null) {
      const origin = gatewaySessionOriginForUrl(ready.url, undefined, tunnelAuthority, scope)
      cookie = origin === null ? null : deps.sessions.cachedCookie(origin) ?? null
      proof = origin === null ? null : deps.sessions.registrationAuthProof(origin) ?? null
    }
    const decision = gatewayRegistrationAuthHeaders(token, password !== null, cookie, proof)
    if (!decision.ok) return { ok: false, scope }
    return { ok: true, headers: sanitizedRegistrationHeaders(decision.headers), tunnelAuthority, scope }
  }

  function factsFor(live: LiveRegistrationState, ready: ReadyFacts, authorized: AuthorizedGrant): RegistrationFacts {
    return {
      url: ready.url,
      transport: live.transport,
      ...(ready.socketPath === null ? {} : { socketPath: ready.socketPath }),
      ...(authorized.tunnelAuthority === undefined ? {} : { authority: authorized.tunnelAuthority }),
      ...(live.spec.spkiPin === undefined ? {} : { spkiPin: live.spec.spkiPin }),
      ...(authorized.headers === undefined ? {} : { headers: authorized.headers }),
    }
  }

  function revokedOutcome(
    id: string,
    reason: RevokeReason,
    recovery: { readonly url: string; readonly scope: string | undefined } | null,
  ): CommitOutcome {
    const previous = records.get(id)
    // A revoke with no published record has nothing to withdraw and nothing to fence;
    // writing a tombstone from the LIVE generation here would fence the ready edge that
    // follows an auto-recovery restart (the manager bumps the tunnel generation BEFORE
    // its non-ready push), leaving the proxy unregistered while the instance reads ready.
    if (previous === undefined) return { ok: true, action: 'revoked', reason, recovery }
    records.delete(id)
    const planeHandle = deps.plane()
    if (planeHandle !== null) {
      try {
        planeHandle.unregisterInstanceTransport(previous.connectionId)
      } catch (error) {
        // Never throw out of the commit entry (a refresh leg awaits nothing).
        warn(`registration revoke failed for ${id}: ${sanitizeErrorText(describeError(error))}`)
      }
    }
    // Fence the generation of the record that was ACTUALLY revoked, not the live one:
    // a late refresh/register for that old tunnel incarnation must not resurrect it, while
    // the same-id auto-recovery that already advanced the tunnel may register its new
    // generation (and legitimately restarts the numeric generation at 1).
    const live = deps.live(id)
    const recordIncarnation = recordIncarnations.get(id)
    recordIncarnations.delete(id)
    if (live !== null) {
      const fenceIncarnation = recordIncarnation ?? live.incarnation
      const existing = tombstones.get(id)
      // One tombstone per id: keep the FIRST fence of an incarnation, widen it only
      // for a later generation of the SAME incarnation; a re-created incarnation
      // starts a new resource and must not inherit the old numeric fence.
      if (existing === undefined || existing.incarnation !== fenceIncarnation) {
        tombstones.set(id, { incarnation: fenceIncarnation, transportGen: previous.transportGen })
      } else if (previous.transportGen > existing.transportGen) {
        tombstones.set(id, { incarnation: fenceIncarnation, transportGen: previous.transportGen })
      }
    }
    return { ok: true, action: 'revoked', reason, recovery }
  }

  function registerOrHealth(
    request: Extract<CommitRequest, { kind: 'register' | 'health' }>,
    live: LiveRegistrationState,
    ready: ReadyFacts,
  ): CommitOutcome {
    const planeHandle = deps.plane()
    if (planeHandle === null) return { ok: false, reason: 'not-ready' }
    const previous = records.get(request.id)
    if (request.kind === 'health') {
      if (previous === undefined || previous.transportGen !== live.transportGen) {
        return { ok: false, reason: 'stale-generation' }
      }
      planeHandle.setInstanceTransportHealth(previous.connectionId, ready.health)
      const next: ActiveRegistration = { ...previous, health: ready.health }
      records.set(request.id, next)
      return { ok: true, action: 'health-only', registration: viewOf(next) }
    }
    const authorized = authorizationFor(live, ready)
    if (!authorized.ok) {
      // Fail-closed: an unproven password session must never leave the old
      // registration standing (I6). Revoke + tombstone in the same commit.
      return revokedOutcome(request.id, 'auth-failed', { url: ready.url, scope: authorized.scope })
    }
    const facts = factsFor(live, ready, authorized)
    const targetKey = registrationKey(facts)
    const connectionId = connectionIdForRawInstance(live.spec.id, live.spec.kind)
    // A different tunnel incarnation must re-register even when the target key matches.
    const previousKey = previous !== undefined && previous.transportGen === live.transportGen
      ? previous.targetKey
      : undefined
    // ── phase 1: proxy accept (every register validation throws BEFORE any change) ──
    let proxyError: unknown = null
    const action = applyTransportRegistration(previousKey, targetKey, {
      setHealth: () => planeHandle.setInstanceTransportHealth(connectionId, ready.health),
      register: () => {
        try {
          planeHandle.registerInstanceTransport(connectionId, facts.url, facts.headers, {
            transport: facts.transport,
            health: ready.health,
            ...(facts.spkiPin === undefined ? {} : { tls: { spkiPin: facts.spkiPin } }),
            ...(facts.authority === undefined ? {} : { authority: facts.authority }),
            ...(facts.socketPath === undefined ? {} : { socketPath: facts.socketPath }),
          })
        } catch (error) {
          // The proxy rejected the replacement BEFORE revoking the old traffic: keep the
          // previous record published (it still describes the live proxy record).
          proxyError = error
        }
      },
    })
    if (proxyError !== null) {
      return { ok: false, reason: 'proxy-rejected', error: sanitizeErrorText(describeError(proxyError)) }
    }
    if (action === 'health-only' && previous !== undefined) {
      const next: ActiveRegistration = { ...previous, health: ready.health }
      records.set(request.id, next)
      return { ok: true, action: 'health-only', registration: viewOf(next) }
    }
    // ── phase 2: ONE publication (the only point the record becomes visible) ──
    const record: ActiveRegistration = {
      id: live.spec.id,
      connectionId,
      state: 'committed',
      recordGen: ++nextRecordGen,
      targetKey,
      scope: authorized.scope,
      facts,
      health: ready.health,
      transportGen: live.transportGen,
    }
    records.set(record.id, record)
    recordIncarnations.set(record.id, live.incarnation)
    tombstones.delete(record.id)
    return { ok: true, action: 'registered', registration: viewOf(record) }
  }

  return {
    commit(request) {
      try {
        if (request.kind === 'revoke') return revokedOutcome(request.id, request.reason, null)
        const live = deps.live(request.id)
        if (live === null || live.ready === null) return { ok: false, reason: 'not-ready' }
        if (live.transportGen !== request.transportGen) return { ok: false, reason: 'stale-generation' }
        const tombstone = tombstones.get(request.id)
        if (tombstone !== undefined
          && tombstone.incarnation === live.incarnation
          && request.transportGen <= tombstone.transportGen) {
          return { ok: false, reason: 'stale-generation' }
        }
        return registerOrHealth(request, live, live.ready)
      } catch (error) {
        // The commit entry is a non-throwing boundary: the refresh leg runs from a
        // bare timer callback, so a throw here would become a sidecar-fatal
        // unhandledRejection instead of a refused registration.
        const detail = sanitizeErrorText(describeError(error))
        warn(`registration commit failed for ${request.id}: ${detail}`)
        return { ok: false, reason: 'internal-error', error: detail }
      }
    },
    snapshot(id) {
      const record = records.get(id)
      return record === undefined ? undefined : viewOf(record)
    },
    snapshotForSync(id, recordGen) {
      const record = records.get(id)
      if (record === undefined || record.recordGen !== recordGen) return undefined
      return {
        ...record,
        facts: {
          ...record.facts,
          ...(record.facts.headers === undefined ? {} : { headers: { ...record.facts.headers } }),
        },
      }
    },
    currentRecordGen(id) {
      return records.get(id)?.recordGen
    },
    dispose() {
      records.clear()
      tombstones.clear()
      recordIncarnations.clear()
    },
  }
}
