/**
 * ShellAssemblyCtx — the installIpcHandlers assembly context (design 25 §4.1),
 * extracted from shell-core.ts (R4 P7 type-cycle break). Leaf module: it must
 * never import shell-core.ts or a shell-ipc-* registrar.
 */
import type { AuditEvent } from './audit-log.ts';
import type { ApplyNowGateInput } from './apply-now-gate.ts';
import type { ChamberSettings } from './chamber-settings.ts';
import type { ChamberHostPackageDescriptor } from './control-plane-module.ts';
import type { ActivationJournalState, RuntimeAction, RuntimeOperationFence, StartupResult } from '@dsh-chamber/dsh-runtime';
import type { DshRuntimeController, RuntimeLifecycleProjection } from './dsh-runtime-controller.ts';
import type { GatewaySessionManager } from './gateway-session.ts';
import type { NotificationSourceToken } from './notifications.ts';
import type { ChamberHostPackageSeed, ExactOwnershipRegistry, ExecFn, RemoteSpec, StatusFn } from './plugin-sync.ts';
import type { ProjectedRegistryInstance } from './registry-projection.ts';
import type { SshPluginJournal } from './ssh-plugin-journal.ts';
import type { TransportManager } from './transport-manager.ts';
import type { TransportInstanceSpec } from './transport-provider.ts';
import type { UpdateController } from './updater.ts';

/** IPC 注册面：core 经它注册处理器（channel 为 opaque 通道名；Electron 侧
 *  装配为 `(ch, h) => ipcMain.handle(ch, trustedIpc(h))`——trustedIpc 围栏在
 *  注入点包装，Swift sidecar flavor 注入同形 B 桥注册）。 */
export interface IpcRegistrar {
  handle(channel: string, handler: (payload: unknown) => Promise<unknown> | unknown): void
}

/** ssh 插件管理目标（F 组注册体的解析结果形状）：spec = plugin-sync
 *  RemoteSpec（registry id + remoteDshHome），fingerprint = main 装配侧
 *  operationalFingerprint（id 稳定编辑推进），sourceToken = 来源代际 token
 *  （F 组 owns 复验与 C 组来源证明同一代际面）。main.ts 的私有 RemoteTarget
 *  与此结构同形——ctx 闭包按结构赋值兼容。 */
export interface SshPluginTarget {
  spec: RemoteSpec
  fingerprint: string
  sourceToken: NotificationSourceToken
}

/** 元数据恢复可恢复状态联合（ctx 签名用）——与 main.ts whenReady 内
 *  同名局部类型同构（结构等价，宿主叶赋值兼容；core 不持有额外形状）。 */
type RecoverableMetadataStatus = 'selection-corrupt' | 'recovery-in-progress' | 'recovery-marker-corrupt'

/** ShellAssemblyCtx — installIpcHandlers 装配上下文。最小集原则：只放注册体
 *  实际引用的字段。核心字段：transportManager / audit / gatewaySessions /
 *  publishRegistryTransition（宿主生命周期权威在 main，见字段注释）；
 *  localDshHome / sshPluginJournal /
 *  hostPackageSeeding / chamberHostPackageSeeds / sshPluginTargets
 *  （F 组注册体的共享现实例/闭包束）+ transportManager Pick 扩 appendLog；
 *  syncGatewayChamberPluginsFor
 *  （G 组手动 sync 的执行闭包——main 装配侧 ready 自动 sync 共用同一执行路径，
 *  见字段注释）；runLocalPluginMutation（H 组本地插件
 *  注册体的宿主执行叶——main 装配侧 runtime writer fence/启动门编排，见字段注释）；
 *  runRuntimeStartup / publishBlockedStartup /
 *  setRuntimeGate / authoritativeMetadataRecoveryStatus / runUserMetadataRecovery /
 *  readApplyNowGateInput / selectedJournalIntent / stopLocalDsh / runtimeOperationSlot /
 *  bundledRuntimeVersion（启动事务宿主与共享闭包族在装配侧，见字段注释）。
 *  chamber
 *  settings 的内存 holder 归装配侧（main.ts 尚余直读点）；
 *  core 侧一律经 settingsIO 读写，权威单一。
 *  各副作用叶与其 HostEdges 成员（setKeepAwake / setLoginItem /
 *  setBadge…）同名同语义。 */
export interface ShellAssemblyCtx {
  /** INFO 载荷与 settings 平台投影的宿主事实。 */
  hostFacts: {
    /** 壳 flavor（E2）：'electron'（Electron 壳装配）| 'swift'
     *  （Swift 原生壳 sidecar 装配）——INFO 载荷透传，renderer 侧据此分派
     *  更新/通知等宿主机制语义。 */
    flavor: 'electron' | 'swift'
    /** 控制面 URL（INFO 载荷的 `http://127.0.0.1:${cp.port}`）。 */
    controlPlaneUrl: string
    /** 运行平台（process.platform——BADGE_COUNT 平台门 badgePlatformGate
     *  第一参同源）。 */
    platform: NodeJS.Platform
    /** 托盘恢复面存在性（SETTINGS 投影 closeToTray 门）——invoke 时求值：
     *  托盘在装配后才创建（main.ts maybeCreateTray），不得装配期定格。 */
    trayPresent(): boolean
  }
  /** INFO.dshVersion 的 dsh 运行事实（可选：未提供时 INFO 返回 null）。 */
  runtimeFacts?: {
    /** 当前活动 dsh 运行时版本——invoke 时求值（INFO 每次
     *  调用 resolveActiveRuntime(...).version：运行时重启/切换后返回新版本，
     *  绝不返回装配期定格值）。 */
    dshVersion(): string | null
  }
  /** chamber settings 状态与持久化 IO（装配侧注入现 chamber-settings 读写
   *  函数，<userData> 路径已绑定）。 */
  settingsIO: {
    /** 当前内存 holder 值（设置权威 = 装配侧内存 holder）。 */
    current(): ChamberSettings
    /** 原子替换内存 holder（applySettingsPatch 全链成功尾部调用）。 */
    commit(next: ChamberSettings): void
    /** 持久化到 <userData>/chamber-settings.json（atomic 0600）；失败 throw，
     *  由 applySettingsPatch 触发已应用副作用的回滚。 */
    persist(next: ChamberSettings): void
  }
  /** quit 在途门（design 14 D2）：通知/深链
   *  入队的 ignore 语义与通知投递循环的退出检查经它求值（装配侧注入
   *  `() => quitRequested`）。 */
  isQuitting(): boolean
  /** keep-awake 副作用叶（装配侧注入 setKeepAwakeActive——HostEdges
   *  setKeepAwake 的 main.ts 宿主腿；失败 throw，由 applySettingsPatch 的
   *  catch 做 best-effort 回滚）。
   *  返回 `void | Promise<void>`（双 flavor Promise 兼容）：Electron
   *  宿主腿同步（成功 void / 失败 throw）；Swift flavor 宿主腿在 B 桥另一
   *  侧——叶 await 桥应答后 resolve / leg 失败 reject——两条失败路径同汇于
   *  applySettingsPatch 的 catch 回滚（同步 throw 与异步 reject = 同一路径；
   *  await 吸收同步返回值，Electron 装配闭包无需 async 化）。 */
  setKeepAwake(enabled: boolean): void | Promise<void>
  /** 登录自启副作用叶（装配侧注入现 applyLaunchAtLogin——HostEdges
   *  setLoginItem 的 main.ts 宿主腿；失败 {error} 返回，绝不 throw）。
   *  返回 `{ok:true}|{ok:false;error:string}` 或其 Promise（双 flavor
   *  同前：Electron 同步；Swift await B 桥应答后映射同形判别联合——leg
   *  错误原样进 {error}，applySettingsPatch 两 flavor 收到同一形状）。 */
  setLoginItem(
    enabled: boolean,
  ):
    | { ok: true }
    | { ok: false; error: string }
    | Promise<{ ok: true } | { ok: false; error: string }>
  /** registryOrigin 切换确认对话框叶（SETTINGS_SET dialog.showMessageBox
   *  腿；文案与无窗判定留在实现侧）：
   *  'confirmed' 放行；
   *  'cancelled' = 用户取消（返回 { error: 'cancelled', code: 'cancelled' }）；
   *  'unavailable' = 无存活主窗（返回 { error: 'native confirmation unavailable' }）。 */
  confirmRegistryOriginSwitch(
    currentOrigin: string,
    nextOrigin: string,
  ): Promise<'confirmed' | 'cancelled' | 'unavailable'>
  // —— C 组注册体的装配依赖。registry
  // 读写/投影句柄（transportManager）为现实例注入；audit / gatewaySessions /
  // publishRegistryTransition 为宿主叶或宿主生命周期对象（定义在 main
  // 装配侧——publishRegistryTransition 的插件 seed/journal 撤销与
  // SSH_INSTANCES_CHANGED push 文本归装配侧）。D/E 组注册体复用
  // transportManager（Pick 扩
  // reverify/logs/clearLogs 与 exec，见字段注释）+ 纯模块 ssh-config.ts import。
  // F 组
  // 6 注册体的装配依赖（编排纯模块直接 import）——localDshHome /
  // sshPluginJournal / hostPackageSeeding / chamberHostPackageSeeds /
  // sshPluginTargets（自动 seed/撤销路径与 F 组共用同一现实例/
  // 闭包族：journal 单写者、seed 单飞、目标指纹同一实现，语义不分叉），
  // transportManager Pick 扩 appendLog（seed 结果入实例环形日志）。
  /** registry 读写 + transport 状态/生命周期投影句柄（C/D/E/F 组注册体直接
   *  读写面；装配侧注入 transport-manager 现实例——纯模块按引用共享；Pick 收窄
   *  到实际调用的方法面（reverify/logs/clearLogs——D 组状态/日志/重验证通道；
   *  exec——E 组 exec/systemd 执行通道；appendLog——F 组
   *  host-graph seed 结果投影入实例环形日志），体内以 sm 名解构）。 */
  transportManager: Pick<
    TransportManager,
    | 'listInstances'
    | 'saveInstances'
    | 'status'
    | 'readyUrl'
    | 'disconnect'
    | 'connect'
    | 'reverify'
    | 'logs'
    | 'clearLogs'
    | 'exec'
    | 'appendLog'
  >
  /** 非秘密审计叶（appendAuditEvent({ file:
   *  auditLogPath })——装配侧绑定 <userData> 路径注入；JSONL append 只记非
   *  秘密事实，凭据值绝不入日志）。 */
  audit(event: AuditEvent): void
  /** gateway 密码会话管理器（design 17 §7.1/§9.3——主进程内存持有；C 组注册体
   *  invalidation 的直接面）。装配侧传模块级 `gatewaySessions` 的**装配期取
   *  值**：该 let 仅在 will-quit 清理置 null（届时窗口已关、IPC 处理器不可
   *  达），处理器可达期恒非空——null 分支判据（有界收敛注记：
   *  同一 will-quit 竞态下直读闭包可见 null 而装配捕获不可见的路径不可达）。 */
  gatewaySessions: GatewaySessionManager | null
  /** registry 变更生命周期权威 sidecar（source-lifecycle
   *  authority：来源证明/代际同步 + 插件 seed/journal 撤销 + 活跃通知退役驱逐
   *  + SSH_INSTANCES_CHANGED committed push 编排）——main 装配侧经本叶
   *  注入（其宿主对象 readySeedEdges/hostPackageSeeding/sshPluginJournal/
   *  setGatewaySyncRegistration/startAutomaticHostSeed 归装配侧，push 文本被
   *  renderer-trust 锚定），C 组 save/delete 注册体经它发布 committed 结果。 */
  publishRegistryTransition(
    before: readonly TransportInstanceSpec[],
    after: readonly TransportInstanceSpec[],
  ): ProjectedRegistryInstance[]
  // —— F 组 6 注册体的装配依赖。编排纯模块
  // （plugin-sync / ssh-apply-rows / plugin-tarball）在 core 直接 import；下列
  // 共享现实例与闭包为 main 装配侧所有物（自动 seed/ready 撤销路径与 F 组
  // 注册体共用——journal 单写者、seed 单飞、目标指纹同一实现，语义不分叉）。
  /** 权威本地 dsh home 路径（<userData>/state/dsh-home——装配期解析值注入，
   *  core 不碰 Electron paths；localPluginList / resolveLocalMaterializeDirectory
   *  读它，与自动路径同一值）。 */
  localDshHome: string
  /** ssh 插件 undo journal 现实例（main 装配侧 createSshPluginJournal
   *  (<userData>)——main 的 publishRegistryTransition 撤销清理（clear）与
   *  F 组 undo/apply 注册体共享同一实例；类型定义在 ssh-plugin-journal.ts，
   *  record 永不 throw）。 */
  sshPluginJournal: SshPluginJournal
  /** chamber host 包种子数组（main 装配侧构造——sourceDir 已按
   *  app.isPackaged/pkgDir/repoRoot 解析；自动 seed 路径与手动 seed 注册体
   *  共用同一数组）。 */
  chamberHostPackageSeeds: readonly ChamberHostPackageSeed[]
  /** host 包 seed 单飞注册表现实例（ExactOwnershipRegistry——main 自动 seed
   *  路径与手动 seed 注册体共用同一注册表，跨路径并发单飞语义不变）。 */
  hostPackageSeeding: ExactOwnershipRegistry
  /** ssh 插件管理目标解析/所有权/执行/探针闭包束（main 装配侧定义——自动
   *  seed 与 ready 边缘用同一族闭包；F 组注册体以原名
   *  调用 findRemoteTarget / ownsRemoteTarget / scoped* 等）。目标结构
   *  = SshPluginTarget（spec + operational fingerprint + 来源代际 token）。 */
  sshPluginTargets: {
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
  // —— G 组 3 注册体的装配依赖。编排纯模块
  // （gateway-ipc-shared / gateway-sync-registry / gateway-provider /
  // plugin-tarball——classifyPluginPick/buildPluginTarball 亦 import）在
  // core 直接 import；注册参数读取（getGatewaySyncRegistration）与 ready 位复验
  // 在注册体侧。确认对话框复用上方 edges 版 confirmPluginAction 助手、
  // 无存活主窗预检 = edges.mainWindowAlive、插件源 pick = edges.pickPluginSource。
  /** 手动 gateway_plugin_sync 的上传执行闭包（main 装配侧定义——ready 注册自动
   *  sync（sm.onStatusChanged ready 边缘）与手动 re-entry 注册体共用同一执行
   *  路径与注册参数，语义不分叉）：把本地 chamber host 包种子缓存上传到注册
   *  transport 来源；无实例/非 gateway → null。本地包源解析（app.isPackaged /
   *  pkgDir/repoRoot）在闭包内，core 不碰 Electron paths。 */
  syncGatewayChamberPluginsFor(
    id: string,
    url: string,
    headers: Record<string, string>,
    spkiPin: string | null,
  ): Promise<{ uploaded: boolean; skipped: boolean; failed?: boolean; error?: string } | null>
  // —— H 组 3 个本地插件注册体（LOCAL_PLUGIN_ADD /
  // LOCAL_PLUGIN_ADD_FILE / LOCAL_PLUGIN_REMOVE）的本地执行叶。编排纯模块
  // （plugin-sync：runLocalDshPlugin 等）在 core 直接 import；本叶只承载宿主
  // 编排——本体定义在 main 装配侧（runtime writer fence（RuntimeOperationFence）
  // 租约 + runtimeStartBlocked/runtimeStartBlockedReason 启动门 +
  // resolveActiveRuntime(runtimeBaseDir, builtinDshWorkspace) workspace 解析均归
  // 装配侧：fence/启动门是装配侧运行时事务状态，不是 core 状态；workspace 只在
  // fence 租约内解析，绝不跨运行时 swap 保留）。注册体以原名
  // 调用 runLocalPluginMutation（owner + mutate(dshWorkspace) 形状）；mutate 内
  // 实际子进程执行 = plugin-sync runLocalDshPlugin（add
  // 子进程 env 装配/白名单在纯模块内）。
  runLocalPluginMutation<T>(
    owner: string,
    mutate: (dshWorkspace: string) => Promise<T>,
  ): Promise<T | { ok: false; error: string }>
  // —— I 组 7 注册体的装配依赖。open-in
  // 面——wiredCtx/openInCtx 的宿主能力全部来自既有面（hostFacts.platform
  // / settingsIO.current()（vscodeOpenInNewWindow 惰性读）/ transportManager
  // （sm——lookupInstance 与来源捕获的实查）/ edges 打开叶）与纯模块 import
  // （open-in.ts / deep-link.ts，见 I 组段注释）；update 面——updater
  // 现实例（main 装配侧构造的 createUpdateController 包装：electron-updater 与
  // autoInstallOnAppQuit 生命周期、设计 11 的静默检查/下载/quitAndInstall 编排
  // 与设计 14 D2 的退出豁免状态读取（main 模块级 updateController ref）均归装配
  // 侧）。I 组 UPDATE_* 注册体与状态 push 订阅共用同一实例；装配侧在
  // installIpcHandlers 之后调 updater.start()（保持「先订阅后 start」序）。 */
  updateController: UpdateController
  // —— J 组 6 个 runtime 注册体（RUNTIME_STATE /
  // RUNTIME_RESTART / RUNTIME_CHECK / RUNTIME_INSTALL / RUNTIME_CLEANUP_VERSION /
  // RUNTIME_CLEAR_FAILURE）的装配依赖。控制器现实例、fence 现实例、动作门与
  // 宿主叶全部由 main 装配侧定义并经 ctx 注入——main 侧 K 组注册体（RUNTIME_
  // RECOVER_METADATA / RESET_BUILTIN / RETRY_APPLY / APPLY_NOW / RETRY_RESTORE /
  // RESTORE_PRE_ROLLBACK——见本接口尾部）与启动/证据
  // 路径共用同一实例/闭包：状态权威单一、单飞/串行化语义不分叉。注册体经
  // 上方解构以原名调用（`runtimeOperation !== null` →
  // `runtimeOperationBusy()` 与 `chamberSettings.registryOrigin` →
  // `settingsIO.current().registryOrigin` 两处替换——见 J 组段注释）。
  /** DshRuntimeController 现实例（main 装配侧 whenReady 构造——类型 import 自
   *  dsh-runtime-controller.ts（electron-free 纯编排模块），core 只做类型面；
   *  K 组注册体与启动/证据路径共用同一实例，状态权威单一）。 */
  runtimeController: DshRuntimeController
  /** runtime 事务槽在飞读门（`runtimeOperation !== null` 的读门——
   *  槽位本体与单写者归 main：启动事务/自动回滚直接读写，K 组在飞事务的
   *  登记/清槽/在飞值经 runtimeOperationSlot 叶（见本接口尾部），core
   *  只经本叶做 busy 布尔读）。
   *  J/K 组注册体中 `runtimeOperation !== null` 替换为
   *  runtimeOperationBusy()。 */
  runtimeOperationBusy(): boolean
  /** runtime writer fence 现实例（whenReady runtimeWriterFence——启动事务
   *  （runtime:startup / runtime:restart-exhausted 等 acquire）与 K 组路径共用；
   *  busy 读与 tryAcquire 与调用点同一实例，跨 core/main 的 writer 串行化
   *  语义不分叉；owner 名逐字一致）。 */
  runtimeWriterFence: Pick<RuntimeOperationFence, 'busy' | 'tryAcquire'>
  /** runtime 动作终态门（whenReady runtimeActionAllowed 闭包——K 组
   *  注册体同用；单一实现经 ctx 注入 core，行为不分叉）。action 参数 = 共享核
   *  RuntimeAction 联合（allowedActions 的可见动作集）。 */
  runtimeActionAllowed(action: RuntimeAction): boolean
  /** 权威 runtime base dir（装配期解析 <userData> 路径注入——core 不碰 Electron
   *  paths；@dsh-chamber/dsh-runtime 纯 store 函数（listExplicitlyInstalledVersions /
   *  cleanupExplicitRuntimeVersion / listRuntimeFailures / clearRuntimeFailure）
   *  经它与 main 侧同一 baseDir 调用）。 */
  runtimeBaseDir: string
  /** 磁盘/快照/失败证据刷新叶（whenReady refreshRuntimeEvidence 闭包——
   *  coalescer、lastDiskEvidence 与 projectMetadataHealth 宿主状态归装配侧；
   *  K 组注册体与启动路径同用同一实现）。 */
  refreshRuntimeEvidence(patch?: RuntimeLifecycleProjection): Promise<void>
  /** pnpm store prune 叶（whenReady runStorePruneIfNeeded——storePruneOperation
   *  单飞宿主状态归装配侧；清理路径与启动尾部共用同一实现）。 */
  runStorePruneIfNeeded(): Promise<void>
  /** 事务性 dsh 重启宿主叶（PlaneHandle 在 main——RUNTIME_RESTART 注册体的
   *  `controlPlane === null` 门 + controlPlane.restartLocal() + resolve 后实时
   *  connectionState 读封装在装配侧叶内）：controlPlane 未初始化 → throw
   *  'control plane not initialized'（同文案）；resolve ≠ success——
   *  restartLocal() 从 restart-exhausted/error 等终态 resolve 时由 core 注册体
   *  按返回的 connectionState 白名单诚实拒绝。 */
  restartLocalDsh(): Promise<string>
  // —— K 组 6 个 runtime 注册体
  // （RUNTIME_RECOVER_METADATA / RUNTIME_RESET_BUILTIN / RUNTIME_RETRY_APPLY /
  // RUNTIME_APPLY_NOW / RUNTIME_RETRY_RESTORE / RUNTIME_RESTORE_PRE_ROLLBACK）的
  // 装配依赖。启动事务本体与其
  // 共享闭包族全部由 main 装配侧定义并经 ctx 注入——K 组注册体与启动/证据路径
  // 共用同一实现、同一运行时事务槽（模块级 runtimeOperation）与同一 gate/fence，
  // 语义不分叉（executeMetadataRecovery 等恢复事务腿、runtimeOperationAbort /
  // runtimeStartBlocked / runtimeInternalStart / runtimeTransactionWorkspace 等
  // 装配侧事务状态绝不进 core）。dsh-runtime 纯逻辑（queueActivationIntent /
  // writeActivationIntent / restoreMarkerAuthorityStatus / readActivationJournalState /
  // writeOverride / listPreRollbackStashes / restorePreRollback）与 apply-now-gate.ts
  // 的 evaluateApplyNowGate 为纯模块直接 import。注册体中的
  // 替换（`runtimeOperation !== null` → runtimeOperationBusy()、`quitRequested`
  // → quittingLeaf()、`cp.stopLocal()` → stopLocalDsh()、槽登记/清槽/在飞值 →
  // runtimeOperationSlot.*）注记于 K 组段注释。
  /** 运行时启动事务宿主叶（装配侧事务本体 runRuntimeStartup；
   *  K 组注册体与启动尾部（装配侧 refreshRuntimeEvidence().then(runRuntimeStartup)）
   *  共用同一实现：内部 gate/fence/事务槽/abort 管理归装配侧，core 经本叶调用
   *  （槽忙 → 返回在飞事务守卫）。 */
  runRuntimeStartup(): Promise<StartupResult | null>
  /** 启动阻塞发布叶（装配侧 publishBlockedStartup——setRuntimeGate(true) +
   *  refreshRuntimeEvidence 的组合宿主叶；reason 经 sanitizeErrorText 归一，patch
   *  追加到 failed 投影之上；K 组注册体与启动路径共用同一实现）。 */
  publishBlockedStartup(reason: string, patch?: RuntimeLifecycleProjection): Promise<void>
  /** 宿主启动门写叶（装配侧 setRuntimeGate——模块级 runtimeStartBlocked /
   *  runtimeStartBlockedReason 槽与 cp.refreshLocalExposure 宿主刷新归装配侧；
   *  K 组 RESET_BUILTIN 等注册体与启动事务共用同一门）。 */
  setRuntimeGate(blocked: boolean, reason?: string | null): void
  /** 元数据恢复资格投影叶（装配侧 authoritativeMetadataRecoveryStatus——
   *  quit/写进程安全/本地 writers quiescent/bundled 版本等宿主事实归装配侧；K 组
   *  RECOVER_METADATA 注册体与 runUserMetadataRecovery 共用同一实现，语义不分叉）。
   *  'incomplete' 为永久恢复终态（journaled 快照缺失/不可信），'half' 为瞬时可重试
   *  ——门语义保留。 */
  authoritativeMetadataRecoveryStatus(): RecoverableMetadataStatus | null
  /** 用户触发元数据恢复事务宿主叶（装配侧 runUserMetadataRecovery——恢复事务
   *  在飞登记（事务槽/abort/workspace 写）与 executeMetadataRecovery 腿在装配侧；
   *  K 组 RECOVER_METADATA 注册体经本叶启动同一事务）。
   *  返回 null = 资格不符/已在飞（注册体原样返回当前 state）。 */
  runUserMetadataRecovery(
    expectedStatus: RecoverableMetadataStatus,
  ): Promise<StartupResult | null> | null
  /** APPLY_NOW 门输入构造叶（装配侧 readApplyNowGateInput——controlPlane
   *  connectionState / envOverrideActive / 事务槽等装配侧宿主读在叶内；
   *  evaluateApplyNowGate 纯门在 core 直接 import，同一输入形状（pending ??
   *  journalTarget ?? overridePending 三源解析与目标树 preflight 保留）。 */
  readApplyNowGateInput(): ApplyNowGateInput
  /** activation journal intent 选择（selectedJournalIntent——main 启动
   *  路径 readActivationFacts 与 K 组 RETRY_APPLY 注册体共用同一实现；core 侧只消费
   *  targetVersion 投影，完整记录仍在装配侧闭包内使用）。 */
  selectedJournalIntent(state: ActivationJournalState): { targetVersion: string | null } | null
  /** 本机 dsh 宿主停止叶（PlaneHandle 在 main——`cp.stopLocal()`；K 组
   *  RESTORE_PRE_ROLLBACK 事务的 stop 腿经本叶，与 runRuntimeStartup 内部的
   *  同源 stop 语义一致；异常按调用点的 .catch 折算）。 */
  stopLocalDsh(): Promise<void>
  /** runtime 事务槽（main.ts 模块级 runtimeOperation——槽本体与单写者归装配
   *  侧：启动事务/自动回滚/quit 路径直接读写同一槽）；core 的 busy 读经
   *  runtimeOperationBusy()，K 组注册体的在飞值读与登记/清槽经本对象：
   *  - begin：登记一个在飞事务（`runtimeOperation = operation`——RESET_BUILTIN
   *    的 queue-behind-applying 与 RESTORE_PRE_ROLLBACK 事务登记）；
   *  - end：清槽（finally `runtimeOperation = null`）；
   *  - inFlight：在飞事务 promise 值读（`const inFlight = runtimeOperation`——
   *    RESET_BUILTIN 需 await 在飞 applying 事务本体后再启动）。 */
  runtimeOperationSlot: {
    begin(operation: Promise<StartupResult | null>): void
    end(): void
    inFlight(): Promise<StartupResult | null> | null
  }
  /** 内建 dsh 版本（装配期解析值快照——main.ts bundledVersion 常量；
   *  K 组 RESET_BUILTIN 注册体与启动路径同一事实；core 不自行解析内置 workspace）。 */
  bundledRuntimeVersion: string | null
  // —— 插件受保护集合判定（design 21 §6.11）与更新退出腿字段 ——
  /** 内建 dsh 工作区路径（装配期解析值——main.ts 模块级 builtinDshWorkspace
   *  常量 / sidecar inputs.builtinDshWorkspace）。localProtectionFacts 的
   *  resolveActiveRuntime(runtimeBaseDir, builtinDshWorkspacePath) 第二参：
   *  活动树解析需要它才能落到内建树；core 不自行解析 workspace 路径。 */
  builtinDshWorkspacePath: string | null
  /** 运行时线锚锁文件路径叶（design 21 §6.11.1 的 F 首选事实源）：装配侧解析
   *  `vendor/dsh/pnpm-lock.yaml`（Electron = app.isPackaged ? <resources>/vendor/dsh
   *  : <pkgDir>/vendor/dsh；Swift sidecar 装配 = <sidecar>/vendor/dsh，即
   *  builtinDshWorkspacePath 同根）。读不到返回 null——core 侧据此退到活动树自己
   *  的锁文件（跨线误判防护见 shouldPreferPinnedRuntimeLockfile）。 */
  pinnedRuntimeLockfilePath(): string | null
  /** 更新退出腿武装的回撤叶（可选；Electron 装配提供真叶）：I 组 update 状态
   *  订阅在武装期间收到重启失败（restartFailureText）或相位离开 downloaded 时
   *  调用——装配侧 hold updaterQuitArmed / 兜底计时器 / 关窗豁免（main.ts
   *  armUpdaterQuit·disarmUpdaterQuit 同源；叶自身幂等，未武装时 no-op）。
   *  Swift flavor v1 blocked-available 从不武装 ⇒ 不提供，订阅只做状态 push。 */
  disarmUpdaterQuit?(reason: string): void
}
