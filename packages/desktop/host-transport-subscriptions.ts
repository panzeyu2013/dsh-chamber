/**
 * Host transport subscriptions —— the shared host assembly's status/verify edges,
 * registered as ONE factory (B4-2b, split out of host-assembly.ts).
 *
 * `sm.onStatusChanged` (audit transition → active-registration commit → gateway
 * auto-sync / session-refresh arm → seed ready edge → committed status push) and
 * `sm.onVerified` (re-established gateway session → the SAME commit entry) share
 * the ONE ActiveRegistration registry, so the pair cannot drift into two mirrors.
 * The factory is called once at the composition root's original position and
 * registers BOTH subscriptions synchronously (registration timing unchanged).
 *
 * The module owns no lifecycle: the four shared closure states (audit transition
 * maps and the auth-recovery controller + its context map) stay owned by the
 * composition root and arrive as dependencies because the exit leg reads them too.
 * The registry is THE commit entry: no plane register/unregister/health call is
 * made here (I1), so the fail-closed branch no longer early-returns over the
 * committed status push (C7).
 */
import type { AuditEvent } from './audit-log.ts'
import type { ActiveRegistrationRegistry } from './active-registration.ts'
import type { AuthRecoveryController } from './auth-recovery.ts'
import { getGatewayPassword, getGatewayToken } from './gateway-provider.ts'
import type { GatewaySessionRefresh } from './gateway-session-refresh.ts'
import { IPC_CHANNELS } from './ipc-events.ts'
import type { ReadyPhaseEdges } from './plugin-sync.ts'
import { attemptCommittedRegistryPush, type TransportManager } from './transport-manager.ts'

/** The shared closure states the pair reads/writes. Owned by the composition root
 *  (the exit leg and the auth-recovery wiring also read them); injected so the
 *  factory captures ONE closure instead of splitting the pair. */
export interface TransportSubscriptionState {
  lastAuditedPhase: Map<string, string>
  auditRegistered: Set<string>
  authRecovery: AuthRecoveryController
  authRecoveryContext: Map<string, { url: string; scope: string | undefined }>
}

/** Every handle/effect the pair needs, all injected (the module owns no state). */
export interface TransportSubscriptionsDeps extends TransportSubscriptionState {
  sm: TransportManager
  /** The ONE commit entry (register/health/revoke); records are its only truth. */
  registrations: ActiveRegistrationRegistry
  edges: {
    mainWindowAlive(): boolean
    rendererPush(channel: string, payload: unknown): boolean
  }
  sessionRefresh: Pick<GatewaySessionRefresh, 'arm' | 'disarm'>
  readySeedEdges: Pick<ReadyPhaseEdges, 'observe'>
  startAutomaticHostSeed: (id: string) => void
  /** Best-effort chamber host-package sync over the committed record (null = no
   *  live registration / not a gateway; id rides; the shared execution leg re-reads
   *  the record and fences the dial binding + incarnation). */
  syncGatewayChamberPluginsFor: (id: string) => Promise<
    { uploaded: boolean; skipped: boolean; failed?: boolean; error?: string } | null
  >
  audit: (event: AuditEvent) => void
  logTag: string
}

/**
 * Register the status-projection edge and the ready-reverification edge as ONE
 * closure (synchronously, at the composition root's original assembly position).
 */
export function createTransportSubscriptions(deps: TransportSubscriptionsDeps): void {
  const {
    sm, registrations, edges, sessionRefresh, readySeedEdges, startAutomaticHostSeed,
    syncGatewayChamberPluginsFor, audit, logTag, lastAuditedPhase, auditRegistered,
    authRecovery, authRecoveryContext,
  } = deps

  /** Fail-closed commit outcome → the bounded auth recovery (the driver owns the
   *  throttle arithmetic; a throttled attempt is DEFERRED, never dropped). */
  const handleAuthFailed = (id: string, outcome: Extract<ReturnType<ActiveRegistrationRegistry['commit']>, { action: 'revoked' }>): void => {
    sessionRefresh.disarm(id)
    if (outcome.recovery !== null) authRecoveryContext.set(id, outcome.recovery)
    authRecovery.notifyFailure(id)
  }

  // —— sm.onStatusChanged 订阅：audit transition（非秘密 phase 转换一次）+ 唯一提交入口
  // （ready → register/health-only；fail-closed → revoke + 有界认证恢复；离开 ready → revoke）
  // + gateway 自动 sync / session refresh arm + 自动 seed ready 边缘 + SSH_STATUS_CHANGED
  // committed push。窗口门 = edges.mainWindowAlive()。
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
    // Active registration：ready → commit register（同 targetKey 自动退化为 health-only）；
    // 认证 fail-closed → 提交内 revoke；离开 ready → 幂等 revoke。注册参数（URL/UDS/authority/
    // SPKI/认证头）只在提交内从 live 事实派生，本模块不再现读任何一项。
    if (status.phase === 'ready') {
      const attempt = sm.getAttemptFacts(id)
      const outcome = attempt === null
        ? { ok: false as const, reason: 'not-ready' as const }
        : registrations.commit({ kind: 'register', id, transportGen: attempt.tunnelEpoch })
      if (!outcome.ok) {
        console.warn(`${logTag} transport registration commit refused for ${id}: ${outcome.reason}`)
      } else if (outcome.action === 'revoked') {
        // Fail closed on the verify→ready→register TOCTOU：密码 gateway 绝不因 cookie
        // 在间隙被逐/失效而无头注册。撤销已完成；仍要发本次 committed status push。
        handleAuthFailed(id, outcome)
      } else {
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
        // A REAL registration edge starts the pre-expiry session refresh and the
        // best-effort gateway seed sync; a health-only projection update must not
        // touch either (re-registration revokes every in-flight HTTP/WS).
        if (outcome.action === 'registered' && status.kind === 'gateway') {
          sessionRefresh.arm(id)
          authRecovery.cancel(id)
          authRecoveryContext.delete(id)
          void syncGatewayChamberPluginsFor(id)
        }
      }
    } else {
      // Only a COMMITTED record can leave ready: a non-ready push that merely announces a
      // new tunnel generation (auto-recovery bumps before its connecting push) must not
      // revoke/fence anything — the ready re-registration follows in that same generation.
      if (registrations.snapshot(id) !== undefined) {
        registrations.commit({ kind: 'revoke', id, reason: 'leave-ready' })
      }
      authRecovery.cancel(id)
      authRecoveryContext.delete(id)
      // Leaving ready cancels the pre-expiry refresh.
      sessionRefresh.disarm(id)
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
  // Ready-state re-verification → the SAME commit entry：verifyUp 可轮换密码会话而代理仍骑旧
  // cookie——同 targetKey 退化为 health-only；新会话即真实重注册（撤销在途流量）。认证失败
  // 不再静默保留僵尸注册：提交内 revoke + 有界恢复（C7/P1-3）。
  sm.onVerified(id => {
    const current = sm.status(id)
    if (current === null || current.phase !== 'ready' || current.kind !== 'gateway') return
    const attempt = sm.getAttemptFacts(id)
    if (attempt === null) return
    const outcome = registrations.commit({ kind: 'register', id, transportGen: attempt.tunnelEpoch })
    if (!outcome.ok) {
      console.warn(`${logTag} gateway re-verification commit refused for ${id}: ${outcome.reason}`)
      return
    }
    if (outcome.action === 'revoked') {
      handleAuthFailed(id, outcome)
      return
    }
    if (outcome.action !== 'registered') return
    // Same rule as the ready registration: a session re-established by the probe ends
    // any deferred auth recovery (it would otherwise disconnect a healthy link).
    authRecovery.cancel(id)
    authRecoveryContext.delete(id)
    sessionRefresh.arm(id)
    sm.appendLog(id, 'info', 'gateway session re-established — proxy registration refreshed with the new session')
  })
}
