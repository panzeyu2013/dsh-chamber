/**
 * shell-ipc-connections — domain IPC registrations: handler bodies, registration
 * order and error semantics live here; shared state/helpers arrive via ShellIpcCtx,
 * assembly-side deps via ctx.deps.ctx.
 */
import type { ShellIpcCtx } from './shell-ipc-ctx.ts'
import type { ConnectionCredentialMutations } from './connection-save.ts'
import type { GatewaySessionOrigin } from './gateway-session.ts'
import type { TransportInstanceInput, TransportInstanceSpec } from './transport-provider.ts'
import { INSTANCE_ID_PATTERN, commitTransportCredentialUpdate, type TransportManager } from './transport-manager.ts'
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
  // —— C 组 ——registry + 凭据 7 注册体（全零 Electron；trustedIpc 围栏在装配侧注入点
  // 包装）。事务/canonicalize/凭据写入口为纯模块直接 import。凭据 write-only：读侧只判
  // 存在性（!== null），值绝不进入载荷/日志。装配依赖经 ctx：sm / audit /
  // gatewaySessions / publishRegistryTransition。
  // V5-A：装配侧注入的是完整 createTransportManager，但共享 ShellAssemblyCtx Pick
  // 只扩到 loadFailure——roster 两个只读诊断经结构面读取，不加宽 Pick。
  const rosterHealth = sm as unknown as Pick<TransportManager, 'registryIncomplete' | 'loadDroppedCount'>
  /** 注册实例的 gateway-session origin（per-origin session key）：scheme 来自
   *  insecureHttp、端口显式——URL.origin 会省默认端口，缓存 key 必须与注册 baseUrl
   *  及探针 origin 一致。 */
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
  // Registry load health (degraded gate + roster-incomplete gate, narrow
  // read-only channel): separate from instances_get so its array payload and
  // every existing consumer stay untouched — a degraded registry answers an
  // empty roster that must NOT settle the renderer's authoritative-roster
  // gate, and a row-dropping load answers a PARTIAL roster whose legal rows
  // still install while durable pruning stays vetoed (V5-A).
  deps.ipc.handle(IPC_CHANNELS.SSH_INSTANCES_HEALTH, () => {
    const reason = sm.loadFailure();
    const rosterIncomplete = rosterHealth.registryIncomplete();
    return {
      degraded: reason !== null,
      ...(reason === null ? {} : { reason }),
      rosterIncomplete,
      // Present only alongside the incomplete bit: the count has no meaning
      // for a complete or a failed (degraded) load.
      ...(rosterIncomplete ? { droppedCount: rosterHealth.loadDroppedCount() } : {}),
    };
  });
  /**
   * Main-owned ADD/EDIT transaction for registry metadata plus every applicable
   * write-only credential dimension: the renderer sends only NEW values, old values
   * are snapshotted/compensated here and never cross IPC. connection-save.ts stops
   * the old transport, writes binding-guarded secrets, writes metadata last, and
   * restores all stores on ordinary failure. Exact-id deletion has its own channel.
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
        // Windows 密码认证不可用（askpass 需 PE 可执行）——拒绝并引导密钥/ssh-agent/Pageant。
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
        // 替换 transport 验证前先失效密码/会话状态，否则凭据编辑可能短暂复用旧缓存 Cookie。
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
  // clear-only 准入的三个描述符：字段 / 拒绝文案 / 注册表读取各自显式——没有布尔开关，token 与 password 的独立性因此留在类型面上。
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
  // Legacy SSH-password CLEAR：非空写入专属 save_connection，使 metadata + 全部凭据域共享一个补偿事务。
  deps.ipc.handle(IPC_CHANNELS.SSH_SET_PASSWORD, (payload: unknown) => {
    const admitted = admitClearOnly(CLEAR_ONLY_SSH_PASSWORD, payload);
    if (!admitted.ok) return { error: admitted.error };
    const { id, spec } = admitted;
    // 不接受新 SSH 密码的平台上清除仍可用；非空写入永不进入本处理器。
    try {
      // 只重建活的 SSH transport 使其停止使用已清除凭据；gateway/http 不受影响；审计只记凭据 kind 不记值。
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
  // Legacy gateway-token CLEAR：非空写入走上方权威 save_connection 事务。
  deps.ipc.handle(IPC_CHANNELS.GATEWAY_SET_TOKEN, (payload: unknown) => {
    const admitted = admitClearOnly(CLEAR_ONLY_GATEWAY_TOKEN, payload);
    if (!admitted.ok) return { error: admitted.error };
    const { id, spec } = admitted;
    try {
      // 先撤销已注册的 Authorization header 再清 token：disconnect() 同步投影旧 gateway idle，控制面在替换 transport 注册前注销 gateway:<id>；审计只记 kind。
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
  // Legacy gateway-password CLEAR：同时失效对应缓存会话；非空写入走 save_connection。
  deps.ipc.handle(IPC_CHANNELS.GATEWAY_SET_PASSWORD, (payload: unknown) => {
    const admitted = admitClearOnly(CLEAR_ONLY_GATEWAY_PASSWORD, payload);
    if (!admitted.ok) return { error: admitted.error };
    const { id, spec } = admitted;
    try {
      // 清除密码前失效全部缓存登录会话：直接与 SSH origin 都按连接/目标 scope 归属，跨历史 localPort。
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
      // 与 token 处理器同样的 disconnect-before-clear：活 gateway 目标不带被删凭据重建；审计永不记录密码值。
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

  // —— D 组 ——ssh 连接状态 7 注册体（全零 Electron）。CONFIG_LIST 经纯模块
  // discoverSshConfigHosts 直接 import（~/.ssh/config 非秘密投影：alias/hostName/
  // user/port 可读，keys/proxies/credentials 绝不离开主进程）；其余 6 个走 ctx 的
  // sm 句柄（Pick 扩 reverify/logs/clearLogs）。status/logs 同样只投影非秘密元数据。
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
  // 按需 ready 态复验（用户激活来源/会话）：对 READY transport 做一次即时身份探针，
  // 死会话/端点在一个往返内翻相位，不等待周期心跳。
  deps.ipc.handle(IPC_CHANNELS.SSH_REVERIFY, (payload: unknown) => {
    const { id } = payload as { id: string };
    return sm.reverify(id);
  });
  // 环形日志读/清：LOGS 返回有界非秘密日志（URL/密钥纪律同 status 投影），
  // LOGS_CLEAR 清空该实例环形日志。
  deps.ipc.handle(IPC_CHANNELS.SSH_LOGS, (payload: unknown) => {
    const { id } = payload as { id: string };
    return sm.logs(id);
  });
  deps.ipc.handle(IPC_CHANNELS.SSH_LOGS_CLEAR, (payload: unknown) => {
    const { id } = payload as { id: string };
    return sm.clearLogs(id);
  });

  // —— E 组 ——exec/systemd 4 注册体（全零 Electron）。装配依赖经 ctx 的 sm exec 面
  // （Pick 扩 exec）。restart 直用 sm.exec（plugin-sync 的 ExecFn 别名即 sm.exec 收窄）。
  // systemctl 固定参数数组与服务名白名单是 ssh-provider 的纯逻辑（白名单拒绝在任何
  // spawn 前），generation 复验（execIsCurrent/execEpoch）在 transport-manager exec
  // 实现内——均在纯模块内部；注册体只做结果投影：成功给最新 status（含 serviceActive），
  // 失败 loud {error}，绝不静默空成功、绝不未处理 rejection。
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
  // SSH_RESTART_SERVICE：语义同 provider exec channel——成功投影最新 status（ok 分支
  // 恒带 status，?? 兜底为 ExecResult 契约的防御分支），失败 loud {error}。
  deps.ipc.handle(IPC_CHANNELS.SSH_RESTART_SERVICE, (payload: unknown) => {
    const { id } = payload as { id: string };
    return sm.exec(id, 'restart').then(result =>
      (result.ok ? (result.status ?? { error: 'restart completed but no status projection' }) : { error: result.error }),
    ).catch(err => ({ error: `exec failed: ${describeUnknownError(err)}` }));
  });
}
