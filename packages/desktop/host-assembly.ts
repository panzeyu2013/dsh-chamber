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
import { authHeadersFingerprint, registrationKey, sanitizedRegistrationHeaders } from './transport-registration.ts'
import { authRecoveryStillApplies, createAuthRecoveryController } from './auth-recovery.ts'
import { connectionIdForRawInstance, linkBusyAdapter, linkFailureAdapter } from './transport-identity.ts'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { PlaneHandle } from '@dsh-chamber/control-plane'
import type { ChamberSettings } from './chamber-settings.ts'
import { writeSettingsFile } from './chamber-settings.ts'
import {auditLogFilePath, captureNotificationSource, chamberSettingsFilePath, gatewaySecretsFilePath, instancesFilePath, localDshHomeDir, ownsNotificationSource, projectNotificationSourceInstances, proxyTransport, readDshVersion, resolveActiveRuntime, sshPasswordsFilePath, stateRootDir, syncNotificationSourceRegistry, type HostMessageOptions, type NotificationSourceToken, type ShellAssemblyCtx} from './shell-core.ts'
import {createTransportManager, type TransportManager} from './transport-manager.ts'
import { createHostExit } from './host-exit.ts'
import { createRegistryTransition } from './host-registry-transition.ts'
import { createTransportSubscriptions } from './host-transport-subscriptions.ts'
import { reconnectStaleTransports } from './transport-reconnect.ts'
import type { TransportInstanceSpec } from './transport-provider.ts'
import { configureSshPasswordStore, probeChamberHostLive, sshProvider } from './ssh-provider.ts'
import { cleanupStaleAskpassHelpers } from './ssh-askpass.ts'
import { sweepSshOrphans } from './ssh-orphan.ts'
import { createHostKeyGuard, defaultUserKnownHostsPath, knownHostsPathFor } from './host-key.ts'
import { configureSshSocketNamespace } from './ssh-socket.ts'
import { configureGatewaySecretStore, configureGatewaySessionProvider, gatewayProvider, getGatewayPassword, getGatewayToken, syncGatewayChamberPlugins, type LocalChamberHostPackage, type SecretCryptoAdapter } from './gateway-provider.ts'
import { createGatewaySessionManager, gatewaySessionScopeForConnection } from './gateway-session.ts'
import { createGatewaySessionRefresh, gatewayTunnelAuthority, type GatewaySessionRefresh } from './gateway-session-refresh.ts'
import { appendAuditEvent, type AuditEvent } from './audit-log.ts'
import { sanitizeErrorText } from './sanitize-error.ts'
import { describeError } from './describe-error.ts'
import { preserveFileAside } from './store-file-hygiene.ts'
import type { ChamberHostPackageDescriptor } from './control-plane-module.ts'
import type { ChamberHostPackageSeed, ExecFn, RemoteSpec } from './plugin-sync.ts'
import { ExactOwnershipRegistry, ReadyPhaseEdges, builtChamberHostPackageSeeds, chamberHostPackageSeedsFrom, portableChamberHostPackageSeeds, remoteHome, scopeExecToOwnership, seedRemoteChamberHostPackages } from './plugin-sync.ts'
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
  /** 调试模式副作用叶（解锁宿主原生检查器；回读见 ShellAssemblyCtx.setDebugMode）。 */
  setDebugMode: ShellAssemblyCtx['setDebugMode']
  /** 退出在途事实（main：模块级 quitRequested；sidecar：本地 let）。 */
  isQuitting(): boolean
  /** 置位退出在途（dispose 第一步——与 flavor 自己的退出标志同源）。 */
  markQuitting(): void
  /** hostFacts 的 flavor 字段（controlPlaneUrl 由 flavor 在控制面起来后回填）。 */
  hostFacts: { flavor: ShellAssemblyCtx['hostFacts']['flavor']; trayPresent(): boolean }
  /** 凭据镜像加密适配器（Electron safeStorage；gateway 与 SSH 密码共用；Swift 无 = undefined → 文档化明文回退）。 */
  credentialCrypto?: SecretCryptoAdapter
  /** host 包源目录映射（key = 注册表包名；flavor 解析 app.isPackaged/repoRoot 或 --host-*-dir/moduleDir）。 */
  hostPackageSourceDirs: Record<string, string>
  /** runtime 安装器/sidecar 的 pnpm 入口（flavor 经 pnpm-launcher 解析后注入）。 */
  pnpmEntry: string
  updateController: ShellAssemblyCtx['updateController']
  /** beta 通道开关（Swift sidecar 的 --native-updater-beta = 构建期两条通道 feed URL 成对注入；
   *  Electron 冻结装配不传 → false）→ ShellAssemblyCtx.nativeBetaChannelSwitch。 */
  nativeBetaChannelSwitch?: boolean
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
  /** OS 唤醒/网络恢复 → 对 READY 远端强制一次复验（含 ready-but-half-open）。 */
  reverifyAllTransports(): void
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
  let runtimeBootstrapFailure: string | null = null

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
  // askpass 崩溃残留回收（清理 crash 遗留的密码载体助手；纯 Node 叶，同模块同参）。
  const askpassNotice = cleanupStaleAskpassHelpers()
  if (askpassNotice !== null) console.error(`${logTag} ${askpassNotice}`)

  // ssh 隧道崩溃清扫（P2-1，POSIX）：回收上次崩溃遗留的 ssh 子进程；sweep 的
  // pid+startedAt 双判据保证不会误杀 PID 复用的进程。**不按 uid 目录清 socket**：
  // 同一用户可能并行跑另一个 chamber root，其上活着的 ssh 仍持有 socket；按目录 rm
  // 会静默切断那个实例的转发。本实例的陈旧 socket 由下次 spawn 的
  // StreamLocalBindUnlink=yes 原路径替换，不需要启动期扫描。
  // Windows 两者均为 no-op（无 UDS 隧道、TCP 监听由内核随进程回收）。
  configureSshSocketNamespace(runtimeBaseDir)
  const stateRoot = stateRootDir(runtimeBaseDir)
  const orphanSweep = sweepSshOrphans({ stateDir: stateRoot, log: message => console.warn(`${logTag} ${message}`) })
  if (orphanSweep.killed > 0 || orphanSweep.removed > 0 || orphanSweep.kept > 0) {
    console.warn(`${logTag} ssh orphan sweep: reclaimed ${String(orphanSweep.killed)}, stale records ${String(orphanSweep.removed)}, unverifiable ${String(orphanSweep.kept)}`)
  }

  // registry 现实例先占位：凭据存储配置期只持有惰性解析器（transportManager 赋值后按引用共享）。
  let transportManager: TransportManager | null = null
  const resolveCredentialSpec = (id: string): TransportInstanceSpec | null =>
    transportManager?.listInstances().find(instance => instance.id === id) ?? null

  // SSH password store（0600 原子写；safeStorage 加密，旧明文读时迁移；无 keyring 拒绝新保存、旧明文可读；损坏 loud 保留）。v1 无 keyboard-interactive（2FA）→ 用密钥。
  const passwordNotice = configureSshPasswordStore(sshPasswordsFilePath(runtimeBaseDir), resolveCredentialSpec, deps.credentialCrypto)
  if (passwordNotice !== null) console.error(`${logTag} ssh password store: ${passwordNotice}`)

  // Gateway credentials store（schema v3, 0600, 原子写）：Electron 经 safeStorage 加密镜像；Swift 无
  // safeStorage → 非 win32 = 0600 plaintext loud 回退（renderer 见 secretStorage:'plaintext'），win32 = memory-only 拒绝明文。
  const windowsRefusePlaintext = process.platform === 'win32' && deps.credentialCrypto?.isAvailable() !== true
  if (deps.credentialCrypto?.isAvailable() !== true) {
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
    deps.credentialCrypto,
    resolveCredentialSpec,
  )
  if (gatewaySecretNotice !== null) console.error(`${logTag} gateway secrets store: ${gatewaySecretNotice}`)

  // Gateway password-session manager（纯主进程内存；注册体的 invalidation 直接面）：
  // configureGatewaySessionProvider 六钩子全量接线（ssh 隧道与 http 直连双形态共用）。
  // P0-3 host-key policy: the APP-OWNED known_hosts (first-use copy of ~/.ssh/known_hosts) gates
  // every tunnel before spawn, and the failure-triggered ssh self-proof feeds the fingerprint
  // projection. ONE guard instance serves both the transport manager and the host-key IPC
  // handlers (probe registry + file mutex in one process).
  const hostKeyGuard = createHostKeyGuard({
    knownHostsFile: knownHostsPathFor(runtimeBaseDir),
    userKnownHostsFile: defaultUserKnownHostsPath(),
    log: (level, message) => (level === 'error' ? console.error : console.warn)(`[host-key] ${message}`),
  })
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

  // Transport manager：provider 缺省 = sshProvider（条目按 transport 解析）；providers
  // 按 TRANSPORT 注册 {ssh, http}；instancesFile = <userData>/ssh-instances.json。
  const created = createTransportManager({
    provider: sshProvider,
    providers: { ssh: sshProvider, http: gatewayProvider },
    hostKey: hostKeyGuard,
    sshOrphanStateDir: stateRoot,
    instancesFile: instancesFilePath(runtimeBaseDir),
    logger: {
      log: (...args) => console.log('[transport-manager]', ...args),
      warn: (...args) => console.warn('[transport-manager]', ...args),
      error: (...args) => console.error('[transport-manager]', ...args),
    },
    // Our own bulk upload owns the tunnel's single TCP: the probe reads that fact
    // from the proxy so congestion can never be booked as link death. The manager
    // speaks RAW instance ids; the plane speaks connectionIds — the conversion is
    // the tested one in transport-identity.ts, never an ad-hoc guess.
    options: {
      linkBusy: linkBusyAdapter(
        () => sm.listInstances(),
        connectionId => plane()?.isTransportLinkBusy(connectionId) ?? false,
      ),
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

  // Transport-manager 执行投影面（plugin-sync 经结构等价收窄别名桥接）。
  const execTransport = sm.exec as unknown as ExecFn
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
  /** The exact target/credential/transport key of the LIVE registration. A status
   *  push that only changes link health must NOT call registerInstanceTransport:
   *  the proxy revokes every in-flight response/stream when a connectionId is
   *  re-registered. */
  const registeredTargetKeys = new Map<string, string>()
  /** Bound the auth-fail -> disconnect/connect TOCTOU retry: a second ready edge
   *  before the first reconnect settles must not hammer the gateway. */
  const AUTH_RECOVERY_MIN_INTERVAL_MS = 5_000
  // Live-proxy 会话自愈控制器（gateway-session-refresh.ts 零 electron——时钟/计时器注入
  // 为纯 Node 缺省）；ready 注册 arm / 离开 ready disarm / onVerified 指纹重注册接线在下方，
  // register 腿 = plane → registerInstanceTransport（隧道 Host authority 覆盖 + 指纹锁步）。
  const sessionRefresh: GatewaySessionRefresh = createGatewaySessionRefresh({
    sessionManager: gatewaySessions,
    passwordFor: id => getGatewayPassword(id),
    tokenFor: id => getGatewayToken(id),
    readyUrlFor: id => sm.readyUrl(id),
    // POSIX ssh tunnels are reachable only through their UDS listener: the refresh
    // login must dial it exactly like verifyUp, or a password gateway silently stops
    // re-authenticating after the transport switches shape.
    socketPathFor: id => sm.readySocketPath(id),
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
      const liveStatus = sm.status(id)
      const liveSocketPath = sm.readySocketPath(id)
      if (livePlane !== null) livePlane.registerInstanceTransport(connectionIdForRawInstance(id, 'gateway'), url, headers, {
        ...(registered === undefined ? {} : { transport: proxyTransport(registered.transport) }),
        ...(tls === undefined ? {} : tls),
        ...(authority === undefined ? {} : { authority }),
        ...(liveSocketPath === null ? {} : { socketPath: liveSocketPath }),
        ...(liveStatus?.link === undefined ? {} : { health: liveStatus.link.state }),
      })
      // A successful (re-)registration ends any pending auth recovery: a deferred
      // disconnect/connect must never tear down a transport that is already
      // registered again (the refresh path is the most likely place for this race).
      authRecovery.cancel(id)
      authRecoveryContext.delete(id)
      // Keep the registered-auth fingerprint in lockstep：refresh 重注册 REPLACES 代理
      // headers——指纹门须认已轮换 cookie，否则下次 ready 探针无条件再注册（撤销在途流量）。
      const sanitized = headers === undefined ? undefined : sanitizedRegistrationHeaders(headers)
      registeredAuthFingerprints.set(connectionIdForRawInstance(id, 'gateway'), authHeadersFingerprint(sanitized))
      registeredTargetKeys.set(connectionIdForRawInstance(id, 'gateway'), registrationKey({
        url,
        transport: registered?.transport,
        headers: sanitized,
        spkiPin: tls?.tls.spkiPin,
        authority,
        socketPath: liveSocketPath ?? undefined,
      }))
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
      const socketPath = sm.readySocketPath(id)
      const result = await probeChamberHostLive(
        { host: parsed.hostname, port, ...(socketPath === null ? {} : { socketPath }) },
        descriptor.probe.method,
        descriptor.probe.args,
      )
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
    const socketPath = sm.readySocketPath(id)
    return syncGatewayChamberPlugins({
      // Sync through the REGISTERED transport origin (the ready URL)：ssh 隧道 = 用户
      // 验证过的 loopback 端点，绝非远端 host:port；authority 覆盖呈现远端 gateway。
      // POSIX UDS 隧道：真正的拨号目标是 socket，URL 只承担 authority/path 语义。
      origin: url,
      authority: instance.transport === 'ssh' ? gatewayTunnelAuthority(instance.remotePort) : undefined,
      ...(socketPath === null ? {} : { socketPath }),
      headers,
      spkiPin,
      packages,
      logger: { warn: message => console.warn(message), log: message => console.log(message) },
    })
  }

  /**
   * One bounded auth recovery per gateway ready push: an auth-failed ready push
   * unregisters the proxy and must re-verify the session. The DRIVER (timers +
   * throttle accounting) is auth-recovery.ts — unit-tested with an injected clock;
   * this wiring only supplies the effect and the guards it needs. Throttled
   * attempts are deferred (not dropped) so the instance cannot stay
   * ready-but-unregistered.
   */
  const authRecoveryContext = new Map<string, { url: string; scope: string | undefined }>()
  const authRecovery = createAuthRecoveryController({
    minIntervalMs: AUTH_RECOVERY_MIN_INTERVAL_MS,
    onDecision: (id, decision, delayMs) => {
      // Keep the two operator-facing messages that existed before the extraction.
      if (decision === 'now') {
        sm.appendLog(id, 'warn', 'gateway session changed before proxy registration; re-authenticating')
        return
      }
      sm.appendLog(id, 'warn', delayMs === 0
        ? 'gateway session changed again before recovery settled; one deferred re-authentication is already armed'
        : 'gateway session changed again before recovery settled; one deferred re-authentication is armed')
    },
    attempt: (id) => {
      // Deferred one microtask: the driver calls this from inside the status push,
      // and a synchronous disconnect/connect would re-enter the onStatusChanged
      // emit. The guards below re-observe the instance after that hop — exactly what
      // a deferred attempt has to do anyway.
      queueMicrotask(() => {
        const context = authRecoveryContext.get(id)
        if (context === undefined) return
        const currentStatus = sm.status(id)
        const currentSpec = sm.listInstances().find(instance => instance.id === id)
        const stillApplies = currentSpec !== undefined && authRecoveryStillApplies({
          phase: currentStatus?.phase ?? 'idle',
          readyUrlMatches: sm.readyUrl(id) === context.url,
          kind: currentSpec.kind,
          hasPassword: getGatewayPassword(id) !== null,
          scopeMatches: context.scope !== undefined
            && gatewaySessionScopeForConnection(currentSpec) === context.scope,
        })
        if (!stillApplies) {
          authRecoveryContext.delete(id)
          return
        }
        sm.disconnect(id)
        sm.connect(id)
      })
    },
  })

  // —— 传输状态/复验订阅：同一工厂注册两条订阅（audit transition + ready 注册/gateway sync/
  // session refresh arm/自动 seed ready 边缘/committed status push ⇄ onVerified 指纹重注册），
  // 共享 registeredTargetKeys/registeredAuthFingerprints；工厂在组合根原位调用一次、仍同步订阅，
  // 注册时机不变（先于 publishRegistryTransition 与任何 plane 启动腿）。
  createTransportSubscriptions({
    sm,
    plane,
    edges: deps.edges,
    gatewaySessions,
    sessionRefresh,
    readySeedEdges,
    startAutomaticHostSeed,
    syncGatewayChamberPluginsFor,
    audit,
    logTag,
    // 6 个共享闭包状态留在组合根：退出腿（sessionRefresh/authRecovery 清理）与
    // sessionRefresh.register 也读写它们，工厂只捕获不拥有。
    registeredAuthFingerprints,
    registeredTargetKeys,
    lastAuditedPhase,
    auditRegistered,
    authRecovery,
    authRecoveryContext,
  })

  // 注册表提交转移（证明投影/代际同步/seed owner 撤销/committed push）是命名模块；App 只注入句柄。
  const { publishRegistryTransition } = createRegistryTransition({
    sm, edges: deps.edges, logTag, operationalFingerprint, readySeedEdges, hostPackageSeeding,
    startAutomaticHostSeed,
  })

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
    setDebugMode: enabled => deps.setDebugMode(enabled),
    isQuitting: () => deps.isQuitting(),
    transportManager: sm,
    audit,
    hostKey: hostKeyGuard,
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
    hostPackageSeeding,
    chamberHostPackageSeeds,
    sshPluginTargets: {
      findRemoteTarget,
      ownsRemoteTarget,
      scopedExecForTarget,
      scopedProbeForTarget,
      liveProbeFor,
    },
    syncGatewayChamberPluginsFor,
    updateController: deps.updateController,
    nativeBetaChannelSwitch: deps.nativeBetaChannelSwitch === true,
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
    // Failure-driven probe seam (design 27 §3.2): a forwarded request that got no
    // HTTP answer forces ONE identity probe, so a half-open link is detected in
    // ~1s instead of waiting for the next heartbeat. The manager owns the throttle
    // and the "healthy only / not busy" guards.
    // connectionId ('dsh:abc') -> the manager's raw id ('abc'); a malformed id is
    // dropped inside the adapter, never guessed (see transport-identity tests).
    planeInstance.onTransportUpstreamFailure(linkFailureAdapter(rawId => { sm.notifyLinkFailure(rawId) }))
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
  const exitLeg = createHostExit({
    runtimeState,
    transportManager,
    disposeRuntimeInstaller,
    sessionRefresh,
    authRecovery,
    authRecoveryContext,
    gatewaySessions,
    markQuitting: deps.markQuitting,
    settings: deps.settings,
    updateQuitExempt: deps.updateQuitExempt,
    plane,
    logTag,
  })
  const { dispose, quitFacts } = exitLeg
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
      { staggerMs: 120 },
    ),
    reverifyAllTransports: () => {
      if (deps.isQuitting()) return
      transportManager?.reverifyAll()
    },
  }
}
