/**
 * shell-ipc-connections — domain IPC registrations.
 * The handler bodies, registration order and error semantics live here; the shared
 * state/helpers arrive through ShellIpcCtx, the assembly-side deps through
 * ctx.deps.ctx.
 */
import type { ShellIpcCtx } from './shell-core.ts'
import type { ConnectionCredentialMutations } from './connection-save.ts'
import type { GatewaySessionOrigin } from './gateway-session.ts'
import type { TransportInstanceInput, TransportInstanceSpec } from './transport-provider.ts'
import { INSTANCE_ID_PATTERN, commitTransportCredentialUpdate } from './transport-manager.ts'
import { IPC_CHANNELS } from './ipc-events.ts'
import { MAX_SSH_PASSWORD_CHARS, getSshPassword, setSshPassword, sshPasswordSupported, sshProvider } from './ssh-provider.ts'
import { deleteConnectionTransaction, saveConnectionTransaction } from './connection-save.ts'
import { describeError } from './describe-error.ts'
import { admitClearOnly } from './clear-only-credentials.ts'
import { describeUnknownError } from './deep-link.ts'
import { discoverSshConfigHosts } from './ssh-config.ts'
import { gatewayPasswordValidationError, gatewayProvider, gatewayTokenValidationError, getGatewayPassword, getGatewayToken, setGatewayPassword, setGatewayToken, setInstanceSecrets } from './gateway-provider.ts'
import { gatewaySessionOriginForUrl, gatewayTunnelAuthority } from './gateway-session-refresh.ts'
import { gatewaySessionScopeForConnection } from './gateway-session.ts'

export function registerConnectionHandlers(ctx: ShellIpcCtx): void {
  const { deps, projectInstances } = ctx
  const { transportManager: sm, gatewaySessions, publishRegistryTransition, audit } = ctx.deps.ctx
  // —— C 组 ——
  // registry + 凭据 7 注册体（全零 Electron）。trustedIpc 围栏由装配侧在
  // registrar 注入点包装；事务（connection-save）/ canonicalize
  // （transport-provider）/ 凭据写入口（ssh/gateway-provider）与 session origin
  // 纯函数（gateway-session*）为 electron-free 纯模块直接 import。凭据
  // write-only 语义与「绝不回读」纪律保持：读侧只判存在性（!== null），值绝不
  // 进入载荷/日志。装配依赖经 ctx：sm = transportManager 句柄（registry 读写
  // + 状态/生命周期投影）、audit（非秘密审计叶）、gatewaySessions（会话
  // invalidation 宿主面）、publishRegistryTransition（registry 变更生命周期
  // sidecar——宿主对象与 SSH_INSTANCES_CHANGED push 文本在 main，本组注册体
  // 经 ctx 调用）。
  /** The gateway-session origin for a registered instance (design 17 §9.3
   * per-origin session key): scheme from `insecureHttp`, explicit port —
   * URL.origin normalizes default-port elision, so the cache key matches
   * the registration baseUrl and the provider's probe origin. */
  function gatewayOriginFor(spec: TransportInstanceSpec): GatewaySessionOrigin {
    return {
      baseUrl: `${spec.insecureHttp ? 'http' : 'https'}://${spec.host}:${spec.remotePort}`,
      insecureHttp: spec.insecureHttp,
      scope: gatewaySessionScopeForConnection(spec),
    };
  }

  const normalizeConnectionInput = (candidate: TransportInstanceInput): TransportInstanceSpec | null => {
    if (candidate === null || typeof candidate !== 'object') return null;
    if (candidate.transport === 'ssh') return sshProvider.validateSpec(candidate);
    if (candidate.transport === 'http') return gatewayProvider.validateSpec(candidate);
    return null;
  };

  deps.ipc.handle(IPC_CHANNELS.SSH_INSTANCES_GET, () =>
    projectInstances(sm.listInstances())
  );
  /**
   * Main-owned ADD/EDIT transaction for registry metadata plus every
   * applicable write-only credential dimension. The renderer sends only
   * NEW values; old values are snapshotted and compensated here, where
   * they can never cross IPC. connection-save.ts stops the old live
   * transport, writes binding-guarded secrets, writes metadata last, and
   * restores every store plus metadata on any ordinary failure. Exact-id
   * deletion has its own transaction/channel.
   */
  deps.ipc.handle(IPC_CHANNELS.SSH_SAVE_CONNECTION, (payload: unknown) => {
    const before = sm.listInstances();
    const currentProjected = () => projectInstances(sm.listInstances());
    const refuse = (error: string) => ({
      ok: false as const,
      instances: currentProjected(),
      error,
      metadataCommitted: false,
    });
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      return refuse('invalid connection save payload');
    }
    const record = payload as Record<string, unknown>;
    const previousId = record.previousId;
    if (previousId !== null && (typeof previousId !== 'string' || !INSTANCE_ID_PATTERN.test(previousId))) {
      return refuse('invalid or unknown connection id');
    }
    if (record.input === null || typeof record.input !== 'object' || Array.isArray(record.input)) {
      return refuse('invalid connection metadata');
    }
    if (record.credentials === null || typeof record.credentials !== 'object' || Array.isArray(record.credentials)) {
      return refuse('invalid connection credentials payload');
    }
    const credentialRecord = record.credentials as Record<string, unknown>;
    const allowedCredentialKeys = new Set(['sshPassword', 'gatewayToken', 'gatewayPassword']);
    if (Object.keys(credentialRecord).some(key => !allowedCredentialKeys.has(key))) {
      return refuse('invalid connection credentials payload');
    }
    for (const key of allowedCredentialKeys) {
      const value = credentialRecord[key];
      if (value !== undefined && typeof value !== 'string') {
        return refuse('invalid connection credentials payload');
      }
    }
    const credentials = credentialRecord as ConnectionCredentialMutations;
    const input = record.input as TransportInstanceInput;
    const normalized = normalizeConnectionInput(input);
    if (normalized === null) return refuse('invalid connection metadata');
    const sshPassword = credentials.sshPassword === '' ? undefined : credentials.sshPassword;
    const gatewayToken = credentials.gatewayToken === '' ? undefined : credentials.gatewayToken;
    const gatewayPassword = credentials.gatewayPassword === '' ? undefined : credentials.gatewayPassword;
    if (sshPassword !== undefined) {
      if (sshPassword.length > MAX_SSH_PASSWORD_CHARS) {
        return refuse(`SSH password is limited to ${MAX_SSH_PASSWORD_CHARS} characters`);
      }
      if (!sshPasswordSupported()) {
        // design 21 C15: Windows 密码认证不可用(askpass 需 PE 可执行)——门控
        // 拒绝并给出主路径引导(密钥 / ssh-agent / Pageant)。
        return refuse('SSH password auth is not supported on Windows yet — use a key or ssh-agent (Pageant) instead');
      }
    }
    const tokenError = gatewayTokenValidationError(gatewayToken ?? null);
    if (tokenError !== null) return refuse(tokenError);
    const passwordError = gatewayPasswordValidationError(gatewayPassword ?? null);
    if (passwordError !== null) return refuse(passwordError);

    const previous = typeof previousId === 'string'
      ? sm.listInstances().find(instance => instance.id === previousId) ?? null
      : null;
    const previousReadyUrl = typeof previousId === 'string' ? sm.readyUrl(previousId) : null;
    const invalidateGatewaySessionsFor = (spec: TransportInstanceSpec | null, readyUrl: string | null): void => {
      if (spec === null || spec.kind !== 'gateway') return;
      if (gatewaySessions === null) throw new Error('gateway session manager is unavailable');
      if (spec.transport === 'http') gatewaySessions.invalidate(gatewayOriginFor(spec));
      if (spec.transport === 'ssh') gatewaySessions.invalidateScope(gatewaySessionScopeForConnection(spec));
      if (readyUrl !== null) {
        const liveOrigin = gatewaySessionOriginForUrl(
          readyUrl,
          spec.spkiPin ?? undefined,
          spec.transport === 'ssh' ? gatewayTunnelAuthority(spec.remotePort) : undefined,
          gatewaySessionScopeForConnection(spec),
        );
        if (liveOrigin === null) throw new Error('invalid ready gateway session origin');
        gatewaySessions.invalidate(liveOrigin);
      }
    };
    const invalidateOldAndCurrentSessions = (): void => {
      invalidateGatewaySessionsFor(previous, previousReadyUrl);
      const current = sm.listInstances().find(instance => instance.id === normalized.id) ?? null;
      invalidateGatewaySessionsFor(current, sm.readyUrl(normalized.id));
    };

    const result = saveConnectionTransaction({
      listInstances: () => sm.listInstances(),
      normalize: normalizeConnectionInput,
      saveInstances: sm.saveInstances,
      getSshPassword,
      getGatewayToken,
      getGatewayPassword,
      setSshPassword: (id, value, bindingSpec) => setSshPassword(id, value, bindingSpec),
      setGatewaySecrets: (id, token, password, bindingSpec) => setInstanceSecrets(id, token, password, bindingSpec),
      invalidateGatewaySessions: (oldSpec, nextSpec) => {
        invalidateGatewaySessionsFor(oldSpec, previousReadyUrl);
        if (nextSpec !== null) invalidateGatewaySessionsFor(nextSpec, null);
      },
      isActive: id => {
        const status = sm.status(id);
        return status !== null && status.phase !== 'idle';
      },
      disconnect: id => { sm.disconnect(id); },
      connect: id => {
        // Password/session state must be invalidated before the replacement
        // live gateway verifies; otherwise a credential edit could briefly
        // reuse the old cached Cookie.
        invalidateOldAndCurrentSessions();
        sm.connect(id);
      },
    }, {
      previousId: previousId as string | null,
      input,
      credentials: { sshPassword, gatewayToken, gatewayPassword },
    });
    if (!result.ok) {
      const instances = result.metadataCommitted
        ? publishRegistryTransition(before, result.instances)
        : projectInstances(result.instances);
      return { ...result, instances };
    }

    if (result.changes.gatewayPassword) invalidateOldAndCurrentSessions();
    const credentialAudits: Array<[boolean, string, boolean]> = [
      [result.changes.sshPassword, 'ssh_password', getSshPassword(normalized.id) !== null],
      [result.changes.gatewayToken, 'token', getGatewayToken(normalized.id) !== null],
      [result.changes.gatewayPassword, 'password', getGatewayPassword(normalized.id) !== null],
    ];
    for (const [changed, detail, isSet] of credentialAudits) {
      if (!changed) continue;
      audit({
        ts: new Date().toISOString(),
        event: isSet ? 'credential_set' : 'credential_cleared',
        sourceId: normalized.id,
        kind: normalized.kind,
        transport: normalized.transport,
        detail,
      });
    }
    return { ok: true as const, instances: publishRegistryTransition(before, result.instances) };
  });
  deps.ipc.handle(IPC_CHANNELS.SSH_DELETE_CONNECTION, (payload: unknown) => {
    const { id } = payload as { id?: unknown };
    const before = sm.listInstances();
    if (typeof id !== 'string' || !INSTANCE_ID_PATTERN.test(id)) {
      console.warn('[dsh-chamber] desktop_ssh_delete_connection: invalid id refused');
      return projectInstances(before);
    }
    const result = deleteConnectionTransaction({
      listInstances: () => sm.listInstances(),
      saveInstances: sm.saveInstances,
      getSshPassword,
      getGatewayToken,
      getGatewayPassword,
      setSshPassword: (id, value, bindingSpec) => setSshPassword(id, value, bindingSpec),
      setGatewaySecrets: (id, token, password, bindingSpec) => setInstanceSecrets(id, token, password, bindingSpec),
      invalidateGatewaySessions: spec => {
        if (gatewaySessions === null) throw new Error('gateway session manager is unavailable');
        if (spec.transport === 'http') gatewaySessions.invalidate(gatewayOriginFor(spec));
        if (spec.transport === 'ssh') gatewaySessions.invalidateScope(gatewaySessionScopeForConnection(spec));
        const readyUrl = sm.readyUrl(spec.id);
        if (readyUrl !== null) {
          const liveOrigin = gatewaySessionOriginForUrl(
            readyUrl,
            spec.spkiPin ?? undefined,
            spec.transport === 'ssh' ? gatewayTunnelAuthority(spec.remotePort) : undefined,
            gatewaySessionScopeForConnection(spec),
          );
          if (liveOrigin === null) throw new Error('invalid ready gateway session origin');
          gatewaySessions.invalidate(liveOrigin);
        }
      },
      isActive: id => {
        const status = sm.status(id);
        return status !== null && status.phase !== 'idle';
      },
      disconnect: id => { sm.disconnect(id); },
      connect: id => { sm.connect(id); },
    }, id);
    if (!result.ok) {
      console.error(`[dsh-chamber] desktop_ssh_delete_connection transaction failed: ${result.error}`);
      return result.metadataCommitted
        ? publishRegistryTransition(before, result.instances)
        : projectInstances(result.instances);
    }
    return publishRegistryTransition(before, result.instances);
  });
  // clear-only 准入的三个描述符：字段 / 拒绝文案 / 注册表读取各自显式——没有布尔开关，
  // token 与 password 的独立性因此留在类型面上（design 17 §2.3）。
  const CLEAR_ONLY_SSH_PASSWORD = {
    field: 'password',
    refusal: 'desktop_ssh_set_password is clear-only; use desktop_ssh_save_connection to set credentials',
    list: () => sm.listInstances(),
  } as const;
  const CLEAR_ONLY_GATEWAY_TOKEN = {
    field: 'token',
    refusal: 'desktop_gateway_set_token is clear-only; use desktop_ssh_save_connection to set credentials',
    list: () => sm.listInstances(),
  } as const;
  const CLEAR_ONLY_GATEWAY_PASSWORD = {
    field: 'password',
    refusal: 'desktop_gateway_set_password is clear-only; use desktop_ssh_save_connection to set credentials',
    list: () => sm.listInstances(),
  } as const;
  // Legacy explicit SSH-password CLEAR action. Non-empty writes are owned
  // exclusively by desktop_ssh_save_connection so metadata + all credential
  // domains share one compensated transaction.
  deps.ipc.handle(IPC_CHANNELS.SSH_SET_PASSWORD, (payload: unknown) => {
    const admitted = admitClearOnly(CLEAR_ONLY_SSH_PASSWORD, payload);
    if (!admitted.ok) return { error: admitted.error };
    const { id, spec } = admitted;
    // Clearing remains available on platforms where accepting a new SSH
    // password is unsupported; non-empty writes never reach this handler.
    try {
      // Rebuild only a live SSH transport so it stops using the cleared
      // transport credential. Gateway/http transports are unaffected.
      // Audit records only the credential kind, never its value.
      const hadPassword = getSshPassword(id) !== null;
      commitTransportCredentialUpdate(sm, id, status => status.transport === 'ssh', () => {
        setSshPassword(id, null, null);
      });
      if (hadPassword) {
        audit({
          ts: new Date().toISOString(),
          event: 'credential_cleared',
          sourceId: id,
          kind: spec.kind,
          transport: spec.transport,
          detail: 'ssh_password',
        });
      }
      return { ok: true };
    } catch (error) {
      return { error: describeError(error) };
    }
  });
  // Legacy explicit gateway-token CLEAR action. Non-empty writes use the
  // authoritative save_connection transaction above.
  deps.ipc.handle(IPC_CHANNELS.GATEWAY_SET_TOKEN, (payload: unknown) => {
    const admitted = admitClearOnly(CLEAR_ONLY_GATEWAY_TOKEN, payload);
    if (!admitted.ok) return { error: admitted.error };
    const { id, spec } = admitted;
    try {
      // Revoke the currently registered Authorization header BEFORE
      // clearing the token. disconnect() synchronously emits the old
      // gateway idle projection, so the control plane unregisters
      // gateway:<id> before a replacement transport can register.
      // Audit names the credential kind, never its value.
      const hadToken = getGatewayToken(id) !== null;
      commitTransportCredentialUpdate(sm, id, status => status.kind === 'gateway', () => {
        setGatewayToken(id, null, null);
      });
      if (hadToken) {
        audit({
          ts: new Date().toISOString(),
          event: 'credential_cleared',
          sourceId: id,
          kind: spec.kind,
          transport: spec.transport,
          detail: 'token',
        });
      }
      return { ok: true };
    } catch (error) {
      return { error: describeError(error) };
    }
  });
  // Legacy explicit gateway-password CLEAR action. It also invalidates the
  // corresponding cached sessions; non-empty writes use save_connection.
  deps.ipc.handle(IPC_CHANNELS.GATEWAY_SET_PASSWORD, (payload: unknown) => {
    const admitted = admitClearOnly(CLEAR_ONLY_GATEWAY_PASSWORD, payload);
    if (!admitted.ok) return { error: admitted.error };
    const { id, spec } = admitted;
    try {
      // Clearing a password invalidates every cached login session before
      // the target can reconnect. Both direct and SSH origins are owned by
      // the exact connection/target scope across historical local ports.
      if (gatewaySessions === null) throw new Error('gateway session manager is unavailable');
      if (spec.transport === 'http') gatewaySessions.invalidate(gatewayOriginFor(spec));
      if (spec.transport === 'ssh') gatewaySessions.invalidateScope(gatewaySessionScopeForConnection(spec));
      const liveReadyUrl = sm.readyUrl(id);
      if (liveReadyUrl !== null) {
        const tunnelAuthority = spec.transport === 'ssh'
          ? gatewayTunnelAuthority(spec.remotePort)
          : undefined;
        const liveOrigin = gatewaySessionOriginForUrl(
          liveReadyUrl,
          spec.spkiPin ?? undefined,
          tunnelAuthority,
          gatewaySessionScopeForConnection(spec),
        );
        if (liveOrigin === null) throw new Error('invalid ready gateway session origin');
        gatewaySessions.invalidate(liveOrigin);
      }
      // Same disconnect-before-clear discipline as the token handler: a
      // live gateway target is rebuilt without the removed credential.
      // Audit never records the password value.
      const hadPassword = getGatewayPassword(id) !== null;
      commitTransportCredentialUpdate(sm, id, status => status.kind === 'gateway', () => {
        setGatewayPassword(id, null, null);
      });
      if (hadPassword) {
        audit({
          ts: new Date().toISOString(),
          event: 'credential_cleared',
          sourceId: id,
          kind: spec.kind,
          transport: spec.transport,
          detail: 'password',
        });
      }
      return { ok: true };
    } catch (error) {
      return { error: describeUnknownError(error) };
    }
  });

  // —— D 组 ——
  // ssh 连接状态 7 注册体（全零 Electron）。trustedIpc 围栏由装配侧在 registrar
  // 注入点包装。CONFIG_LIST：~/.ssh/config 非秘密投影（alias/hostName/user/port——
  // keys/proxies/credentials 绝不离开主进程），经纯模块 ssh-config.ts 的
  // discoverSshConfigHosts 直接 import；CONNECT / DISCONNECT /
  // STATUS / REVERIFY / LOGS / LOGS_CLEAR 全走 ctx 注入的 transportManager
  // 句柄（sm；Pick 面扩 reverify/logs/clearLogs，见 ShellAssemblyCtx）。
  // status/logs 的非秘密投影纪律保持（localPort/phase 等元数据可读；URL/密钥
  // 绝不进投影/载荷/日志）。
  // ~/.ssh/config discovery (design 05 §5): non-secret host projections only
  // (alias/hostName/user/port) — keys/proxies/credentials never leave the
  // main process.
  deps.ipc.handle(IPC_CHANNELS.SSH_CONFIG_LIST, () => discoverSshConfigHosts());
  deps.ipc.handle(IPC_CHANNELS.SSH_CONNECT, (payload: unknown) => {
    const { id } = payload as { id: string };
    return sm.connect(id);
  });
  deps.ipc.handle(IPC_CHANNELS.SSH_DISCONNECT, (payload: unknown) => {
    const { id } = payload as { id: string };
    sm.disconnect(id);
    return sm.status(id);
  });
  deps.ipc.handle(IPC_CHANNELS.SSH_STATUS, (payload: unknown) => {
    const { id } = payload as { id: string };
    return sm.status(id);
  });
  // On-demand ready-state re-verification (user activation of a source/
  // session): one immediate identity probe for a READY transport — a dead
  // gateway session or remote endpoint flips the phase within one probe
  // round-trip instead of waiting for the periodic heartbeat (transport-
  // manager reverify; see READY_VERIFY_INTERVAL_MS).
  deps.ipc.handle(IPC_CHANNELS.SSH_REVERIFY, (payload: unknown) => {
    const { id } = payload as { id: string };
    return sm.reverify(id);
  });
  // 环形日志读/清（transport-manager ring buffer）：LOGS 返回有界环形日志
  // （非秘密——logSummary 等元数据；URL/密钥纪律同 status 投影），LOGS_CLEAR
  // 清空该实例环形日志。
  deps.ipc.handle(IPC_CHANNELS.SSH_LOGS, (payload: unknown) => {
    const { id } = payload as { id: string };
    return sm.logs(id);
  });
  deps.ipc.handle(IPC_CHANNELS.SSH_LOGS_CLEAR, (payload: unknown) => {
    const { id } = payload as { id: string };
    return sm.clearLogs(id);
  });

  // —— E 组 ——
  // exec/systemd 4 注册体（SSH_START_SERVICE / SSH_STOP_SERVICE / SSH_IS_ACTIVE
  // / SSH_RESTART_SERVICE，全零 Electron）。装配依赖经 ctx：transportManager（sm）的 exec
  // 面（Pick 扩 exec——装配侧注入完整现实例）。restart 注册体直用 sm.exec
  // （plugin-sync 的 ExecFn 别名 execTransport 即 sm.exec 的 as unknown 收窄，
  // 为适配 plugin-sync 自身的执行契约）。systemctl argv 固定参数数组
  // `systemctl <action> -- <serviceName>` 与服务名白名单（`^[a-zA-Z0-9]
  // [a-zA-Z0-9_.-]*$`、首字符字母数字；design 02 §3.9）是 ssh-provider
  // provider exec 的纯逻辑（白名单拒绝发生在任何 spawn 前），generation 复验
  // 纪律（exec 结果/status/serviceActive 提交前经 execIsCurrent 复验，防旧代
  // 污染）在 transport-manager exec 实现内（execEpoch/execIdentityChanged）
  // ——均在纯模块内部；注册体只做结果投影：
  // Provider exec channel (design 05 §7.4, ssh: remote systemd): the fresh
  // status projection on success (serviceActive included), {error} on
  // failure — loud, never a silent empty success, never an unhandled
  // rejection.
  deps.ipc.handle(IPC_CHANNELS.SSH_START_SERVICE, (payload: unknown) => {
    const { id } = payload as { id: string };
    return sm.exec(id, 'start').then(result => (result.ok ? result.status : { error: result.error })).catch(err => ({ error: `exec failed: ${describeUnknownError(err)}` }));
  });
  deps.ipc.handle(IPC_CHANNELS.SSH_STOP_SERVICE, (payload: unknown) => {
    const { id } = payload as { id: string };
    return sm.exec(id, 'stop').then(result => (result.ok ? result.status : { error: result.error })).catch(err => ({ error: `exec failed: ${describeUnknownError(err)}` }));
  });
  deps.ipc.handle(IPC_CHANNELS.SSH_IS_ACTIVE, (payload: unknown) => {
    const { id } = payload as { id: string };
    return sm.exec(id, 'is-active').then(result => (result.ok ? result.status : { error: result.error })).catch(err => ({ error: `exec failed: ${describeUnknownError(err)}` }));
  });
  // SSH_RESTART_SERVICE（design 13 的 ssh 服务重启腿）：
  // 语义同 provider exec channel——成功时投影最新 status（服务重启的即时
  // 状态；transport exec 的 ok 分支恒带 status，此处 ?? 兜底为 plugin-sync
  // ExecResult 契约保留的防御分支，运行时不可达）；
  // 失败 loud {error}。
  deps.ipc.handle(IPC_CHANNELS.SSH_RESTART_SERVICE, (payload: unknown) => {
    const { id } = payload as { id: string };
    return sm.exec(id, 'restart').then(result =>
      (result.ok ? (result.status ?? { error: 'restart completed but no status projection' }) : { error: result.error }),
    ).catch(err => ({ error: `exec failed: ${describeUnknownError(err)}` }));
  });
}
