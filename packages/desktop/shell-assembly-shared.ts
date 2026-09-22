/**
 * shell-assembly-shared.ts —— Electron main / Swift sidecar 共用的壳装配闭包族。
 *
 * owner = shell-core（electron-free 装配层）。依赖方向（禁止反向）：
 *   main.ts | sidecar-ctx.ts → shell-assembly-shared.ts
 *     → { runtime-startup-host, transport-manager, plugin-sync, ssh-plugin-journal,
 *         shell-core, gateway-provider, gateway-session, gateway-session-refresh,
 *         gateway-sync-registry, ssh-provider, control-plane-module, ipc-events }
 * 本模块绝不 import main.ts / sidecar-ctx.ts / electron；flavor 差异（日志前缀、
 * plane 晚绑定访问器、窗口判据与推送证明、HostEdges 叶、host 包源目录映射、
 * 缺省诊断文案）全部经 ShellAssemblySharedHost 注入。
 *
 * 迁移范围（4.4b，逐块逐字搬 + 参数化）：transport 恒等/操作指纹、ssh 插件
 * 目标闭包束（findRemoteTarget/ownsRemoteTarget/scopedExecForTarget 等）、自动
 * host-package seed（ExactOwnershipRegistry 单飞）、gateway 包同步执行闭包、
 * ready 注册期 auth 事实派生（currentGatewayAuth）、session refresh 装配、
 * sm.onStatusChanged / sm.onVerified 订阅与 publishRegistryTransition。
 * generation / fingerprint / 单飞语义逐字保留：registeredAuthFingerprints、
 * readySeedEdges、hostPackageSeeding、sessionRefresh 与事务槽都是本模块内的
 * 单实例；每 flavor 调用一次 createShellAssemblyShared()。
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { PlaneHandle } from '@dsh-chamber/control-plane'
import { attemptCommittedRegistryPush, computeRemovedInstanceIds, computeRetiredInstanceIds, type TransportManager } from './transport-manager.ts'
import type { TransportInstanceSpec } from './transport-provider.ts'
import { CHAMBER_HOST_PACKAGES, type ChamberHostPackageDescriptor } from './control-plane-module.ts'
import { ExactOwnershipRegistry, ReadyPhaseEdges, builtChamberHostPackageSeeds, portableChamberHostPackageSeeds, remoteHome, scopeExecToOwnership, seedRemoteChamberHostPackages, type ChamberHostPackageSeed, type ExecFn, type RemoteSpec, type StatusFn } from './plugin-sync.ts'
import { probeChamberHostLive } from './ssh-provider.ts'
import { createGatewaySessionRefresh, gatewaySessionOriginForUrl, gatewayTunnelAuthority, type GatewaySessionRefresh } from './gateway-session-refresh.ts'
import { gatewayRegistrationAuthHeaders, gatewaySessionScopeForConnection, type GatewayRegistrationAuthProof, type GatewaySessionManager } from './gateway-session.ts'
import { getGatewayPassword, getGatewayToken, syncGatewayChamberPlugins, type LocalChamberHostPackage } from './gateway-provider.ts'
import { setGatewaySyncRegistration } from './gateway-sync-registry.ts'
import { captureNotificationSource, ownsNotificationSource, projectInstanceSecrets, projectNotificationSourceInstances, proxyTransport, syncNotificationSourceRegistry, type ProjectedRegistryInstance, type SshPluginTarget } from './shell-core.ts'
import type { SshPluginJournal } from './ssh-plugin-journal.ts'
import type { AuditEvent } from './audit-log.ts'
import { describeError } from './describe-error.ts'
import { IPC_CHANNELS } from './ipc-events.ts'

/** main.ts / sidecar-ctx.ts 为共享装配注入的 flavor 面（见文件头依赖方向）。 */
export interface ShellAssemblySharedHost {
  /** 控制台前缀（'dsh-chamber' | 'sidecar'）。 */
  readonly logTag: string
  /** 已装配的传输注册表/生命周期管理器现实例。 */
  readonly transportManager: TransportManager
  /** 控制面句柄晚绑定访问器（null = 未创建/已销毁——与 main 的
   *  `const cp = controlPlane` 及 sidecar 的 planeRef 同语义）。 */
  plane(): PlaneHandle | null
  /** 渲染器窗口存在性（main: mainWindow !== null；sidecar: edges.mainWindowAlive）。 */
  windowAlive(): boolean
  /** 推送目标证明捕获（main: 当前 mainWindow；sidecar: null——无窗口对象）。 */
  capturePushTarget(): unknown
  /** 证明复验（main: 同一 mainWindow 且未 destroyed；sidecar: windowAlive() 复读）。 */
  pushTargetStillCurrent(target: unknown): boolean
  /** HostEdges.rendererPush。 */
  rendererPush(channel: string, payload: unknown): boolean
  /** S24 非秘密审计叶。 */
  audit(event: AuditEvent): void
  /** HostEdges.retireNotificationsForSources。 */
  retireNotificationsForSources(sources: ReadonlySet<string>): void
  /** gateway 密码会话管理器（装配期非空；null 仅 will-quit 清理后可达）。 */
  gatewaySessions: GatewaySessionManager
  /** ssh 插件 undo journal 现实例（单写者）。 */
  readonly sshPluginJournal: SshPluginJournal
  /** 远端 host 包源目录（键 = 注册表包名）。 */
  readonly hostPackageSourceDirs: Readonly<Record<string, string>>
  /** 非 localOnly 注册表行缺源目录的 loud 诊断（sidecar 提供；main 缺省不告警，
   *  保持原诊断面）。 */
  onUnmappedHostPackage?(descriptor: ChamberHostPackageDescriptor): void
  /** gateway 上传源读取失败的 loud 诊断（main 提供；sidecar 保持原静默注释面）。 */
  onHostPackageSourceReadError?(source: { name: string }, error: unknown): void
  /** 同步上传缺源目录的 flavor 诊断文案（各自保持原文案）。 */
  missingHostPackageSourceWarning?(seed: ChamberHostPackageSeed): void
}

/** 共享装配面：main/sidecar 两 flavor 的 ctx 与宿主对象从同一处取用。 */
export interface ShellAssemblyShared {
  /** 注册表驱动 + flavor 源目录的远端 seed 数组（含 localOnly 空源行）。 */
  readonly chamberHostPackageSeeds: readonly ChamberHostPackageSeed[]
  /** 可移植（非 localOnly）seed 列表（portableChamberHostPackageSeeds 单源）。 */
  readonly portableHostSeeds: readonly ChamberHostPackageSeed[]
  /** host 包 seed 单飞注册表（自动 seed 与手动 seed 注册体共用同一实例）。 */
  readonly hostPackageSeeding: ExactOwnershipRegistry
  /** ready 边缘观察器（自动 seed 与 registry 撤销路径共用同一实例）。 */
  readonly readySeedEdges: ReadyPhaseEdges
  /** ssh 插件管理目标闭包束（F 组注册体与自动路径同族）。 */
  readonly sshPluginTargets: {
    findRemoteTarget(id: string): SshPluginTarget | null
    ownsRemoteTarget(target: SshPluginTarget): boolean
    scopedExecForTarget(target: SshPluginTarget, extraOwner?: () => boolean): ExecFn
    scopedStatusForTarget(target: SshPluginTarget): StatusFn
    scopedProbeForTarget(
      target: SshPluginTarget,
      probe: (descriptor: ChamberHostPackageDescriptor) => Promise<boolean | null>,
    ): (descriptor: ChamberHostPackageDescriptor) => Promise<boolean | null>
    liveProbeFor(id: string): (descriptor: ChamberHostPackageDescriptor) => Promise<boolean | null>
  }
  /** gateway 插件手动/自动同步执行闭包（同一执行路径与注册参数）。 */
  readonly syncGatewayChamberPluginsFor: (
    id: string,
    url: string,
    headers: Record<string, string>,
    spkiPin: string | null,
  ) => Promise<{ uploaded: boolean; skipped: boolean; failed?: boolean; error?: string } | null>
  /** registry 变更生命周期权威 sidecar（投影/代际同步/撤销/committed push）。 */
  readonly publishRegistryTransition: (
    before: readonly TransportInstanceSpec[],
    after: readonly TransportInstanceSpec[],
  ) => ProjectedRegistryInstance[]
  /** live-proxy 会话自愈控制器（ready arm / 离开 ready disarm 由订阅驱动）。 */
  readonly sessionRefresh: GatewaySessionRefresh
  /** 自动 host-package seed 启动叶（ready 边缘与 registry reseed 同用）。 */
  readonly startAutomaticHostSeed: (id: string) => void
  /** 注册 sm.onStatusChanged / sm.onVerified 两条订阅（每 flavor 恰一次；
   *  调用点与搬迁前订阅点同位）。 */
  subscribeTransportStatus(): void
}

/**
 * Registry-driven remote chamber host seed list（原 main 1636-1655 / sidecar
 * 707-732 的单一实现）。`sourceDirs` 是 flavor 的包名 → 源目录映射；
 * localOnly 行恒为空 sourceDir（绝不去别的机器）。`onUnmapped` 是非 localOnly
 * 行缺源目录时 flavor 的 loud 诊断（sidecar 提供；main 原语义不告警）。
 */
export function buildRemoteChamberHostPackageSeeds(
  descriptors: readonly ChamberHostPackageDescriptor[],
  sourceDirs: Readonly<Record<string, string>>,
  onUnmapped?: (descriptor: ChamberHostPackageDescriptor) => void,
): ChamberHostPackageSeed[] {
  return descriptors.map(descriptor => {
    const sourceDir = descriptor.localOnly === true ? '' : (sourceDirs[descriptor.insert.name] ?? '')
    if (descriptor.localOnly !== true && sourceDir === '' && onUnmapped !== undefined) onUnmapped(descriptor)
    return {
      insertId: descriptor.insert.id,
      packageName: descriptor.insert.name,
      sourceDir,
      label: descriptor.insert.id,
      ...(descriptor.localOnly === true ? { localOnly: true as const } : {}),
    }
  })
}

export function createShellAssemblyShared(host: ShellAssemblySharedHost): ShellAssemblyShared {
  const sm = host.transportManager
  const sessionManager = host.gatewaySessions

  // 插件管理面实例级恒等/操作指纹（原 main 1470-1482 / sidecar 600-612 逐字；
  // registry 变更生命周期与 F 组目标闭包共用）。
  const transportIdentityFingerprint = (instance: TransportInstanceSpec): string => JSON.stringify([
    instance.kind,
    instance.transport,
    instance.host,
    instance.user,
    instance.sshPort,
    instance.remotePort,
  ])
  const operationalFingerprint = (instance: TransportInstanceSpec): string => JSON.stringify([
    transportIdentityFingerprint(instance),
    instance.serviceName,
    instance.remoteDshHome,
  ])

  // S24 audit transition dedupe（PHASE TRANSITIONS only）与注册边沿去重。
  const lastAuditedPhase = new Map<string, string>()
  const auditRegistered = new Set<string>()

  // Proxy-registration auth-header fingerprints（原 main 1922-1943 / sidecar
  // 613-631 逐字）：只存非秘密 sha256；header VALUE 绝不进 map。
  const registeredAuthFingerprints = new Map<string, string>()
  const authHeadersFingerprint = (headers: Record<string, string> | undefined): string => {
    const canonical = headers === undefined
      ? 'none'
      : Object.keys(headers).sort().map(key => key + ':' + headers[key]).join('|')
    return createHash('sha256').update(canonical).digest('hex')
  }
  const sanitizedRegistrationHeaders = (headers: Record<string, string>): Record<string, string> | undefined =>
    Object.keys(headers).length === 0 ? undefined : headers

  // Ready 注册期 auth 事实派生（原 main 1882-1921 / sidecar 912-940 逐字：
  // S23 SPKI pin 随注册；token/password 存在性投影；会话 cookie 仅缓存读）。
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
      cookie = origin === null ? null : sessionManager.cachedCookie(origin) ?? null
      authProof = origin === null ? null : sessionManager.registrationAuthProof(origin) ?? null
    }
    return {
      auth: gatewayRegistrationAuthHeaders(token, password !== null, cookie, authProof),
      tunnelAuthority,
      scope,
      spkiPin: registered !== undefined ? registered.spkiPin : undefined,
    }
  }

  // Host 包种子数组：注册表驱动（localOnly 行保留但 sourceDir 恒空；哪一行可以
  // 去别的机器只由 portableChamberHostPackageSeeds 判）。
  const chamberHostPackageSeeds = buildRemoteChamberHostPackageSeeds(
    CHAMBER_HOST_PACKAGES,
    host.hostPackageSourceDirs,
    host.onUnmappedHostPackage,
  )
  const portableHostSeeds = portableChamberHostPackageSeeds(chamberHostPackageSeeds)

  // Exact-incarnation single-flight for ready/manual host-package seeds（changed
  // same-id target 立即 supersede；stale finally/log/result 绝不清理/写入其替换者）。
  const hostPackageSeeding = new ExactOwnershipRegistry()
  const readySeedEdges = new ReadyPhaseEdges()
  // Remote install-level fallback path shared by the chamber host packages.
  const remoteHostPackageDir = (spec: RemoteSpec, packageName: string): string =>
    remoteHome(spec.remoteDshHome) + '/profiles/node_modules/' + packageName

  // Transport-manager 执行/状态投影面（plugin-sync 在本地重新声明 exec/status
  // 契约，经结构等价收窄别名桥接；status = runtime status(id) 投影）。
  const execTransport = sm.exec as unknown as ExecFn
  const statusTransport: StatusFn = (id) => sm.status(id)

  // —— ssh 插件管理目标闭包束（原 main 1656-1683 / sidecar 750-800 逐字）。
  // 目标 = spec + operational fingerprint + 来源代际 token（F 组 owns 复验与
  // C 组来源证明同一代际面）。——
  const findRemoteTarget = (id: string): SshPluginTarget | null => {
    const instance = sm.listInstances().find((entry) => entry.id === id)
    if (instance === undefined || instance.kind !== 'dsh' || instance.transport !== 'ssh') return null
    const sourceToken = captureNotificationSource(instance.kind + '-' + instance.id)
    if (sourceToken === null) return null
    return {
      spec: { id: instance.id, remoteDshHome: instance.remoteDshHome ?? null },
      fingerprint: operationalFingerprint(instance),
      sourceToken,
    }
  }
  const ownsRemoteTarget = (target: SshPluginTarget): boolean =>
    ownsNotificationSource(target.sourceToken)
    && findRemoteTarget(target.spec.id)?.fingerprint === target.fingerprint
  const scopedExecForTarget = (target: SshPluginTarget, extraOwner: () => boolean = () => true): ExecFn =>
    scopeExecToOwnership(execTransport, target.spec.id, () => extraOwner() && ownsRemoteTarget(target))
  const scopedStatusForTarget = (target: SshPluginTarget): StatusFn => id =>
    id === target.spec.id && ownsRemoteTarget(target) ? statusTransport(id) : null
  const scopedProbeForTarget = (
    target: SshPluginTarget,
    probe: (descriptor: ChamberHostPackageDescriptor) => Promise<boolean | null>,
  ): ((descriptor: ChamberHostPackageDescriptor) => Promise<boolean | null>) => async (descriptor) => {
    if (!ownsRemoteTarget(target)) return null
    const result = await probe(descriptor)
    return ownsRemoteTarget(target) ? result : null
  }
  // Live-effect probe for the chamber host packages（设计 09 module A / 08 §11 /
  // 24 §7）：通用隧道 RPC 探针，由控制面注册表 probe 描述子驱动；无 ready
  // 隧道 → null = "未探测"（绝不猜测）。
  const liveProbeFor = (id: string): ((descriptor: ChamberHostPackageDescriptor) => Promise<boolean | null>) => async (descriptor) => {
    const url = sm.readyUrl(id)
    if (url === null) return null
    try {
      const parsed = new URL(url)
      const port = parsed.port === '' ? null : Number(parsed.port)
      if (port === null || !Number.isInteger(port) || port < 1 || port > 65535) return null
      const result = await probeChamberHostLive({ host: parsed.hostname, port }, descriptor.probe.method, descriptor.probe.args)
      return result === 'live' ? true : result === 'not-live' ? false : null
    } catch {
      return null
    }
  }

  // 自动 chamber host seed（原 main 1687-1734 / sidecar 801-853 逐字：单飞
  // 注册表 begin/owns/finish + 构建产物过滤（缺失 loud 入实例环形日志）+
  // seedRemoteChamberHostPackages 幂等注入）。
  const startAutomaticHostSeed = (id: string): void => {
    const target = findRemoteTarget(id)
    if (target === null) return
    const begun = hostPackageSeeding.begin(id, target.fingerprint)
    if (!begun.accepted) return
    const token = begun.token
    const ownsSeed = () => hostPackageSeeding.owns(token) && ownsRemoteTarget(target)
    const appendSeedLog = (level: 'info' | 'error', message: string): void => {
      if (ownsSeed()) sm.appendLog(id, level, message)
    }
    void (async () => {
      try {
        const builtSeeds = builtChamberHostPackageSeeds(portableHostSeeds)
        if (builtSeeds.length === 0) {
          if (ownsSeed()) console.log(`[${host.logTag}] chamber host seed skipped for ${id}: no built host package artifacts`)
          appendSeedLog('info', 'chamber host 包未注入：构建产物缺失；远端相关客户端能力不可用')
          return
        }
        const missingSeeds = portableHostSeeds.filter(seed => !builtSeeds.includes(seed))
        if (missingSeeds.length > 0) {
          appendSeedLog('info', `chamber host 包部分未注入（构建产物缺失）：${missingSeeds.map(seed => seed.label).join(', ')}`)
        }
        const result = await seedRemoteChamberHostPackages(
          scopedExecForTarget(target, ownsSeed),
          target.spec,
          portableHostSeeds,
        )
        if (!ownsSeed()) return
        if (result.ok) {
          const seeded = result.packages.map(entry => entry.insertId).join(',')
          console.log(`[${host.logTag}] chamber host packages seeded onto ${id} (${seeded}; wrote=${result.wrote}, patched=${result.patched})`)
          const packageSummary = result.packages.map(entry =>
            `${entry.insertId}${entry.wrote ? ' 已写入' : ' 已是最新'}（${remoteHostPackageDir(target.spec, entry.packageName)}）`).join('；')
          appendSeedLog('info', `chamber host 包注入完成：${packageSummary}；boot 层${result.patched ? '已合并挂载' : '无需改动'}（重启后生效）`)
        } else {
          console.warn(`[${host.logTag}] chamber host seed failed for ${id}: ${result.error}`)
          appendSeedLog('error', `chamber host 包注入失败：${result.error}`)
        }
      } catch (err) {
        if (!ownsSeed()) return
        const detail = describeError(err)
        console.warn(`[${host.logTag}] chamber host seed error for ${id}: ${detail}`)
        appendSeedLog('error', `chamber host 包注入异常：${detail}`)
      } finally {
        hostPackageSeeding.finish(token)
      }
    })()
  }

  // 本地 chamber host 包源 + gateway 上传执行闭包（原 main 1735-1794 /
  // sidecar 855-910 逐字；注册表 + 可移植驱动，缺目录/读失败按 flavor 诊断）。
  const localChamberHostPackageSources = (): Array<{ name: string; packageJsonPath: string; distIndexPath: string }> => {
    return portableHostSeeds.flatMap(seed => {
      const dir = host.hostPackageSourceDirs[seed.packageName]
      if (dir === undefined || dir === '') {
        host.missingHostPackageSourceWarning?.(seed)
        return []
      }
      return [{
        name: seed.packageName,
        packageJsonPath: path.join(dir, 'package.json'),
        distIndexPath: path.join(dir, 'dist', 'index.js'),
      }]
    })
  }
  const syncGatewayChamberPluginsFor = async (
    id: string,
    url: string,
    headers: Record<string, string>,
    spkiPin: string | null,
  ): Promise<{ uploaded: boolean; skipped: boolean; failed?: boolean; error?: string } | null> => {
    const instance = sm.listInstances().find(candidate => candidate.id === id)
    if (instance === undefined || instance.kind !== 'gateway') return null
    const packages: LocalChamberHostPackage[] = []
    for (const source of localChamberHostPackageSources()) {
      try {
        packages.push({
          name: source.name,
          packageJson: readFileSync(source.packageJsonPath, 'utf8'),
          distIndex: readFileSync(source.distIndexPath, 'utf8'),
        })
      } catch (error) {
        // Not built/bundled in this runtime — nothing to sync for this entry.
        host.onHostPackageSourceReadError?.(source, error)
      }
    }
    return syncGatewayChamberPlugins({
      // Sync through the REGISTERED transport origin (the ready URL): for an ssh
      // tunnel that is the loopback endpoint the user verified, never the
      // (usually unreachable) remote host:port. The tunnel authority override
      // presents the remote gateway in the Host header.
      origin: url,
      authority: instance.transport === 'ssh' ? gatewayTunnelAuthority(instance.remotePort) : undefined,
      headers,
      spkiPin,
      packages,
      logger: { warn: message => console.warn(message), log: message => console.log(message) },
    })
  }

  // Live-proxy session self-healing（原 main 1549-1621 / sidecar 632-682 逐字）：
  // ready 注册 arm / 离开 ready disarm；控制器只对密码目标生效，register 腿经
  // plane 晚绑定（隧道 Host authority 覆盖 + registeredAuthFingerprints 锁步）。
  const sessionRefresh: GatewaySessionRefresh = createGatewaySessionRefresh({
    sessionManager,
    passwordFor: id => getGatewayPassword(id),
    tokenFor: id => getGatewayToken(id),
    readyUrlFor: id => sm.readyUrl(id),
    tlsPinFor: id => sm.listInstances().find(instance => instance.id === id)?.spkiPin ?? null,
    authorityFor: id => {
      const instance = sm.listInstances().find(candidate => candidate.id === id)
      return instance !== undefined && instance.kind === 'gateway' && instance.transport === 'ssh'
        ? gatewayTunnelAuthority(instance.remotePort)
        : undefined
    },
    scopeFor: id => {
      const instance = sm.listInstances().find(candidate => candidate.id === id)
      return instance !== undefined && instance.kind === 'gateway'
        ? gatewaySessionScopeForConnection(instance)
        : undefined
    },
    register: (id, url, headers, tls, authority) => {
      const livePlane = host.plane()
      const registered = sm.listInstances().find(instance => instance.id === id)
      if (livePlane !== null) livePlane.registerInstanceTransport('gateway:' + id, url, headers, {
        ...(registered === undefined ? {} : { transport: proxyTransport(registered.transport) }),
        ...(tls === undefined ? {} : tls),
        ...(authority === undefined ? {} : { authority }),
      })
      // Keep the registered-auth fingerprint in lockstep：refresh 重注册 REPLACES
      // 代理 headers——onVerified 指纹门须把已轮换 cookie 视为 "already
      // registered"，否则下次 ready 探针无条件再注册（撤销在途流量）。
      registeredAuthFingerprints.set('gateway:' + id, authHeadersFingerprint(
        headers === undefined ? undefined : sanitizedRegistrationHeaders(headers),
      ))
    },
    // Bounded dead-cookie recovery：disconnect（idle → 控制面注销 + refresh
    // disarm）→ connect（verifyUp 用存储密码重认证——单次 re-login → terminal
    // path）；每次 refresh fire 至多一次、仅 transport 仍 ready 且同 origin 时。
    reconnect: (id) => {
      try {
        sm.disconnect(id)
        sm.connect(id)
      } catch (error) {
        console.warn(`[${host.logTag}] session-refresh recovery reconnect failed for ${id}: ${String(error)}`)
      }
    },
    warn: message => console.warn('[' + host.logTag + '] ' + message),
  })

  // Committed push helper：注册/状态 push 都经 attemptCommittedRegistryPush 的
  // 非抛出边界；窗口门 = host.windowAlive()，push 前以 flavor 证明复验竞态
  // （main: 同一 mainWindow 且未 destroyed；sidecar: mainWindowAlive 复读）。
  const pushCommitted = (
    channel: string,
    payload: unknown,
    raceError: string,
    pushError: string,
    warnPrefix: string,
  ): void => {
    if (!host.windowAlive()) return
    const target = host.capturePushTarget()
    const pushed = attemptCommittedRegistryPush(() => {
      if (!host.pushTargetStillCurrent(target)) throw new Error(raceError)
      if (!host.rendererPush(channel, payload)) throw new Error(pushError)
    })
    if (!pushed.sent) {
      try { console.warn('[' + host.logTag + '] ' + warnPrefix + pushed.error) } catch { /* callback boundary */ }
    }
  }

  // —— sm.onStatusChanged / sm.onVerified 订阅（原 main 1944-2165 /
  // sidecar 950-1123 镜像逐字；S24 audit、ready → 代理注册/凭据注入/gateway
  // 自动 sync/session refresh arm/自动 seed ready 边缘/committed push）。——
  function subscribeTransportStatus(): void {
    sm.onStatusChanged((id, status) => {
      // S24 audit：仅 phase TRANSITIONS；requiresUserAction 终态分类同源。
      // 绝不落凭据/cookie/会话体。
      const prevPhase = lastAuditedPhase.get(id)
      if (prevPhase !== status.phase) {
        lastAuditedPhase.set(id, status.phase)
        host.audit({
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
      // Non-secret auth-mode marker（token+password | token | password | none——
      // EXISTENCE projection，绝非值）。
      const auditAuth = status.kind === 'gateway'
        ? getGatewayToken(id) !== null && getGatewayPassword(id) !== null ? 'token+password'
          : getGatewayToken(id) !== null ? 'token'
            : getGatewayPassword(id) !== null ? 'password' : 'none'
        : 'none'
      const auditDetail = 'auth:' + auditAuth + (status.insecureHttp ? ',http_plaintext' : '')
      // Ready transport → per-instance reverse proxy（transport URL 只在主进程，
      // 绝不进 renderer payload）。
      const cp = host.plane()
      if (cp !== null) {
        if (status.phase === 'ready') {
          const url = sm.readyUrl(id)
          if (url !== null) {
            if (status.kind === 'gateway') {
              const registered = sm.listInstances().find(instance => instance.id === id)
              const facts = currentGatewayAuth(id, url, registered)
              const auth = facts.auth
              if (!auth.ok) {
                // Fail closed on the verify→ready→register TOCTOU：密码 gateway
                // 绝不因 cookie 在间隙被逐/失效而无头注册；有 token 时纯决策
                // 助手允许有意的 OR-principal bearer 回退。
                cp.unregisterInstanceTransport(status.kind + ':' + id)
                registeredAuthFingerprints.delete(status.kind + ':' + id)
                sessionRefresh.disarm(id)
                sm.appendLog(id, 'warn', 'gateway session changed before proxy registration; re-authenticating')
                // Capture ONLY the scope（绝不闭包整个 facts——其 auth.headers
                // 携带会话 cookie）。
                const scope = facts.scope
                queueMicrotask(() => {
                  const currentStatus = sm.status(id)
                  const currentSpec = sm.listInstances().find(instance => instance.id === id)
                  if (currentStatus?.phase !== 'ready' || sm.readyUrl(id) !== url
                    || currentSpec === undefined || currentSpec.kind !== 'gateway'
                    || getGatewayPassword(id) === null
                    || scope === undefined
                    || gatewaySessionScopeForConnection(currentSpec) !== scope) return
                  sm.disconnect(id)
                  sm.connect(id)
                })
                return
              }
              const connectionId = status.kind + ':' + id
              const headers = sanitizedRegistrationHeaders(auth.headers)
              cp.registerInstanceTransport(
                connectionId,
                url,
                headers,
                {
                  ...(registered === undefined ? {} : { transport: proxyTransport(registered.transport) }),
                  ...(facts.spkiPin === undefined ? {} : { tls: { spkiPin: facts.spkiPin } }),
                  ...(facts.tunnelAuthority === undefined ? {} : { authority: facts.tunnelAuthority }),
                },
              )
              registeredAuthFingerprints.set(connectionId, authHeadersFingerprint(headers))
              // 每次 gateway ready 注册后 best-effort sync 本地 chamber host 包
              // 进 gateway seed cache（幂等）；手动 sync re-entry 参数落注册表。
              setGatewaySyncRegistration(id, { url, headers: { ...auth.headers }, spkiPin: facts.spkiPin ?? null })
              void syncGatewayChamberPluginsFor(id, url, auth.headers, facts.spkiPin ?? null)
            } else {
              cp.registerInstanceTransport(status.kind + ':' + id, url, undefined, {
                transport: proxyTransport(status.transport),
              })
              registeredAuthFingerprints.set(status.kind + ':' + id, authHeadersFingerprint(undefined))
            }
            // Live-proxy session self-healing：ready 注册即 arm 预到期 refresh。
            if (status.kind === 'gateway') sessionRefresh.arm(id)
            // S24: one registration edge per instance。
            if (!auditRegistered.has(id)) {
              auditRegistered.add(id)
              host.audit({
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
          cp.unregisterInstanceTransport(status.kind + ':' + id)
          registeredAuthFingerprints.delete(status.kind + ':' + id)
          sessionRefresh.disarm(id)
          setGatewaySyncRegistration(id, null)
          if (auditRegistered.delete(id)) {
            host.audit({
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
      // Remote chamber host-package seed ready 边缘：kind 'dsh' + transport
      // 'ssh' 才 seed（seed 走 ssh exec 通道；http-direct/gateway 排除）。
      if (status.kind === 'dsh' && status.transport === 'ssh' && readySeedEdges.observe(id, status.phase)) {
        startAutomaticHostSeed(id)
      }
      pushCommitted(
        IPC_CHANNELS.SSH_STATUS_CHANGED,
        { id, status },
        'status renderer changed before push',
        'status renderer push failed',
        'transport 状态已更新但 renderer push 失败：',
      )
    })

    // Ready-state re-verification → proxy re-registration：仅当当前 auth
    // headers 与已注册指纹不同才重注册（注册撤销在途流量——健康未变注册绝不
    // 重注册）；失败绝不 emit（翻转 phase 自愈）。
    sm.onVerified(id => {
      const cp = host.plane()
      const current = sm.status(id)
      if (cp === null || current === null || current.phase !== 'ready' || current.kind !== 'gateway') return
      const url = sm.readyUrl(id)
      const registered = sm.listInstances().find(instance => instance.id === id)
      if (url === null || registered === undefined || registered.kind !== 'gateway') return
      const facts = currentGatewayAuth(id, url, registered)
      // Fail closed like the ready registration：cookie 在间隙消失时绝不以
      // 无头注册替换 live 注册。
      if (!facts.auth.ok) return
      const connectionId = 'gateway:' + id
      const headers = sanitizedRegistrationHeaders(facts.auth.headers)
      if (authHeadersFingerprint(headers) === registeredAuthFingerprints.get(connectionId)) return
      cp.registerInstanceTransport(
        connectionId,
        url,
        headers,
        {
          transport: proxyTransport(registered.transport),
          ...(facts.spkiPin === undefined ? {} : { tls: { spkiPin: facts.spkiPin } }),
          ...(facts.tunnelAuthority === undefined ? {} : { authority: facts.tunnelAuthority }),
        },
      )
      registeredAuthFingerprints.set(connectionId, authHeadersFingerprint(headers))
      sm.appendLog(id, 'info', 'gateway session re-established — proxy registration refreshed with the new session')
    })
  }

  // publishRegistryTransition（原 main 2167-2246 / sidecar 1125-1214 逐字）：
  // 投影计算 / 来源代际同步 / journal 撤销 / reseed 调度 / committed push。
  const publishRegistryTransition = (
    before: readonly TransportInstanceSpec[],
    after: readonly TransportInstanceSpec[],
  ): ProjectedRegistryInstance[] => {
    const projected = projectNotificationSourceInstances(after)
    if (JSON.stringify(before) === JSON.stringify(after)) {
      return projected.map(projectInstanceSecrets)
    }
    const projectedSaved = projected.map(projectInstanceSecrets)

    const removedIds = computeRemovedInstanceIds(before, after)
    // Manual gateway-sync re-entry dies with the instance：a removed row must
    // never keep a registration a later gateway_plugin_sync(id) call could sync
    // against.
    for (const id of removedIds) {
      setGatewaySyncRegistration(id, null)
      host.sshPluginJournal.clear(id)
    }
    const retiredIds = computeRetiredInstanceIds(before, after)
    const afterById = new Map(after.map(instance => [instance.id, instance]))
    const reseedIds: string[] = []
    for (const previous of before) {
      const current = afterById.get(previous.id)
      if (current === undefined || operationalFingerprint(previous) !== operationalFingerprint(current)) {
        readySeedEdges.forget(previous.id)
        hostPackageSeeding.revoke(previous.id)
        // The plugin undo journal is bound to the OPERATIONAL target：id-stable
        // edit that changed host/user/service/home invalidates every op
        // recorded on the previous target（undo time 亦复验）。
        host.sshPluginJournal.clear(previous.id)
        if (current?.kind === 'dsh' && current.transport === 'ssh') reseedIds.push(previous.id)
      }
    }

    // 代际同步 + 队列退役丢弃 = syncNotificationSourceRegistry（core 导出）；
    // 活跃原生通知驱逐 = HostEdges.retireNotificationsForSources。
    const retiredNotificationSources = new Set(syncNotificationSourceRegistry(projected))
    if (retiredNotificationSources.size > 0) {
      host.retireNotificationsForSources(retiredNotificationSources)
    }

    // A service/home edit may complete while the transport is already ready：
    // 显式 reseed 替换 owner；普通重连由 ready 边缘拾取。
    for (const id of reseedIds) {
      if (sm.status(id)?.phase === 'ready') startAutomaticHostSeed(id)
    }

    pushCommitted(
      IPC_CHANNELS.SSH_INSTANCES_CHANGED,
      { removedIds, retiredIds },
      'registry renderer changed before push',
      'registry renderer push failed',
      'registry 已保存但 lifecycle push 失败（等待 renderer 重拉）：',
    )
    return projectedSaved;
  }

  return {
    chamberHostPackageSeeds,
    portableHostSeeds,
    hostPackageSeeding,
    readySeedEdges,
    sshPluginTargets: {
      findRemoteTarget,
      ownsRemoteTarget,
      scopedExecForTarget,
      scopedStatusForTarget,
      scopedProbeForTarget,
      liveProbeFor,
    },
    syncGatewayChamberPluginsFor,
    publishRegistryTransition,
    sessionRefresh,
    startAutomaticHostSeed,
    subscribeTransportStatus,
  }
}
