/**
 * host-assembly.ts —— Electron main（main.ts）与 Swift sidecar（sidecar-ctx.ts）共享的
 * 宿主装配单一实现：唯一 createHostAssembly(deps)，flavor 差异全部经 deps 显式注入
 * （日志 tag、edges 宿主腿、settings holder、gateway secret crypto 适配器、host 包源目录、
 * pnpm 入口、更新控制器/退出腿、固定锁文件叶、退出事实）。
 * 装配顺序与原 whenReady / buildHeadlessCtx 同序：启动前导 → registry/凭据/gateway →
 * host 包 seed 与 ssh 目标闭包束 → gateway 同步执行叶 → 状态订阅（先于任何平面调用）→
 * publishRegistryTransition → runtime 启动事务宿主 → ctx + spawn 门 + 启动尾部 + 回收腿 + 退出事实。
 * 不变式：零 electron import；plane 晚绑定；凭据值/cookie/会话体绝不进日志、registry 与
 * renderer 载荷（只传存在性投影与 non-secret 指纹）。
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { PlaneHandle } from '@dsh-chamber/control-plane'
import type { ChamberSettings } from './chamber-settings.ts'
import { writeSettingsFile } from './chamber-settings.ts'
import { IPC_CHANNELS } from './ipc-events.ts'
import {
  auditLogFilePath, captureNotificationSource, chamberSettingsFilePath, gatewaySecretsFilePath, instancesFilePath,
  LOCAL_RUNNING_STATES, localDshHomeDir, ownsNotificationSource, projectInstanceSecrets,
  projectNotificationSourceInstances, proxyTransport, readDshVersion, resolveActiveRuntime,
  RUNTIME_ABORT_REASON, sshPasswordsFilePath, syncNotificationSourceRegistry,
  type HostMessageOptions, type NotificationSourceToken, type ProjectedRegistryInstance,
  type ShellAssemblyCtx,
} from './shell-core.ts'
import { attemptCommittedRegistryPush, computeRemovedInstanceIds, computeRetiredInstanceIds, createTransportManager, type TransportManager } from './transport-manager.ts'
import { reconnectStaleTransports } from './transport-reconnect.ts'
import type { TransportInstanceSpec } from './transport-provider.ts'
import { cleanupStaleAskpassHelpers, configureSshPasswordStore, probeChamberHostLive, sshProvider } from './ssh-provider.ts'
import { configureGatewaySecretStore, configureGatewaySessionProvider, gatewayProvider, getGatewayPassword, getGatewayToken, syncGatewayChamberPlugins, type LocalChamberHostPackage, type SecretCryptoAdapter } from './gateway-provider.ts'
import { createGatewaySessionManager, gatewayRegistrationAuthHeaders, gatewaySessionScopeForConnection, type GatewayRegistrationAuthProof } from './gateway-session.ts'
import { createGatewaySessionRefresh, gatewaySessionOriginForUrl, gatewayTunnelAuthority, type GatewaySessionRefresh } from './gateway-session-refresh.ts'
import { appendAuditEvent, type AuditEvent } from './audit-log.ts'
import { createSshPluginJournal } from './ssh-plugin-journal.ts'
import { sanitizeErrorText } from './sanitize-error.ts'
import { describeError } from './describe-error.ts'
import { preserveFileAside } from './store-file-hygiene.ts'
import type { ChamberHostPackageDescriptor } from './control-plane-module.ts'
import type { ChamberHostPackageSeed, ExecFn, RemoteSpec, StatusFn } from './plugin-sync.ts'
import { ExactOwnershipRegistry, ReadyPhaseEdges, builtChamberHostPackageSeeds, chamberHostPackageSeedsFrom, disposePluginSyncChildren, portableChamberHostPackageSeeds, reapStaleLocalPluginWriters, remoteHome, scopeExecToOwnership, seedRemoteChamberHostPackages } from './plugin-sync.ts'
import { setGatewaySyncRegistration } from './gateway-sync-registry.ts'
import { RuntimeOperationFence, clearStorePruneRequest, detectRuntimeMetadataHealth, disposeRuntimeInstaller, invalidate, isSafeVersion, pruneRuntimeStore, readActivationJournalState, readStorePruneRequest, resetCandidateHealthWindow, writeActivationIntent, writeOverride, type RuntimeMetadataHealth, type StartupResult } from '@dsh-chamber/dsh-runtime'
import { createRuntimeStartupHost, type RuntimeStartupHostState } from './runtime-startup-host.ts'
import type { DshRuntimeController } from './dsh-runtime-controller.ts'

/** 宿主 edge 面（flavor 注入——Electron：mainWindow/dialog；Swift：node-edges/B 桥）。 */
export interface HostAssemblyEdges {
  rendererPush(channel: string, payload: unknown): boolean
  mainWindowAlive(): boolean
  retireNotificationsForSources(retiredSourceIds: ReadonlySet<string>): number
  /** 原生确认对话框 leg（返回按钮序号；无存活主窗由调用点预检；leg 抛错折算 'unavailable'）。 */
  showNativeMessage(opts: HostMessageOptions): Promise<number>
}

/** settings 内存 holder（persist 路径 <userData>/chamber-settings.json 由本模块单源提供；holder 本体归 flavor）。 */
export interface HostSettingsHolder {
  current(): ChamberSettings
  commit(next: ChamberSettings): void
}

/** createHostAssembly 的 flavor 输入（差异全部在此显式化，装配体内无 if(flavor)）。 */
export interface HostAssemblyDeps {
  /** 日志前缀（'[dsh-chamber]' / '[sidecar]'）——装配侧每条 loud 行共用。 */
  logTag: string
  /** <userData>（runtimeBaseDir 同值；两 flavor 各自解析来源）。 */
  userDataDir: string
  /** shell 版本（override/activation journal 的 shellVersion 判别必须与 core 读到的版本一致——shell-core 同法）。 */
  shellVersion: string
  builtinDshWorkspace: string | null
  /** 宿主 edge 面。 */
  edges: HostAssemblyEdges
  /** settings 内存 holder（load/reconcile 副作用留在 flavor 装配侧）。 */
  settings: HostSettingsHolder
  setKeepAwake: ShellAssemblyCtx['setKeepAwake']
  setLoginItem: ShellAssemblyCtx['setLoginItem']
  /** 退出在途事实（main：模块级 quitRequested；sidecar：本地 let）。 */
  isQuitting(): boolean
  /** 置位退出在途（dispose 第一步——与 flavor 自己的退出标志同源）。 */
  markQuitting(): void
  /** hostFacts 的 flavor 字段（controlPlaneUrl 由 flavor 在控制面起来后回填）。 */
  hostFacts: { flavor: ShellAssemblyCtx['hostFacts']['flavor']; trayPresent(): boolean }
  /** gateway secret store 加密适配器（Electron safeStorage；Swift 无 = undefined → 0600 plaintext 诚实 loud 回退）。 */
  gatewaySecretsCrypto?: SecretCryptoAdapter
  /** host 包源目录映射（key = 注册表包名；flavor 解析 app.isPackaged/repoRoot 或 --host-*-dir/moduleDir）。 */
  hostPackageSourceDirs: Record<string, string>
  /** runtime 安装器/sidecar 的 pnpm 入口（flavor 经 pnpm-launcher 解析后注入）。 */
  pnpmEntry: string
  updateController: ShellAssemblyCtx['updateController']
  /** 更新退出腿撤回叶（Electron 真实实现；Swift v1 显式 no-op）；reason 由 core 提供，必须原样转发。 */
  disarmUpdaterQuit(reason: string): void
  /** 退出确认的「更新已下载待装」豁免判据（Electron = downloaded 且 !blocked；Swift = downloaded/installing）。 */
  updateQuitExempt(): boolean
  /** 运行时线锚锁文件叶（flavor 路径解析）。 */
  pinnedRuntimeLockfilePath(): string | null
  /** 内建树缺失时启动尾部的静默窗（sidecar 1500ms；Electron 0 = 不延迟）。 */
  missingBuiltinStartupTailDelayMs?: number
  /** runtimeInstance 回填（Electron 的 will-quit 模块级 ref 可读性）。 */
  onRuntimeInstance?(instance: DshRuntimeController): void
}

/** 本地 dsh spawn 门（与 main 三闭包语义同源；flavor 无差异）。 */
export interface HostLocalSpawnGates {
  getDshWorkspacePath(): string
  canStartLocal(): { ok: true } | { ok: false; reason: string }
  canExposeLocal(): boolean
}

/** createHostAssembly 的产物（两 flavor 同一形状）。 */
export interface HostAssembly {
  ctx: ShellAssemblyCtx
  /** 本地 dsh spawn 门（见 HostLocalSpawnGates）。 */
  localSpawnGates: HostLocalSpawnGates
  /** runtime 模块级事务槽（will-quit / localSpawnGates / 启动事务共用同一实例）。 */
  runtimeState: RuntimeStartupHostState
  /** DshRuntimeController 现实例（启动尾部/lifecycle 投影共用）。 */
  runtimeInstance: DshRuntimeController
  runtimeBaseDir: string
  localDshHome: string
  /** 绑定控制面实例（plane 晚绑定：代理注册/会话 refresh/restart 宿主腿/connectionState 投影/onLocalStateChange 订阅），恰一次。 */
  bindPlane(plane: PlaneHandle): void
  /** 启动尾部（refreshRuntimeEvidence().then(runRuntimeStartup) + catch 折叠）——bindPlane 之后调用恰一次。 */
  runStartupTail(): Promise<void>
  /** 优雅回收腿（transport/插件子进程/安装器/在飞事务 + session refresh/gateway 会话清理）。 */
  dispose(): Promise<void>
  /** 关窗/退出事实投影输入（E1/E9/E20；决策纯函数在 chamber-settings）。 */
  quitFacts(): {
    windowCloseBehavior: ChamberSettings['windowCloseBehavior']
    quitConfirmation: boolean
    localRunning: boolean
    updateDownloadReady: boolean
  }
  /** OS 唤醒 → 重探陈旧 transport（判据在 transport-reconnect 单源）。 */
  reconnectStaleTransports(): void
}

/** 装配两个 flavor 共用的宿主。async：启动前导先回收本地插件写进程账目（stale writer 证明先于任何本地 spawn/写路径）。 */
export async function createHostAssembly(deps: HostAssemblyDeps): Promise<HostAssembly> {
  const { logTag } = deps
  const runtimeBaseDir = deps.userDataDir
  const localDshHome = localDshHomeDir(runtimeBaseDir)
  const shellVersion = deps.shellVersion
  const builtinDshWorkspace = deps.builtinDshWorkspace
  const runtimeWriterFence = new RuntimeOperationFence()
  // 模块级事务槽与宿主门状态（事务槽归装配侧：启动事务/自动回滚直接读写）。
  const runtimeState: RuntimeStartupHostState = {
    startBlocked: true,
    startBlockedReason: '正在确认 dsh 运行时安全状态',
    internalStart: false,
    transactionWorkspace: null,
    operation: null,
    operationAbort: null,
  }
  const planeRef: { current: PlaneHandle | null } = { current: null }
  const plane = (): PlaneHandle | null => planeRef.current
  const envOverrideActive = Boolean(process.env.DSH_CHAMBER_DSH_PATH)
  // Windows runtime mutations stay read-only（两 flavor 同表达式，防御一致）。
  const runtimeManagementSupported = process.platform !== 'win32'
    || process.env.DSH_CHAMBER_WINDOWS_RUNTIME_MUTATIONS === '1'
  const bundledVersion = readDshVersion(builtinDshWorkspace)
  const stalePluginWriter = await reapStaleLocalPluginWriters(localDshHome)
  const runtimeBootstrapWriterUnsafe = !stalePluginWriter.ok
  let runtimeBootstrapFailure: string | null = stalePluginWriter.ok
    ? null
    : `无法证明旧的本地插件写进程已回收：${stalePluginWriter.error}`

  let startupMetadataHealth: RuntimeMetadataHealth | null = null
  try {
    startupMetadataHealth = detectRuntimeMetadataHealth(runtimeBaseDir, shellVersion)
  } catch (error) {
    runtimeBootstrapFailure = `无法检查 dsh 运行时选择元数据：${sanitizeErrorText(describeError(error))}`
  }
  // A shell-version fallback is itself a runtime/data switch：持久化内建激活意图
  // 先于 override invalidation，崩溃不得无快照回内建。健康快照只取一次（启动
  // TOCTOU 与恶意硬链接/符号链接都不得在健康检查拒绝后再触达收紧副作用）。
  const startupOverrideState = startupMetadataHealth?.override ?? { kind: 'corrupt' as const }
  const startupPointerState = startupMetadataHealth?.current ?? { kind: 'corrupt' as const }
  const bootstrapMetadataCorrupt = startupOverrideState.kind === 'corrupt'
    || startupPointerState.kind === 'corrupt'
  if (runtimeBootstrapFailure !== null) {
    // Writer ownership outranks runtime-selection mutation：stale 进程证明前保留每一个指针/journal 字节。
  } else if (startupMetadataHealth?.status === 'recovery-in-progress') {
    runtimeBootstrapFailure = 'dsh 运行时元数据恢复事务未完成；已隔离本地实例并将在启动事务中续作'
  } else if (startupMetadataHealth?.status === 'selection-corrupt') {
    runtimeBootstrapFailure = 'dsh runtime 选择元数据损坏；已阻止本地实例启动'
  } else if (startupMetadataHealth?.status === 'recovery-marker-corrupt') {
    runtimeBootstrapFailure = 'dsh runtime 元数据恢复标记损坏；已阻止本地实例启动'
  } else if (startupOverrideState.kind === 'corrupt') {
    runtimeBootstrapFailure = 'dsh runtime override metadata 损坏；已阻止本地实例启动'
  } else if (startupPointerState.kind === 'corrupt') {
    runtimeBootstrapFailure = 'dsh runtime current pointer 损坏；已阻止本地实例启动'
  } else if (
    runtimeManagementSupported
    && !envOverrideActive
    && startupOverrideState.kind === 'valid'
    // A newly observed shell-version mismatch starts the fallback transaction；durable
    // invalidation 已落定的不重复造事务；EXCEPTION = 指针悬在旧树且 journal 丢失的 stranded 首事务。
    && (
      (startupOverrideState.record.invalidatedAt == null
        && startupOverrideState.record.shellVersion !== shellVersion)
      || (startupOverrideState.record.invalidatedAt != null
        && startupPointerState.kind === 'valid'
        && readActivationJournalState(runtimeBaseDir).kind === 'missing')
    )
  ) {
    if (bundledVersion === null || !isSafeVersion(bundledVersion)) {
      runtimeBootstrapFailure = '无法确认内建 dsh 运行时版本；拒绝执行 shell 更新回落'
    } else {
      try {
        writeActivationIntent(runtimeBaseDir, {
          targetVersion: bundledVersion,
          targetIsBuiltin: true,
          manualRollback: false,
          intentKind: 'shell-invalidation',
        })
        if (startupOverrideState.record.invalidatedAt == null) {
          writeOverride(
            runtimeBaseDir,
            invalidate(startupOverrideState.record, `shell updated to ${shellVersion}`),
          )
        }
      } catch (error) {
        runtimeBootstrapFailure = `无法持久化 shell 更新回落事务：${sanitizeErrorText(describeError(error))}`
      }
    }
  }

  // —— 装配序（与抽取前同向）——
  // ssh plugin undo journal 现实例（文件 <userData>/ssh-plugin-journal.json；publish 叶的撤销清理与 undo/apply 共用同一实例）。
  const sshPluginJournal = createSshPluginJournal(runtimeBaseDir, {
    log: (...args) => console.log(logTag, ...args),
    warn: (...args) => console.warn(logTag, ...args),
  })

  // askpass 崩溃残留回收（清理 crash 遗留的密码载体助手；纯 Node 叶，同模块同参）。
  const askpassNotice = cleanupStaleAskpassHelpers()
  if (askpassNotice !== null) console.error(`${logTag} ${askpassNotice}`)

  // registry 现实例先占位：凭据存储配置期只持有惰性解析器（transportManager 赋值后按引用共享）。
  let transportManager: TransportManager | null = null
  const resolveCredentialSpec = (id: string): TransportInstanceSpec | null =>
    transportManager?.listInstances().find(instance => instance.id === id) ?? null

  // SSH password store（0600/原子写/损坏 loud 保留）：<userData>/ssh-passwords.json。
  // 凭据值绝不进 registry/日志/渲染器（write-only、绝不回读）。
  const passwordNotice = configureSshPasswordStore(sshPasswordsFilePath(runtimeBaseDir), resolveCredentialSpec)
  if (passwordNotice !== null) console.error(`${logTag} ssh password store: ${passwordNotice}`)

  // Gateway credentials store（schema v3, 0600, 原子写）：Electron 经 safeStorage 适配器
  // 加密镜像；Swift 无 safeStorage → 非 win32 = 0600 plaintext 诚实 loud 回退（renderer 可见
  // secretStorage:'plaintext'），win32 = memory-only（file null）拒绝明文。
  const windowsRefusePlaintext = process.platform === 'win32' && deps.gatewaySecretsCrypto === undefined
  if (deps.gatewaySecretsCrypto === undefined) {
    if (windowsRefusePlaintext) {
      // win32 无 DPAPI：loud 拒绝而非 plaintext 回退；gateway 凭据仅本次会话内存驻留。
      console.error(`${logTag} Windows safeStorage (DPAPI) 不可用 — 拒绝明文镜像回退 (design 21 C16)；gateway 凭据仅本次会话内存驻留，每次连接需重录`)
    } else {
      // OS keychain 不可用 → 回退到文档化的 0600 plaintext 镜像：LOUD 注册（绝不静默）
      // + renderer 可见投影（instances_get 合并 secretStorage:'plaintext'），设置页明示回退路径。
      console.warn(`${logTag} OS keychain (Electron safeStorage) is unavailable — gateway credentials will be mirrored to the 0600 plaintext file fallback (design 17 §12/S22)`)
    }
  }
  const gatewaySecretNotice = configureGatewaySecretStore(
    windowsRefusePlaintext ? null : gatewaySecretsFilePath(runtimeBaseDir),
    deps.gatewaySecretsCrypto,
    resolveCredentialSpec,
  )
  if (gatewaySecretNotice !== null) console.error(`${logTag} gateway secrets store: ${gatewaySecretNotice}`)

  // Gateway password-session manager（纯主进程内存；注册体的 invalidation 直接面）：
  // configureGatewaySessionProvider 六钩子全量接线（ssh 隧道与 http 直连双形态共用）。
  const gatewaySessions = createGatewaySessionManager()
  configureGatewaySessionProvider({
    ensureSession: (origin, password) => gatewaySessions.ensureSession(origin, password),
    generation: origin => gatewaySessions.generation(origin),
    registrationAuthProof: origin => gatewaySessions.registrationAuthProof(origin),
    setRegistrationAuthProof: (origin, proof) => gatewaySessions.setRegistrationAuthProof(origin, proof),
    cachedCookie: origin => gatewaySessions.cachedCookie(origin),
    invalidate: origin => gatewaySessions.invalidate(origin),
  })

  // 非秘密审计叶（JSONL append + 5 MiB 轮换, 0600）：序列化白名单/凭据值绝不入日志的
  // 纪律在 serializeAuditEvent（control-plane 审计单源）——本叶只做文件绑定。
  const audit = (event: AuditEvent): void => appendAuditEvent({ file: auditLogFilePath(runtimeBaseDir) }, event)

  // Transport manager：provider 缺省 = sshProvider（legacy kind-keyed 条目解析）；providers
  // 按 TRANSPORT 注册 {ssh, http}；instancesFile = <userData>/ssh-instances.json。
  const created = createTransportManager({
    provider: sshProvider,
    providers: { ssh: sshProvider, http: gatewayProvider },
    instancesFile: instancesFilePath(runtimeBaseDir),
    logger: {
      log: (...args) => console.log('[transport-manager]', ...args),
      warn: (...args) => console.warn('[transport-manager]', ...args),
      error: (...args) => console.error('[transport-manager]', ...args),
    },
  })
  transportManager = created
  const sm = created
  try {
    sm.loadInstances()
  } catch (loadError) {
    // Corrupt instance file: loud failure — PRESERVE it as *.corrupt (reversible) before
    // starting empty; the next save_connection rebuilds the registry (never faked as empty).
    console.error(`${logTag} 加载 SSH 实例失败：`, loadError)
    const file = instancesFilePath(runtimeBaseDir)
    const aside = preserveFileAside(file, '.corrupt')
    if (aside.ok) console.warn(`${logTag} 已保留损坏的实例文件为 ${aside.path}`)
    else console.error(`${logTag} 保留损坏实例文件失败：`, aside.error)
  }
  // 初始来源代际同步（installIpcHandlers 之前建立首代证明——先 sync 后 handler 注册）。
  syncNotificationSourceRegistry(projectNotificationSourceInstances(sm.listInstances()))

  // Transport-manager 执行/状态投影面（plugin-sync 经结构等价收窄别名桥接）。
  const execTransport = sm.exec as unknown as ExecFn
  const statusTransport: StatusFn = (id) => sm.status(id)
  // 插件管理面实例级恒等指纹（registry 变更生命周期与 F 组目标闭包共用）。
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
  // Audit transition dedupe（PHASE TRANSITIONS only）。
  const lastAuditedPhase = new Map<string, string>()
  const auditRegistered = new Set<string>()

  // —— live-proxy 会话自愈：仅存非秘密 sha256 指纹（headers VALUES 绝不进 map）；
  // register/onVerified 两条路径共用同一事实（否则 refresh 重注册后指纹门失效）。
  const registeredAuthFingerprints = new Map<string, string>()
  const authHeadersFingerprint = (headers: Record<string, string> | undefined): string => {
    const canonical = headers === undefined
      ? 'none'
      : Object.keys(headers).sort().map(key => `${key}:${headers[key]}`).join('|')
    return createHash('sha256').update(canonical).digest('hex')
  }
  const sanitizedRegistrationHeaders = (headers: Record<string, string>): Record<string, string> | undefined =>
    Object.keys(headers).length === 0 ? undefined : headers
  // Live-proxy 会话自愈控制器（gateway-session-refresh.ts 零 electron——时钟/计时器注入
  // 为纯 Node 缺省）；ready 注册 arm / 离开 ready disarm / onVerified 指纹重注册接线在下方，
  // register 腿 = plane → registerInstanceTransport（隧道 Host authority 覆盖 + 指纹锁步）。
  const sessionRefresh: GatewaySessionRefresh = createGatewaySessionRefresh({
    sessionManager: gatewaySessions,
    passwordFor: id => getGatewayPassword(id),
    tokenFor: id => getGatewayToken(id),
    readyUrlFor: id => sm.readyUrl(id),
    tlsPinFor: id => sm.listInstances().find(instance => instance.id === id)?.spkiPin ?? null,
    // Tunnel Host override：ssh 隧道 gateway 目标以远端 LOOPBACK 权威重注册——Host 头/
    // 稳定 connection-target scope/网络 origin 与 verifyUp-minted session key 同构。
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
      const livePlane = plane()
      const registered = sm.listInstances().find(instance => instance.id === id)
      if (livePlane !== null) livePlane.registerInstanceTransport(`gateway:${id}`, url, headers, {
        ...(registered === undefined ? {} : { transport: proxyTransport(registered.transport) }),
        ...(tls === undefined ? {} : tls),
        ...(authority === undefined ? {} : { authority }),
      })
      // Keep the registered-auth fingerprint in lockstep：refresh 重注册 REPLACES 代理
      // headers——指纹门须认已轮换 cookie，否则下次 ready 探针无条件再注册（撤销在途流量）。
      registeredAuthFingerprints.set(`gateway:${id}`, authHeadersFingerprint(
        headers === undefined ? undefined : sanitizedRegistrationHeaders(headers),
      ))
    },
    // Bounded dead-cookie recovery：disconnect（idle → 控制面注销 + disarm）→ connect
    //（verifyUp 用存储密码重认证）；每次 refresh 至多一次、仅 transport 仍 ready 且同
    // origin；抛错绝不击穿 refresh 控制器。
    reconnect: (id) => {
      try {
        sm.disconnect(id)
        sm.connect(id)
      } catch (error) {
        console.warn(`${logTag} session-refresh recovery reconnect failed for ${id}: ${String(error)}`)
      }
    },
    warn: message => console.warn(`${logTag} ${message}`),
  })

  // —— chamber host 包种子数组（注册表驱动）——
  // sourceDir 由 flavor 的 hostPackageSourceDirs 提供；构造点单源化在 plugin-sync
  // .chamberHostPackageSeedsFrom：非 localOnly 行缺 sourceDir 直接 throw（绝不静默少域）；
  // localOnly 行（open-in）sourceDir 恒空，「哪一行可去别的机器」只由 portable 判定。
  const chamberHostPackageSeeds: ChamberHostPackageSeed[] =
    chamberHostPackageSeedsFrom(deps.hostPackageSourceDirs)

  // 可移植（非 localOnly）seed 列表：规则取自单一实现 portableChamberHostPackageSeeds，flavor 不自带过滤判定。
  const portableHostSeeds = portableChamberHostPackageSeeds(chamberHostPackageSeeds)

  // Exact-incarnation single-flight for ready/manual seeds（changed same-id target 立即 supersede；stale finally/log/result 不清理其替换者）。
  const hostPackageSeeding = new ExactOwnershipRegistry()
  const readySeedEdges = new ReadyPhaseEdges()
  // Remote install-level fallback path shared by both chamber host packages.
  const remoteHostPackageDir = (spec: RemoteSpec, packageName: string): string =>
    `${remoteHome(spec.remoteDshHome)}/profiles/node_modules/${packageName}`

  // —— ssh 插件管理目标闭包束：目标 = spec + operational fingerprint + 来源代际 token（owns 复验与来源证明同一代际面）。——
  type RemoteTarget = {
    spec: RemoteSpec
    fingerprint: string
    sourceToken: NotificationSourceToken
  }
  const findRemoteTarget = (id: string): RemoteTarget | null => {
    const instance = sm.listInstances().find((entry) => entry.id === id)
    if (instance === undefined || instance.kind !== 'dsh' || instance.transport !== 'ssh') return null
    const sourceToken = captureNotificationSource(`${instance.kind}-${instance.id}`)
    if (sourceToken === null) return null
    return {
      spec: { id: instance.id, remoteDshHome: instance.remoteDshHome ?? null },
      fingerprint: operationalFingerprint(instance),
      sourceToken,
    }
  }
  const ownsRemoteTarget = (target: RemoteTarget): boolean =>
    ownsNotificationSource(target.sourceToken)
    && findRemoteTarget(target.spec.id)?.fingerprint === target.fingerprint
  const scopedExecForTarget = (target: RemoteTarget, extraOwner: () => boolean = () => true): ExecFn =>
    scopeExecToOwnership(execTransport, target.spec.id, () => extraOwner() && ownsRemoteTarget(target))
  const scopedStatusForTarget = (target: RemoteTarget): StatusFn => id =>
    id === target.spec.id && ownsRemoteTarget(target) ? statusTransport(id) : null
  const scopedProbeForTarget = (
    target: RemoteTarget,
    probe: (descriptor: ChamberHostPackageDescriptor) => Promise<boolean | null>,
  ): ((descriptor: ChamberHostPackageDescriptor) => Promise<boolean | null>) => async (descriptor) => {
    if (!ownsRemoteTarget(target)) return null
    const result = await probe(descriptor)
    return ownsRemoteTarget(target) ? result : null
  }
  // Live-effect probe for the chamber host packages：单个通用隧道 RPC 探针，由控制面注册表
  // 自带的 probe 描述子（method + args）驱动——每包无专用分支。无 ready 隧道 → null = 未探测。
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
  // 自动 chamber host seed（单飞注册表 begin/owns/finish + 构建产物 existsSync 过滤 +
  // seedRemoteChamberHostPackages 幂等注入）；自动路径与手动 seed 注册体共用同一数组/注册表/闭包。
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
        // 已构建判定与 main/shell-core 同一实现（空 sourceDir 绝不解析进程 CWD 的 dist/index.js；localOnly 不算缺件）。
        const builtSeeds = builtChamberHostPackageSeeds(portableHostSeeds)
        if (builtSeeds.length === 0) {
          if (ownsSeed()) console.log(`${logTag} chamber host seed skipped for ${id}: no built host package artifacts`)
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
          console.log(`${logTag} chamber host packages seeded onto ${id} (${seeded}; wrote=${result.wrote}, patched=${result.patched})`)
          const packageSummary = result.packages.map(entry =>
            `${entry.insertId}${entry.wrote ? ' 已写入' : ' 已是最新'}（${remoteHostPackageDir(target.spec, entry.packageName)}）`).join('；')
          appendSeedLog('info', `chamber host 包注入完成：${packageSummary}；boot 层${result.patched ? '已合并挂载' : '无需改动'}（重启后生效）`)
        } else {
          console.warn(`${logTag} chamber host seed failed for ${id}: ${result.error}`)
          appendSeedLog('error', `chamber host 包注入失败：${result.error}`)
        }
      } catch (err) {
        if (!ownsSeed()) return
        const detail = describeError(err)
        console.warn(`${logTag} chamber host seed error for ${id}: ${detail}`)
        appendSeedLog('error', `chamber host 包注入异常：${detail}`)
      } finally {
        hostPackageSeeding.finish(token)
      }
    })()
  }

  // —— 本地 chamber host 包源 + 手动 gateway 同步执行闭包 ——
  // 只遍历 portableHostSeeds，本地专属行绝不进 gateway 上传；缺目录 = 响亮跳过（绝不静默少上传一个域）。
  const localChamberHostPackageSources = (): Array<{ name: string; packageJsonPath: string; distIndexPath: string }> => {
    return portableHostSeeds.flatMap(seed => {
      const dir = deps.hostPackageSourceDirs[seed.packageName]
      if (dir === undefined || dir === '') {
        console.warn(
          `${logTag} chamber host 包 ${seed.packageName} (${seed.insertId}) 缺源目录：`
          + '它不会被上传到 gateway seed 缓存，gateway 形态实例的对应宿主域会 404 且界面无提示',
        )
        return []
      }
      return [{
        name: seed.packageName,
        packageJsonPath: path.join(dir, 'package.json'),
        distIndexPath: path.join(dir, 'dist', 'index.js'),
      }]
    })
  }
  // Resolves the awaited sync outcome for the caller（手动 gateway_plugin_sync IPC）or null
  // when the instance is missing / no longer a gateway；ready-registration 调用点保留 fire-and-forget。
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
        // Not built/bundled in this runtime — still loud：静默跳过会表现成「gateway 缺少 chamber host 包」而无诊断。
        console.warn(
          `${logTag} chamber host package source skipped (${source.name}): ${sanitizeErrorText(describeError(error))}`,
        )
      }
    }
    return syncGatewayChamberPlugins({
      // Sync through the REGISTERED transport origin (the ready URL)：ssh 隧道 = 用户
      // 验证过的 loopback 端点，绝非远端 host:port；authority 覆盖呈现远端 gateway。
      origin: url,
      authority: instance.transport === 'ssh' ? gatewayTunnelAuthority(instance.remotePort) : undefined,
      headers,
      spkiPin,
      packages,
      logger: { warn: message => console.warn(message), log: message => console.log(message) },
    })
  }

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
        if (url !== null) {
          if (status.kind === 'gateway') {
            const registered = sm.listInstances().find(instance => instance.id === id)
            const facts = currentGatewayAuth(id, url, registered)
            const auth = facts.auth
            if (!auth.ok) {
              // Fail closed on the verify→ready→register TOCTOU：密码 gateway 绝不因 cookie
              // 在间隙被逐/失效而无头注册；有 token 时允许有意的 OR-principal bearer 回退。
              cp.unregisterInstanceTransport(`${status.kind}:${id}`)
              registeredAuthFingerprints.delete(`${status.kind}:${id}`)
              sessionRefresh.disarm(id)
              sm.appendLog(id, 'warn', 'gateway session changed before proxy registration; re-authenticating')
              // 只捕获 scope 进恢复 microtask——绝不闭包整个 facts（auth.headers 载 cookie）。
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
            const connectionId = `${status.kind}:${id}`
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
            // 每次 gateway ready 注册后 best-effort 把本地 chamber host 包 sync 进 gateway
            // seed cache（幂等：仅版本失配重传）；手动 sync re-entry 参数经
            // setGatewaySyncRegistration 落注册表——删除/离开 ready 撤销同表。
            setGatewaySyncRegistration(id, { url, headers: { ...auth.headers }, spkiPin: facts.spkiPin ?? null })
            void syncGatewayChamberPluginsFor(id, url, auth.headers, facts.spkiPin ?? null)
          } else {
            cp.registerInstanceTransport(`${status.kind}:${id}`, url, undefined, {
              transport: proxyTransport(status.transport),
            })
            registeredAuthFingerprints.set(`${status.kind}:${id}`, authHeadersFingerprint(undefined))
          }
          // Live-proxy session self-healing：ready 注册即 arm 预到期 refresh（无密码目标
          // no-op、重连后新隧道 origin 下幂等 re-arm）；dsh 目标无 auth 面 → 不 refresh。
          if (status.kind === 'gateway') sessionRefresh.arm(id)
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
        cp.unregisterInstanceTransport(`${status.kind}:${id}`)
        registeredAuthFingerprints.delete(`${status.kind}:${id}`)
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
    if (deps.edges.mainWindowAlive()) {
      const pushed = attemptCommittedRegistryPush(() => {
        if (!deps.edges.mainWindowAlive()) {
          throw new Error('status renderer changed before push')
        }
        if (!deps.edges.rendererPush(IPC_CHANNELS.SSH_STATUS_CHANGED, { id, status })) {
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
    const registered = sm.listInstances().find(instance => instance.id === id)
    if (url === null || registered === undefined || registered.kind !== 'gateway') return
    const facts = currentGatewayAuth(id, url, registered)
    // Fail closed like the ready registration.
    if (!facts.auth.ok) return
    const connectionId = `gateway:${id}`
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

  /**
   * Finish every committed registry transition through the source-lifecycle authority：旋转
   * renderer/native-notification 证明、撤销精确 plugin-seed owner、发布 committed roster。
   * 证明投影/代际同步/队列退役清理在 shell-core；活跃原生通知退役经
   * edges.retireNotificationsForSources。元数据/secret 持久化归事务（connection-save.ts）。
   */
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
    // Manual gateway-sync re-entry dies with the instance：removed 行绝不保留后续还能同步的注册。
    for (const id of removedIds) {
      setGatewaySyncRegistration(id, null)
      sshPluginJournal.clear(id)
    }
    const retiredIds = computeRetiredInstanceIds(before, after)
    const afterById = new Map(after.map(instance => [instance.id, instance]))
    const reseedIds: string[] = []
    for (const previous of before) {
      const current = afterById.get(previous.id)
      if (current === undefined || operationalFingerprint(previous) !== operationalFingerprint(current)) {
        readySeedEdges.forget(previous.id)
        hostPackageSeeding.revoke(previous.id)
        // 插件 undo journal 绑定在 OPERATIONAL 目标上：id 稳定的 host/user/service/home 编辑
        // 使旧目标上的每条 op 失效——这里与 undo 时（latestOkForTarget）都清。
        sshPluginJournal.clear(previous.id)
        // service/home 编辑后仍是 dsh+ssh 目标的同 id 替换 → 若已完成即显式 reseed（普通重连由 ready 边缘拾取）。
        if (current?.kind === 'dsh' && current.transport === 'ssh') reseedIds.push(previous.id)
      }
    }

    const retiredNotificationSources = new Set(syncNotificationSourceRegistry(projected))
    if (retiredNotificationSources.size > 0) {
      deps.edges.retireNotificationsForSources(retiredNotificationSources)
    }

    // A service/home edit may complete while the transport is already ready：显式 seed 替换
    // owner（仅 ready 实例可达：startAutomaticHostSeed 经 findRemoteTarget + 单飞注册表）。
    for (const id of reseedIds) {
      if (sm.status(id)?.phase === 'ready') startAutomaticHostSeed(id)
    }

    // Committed lifecycle push（{removedIds, retiredIds} 文本被 renderer-trust 锚定；窗口门 =
    // edges.mainWindowAlive，push 前竞态复查；无窗口常驻期间由下次查询兜底）。
    if (deps.edges.mainWindowAlive()) {
      const pushed = attemptCommittedRegistryPush(() => {
        if (!deps.edges.mainWindowAlive()) {
          throw new Error('registry renderer changed before push')
        }
        if (!deps.edges.rendererPush(IPC_CHANNELS.SSH_INSTANCES_CHANGED, { removedIds, retiredIds })) {
          throw new Error('registry renderer push failed')
        }
      })
      if (!pushed.sent) {
        console.warn(`${logTag} registry 已保存但 lifecycle push 失败（等待 renderer 重拉）：${pushed.error}`)
      }
    }
    return projectedSaved;
  }

  // —— dsh runtime 管理宿主 ——
  // pnpm 入口由 flavor 经 pnpm-launcher 单源解析后注入；node 执行器两 flavor 同表达式：
  // 有 electron 时给 EVERY pnpm child 注入 ELECTRON_RUN_AS_NODE 分支（install 与 store-prune）。
  let storePruneOperation: Promise<void> | null = null
  const runtimeNodeExecutor = (): { file: string; args: string[]; env: Record<string, string> } =>
    process.versions.electron !== undefined
      ? { file: process.execPath, args: ['--expose-internals'], env: { ELECTRON_RUN_AS_NODE: '1' } }
      : { file: process.execPath, args: [], env: {} }
  const runStorePruneIfNeeded = (): Promise<void> => {
    if (storePruneOperation !== null) return storePruneOperation
    if (deps.isQuitting() || readStorePruneRequest(runtimeBaseDir) === null) return Promise.resolve()
    const operation = pruneRuntimeStore({ baseDir: runtimeBaseDir, pnpmEntry: deps.pnpmEntry, deps: { node: runtimeNodeExecutor } })
      .then(() => { clearStorePruneRequest(runtimeBaseDir) })
      .catch((error) => {
        // Retain the marker: the next safe startup/operation retries; prune failure is disk hygiene, never a gate.
        console.error(`${logTag} dsh runtime store prune failed:`, sanitizeErrorText(describeError(error)))
      })
      .finally(() => {
        if (storePruneOperation === operation) storePruneOperation = null
      })
    storePruneOperation = operation
    return operation
  }

  // —— DshRuntimeController 现实例（ControllerOptions + DI 全参；K 组注册体与启动/证据路径共用）。——
  const runtimeHost = createRuntimeStartupHost({
    logTag,
    rendererPush: (channel, payload) => deps.edges.rendererPush(channel, payload),
    windowAlive: () => deps.edges.mainWindowAlive(),
    isQuitting: () => deps.isQuitting(),
    settings: {
      get registryOrigin() { return deps.settings.current().registryOrigin },
    },
    plane: {
      connectionState: () => plane()?.connectionState ?? null,
      localWritersQuiescent: () => plane()?.localWritersQuiescent ?? false,
      localProcessAlive: () => plane()?.localProcessAlive ?? false,
      localDshPort: () => plane()?.localDshPort ?? null,
      seededProbeDomains: () => plane()?.seededProbeDomains ?? [],
      startLocal: () => plane()?.startLocal(),
      stopLocal: () => plane()?.stopLocal() ?? Promise.resolve(),
      refreshLocalExposure: () => plane()?.refreshLocalExposure(),
    },
    state: runtimeState,
    writerFence: runtimeWriterFence,
    runtimeBaseDir,
    localDshHome,
    builtinDshWorkspace,
    shellVersion,
    bundledVersion,
    envOverrideActive,
    runtimeManagementSupported,
    runtimeBootstrapFailure,
    runtimeBootstrapWriterUnsafe,
    bootstrapMetadataCorrupt,
    pnpmEntry: deps.pnpmEntry,
    runtimeNodeExecutor,
    runStorePruneIfNeeded,
    onRuntimeInstance: deps.onRuntimeInstance,
  })
  const {
    runtimeInstance,
    refreshRuntimeEvidence,
    setRuntimeGate,
    publishBlockedStartup,
    runRuntimeStartup,
    runRestartExhaustedRollback,
    authoritativeMetadataRecoveryStatus,
    runUserMetadataRecovery,
    runtimeActionAllowed,
    readApplyNowGateInput,
    selectedJournalIntent,
  } = runtimeHost

  // H 组本地插件执行叶（runtime writer fence 租约 + runtimeState.startBlocked 启动门 +
  // resolveActiveRuntime 解析；workspace 只在 fence 租约内解析，绝不跨 runtime swap 保留）。
  const runLocalPluginMutation = async <T>(
    owner: string,
    mutate: (dshWorkspace: string) => Promise<T>,
  ): Promise<T | { ok: false; error: string }> => {
    const lease = runtimeWriterFence.tryAcquire(owner)
    if (lease === null) return { ok: false, error: 'dsh runtime/data operation in progress' }
    try {
      if (runtimeState.startBlocked) return { ok: false, error: runtimeState.startBlockedReason }
      const resolved = resolveActiveRuntime(runtimeBaseDir, builtinDshWorkspace)
      if (resolved.path === null) return { ok: false, error: resolved.blockedReason ?? 'dsh workspace not found' }
      return await mutate(resolved.path)
    } finally {
      lease.release()
    }
  }

  // —— ctx 完成形态（ShellAssemblyCtx 全字段真实；两 flavor 同形状）。——
  const ctx: ShellAssemblyCtx = {
    hostFacts: {
      flavor: deps.hostFacts.flavor,
      controlPlaneUrl: '',
      platform: process.platform,
      trayPresent: () => deps.hostFacts.trayPresent(),
    },
    runtimeFacts: {
      dshVersion: () => resolveActiveRuntime(runtimeBaseDir, builtinDshWorkspace).version,
    },
    settingsIO: {
      current: () => deps.settings.current(),
      commit: next => deps.settings.commit(next),
      persist: next => writeSettingsFile(chamberSettingsFilePath(runtimeBaseDir), next),
    },
    setKeepAwake: enabled => deps.setKeepAwake(enabled),
    setLoginItem: enabled => deps.setLoginItem(enabled),
    isQuitting: () => deps.isQuitting(),
    transportManager: sm,
    audit,
    gatewaySessions,
    publishRegistryTransition,
    confirmRegistryOriginSwitch: async (currentOrigin, nextOrigin) => {
      // registryOrigin 切换确认（SETTINGS_SET——信任边界变更需原生用户确认）。文案/按钮/
      // 默认序单源在本模块；宿主腿 = edges.showNativeMessage。无存活主窗预检 =
      // edges.mainWindowAlive；预检与调用间窗口销毁的竞态 = 腿抛错 → loud + 折算 'unavailable'。
      if (!deps.edges.mainWindowAlive()) return 'unavailable' as const
      try {
        const response = await deps.edges.showNativeMessage({
          type: 'warning',
          title: '切换 dsh 运行时版本源？',
          message: '切换 dsh 运行时版本源？',
          detail: `版本检查、下载与安装的信任边界将从\n${currentOrigin}\n切换到\n${nextOrigin}`,
          buttons: ['取消', '切换版本源'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        })
        return response === 1 ? ('confirmed' as const) : ('cancelled' as const)
      } catch (err) {
        console.error(`${logTag} registryOrigin 切换确认失败（按不可用处理）：${String(err)}`)
        return 'unavailable' as const
      }
    },
    localDshHome,
    sshPluginJournal,
    hostPackageSeeding,
    chamberHostPackageSeeds,
    sshPluginTargets: {
      findRemoteTarget,
      ownsRemoteTarget,
      scopedExecForTarget,
      scopedStatusForTarget,
      scopedProbeForTarget,
      liveProbeFor,
    },
    syncGatewayChamberPluginsFor,
    runLocalPluginMutation,
    updateController: deps.updateController,
    runtimeController: runtimeInstance,
    runtimeOperationBusy: () => runtimeState.operation !== null,
    runtimeWriterFence,
    runtimeActionAllowed,
    runtimeBaseDir,
    refreshRuntimeEvidence,
    runStorePruneIfNeeded,
    restartLocalDsh: async () => {
      // PlaneHandle 宿主腿（null 门 + restartLocal() + resolve 后实时 connectionState 读；resolve ≠ success 判据留 core）。
      const livePlane = plane()
      if (livePlane === null) throw new Error('control plane not initialized')
      await livePlane.restartLocal()
      return livePlane.connectionState
    },
    runRuntimeStartup,
    publishBlockedStartup,
    setRuntimeGate,
    authoritativeMetadataRecoveryStatus,
    runUserMetadataRecovery,
    readApplyNowGateInput,
    selectedJournalIntent,
    stopLocalDsh: async () => {
      const livePlane = plane()
      if (livePlane === null) throw new Error('control plane not initialized')
      await livePlane.stopLocal()
    },
    runtimeOperationSlot: {
      begin: (operation: Promise<StartupResult | null>) => { runtimeState.operation = operation },
      end: () => { runtimeState.operation = null },
      inFlight: () => runtimeState.operation,
    },
    bundledRuntimeVersion: bundledVersion,
    builtinDshWorkspacePath: builtinDshWorkspace,
    // 插件受保护集合判定：core 的 localProtectionFacts 需要内建工作区路径与运行时线锚锁文件路径叶。
    pinnedRuntimeLockfilePath: () => deps.pinnedRuntimeLockfilePath(),
    // 更新退出腿回撤叶（**不能省略**：core 的 I 组状态订阅在每个非 downloaded 相位都调
    // disarmUpdaterQuit?.(...)，省略会让首次「检查更新」在订阅回调里抛错、headless checking
    // 卡死）；Electron = 真实撤回，Swift v1 = 显式惰性 no-op。
    disarmUpdaterQuit: (reason: string) => deps.disarmUpdaterQuit(reason),
  }

  // —— 装配面返回：本地 spawn 门 + plane 晚绑定 + 启动尾部 + 优雅回收腿 ——

  // 本地 dsh spawn 门（事务特权 workspace 优先、writers quiescent 门 + startBlocked &&
  // !internalStart 公共门、canExposeLocal = !startBlocked；实时读 plane() 自身状态）。
  const localSpawnGates: HostLocalSpawnGates = {
    getDshWorkspacePath: () => {
      if (runtimeState.transactionWorkspace !== null) return runtimeState.transactionWorkspace
      const resolved = resolveActiveRuntime(runtimeBaseDir, builtinDshWorkspace)
      if (resolved.path === null) throw new Error(resolved.blockedReason ?? 'dsh workspace not found')
      return resolved.path
    },
    canStartLocal: () => {
      if (plane()?.localWritersQuiescent === false) {
        return { ok: false, reason: 'managed dsh writer ownership could not be proven quiescent' }
      }
      return runtimeState.startBlocked && !runtimeState.internalStart
        ? { ok: false, reason: runtimeState.startBlockedReason }
        : { ok: true }
    },
    canExposeLocal: () => !runtimeState.startBlocked,
  }

  let boundPlane = false
  const bindPlane = (planeInstance: PlaneHandle): void => {
    if (boundPlane) {
      console.warn(`${logTag} bindPlane 重复调用（忽略——单装配不变式）`)
      return
    }
    boundPlane = true
    planeRef.current = planeInstance
    console.log(`${logTag} control plane bound (connectionState=${planeInstance.connectionState})`)
    // onLocalStateChange 订阅：degraded/restarting/error/restart-exhausted → 关 known-good 候选健康窗口；restart-exhausted → 自动回退事务。
    planeInstance.onLocalStateChange((snapshot) => {
      if (snapshot.status === 'degraded' || snapshot.status === 'restarting'
        || snapshot.status === 'error' || snapshot.status === 'restart-exhausted') {
        try { resetCandidateHealthWindow(runtimeBaseDir) } catch (error) {
          console.error(`${logTag} known-good 健康窗口重置失败：`, sanitizeErrorText(describeError(error)))
        }
      }
      if (snapshot.status === 'restart-exhausted') void runRestartExhaustedRollback()
    })
  }

  // 启动尾部：refreshRuntimeEvidence().then(runRuntimeStartup)，catch 折叠为 loud + 启动门
  // 关闭 + failed 投影。无内建树时按 flavor 静默窗延迟（sidecar 避免 ready 后采样竞态；Electron 0）。
  const runStartupTail = async (): Promise<void> => {
    if (!boundPlane) {
      console.error(`${logTag} runStartupTail 在 bindPlane 之前被调用（跳过——装配序错误，绝不让启动事务在无 plane 下跑）`)
      return
    }
    const delayMs = deps.missingBuiltinStartupTailDelayMs ?? 0
    if (builtinDshWorkspace === null && delayMs > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delayMs)
        timer.unref?.()
      })
    }
    try {
      await refreshRuntimeEvidence().then(() => runRuntimeStartup())
    } catch (error) {
      console.error(`${logTag} dsh 运行时启动事务失败：`, error)
      runtimeState.startBlocked = true
      runtimeInstance.setLifecycle({ phase: 'failed', error: describeError(error) })
    }
  }

  // 优雅回收腿：传输层 + 插件子进程 + runtime 安装器 + gateway 会话 + session refresh 计时器
  //（main will-quit 与 sidecar SIGTERM 同源：quitting 门先置位 → abort 在飞事务 → 并行回收
  // → session refresh/gateway 会话清理）。
  const dispose = async (): Promise<void> => {
    deps.markQuitting()
    runtimeState.startBlocked = true
    // abort 文案单源（shell-core RUNTIME_ABORT_REASON）。
    runtimeState.operationAbort?.abort(new Error(RUNTIME_ABORT_REASON))
    try {
      await Promise.allSettled([
        transportManager?.disposeAsync().catch((err) => console.error(`${logTag} 传输层关闭失败：`, err)),
        disposePluginSyncChildren().catch((err) => console.error(`${logTag} 插件子进程关闭失败：`, err)),
        disposeRuntimeInstaller().catch((err) => console.error(`${logTag} 运行时安装器关闭失败：`, err)),
        runtimeState.operation?.catch((err) => console.error(`${logTag} 运行时事务关闭失败：`, err)),
      ])
    } finally {
      // 计时器先停：refresh 触发绝不可竞态已 dispose 的 manager。
      sessionRefresh.dispose()
      gatewaySessions.dispose()
    }
  }
  // 关窗/退出事实投影：settings 实时 holder + localProcessAlive 判据（state 显示 running 不够，
  // restart backoff 期间会误报）；updateDownloadReady 由 flavor 注入。
  const quitFacts = (): {
    windowCloseBehavior: ChamberSettings['windowCloseBehavior']
    quitConfirmation: boolean
    localRunning: boolean
    updateDownloadReady: boolean
  } => {
    const livePlane = plane()
    const localRunning = livePlane !== null
      && LOCAL_RUNNING_STATES.has(livePlane.connectionState)
      && livePlane.localProcessAlive
    return {
      windowCloseBehavior: deps.settings.current().windowCloseBehavior,
      quitConfirmation: deps.settings.current().quitConfirmation,
      localRunning,
      updateDownloadReady: deps.updateQuitExempt(),
    }
  }

  return {
    ctx,
    localSpawnGates,
    runtimeState,
    runtimeInstance,
    runtimeBaseDir,
    localDshHome,
    bindPlane,
    runStartupTail,
    dispose,
    quitFacts,
    // 闭包绑定本装配的传输管理器单例 + 退出在途门（判据在 transport-reconnect 单源）。
    reconnectStaleTransports: () => reconnectStaleTransports(
      transportManager,
      deps.isQuitting,
      (message, error) => console.warn(message, error),
      logTag,
    ),
  }
}
