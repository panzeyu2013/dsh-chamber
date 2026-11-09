/**
 * Host transport subscriptions —— the shared host assembly's status/verify edges
 * registered as ONE factory (B4-2b, split out of host-assembly.ts).
 *
 * `sm.onStatusChanged` (audit transition → ready proxy registration → gateway
 * auto-sync → session-refresh arm → seed ready edge → committed status push) and
 * `sm.onVerified` (re-established gateway session → proxy re-registration) share
 * the SAME registration facts — `registeredTargetKeys`/`registeredAuthFingerprints`
 * — so they must be wired from one closure; two modules would let the pair drift.
 * The factory is called once at the composition root's original position and
 * registers BOTH subscriptions synchronously (registration timing unchanged).
 *
 * The module owns no lifecycle: the six shared closure states (the four
 * maps/sets, the auth-recovery controller and its context map) stay owned by the
 * composition root and arrive as dependencies because the exit leg and
 * `sessionRefresh.register` read/write them too. `currentGatewayAuth` moves with
 * the pair because they are its only consumers: ready registration and
 * onVerified re-registration must derive identical auth facts. The fail-closed
 * branch inside `onStatusChanged` keeps its `return` semantics verbatim.
 */
import type { PlaneHandle } from '@dsh-chamber/control-plane'
import type { AuditEvent } from './audit-log.ts'
import type { AuthRecoveryController } from './auth-recovery.ts'
import { getGatewayPassword, getGatewayToken } from './gateway-provider.ts'
import {
  gatewayRegistrationAuthHeaders, gatewaySessionScopeForConnection,
  type GatewayRegistrationAuthProof, type GatewaySessionManager,
} from './gateway-session.ts'
import { gatewaySessionOriginForUrl, gatewayTunnelAuthority, type GatewaySessionRefresh } from './gateway-session-refresh.ts'
import { setGatewaySyncRegistration } from './gateway-sync-registry.ts'
import { IPC_CHANNELS } from './ipc-events.ts'
import type { ReadyPhaseEdges } from './plugin-sync.ts'
import { proxyTransport } from './shell-core.ts'
import { connectionIdForRawInstance } from './transport-identity.ts'
import { attemptCommittedRegistryPush, type TransportManager } from './transport-manager.ts'
import {
  applyTransportRegistration, authHeadersFingerprint, registrationKey, sanitizedRegistrationHeaders,
} from './transport-registration.ts'
import type { TransportInstanceSpec } from './transport-provider.ts'

/** The six closure states the pair shares. Owned by the composition root (the
 *  exit leg and `sessionRefresh.register` also read/write them); injected so the
 *  factory captures ONE closure instead of splitting the pair. */
export interface TransportSubscriptionState {
  registeredAuthFingerprints: Map<string, string>
  registeredTargetKeys: Map<string, string>
  lastAuditedPhase: Map<string, string>
  auditRegistered: Set<string>
  authRecovery: AuthRecoveryController
  authRecoveryContext: Map<string, { url: string; scope: string | undefined }>
}

/** Every handle/effect the pair needs, all injected (the module owns no state of
 *  its own beyond the derivation `currentGatewayAuth` below). */
export interface TransportSubscriptionsDeps extends TransportSubscriptionState {
  sm: TransportManager
  plane: () => PlaneHandle | null
  edges: {
    mainWindowAlive(): boolean
    rendererPush(channel: string, payload: unknown): boolean
  }
  gatewaySessions: GatewaySessionManager
  sessionRefresh: GatewaySessionRefresh
  readySeedEdges: Pick<ReadyPhaseEdges, 'observe'>
  startAutomaticHostSeed: (id: string) => void
  syncGatewayChamberPluginsFor: (
    id: string,
    url: string,
    headers: Record<string, string>,
    spkiPin: string | null,
  ) => Promise<{ uploaded: boolean; skipped: boolean; failed?: boolean; error?: string } | null>
  audit: (event: AuditEvent) => void
  logTag: string
}

/**
 * Register the status-projection edge and the ready-reverification edge as ONE
 * closure (synchronously, at the composition root's original assembly position).
 */
export function createTransportSubscriptions(deps: TransportSubscriptionsDeps): void {
  const {
    sm, plane, edges, gatewaySessions, sessionRefresh, readySeedEdges, startAutomaticHostSeed,
    syncGatewayChamberPluginsFor, audit, logTag, registeredAuthFingerprints, registeredTargetKeys,
    lastAuditedPhase, auditRegistered, authRecovery, authRecoveryContext,
  } = deps

  /**
   * Current ready-registration auth facts for one gateway instance：token/password 存在性、
   * live cached login cookie + registration auth proof（按 TRANSPORT origin 键：ssh 隧道 =
   * loopback 端点 + 精确 connection/target scope；http(s) 直连 = verifyUp 同一键）、
   * tunnel Host authority 与 SPKI pin（pin 随注册走）。ready 注册与 onVerified 重注册
   * 派生同一实现，两条路径不可能漂移。
   */
  const currentGatewayAuth = (id: string, url: string, registered: TransportInstanceSpec | undefined): {
    auth: ReturnType<typeof gatewayRegistrationAuthHeaders>
    tunnelAuthority: string | undefined
    scope: string | undefined
    spkiPin: string | undefined
  } => {
    const token = getGatewayToken(id)
    const password = getGatewayPassword(id)
    const tunnelAuthority = registered !== undefined && registered.transport === 'ssh'
      ? gatewayTunnelAuthority(registered.remotePort)
      : undefined
    const scope = registered === undefined ? undefined : gatewaySessionScopeForConnection(registered)
    let cookie: string | null = null
    let authProof: GatewayRegistrationAuthProof | null = null
    if (password !== null) {
      const origin = gatewaySessionOriginForUrl(url, undefined, tunnelAuthority, scope)
      cookie = origin === null ? null : gatewaySessions.cachedCookie(origin) ?? null
      authProof = origin === null ? null : gatewaySessions.registrationAuthProof(origin) ?? null
    }
    return {
      auth: gatewayRegistrationAuthHeaders(token, password !== null, cookie, authProof),
      tunnelAuthority,
      scope,
      spkiPin: registered !== undefined ? registered.spkiPin : undefined,
    }
  }

  // —— sm.onStatusChanged 订阅：audit transition（非秘密 phase 转换，注册边沿一次）+ ready →
  // 代理注册/凭据注入 + gateway 自动 sync + session refresh arm + 自动 seed ready 边缘 +
  // SSH_STATUS_CHANGED committed push。窗口门 = edges.mainWindowAlive()；plane 腿以 plane() 读。
  sm.onStatusChanged((id, status) => {
    // Audit transition：仅 phase TRANSITIONS；requiresUserAction 终态分类同源；绝不落凭据/cookie/会话体。
    const prevPhase = lastAuditedPhase.get(id)
    if (prevPhase !== status.phase) {
      lastAuditedPhase.set(id, status.phase)
      audit({
        ts: new Date().toISOString(),
        event: 'transport_phase',
        sourceId: id,
        kind: status.kind,
        transport: status.transport,
        detail: status.phase === 'error' && status.requiresUserAction
          ? 'error:requires_user_action'
          : status.phase,
      })
    }
    // Non-secret auth-mode marker（存在性投影）。
    const auditAuth = status.kind === 'gateway'
      ? getGatewayToken(id) !== null && getGatewayPassword(id) !== null ? 'token+password'
        : getGatewayToken(id) !== null ? 'token'
          : getGatewayPassword(id) !== null ? 'password' : 'none'
      : 'none'
    const auditDetail = `auth:${auditAuth}${status.insecureHttp ? ',http_plaintext' : ''}`
    // Ready transport → per-instance reverse proxy（ready 注册/离开 ready 注销；transport URL 只在主进程）。
    const cp = plane()
    if (cp !== null) {
      if (status.phase === 'ready') {
        const url = sm.readyUrl(id)
        const socketPath = sm.readySocketPath(id)
        if (url !== null) {
          if (status.kind === 'gateway') {
            const registered = sm.listInstances().find(instance => instance.id === id)
            const facts = currentGatewayAuth(id, url, registered)
            const auth = facts.auth
            if (!auth.ok) {
              // Fail closed on the verify→ready→register TOCTOU：密码 gateway 绝不因 cookie
              // 在间隙被逐/失效而无头注册；有 token 时允许有意的 OR-principal bearer 回退。
              cp.unregisterInstanceTransport(connectionIdForRawInstance(id, status.kind))
              registeredAuthFingerprints.delete(connectionIdForRawInstance(id, status.kind))
              registeredTargetKeys.delete(connectionIdForRawInstance(id, status.kind))
              sessionRefresh.disarm(id)
              // The driver owns the throttle arithmetic and the deferred timer; a
              // throttled attempt is DEFERRED to the window edge, never dropped.
              authRecoveryContext.set(id, { url, scope: facts.scope })
              authRecovery.notifyFailure(id)
              return
            }
            const connectionId = connectionIdForRawInstance(id, status.kind)
            const headers = sanitizedRegistrationHeaders(auth.headers)
            const nextKey = registrationKey({
              url,
              transport: status.transport,
              headers,
              spkiPin: facts.spkiPin,
              authority: facts.tunnelAuthority,
              socketPath: socketPath ?? undefined,
            })
            applyTransportRegistration(registeredTargetKeys.get(connectionId), nextKey, {
              // Health-only projection change: do NOT re-register (it revokes
              // every in-flight HTTP response and WS splice).
              setHealth: () => cp.setInstanceTransportHealth(connectionId, status.link?.state ?? 'healthy'),
              register: () => {
                cp.registerInstanceTransport(
                  connectionId,
                  url,
                  headers,
                  {
                    transport: proxyTransport(status.transport),
                    ...(facts.spkiPin === undefined ? {} : { tls: { spkiPin: facts.spkiPin } }),
                    ...(facts.tunnelAuthority === undefined ? {} : { authority: facts.tunnelAuthority }),
                    ...(socketPath === null ? {} : { socketPath }),
                    ...(status.link === undefined ? {} : { health: status.link.state }),
                  },
                )
                registeredTargetKeys.set(connectionId, nextKey)
                registeredAuthFingerprints.set(connectionId, authHeadersFingerprint(headers))
                authRecovery.cancel(id)
                authRecoveryContext.delete(id)
                // 每次 gateway ready 注册后 best-effort 把本地 chamber host 包 sync 进 gateway
                // seed cache（幂等：仅版本失配重传）；手动 sync re-entry 参数经
                // setGatewaySyncRegistration 落注册表——删除/离开 ready 撤销同表。
                setGatewaySyncRegistration(id, { url, headers: { ...auth.headers }, spkiPin: facts.spkiPin ?? null })
                void syncGatewayChamberPluginsFor(id, url, auth.headers, facts.spkiPin ?? null)
                // A real registration edge starts the pre-expiry session refresh; a
                // health-only update above must not touch its epoch.
                sessionRefresh.arm(id)
              },
            })
          } else {
            const connectionId = connectionIdForRawInstance(id, status.kind)
            const nextKey = registrationKey({ url, transport: status.transport, socketPath: socketPath ?? undefined })
            applyTransportRegistration(registeredTargetKeys.get(connectionId), nextKey, {
              setHealth: () => cp.setInstanceTransportHealth(connectionId, status.link?.state ?? 'healthy'),
              register: () => {
                cp.registerInstanceTransport(connectionId, url, undefined, {
                  transport: proxyTransport(status.transport),
                  ...(socketPath === null ? {} : { socketPath }),
                  ...(status.link === undefined ? {} : { health: status.link.state }),
                })
                registeredTargetKeys.set(connectionId, nextKey)
                registeredAuthFingerprints.set(connectionId, authHeadersFingerprint(undefined))
              },
            })
          }
          // Live-proxy session self-healing is armed on the REGISTER edge below,
          // not on every ready status push: a health-only projection change must
          // not bump the refresh epoch and discard an in-flight re-login.
          // One registration edge per instance.
          if (!auditRegistered.has(id)) {
            auditRegistered.add(id)
            audit({
              ts: new Date().toISOString(),
              event: 'transport_registered',
              sourceId: id,
              kind: status.kind,
              transport: status.transport,
              detail: auditDetail,
            })
          }
        }
      } else {
        cp.unregisterInstanceTransport(connectionIdForRawInstance(id, status.kind))
        registeredAuthFingerprints.delete(connectionIdForRawInstance(id, status.kind))
        registeredTargetKeys.delete(connectionIdForRawInstance(id, status.kind))
        authRecovery.cancel(id)
        authRecoveryContext.delete(id)
        // Leaving ready cancels the pre-expiry refresh.
        sessionRefresh.disarm(id)
        // Manual gateway_plugin_sync re-entry dies with the ready registration（design 21 §6.5）。
        setGatewaySyncRegistration(id, null)
        if (auditRegistered.delete(id)) {
          audit({
            ts: new Date().toISOString(),
            event: 'transport_unregistered',
            sourceId: id,
            kind: status.kind,
            transport: status.transport,
            detail: auditDetail,
          })
        }
      }
    }
    // Remote chamber host-package seed ready 边缘：kind dsh + transport ssh 才 seed（走 ssh
    // exec；http-direct/gateway 排除）；幂等 + 失败随下次 ready 重试；observe = ready 边沿恰一次门。
    if (status.kind === 'dsh' && status.transport === 'ssh' && readySeedEdges.observe(id, status.phase)) {
      startAutomaticHostSeed(id)
    }
    // Committed status push（窗口门 = edges.mainWindowAlive；push 前竞态复查同一叶；false → loud 等待下次查询兜底）。
    if (edges.mainWindowAlive()) {
      const pushed = attemptCommittedRegistryPush(() => {
        if (!edges.mainWindowAlive()) {
          throw new Error('status renderer changed before push')
        }
        if (!edges.rendererPush(IPC_CHANNELS.SSH_STATUS_CHANGED, { id, status })) {
          throw new Error('status renderer push failed')
        }
      })
      if (!pushed.sent) {
        try { console.warn(`${logTag} transport 状态已更新但 renderer push 失败：${pushed.error}`) } catch { /* callback boundary */ }
      }
    }
  })
  // Ready-state re-verification → proxy re-registration：verifyUp 可轮换密码会话而代理仍骑旧
  // cookie——仅当 auth headers 指纹与已注册不同才重注册（注册撤销在途流量）；失败绝不 emit。
  sm.onVerified(id => {
    const cp = plane()
    const current = sm.status(id)
    if (cp === null || current === null || current.phase !== 'ready' || current.kind !== 'gateway') return
    const url = sm.readyUrl(id)
    const socketPath = sm.readySocketPath(id)
    const registered = sm.listInstances().find(instance => instance.id === id)
    if (url === null || registered === undefined || registered.kind !== 'gateway') return
    const facts = currentGatewayAuth(id, url, registered)
    // Fail closed like the ready registration.
    if (!facts.auth.ok) return
    const connectionId = connectionIdForRawInstance(id, 'gateway')
    const headers = sanitizedRegistrationHeaders(facts.auth.headers)
    if (authHeadersFingerprint(headers) === registeredAuthFingerprints.get(connectionId)) {
      cp.setInstanceTransportHealth(connectionId, 'healthy')
      return
    }
    cp.registerInstanceTransport(
      connectionId,
      url,
      headers,
      {
        transport: proxyTransport(registered.transport),
        ...(facts.spkiPin === undefined ? {} : { tls: { spkiPin: facts.spkiPin } }),
        ...(facts.tunnelAuthority === undefined ? {} : { authority: facts.tunnelAuthority }),
        ...(socketPath === null ? {} : { socketPath }),
        health: 'healthy',
      },
    )
    registeredAuthFingerprints.set(connectionId, authHeadersFingerprint(headers))
    registeredTargetKeys.set(connectionId, registrationKey({
      url,
      transport: registered.transport,
      headers,
      spkiPin: facts.spkiPin,
      authority: facts.tunnelAuthority,
      socketPath: socketPath ?? undefined,
    }))
    // Same rule as the ready registration: a session re-established by the probe
    // ends any deferred auth recovery (it would otherwise disconnect a healthy link).
    authRecovery.cancel(id)
    authRecoveryContext.delete(id)
    // The manual-sync entry rides the SAME registration facts: a rotated cookie must
    // reach the next user-initiated chamber-plugin sync, not the previous one.
    setGatewaySyncRegistration(id, { url, headers: { ...headers }, spkiPin: facts.spkiPin ?? null })
    sessionRefresh.arm(id)
    sm.appendLog(id, 'info', 'gateway session re-established — proxy registration refreshed with the new session')
  })
}
