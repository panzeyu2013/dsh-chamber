/**
 * sidecar-ctx.ts —— Swift flavor sidecar 无头 ctx 装配（S-C-1 第一片 + S-C-2
 * 剩余占位真化；design 25 §3.1/§4.1；原 sidecar-entry.ts 的 buildHeadlessCtx
 * 拆分落位）
 *
 * S-C-1（第一片）把 C/D/E 组注册体（registry+凭据 / ssh 连接状态 / exec+systemd，
 * shell-core installIpcHandlers ② C/D/E 组段）的 ctx 依赖从 loud stub 换成与
 * main.ts 装配**同源同参**的真实实现。每段注记 main.ts 装配行号来源（当前
 * swift 分支 HEAD 8e6c2d9 的 main.ts 行区）：
 *  1. providers 真实（模块级单例 sshProvider/gatewayProvider——shell-core C 组
 *     normalizeConnectionInput 直 import 同一实例；configureSshPasswordStore /
 *     configureGatewaySecretStore / configureGatewaySessionProvider 各凭据存储
 *     注入 <userData> 等价位路径 + 现实例解析器——main 1344-1426 行区）。
 *     spawnFn 无需注入：ssh-provider/gateway-provider 的 spawn/askpass 均为纯
 *     Node 叶（askpass 0700 sh 助手 mkdtemp 于 os.tmpdir、child_process spawn），
 *     transport-manager 缺省 spawnFn = node:child_process spawn（main 装配同样
 *     未传 spawnFn，main 1437-1451）——无 Electron askpass 专用叶需要适配。
 *  2. transportManager 真实：createTransportManager 全参（provider/providers/
 *     instancesFile=userData/ssh-instances.json（instancesFilePath 模板）/
 *     logger→stderr [transport-manager] 前缀）——main 1437-1451。
 *  3. loadInstances 启动（corrupt→loud + 保留 .corrupt，语义同 main 1452-1466）；
 *  4. audit 真实：appendAuditEvent({file})（与 main 同参；JSONL append + 5 MiB
 *     轮换 + 白名单序列化——S24）；
 *  5. publishRegistryTransition 真实叶（main 2094-2159 纯逻辑部分：投影计算 /
 *     来源代际同步 / setGatewaySyncRegistration 注销 / sshPluginJournal 撤销 /
 *     SSH_INSTANCES_CHANGED committed push——push 经注入 edges.rendererPush +
 *     attemptCommittedRegistryPush（core delivery，transport-manager 导出）；
 *     main 侧宿主对象的纯模块工厂部分按 S6 字段注入真实实例（createSshPluginJournal
 *     (userData) / ExactOwnershipRegistry / ReadyPhaseEdges——main 1297/1618/1619）；
 *  6. confirmRegistryOriginSwitch 真实：edges.showMessage 宿主腿——main
 *     3752-3766 闭包文案/按钮序（['取消','切换版本源']，defaultId/cancelId 0）/
 *     应答映射逐字一致；无存活主窗 = edges.mainWindowAlive() 预检 + 竞态
 *     showMessage 抛错折算 → 'unavailable'。
 *
 * S-C-2（本片，S-C-1 尾部遗留清单真化）：
 *   F 组（ssh 插件 6 注册体依赖）：chamberHostPackageSeeds（seed 数组——
 *     sourceDir 取 sidecar 可用位：--host-*-dir 显式参数优先（打包 Resources
 *     布局由 Swift 侧传参），缺省 = main dev 布局的 repoRoot/packages/<pkg>
 *     同构查找（自 sidecar 模块目录向上检索）；运行时 existsSync 过滤与缺省
 *     loud 语义随 main）；sshPluginTargets 目标闭包束（main 1656-1683 逐字搬：
 *     findRemoteTarget/ownsRemoteTarget/scopedExecForTarget/scopedStatusForTarget/
 *     scopedProbeForTarget + transportManager 投影面 execTransport/statusTransport
 *     （main 1577-1578）+ liveProbeFor/gitWorktreeLiveProbeFor（main 1584-1614，
 *     probeClientGraphLive/probeGitWorktreeLive 纯叶同参））；startAutomaticHostSeed
 *     （main 1687-1734 逐字搬）；自动 seed ready 边缘与 SSH_STATUS_CHANGED/
 *     audit/代理注册在 sm.onStatusChanged 订阅（main 1857-2040 镜像——plane
 *     腿经下方 planeRef 注入，无 plane = 同 main cp===null 的跳过语义）；
 *     publishRegistryTransition 的 reseed 调度行补回（main 2125/2140-2142——
 *     `if (sm.status(id)?.phase === 'ready') startAutomaticHostSeed(id)`，随
 *     readySeedEdges.observe 边缘装配后同一实例生效）。
 *   G 组（gateway 插件 3）：syncGatewayChamberPluginsFor 真实叶（main
 *     1759-1794 逐字搬——本地 chamber host 包源（app.isPackaged 分支 →
 *     sidecar --host-*-dir/缺省同源解析）经 syncGatewayChamberPlugins 上传到
 *     REGISTERED transport origin；凭据/会话现真）+ gateway 会话 refresh
 *     （main 1502-1564 createGatewaySessionRefresh 装配——ready 注册 arm/
 *     离开 ready disarm 与 onVerified 指纹重注册随上方订阅接线；register 腿
 *     经 planeRef → plane.registerInstanceTransport，同 main 1525-1542）。
 *   H 组（local+npm）：runLocalPluginMutation 真实叶（main 1270-1286 逐字搬：
 *     runtime writer fence 租约 + runtimeState.startBlocked 启动门 +
 *     resolveActiveRuntime(runtimeBaseDir, builtinDshWorkspace) workspace
 *     解析——随本片 runtime 门族真化后可用）。
 *   J/K 组（runtime 全部）：DshRuntimeController 真实构造（main 2321-2382 的
 *     ControllerOptions/DI 逐字镜像——baseDir=runtimeBaseDir（<userData> 语义
 *     同 main app.getPath('userData')）、pnpmEntry 按 sidecar 可用位解析
 *     （dev <moduleDir>/node_modules/pnpm/bin/pnpm.cjs = main 2295 分支；
 *     打包 <moduleDir>/../pnpm/bin/pnpm.cjs = Resources/pnpm 同构，main 2294
 *     分支）、node 可执行 = 本进程 execPath（Electron-as-node 自身：
 *     main 2301-2304 runtimeNodeExecutor 分支逐字保留——Electron-as-node 时
 *     ELECTRON_RUN_AS_NODE=1 + --expose-internals，纯 node 时裸 execPath））；
 *     ctx 门族真实（runtimeOperationBusy/runtimeWriterFence/runtimeActionAllowed/
 *     readApplyNowGateInput/selectedJournalIntent/setRuntimeGate/
 *     publishBlockedStartup/authoritativeMetadataRecoveryStatus/
 *     runUserMetadataRecovery/refreshRuntimeEvidence/runStorePruneIfNeeded/
 *     restartLocalDsh/stopLocalDsh/runRuntimeStartup/bundledRuntimeVersion——
 *     以 main 装配各闭包原文镜像（main 2540-3462/3488-3560 行区），宿主叶中
 *     plane 依赖经 planeRef（sidecar-entry bindPlane 注入自身 controlPlane，
 *     connectionState/localDshPort/localProcessAlive/localWritersQuiescent/
 *     refreshLocalExposure/startLocal/stopLocal/restartLocal 同 main cp 面）；
 *     runtimeState.operation 事务槽（模块级 let，begin/end/inFlight 同 main 3746-3750）
 *     + RUNTIME_STATE_CHANGED push（runtimeInstance.onChanged →
 *     edges.rendererPush，main 2384-2388 同形——窗口门 = edges.mainWindowAlive）。
 *     启动尾部 = runStartupTail()（sidecar-entry 在 bindPlane 后调用——main
 *     3785-3789 refreshRuntimeEvidence().then(runRuntimeStartup) 同形）。
 *   updateController（I 组）：保持 loud——见下方注记（不可 headless 的真实原因）。
 *   runtimeFacts.dshVersion 真化：resolveActiveRuntime(runtimeBaseDir,
 *     builtinDshWorkspace).version（main 3612-3614 同参，INFO 每次 invoke 即时
 *     解析——runtime 切换/重启后返回新版本，绝不装配期定格）。
 *   A 组设置副作用叶（S-D 衔接增补 + S-E async 化）：ctx.setKeepAwake/
 *     setLoginItem 由 loud stub 改为真实转发——经注入 edges 的公开 sendEdge
 *     （node-edges 转发 → B 桥 edge：Swift 侧 legs 已真化（keep-awake
 *     ProcessInfo activity / setLoginItem SMAppService，no-bundle 诚实错误））。
 *     **await 桥应答**（S-E，parity 边界 #2 收口）：Swift 宿主 leg 应答天然
 *     异步——叶 await 应答：ok → resolve/{ok:true}；leg 失败（no-bundle/
 *     unavailable/apply-failed 等诚实错误 = sendEdge reject，transport
 *     ok:false 折算）→ setKeepAwake throw / setLoginItem {ok:false,error}
 *     （leg 错误原样进 {error}——文案源差异（Electron = electron app 报错，
 *     Swift = legs 文案）属宿主实现细节）——触发 applySettingsPatch 回滚 +
 *     绝不持久化 + renderer 收 {error}，与 Electron 同步失败（throw /
 *     {ok:false}）同一条路径（Electron 同步失败 = rejected promise；Swift
 *     异步失败 = rejected promise）。HostEdges 同步 setKeepAwake/setLoginItem
 *     （node-edges fire-and-forget）不再被 ctx 叶使用（避免双写/乐观假成功），
 *     保留供后续 HostEdges 面。settings 只加载不应用注记随之更新为「宿主腿经
 *     settings-set 转发；启动 reconcile 归 Swift 宿主（M3/W-22）」。
 *
 * Electron-free 不变式：本文件零 electron import（electron-free-gate 面 A 对
 * packages/desktop 顶层源码自动覆盖）；secret 存储路径一律 <userData> 等价位。
 * sidecar 无 Electron safeStorage：gateway 凭据镜像按 design 17 §12/S22 走诚实
 * loud 的 0600 plaintext 回退（main 无 keychain 分支同语义），绝不静默。
 */
import { createHash } from 'node:crypto';
import { describeError } from './describe-error.ts';
import { preserveFileAside } from './store-file-hygiene.ts';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PlaneHandle } from '@dsh-chamber/control-plane';
import type { ChamberSettings } from './chamber-settings.ts';
import { DEFAULT_CHAMBER_SETTINGS, readSettingsFile, writeSettingsFile } from './chamber-settings.ts';
import { IPC_CHANNELS } from './ipc-events.ts';
import { auditLogFilePath, captureNotificationSource, chamberSettingsFilePath, gatewaySecretsFilePath, instancesFilePath, LOCAL_RUNNING_STATES, localDshHomeDir, ownsNotificationSource, projectInstanceSecrets, projectNotificationSourceInstances, proxyTransport, readDshVersion, resolveActiveRuntime, sshPasswordsFilePath, syncNotificationSourceRegistry, type HostMessageOptions, type NotificationSourceToken, type ProjectedRegistryInstance, type ShellAssemblyCtx } from './shell-core.ts';
import { attemptCommittedRegistryPush, computeRemovedInstanceIds, computeRetiredInstanceIds, createTransportManager, type TransportManager } from './transport-manager.ts';
import { reconnectStaleTransports } from './transport-reconnect.ts';
import type { TransportInstanceSpec } from './transport-provider.ts';
import { cleanupStaleAskpassHelpers, configureSshPasswordStore, probeChamberHostLive, sshProvider } from './ssh-provider.ts';
import { configureGatewaySecretStore, configureGatewaySessionProvider, gatewayProvider, getGatewayPassword, getGatewayToken, syncGatewayChamberPlugins, type LocalChamberHostPackage } from './gateway-provider.ts';
import { createGatewaySessionManager, gatewayRegistrationAuthHeaders, gatewaySessionScopeForConnection, type GatewayRegistrationAuthProof } from './gateway-session.ts';
import { createGatewaySessionRefresh, gatewaySessionOriginForUrl, gatewayTunnelAuthority, type GatewaySessionRefresh } from './gateway-session-refresh.ts';
import { appendAuditEvent, type AuditEvent } from './audit-log.ts';
import { createSshPluginJournal } from './ssh-plugin-journal.ts';
import { sanitizeErrorText } from './sanitize-error.ts';
import { createHeadlessUpdateController } from './update-headless.ts';
import type { HeadlessUpdateController, NativeUpdaterBridge } from './update-headless.ts';
import { CHAMBER_HOST_PACKAGES } from './control-plane-module.ts';
import { packageDirName } from './host-package-dirs.ts';
import type { ChamberHostPackageSeed, ExecFn, RemoteSpec, StatusFn } from './plugin-sync.ts';
import type { ChamberHostPackageDescriptor } from './control-plane-module.ts';
import { ARCHIVE_CLEANUP_PACKAGE_NAME, CLIENT_GRAPH_PACKAGE_NAME, ExactOwnershipRegistry, GIT_WORKTREE_PACKAGE_NAME, ReadyPhaseEdges, builtChamberHostPackageSeeds, disposePluginSyncChildren, portableChamberHostPackageSeeds, reapStaleLocalPluginWriters, remoteHome, scopeExecToOwnership, seedRemoteChamberHostPackages } from './plugin-sync.ts';
import { setGatewaySyncRegistration } from './gateway-sync-registry.ts';
import { RuntimeOperationFence, clearStorePruneRequest, detectRuntimeMetadataHealth, disposeRuntimeInstaller, invalidate, isSafeVersion, pruneRuntimeStore, readActivationJournalState, readStorePruneRequest, resetCandidateHealthWindow, writeActivationIntent, writeOverride, type RuntimeMetadataHealth, type StartupResult } from '@dsh-chamber/dsh-runtime';
import { RUNTIME_ABORT_REASON } from './shell-core.ts';
import { createRuntimeStartupHost } from './runtime-startup-host.ts';
import type { RuntimeStartupHostState } from './runtime-startup-host.ts';

// 打包布局锚点（P-13）与 host 包源目录解析（P-05）——具名纯/近纯函数，Swift 布局
// 锁步测试（macos/.../PackagedLayoutTests.swift）读本段源文本与主锚点；调用方只在
// buildHeadlessCtx 内。路径事实的单源：
//   - host 包构建产物：<sidecarDir>/dist/<pkg>（Swift AppDelegate 的
//     sidecarDir + "/dist/" + name；build-sidecar.sidecarLayout().hostPackageDist）；
//   - 内嵌 pnpm 入口：<sidecarDir>/pnpm/bin/pnpm.cjs（sidecarLayout().pnpmEntry）。
// 改这些拼写必须同时改 macos/scripts/build-sidecar.mjs 与 Swift 侧锚点断言。

/** 打包布局：host 包构建产物目录 = `<sidecarDir>/dist/<packageDirName>`。 */
export function packagedHostPackageDir(sidecarDir: string, packageDirName: string): string {
  return path.join(sidecarDir, 'dist', packageDirName)
}

/** 打包布局：内嵌 pnpm 入口 = `<sidecarDir>/pnpm/bin/pnpm.cjs`。 */
export function packagedPnpmEntry(sidecarDir: string): string {
  return path.join(sidecarDir, 'pnpm', 'bin', 'pnpm.cjs')
}

/** 旧装配位：`<sidecarDir>/../pnpm/bin/pnpm.cjs`（sidecar 装配于
 *  Resources/sidecar/ 时的 Electron extraResources 同构位 Resources/pnpm）。 */
export function legacyPackagedPnpmEntry(sidecarDir: string): string {
  return path.join(sidecarDir, '..', 'pnpm', 'bin', 'pnpm.cjs')
}

/** dev 位：`<moduleDir>/node_modules/pnpm/bin/pnpm.cjs`（pinned dep）。 */
export function devPnpmEntry(moduleDir: string): string {
  return path.join(moduleDir, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
}

/** 检索根：自 startDir 向上第一个含 `pnpm-workspace.yaml` 的目录（P-05——
 *  host 包源目录探测必须限定在 workspace 根，祖先链上任意同名
 *  `packages/<pkg>/package.json` 不再可能成为 seed 源）。找不到 → null。 */
export function findWorkspaceRoot(startDir: string, maxDepth = 8): string | null {
  let candidate = startDir
  for (let depth = 0; depth < maxDepth; depth += 1) {
    if (existsSync(path.join(candidate, 'pnpm-workspace.yaml'))) return candidate
    const parent = path.dirname(candidate)
    if (parent === candidate) break
    candidate = parent
  }
  return null
}

/** host 包源目录解析（P-05/P-13）：显式 CLI 目录 > workspace 根
 *  `packages/<dir>`（且 package.json 存在）> 打包布局 `<moduleDir>/dist/<dir>`。
 *  返回值不保证存在——seed 侧按存在性 loud 过滤（与 main.ts 同向）。 */
export function resolveHostPackageSourceDir(
  packageDir: string,
  explicit: string | null,
  moduleDir: string,
): string {
  if (explicit !== null) return explicit
  const workspaceRoot = findWorkspaceRoot(moduleDir)
  if (workspaceRoot !== null) {
    const probe = path.join(workspaceRoot, 'packages', packageDir)
    if (existsSync(path.join(probe, 'package.json'))) return probe
  }
  return packagedHostPackageDir(moduleDir, packageDir)
}

/** pnpm 入口解析：装配位 > 旧装配位 > dev node_modules；全缺失时保留 dev 形状
 *  （安装路径上的 loud 失败与 main 缺 artifact 的 loud 语义同向）。 */
export function resolvePnpmEntry(moduleDir: string): string {
  const candidates = [
    packagedPnpmEntry(moduleDir),
    legacyPackagedPnpmEntry(moduleDir),
    devPnpmEntry(moduleDir),
  ]
  const firstExisting = candidates.find(entry => existsSync(entry))
  return firstExisting ?? devPnpmEntry(moduleDir)
}

/** publish/confirm 等真实叶所需的宿主边沿子集（node-edges 实现——sidecar-entry
 *  把同一 edges 实例传给 buildHeadlessCtx 与 installIpcHandlers：单装配不变式，
 *  push/确认对话框宿主腿与 core 投递状态机同对象、同事实缓存）。S-C-2 S-D 增补
 *  的 setKeepAwake/setLoginItem 同步转发腿已于 S-E 移除——A 组设置副作用叶改经
 *  sendEdge（node-edges 公开转发 → B 桥 edge 'setKeepAwake'/'setLoginItem'，
 *  Swift 侧 legs 真化）await 应答（见下方 sendEdge 注释与 real 字段两叶）。 */
export interface HeadlessCtxEdges {
  rendererPush(channel: string, payload: unknown): boolean
  mainWindowAlive(): boolean
  retireNotificationsForSources(retiredSourceIds: ReadonlySet<string>): number
  showMessage(opts: HostMessageOptions): Promise<number>
  /** B 桥异步 edge 请求面（S-E：node-edges 公开 sendEdge 转发——sidecar-entry
   *  用同一实例注入；edgeId 关联在实现侧）：resolve = 宿主应答 ok
   *  （frame.ok:true 的 result），reject = transport ok:false / leg 错误
   *  （sidecar-entry 应答分派折算；Error.message = Swift legs 错误串）。A 组
   *  设置副作用叶 await 本面应答——leg 失败不再 fire-and-forget，失败回滚
   *  语义与 Electron 同步叶一致（见 real 字段两叶）。 */
  sendEdge(method: string, payload: unknown): Promise<unknown>
}

/** Swift flavor 宿主输入（sidecar-entry 装配接线注入；S-C-2 新增）。 */
export interface HeadlessCtxInputs {
  /** 内建 dsh workspace（sidecar-entry --dsh-path；打包 = Resources/vendor/dsh，
   *  dev = repo ref-dsh 等位）——resolveActiveRuntime 的 builtin 分支 + 启动
   *  事务的 bundled 版本解析共用（main builtinDshWorkspace 同义）。 */
  builtinDshWorkspace: string | null
  /** 当前 chamber 版本（sidecar-entry 读 packages/desktop/package.json 的
   *  shellVersion）——Swift flavor 更新控制器（update-headless.ts）的
   *  currentVersion / 通道判定输入。 */
  chamberVersion?: string
  /** chamber host 包源目录（sidecar-entry --host-graph-dir/--host-git-dir/
   *  --host-archive-dir/--host-open-in-dir；打包 Resources 布局由 Swift 侧
   *  传参——null = 用缺省解析（见 hostPackageSourceDir 注释）。openIn 只喂
   *  本地控制面播种（localOnly 行），不进下面的远端 seed 数组。 */
  hostPackageDirs: {
    graph: string | null
    git: string | null
    archive: string | null
    openIn: string | null
  }
  /** 原生更新器桥（S-01 / 裁决 D-1 选 B；sidecar-entry 按 --native-updater 构造）。
   *  缺省 = 无原生安装腿：更新控制器保持 blocked-available，且只有此时 check 才走
   *  GitHub releases 发现（S-21：声明了原生腿就交壳的 Sparkle appcast，绝不双源）。 */
  nativeUpdater?: NativeUpdaterBridge | null
}

/** 本地 dsh spawn 门（sidecar-entry 的 createControlPlane 装配原样接线——
 *  main 1203-1220 的 getDshWorkspacePath/canStartLocal/canExposeLocal 三闭包的
 *  sidecar 宿主版：事务槽/启动门/workspace 解析状态全在装配侧（本文件），cp
 *  装配经本面取用，语义与 main 逐字同向）。 */
export interface HeadlessLocalSpawnGates {
  /** 权威 dsh workspace（启动事务特权 workspace 优先，否则活动运行时解析）：
   *  失败 throw（main 1203-1208 同文案）。 */
  getDshWorkspacePath(): string
  /** 公共启动门（main 1209-1216：writers 非 quiescent / runtimeState.startBlocked 且
   *  非事务内启动 → 拒绝）。 */
  canStartLocal(): { ok: true } | { ok: false; reason: string }
  /** 暴露门（main 1217-1220：门未开 = HTTP/WS/ready 投影隔离）。 */
  canExposeLocal(): boolean
}

/** buildHeadlessCtx 的装配结果：ctx（installIpcHandlers 消费）+ 优雅回收腿 +
 *  S-C-2 plane 晚绑定面（sidecar-entry 在 createControlPlane 后调用）与启动
 *  尾部（main 3785-3789 同形）。 */
export interface HeadlessCtxAssembly {
  ctx: ShellAssemblyCtx
  /** 本地 dsh spawn 门（见 HeadlessLocalSpawnGates）。 */
  localSpawnGates: HeadlessLocalSpawnGates
  /** 绑定控制面实例（plane 句柄注入：代理注册/会话 refresh/restart 宿主腿/
   *  connectionState 投影/refreshLocalExposure/onLocalStateChange 订阅）。 */
  bindPlane(plane: PlaneHandle): void
  /** 启动尾部（main 3785-3789 同形：refreshRuntimeEvidence().then(runRuntimeStartup)
   *  + catch 折叠）——bindPlane 之后调用恰一次。 */
  runStartupTail(): Promise<void>
  /** 优雅回收腿（sidecar SIGTERM/SIGINT 路径调用——transportManager.disposeAsync()
   *  + disposePluginSyncChildren + disposeRuntimeInstaller + runtime 事务 abort
   *  + sessionRefresh.dispose + gatewaySessions.dispose()，与 main.ts will-quit
   *  清理同源（main 1027-1063）；cp.stop 由 sidecar-entry 自行编排）。 */
  dispose(): Promise<void>
  /** 关窗/退出事实投影输入（E1/E9/E20，design 25 §5 同款判据）：chamber
   *  settings 的 windowCloseBehavior/quitConfirmation + 本地实例在跑判据
   *  （`LOCAL_RUNNING_STATES.has(connectionState) && localProcessAlive`，与
   *  main.ts before-quit 同源）。updateDownloadReady 恒 false——Swift v1 走
   *  blocked-available，无退出自动安装腿（design 25 §7）。决策本身由
   *  chamber-settings 的两个纯函数（shouldHideToTray / computeQuitRisk）在
   *  装配侧合成，本面只给事实。 */
  quitFacts(): {
    windowCloseBehavior: ChamberSettings['windowCloseBehavior']
    quitConfirmation: boolean
    localRunning: boolean
    updateDownloadReady: boolean
  }
  /** OS 唤醒 → 重探陈旧 transport（design 14 D4 ②；S3·D2）：判据与 Electron
   *  main.ts:679-697 reconnectStaleTransports 逐字对齐——只碰 phase error/
   *  degraded 且非终态（requiresUserAction !== true）的实例，绝不碰 idle；
   *  quit 在途早退。sidecar-entry 在 __host.systemResume 入站帧上调用（core
   *  回灌之外的装配侧第二条监听，Electron powerMonitor 双监听对偶）。 */
  reconnectStaleTransports(): void
}

/**
 * S2·F13 退出清理并行编排：把 dispose 与 cp.stop 两条腿**同时启动**、一起等待
 * （allSettled 语义——任一腿失败只 loud，不阻断另一条腿、不改变调用方/退出码
 * 语义）。与 Electron main will-quit 的单个 Promise.allSettled（main.ts
 * 1149-1155）同形：原 Swift 侧 `await dispose` → `await cp.stop` 串行会把
 * 退出耗时变成两者之和，cp.stop（本地 dsh/ssh 子进程回收腿）可能还没开始就撞
 * 4.5s 内部硬顶（QUIT_CLEANUP_DEADLINE_MS），留下孤儿进程。
 *
 * 启动语义：`legs.map(...)` 同步为每条腿建立 promise（async IIFE 体内首个
 * await 之前的 `run()` 立即执行），因此**所有腿都在等待任何一条结算之前已经
 * 启动**——这正是并行与串行的分界；`allSettled` 只负责收尾等待。
 *
 * @param legs 有序腿表（label 只用于失败日志，保持两条腿各自的既有文案）
 * @param onLegError 单腿失败 loud 腿（本函数从不 reject：失败只经它上报）
 */
export async function settleShutdownLegs(
  legs: ReadonlyArray<{ label: string; run: () => Promise<unknown> | undefined }>,
  onLegError: (label: string, error: unknown) => void,
): Promise<void> {
  await Promise.allSettled(
    legs.map(async ({ label, run }) => {
      try {
        await run()
      } catch (error) {
        onLegError(label, error)
      }
    }),
  )
}

/**
 * 装配 Swift flavor 无头 ctx。签名相对 W-13 原型（buildHeadlessCtx(userDataDir)）
 * 增加 edges 参数（S-C-1：publish push / 通知退役驱逐 / mainWindowAlive 预检 /
 * 确认对话框 showMessage 腿）与 inputs 参数（S-C-2：内建 dsh workspace + host
 * 包源目录）；sidecar-ctx 不 import node-edges/不持 plane——edges 实例由
 * sidecar-entry 构造后注入、plane 经 bindPlane 晚绑定，本文件保持纯装配面。
 * async（S-C-2）：启动前导 reaps 本地插件写进程账目（main 1112 reapStaleLocalPluginWriters
 * ——语义：stale writer 证明先于任何本地 spawn/写路径）。
 */
export async function buildHeadlessCtx(
  userDataDir: string,
  edges: HeadlessCtxEdges,
  inputs: Partial<HeadlessCtxInputs> = {},
): Promise<HeadlessCtxAssembly> {
  const stateDir = path.join(userDataDir, 'state')
  mkdirSync(stateDir, { recursive: true })
  const settingsPath = chamberSettingsFilePath(userDataDir)
  const auditLogPath = auditLogFilePath(userDataDir)

  // —— S-C-2 前导：runtime 启动事务的装配期宿主状态（main 1100-1191 行区
  // 同源——runtimeBaseDir=<userData>、localDshHome=<userData>/state/dsh-home、
  // bundled 版本/元数据健康快照 + shell 更新回落 F4 re-arm；先于任何本地
  // spawn/写路径）。——
  const runtimeBaseDir = userDataDir
  const localDshHome = localDshHomeDir(runtimeBaseDir)
  const shellVersion = ((): string => {
    // shell 版本事实：与 shell-core/main 同源（sibling package.json）——
    // override/activation journal 的 shellVersion 判别必须与 core 读到的
    // 版本一致（shell-core.ts 447 行同法）。
    try {
      const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version?: string }
      return pkg.version ?? 'unknown'
    } catch {
      return 'unknown'
    }
  })()
  const builtinDshWorkspace = inputs.builtinDshWorkspace ?? null
  /** chamber 版本（更新控制器 currentVersion / 通道判定；缺省 unknown 时
   *  check 仍可用，只是版本比较恒判「不可比较」→ loud error，绝不静默）。 */
  const chamberVersion = inputs.chamberVersion ?? 'unknown'
  const runtimeWriterFence = new RuntimeOperationFence()
  // 模块级事务槽与宿主门状态（main 380-388 同义；本文件每装配一份宿主状态，
  // 单进程单装配——main 模块级 let 的闭包等价）。
  const runtimeState: RuntimeStartupHostState = {
    startBlocked: true,
    startBlockedReason: '正在确认 dsh 运行时安全状态',
    internalStart: false,
    transactionWorkspace: null,
    operation: null,
    operationAbort: null,
  }
  let quittingRequested = false
  const planeRef: { current: PlaneHandle | null } = { current: null }
  const envOverrideActive = Boolean(process.env.DSH_CHAMBER_DSH_PATH)
  // Windows runtime mutations stay read-only（design 21 M2a/M2b；Swift flavor 为
  // macOS 装配——与 main 1109-1110 同表达式保留，防御一致）。
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
  // A shell-version fallback is itself a runtime/data switch（main 1125-1131 注释
  // 同源——持久化内建激活意图先于 override invalidation，崩溃不得无快照回内建）。
  const startupOverrideState = startupMetadataHealth?.override ?? { kind: 'corrupt' as const }
  const startupPointerState = startupMetadataHealth?.current ?? { kind: 'corrupt' as const }
  const bootstrapMetadataCorrupt = startupOverrideState.kind === 'corrupt'
    || startupPointerState.kind === 'corrupt'
  if (runtimeBootstrapFailure !== null) {
    // Writer ownership outranks runtime-selection mutation（同 main 1133-1135）。
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
    // A newly observed shell-version mismatch starts F4（main 1146-1169 逐字）：
    // durable invalidation 已落定的不重复造事务；EXCEPTION = 指针悬在旧树且
    // journal 丢失的 stranded 首事务——re-arm F4 完成被搁置的快照+探针回落。
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

  // —— 装配序与 main.ts whenReady 同向（行号 = 当前 swift 分支 main.ts）——
  // ssh plugin undo journal 现实例（main 1297-1300：createSshPluginJournal
  // (<userData>, {log,warn})——文件 <userData>/ssh-plugin-journal.json；本片
  // publish 叶的删除/操作目标变更撤销清理与后续 F 组 undo/apply 共用同一实例）。
  const sshPluginJournal = createSshPluginJournal(runtimeBaseDir, {
    log: (...args) => console.log('[sidecar-journal]', ...args),
    warn: (...args) => console.warn('[sidecar-journal]', ...args),
  })

  // chamber settings（design 14 D7）：启动加载 + 损坏 loud——readSettingsFile
  // 自身保留 *.corrupt 并返回 notice，绝不静默假默认。notice 与 Electron
  // main.ts:1430-1432 同路径 console.error（S2·F14：原实现丢弃 notice，用户
  // 设置被静默重置为默认而 stderr 无任何解释）；读取异常同样 loud 回退
  // （readSettingsFile 按契约恒返回 notice 而非抛错，这里只做防御，绝不静默）。
  let settings: ChamberSettings = DEFAULT_CHAMBER_SETTINGS
  try {
    const loaded = readSettingsFile(settingsPath)
    if (loaded.notice !== null) console.error(`[sidecar] ${loaded.notice}`)
    settings = loaded.settings
  } catch (error) {
    console.error('[sidecar] chamber settings 读取异常（回退默认值）：' + sanitizeErrorText(describeError(error)))
  }
  // main 1306-1313 的 keep-awake / 登录自启启动 reconcile 为 Electron 宿主腿
  // （setKeepAwakeActive/applyLaunchAtLogin，同步应用加载值）。Swift flavor：
  // 宿主腿经 ctx.setKeepAwake/setLoginItem 真实转发（见下方 real 字段——S-E
  // 起为 async 叶，await B 桥应答）；启动期 reconcile 归 Swift 宿主（M3/W-22——
  // Swift 起壳时按自身设置面应用），settings 加载本身不 side-effect（与既有
  // sidecar 行为一致）。

  // askpass 崩溃残留回收（main 1344-1345：cleanupStaleAskpassHelpers——启动期
  // 清理 crash 遗留的密码载体助手；纯 Node 叶，同模块同参）。
  const askpassNotice = cleanupStaleAskpassHelpers()
  if (askpassNotice !== null) console.error(`[sidecar] ${askpassNotice}`)

  // registry 现实例先占位：凭据存储配置期只持有惰性解析器（main 1346-1347 的
  // resolveCredentialSpec 闭包形态——transportManager 赋值后按引用共享）。
  let transportManager: TransportManager | null = null
  const resolveCredentialSpec = (id: string): TransportInstanceSpec | null =>
    transportManager?.listInstances().find(instance => instance.id === id) ?? null

  // SSH password store（design 05 §8 plaintext fallback, 0600/原子写/损坏 loud
  // 保留）：<userData>/ssh-passwords.json（sshPasswordsFilePath 模板——main
  // 1348-1352 同参）。凭据值绝不进 registry/日志/渲染器；写入纪律（write-only、
  // 绝不回读）在 ssh-provider 纯模块与 shell-core C 组注册体内，随迁保留。
  const passwordNotice = configureSshPasswordStore(sshPasswordsFilePath(runtimeBaseDir), resolveCredentialSpec)
  if (passwordNotice !== null) console.error(`[sidecar] ssh password store: ${passwordNotice}`)

  // Gateway credentials store（design 17 §12 schema v3, 0600, 原子写）：main
  // 1362-1394 经 Electron safeStorage 适配器（crypto adapter）加密镜像；sidecar
  // 为 Electron-free flavor——无 safeStorage，等同 main 无 keychain 分支的诚实
  // loud 语义：非 win32 = S22 0600 plaintext 回退（用户决策 2026-08，绝不静默——
  // loud 注册 + renderer 可见 secretStorage:'plaintext' 投影，projectInstanceSecrets
  // 经 gatewaySecretStorageMode 读真实存储模式）；win32（不可达于 Swift flavor，
  // 防御分支同 main 1374-1379）= memory-only（file null）拒绝明文。
  const windowsRefusePlaintext = process.platform === 'win32'
  if (windowsRefusePlaintext) {
    console.error('[sidecar] Windows safeStorage (DPAPI) 不可用 — 拒绝明文镜像回退 (design 21 C16)；gateway 凭据仅本次会话内存驻留，每次连接需重录')
  } else {
    console.warn('[sidecar] OS keychain (Electron safeStorage) 在 Swift flavor 不可用（Electron-free sidecar）— gateway credentials will be mirrored to the 0600 plaintext file fallback (design 17 §12/S22)')
  }
  const gatewaySecretNotice = configureGatewaySecretStore(
    windowsRefusePlaintext ? null : gatewaySecretsFilePath(runtimeBaseDir),
    undefined, // 无 Electron safeStorage 适配器 —— S22 plaintext 回退（上方 loud）
    resolveCredentialSpec,
  )
  if (gatewaySecretNotice !== null) console.error(`[sidecar] gateway secrets store: ${gatewaySecretNotice}`)

  // Gateway password-session manager（design 17 §7.1/§9.3——纯主进程内存；C 组
  // 注册体的 invalidation 直接面）：createGatewaySessionManager 纯 Node headless
  // 构造可行（gateway-session.ts 零 electron），与 main 1418 同源构造 + main
  // 1419-1426 的 configureGatewaySessionProvider 六钩子全量接线（密码会话流
  // ensure/cached/proof/invalidate 同源——ssh 隧道与 http 直连双形态共用）。
  const gatewaySessions = createGatewaySessionManager()
  configureGatewaySessionProvider({
    ensureSession: (origin, password) => gatewaySessions.ensureSession(origin, password),
    generation: origin => gatewaySessions.generation(origin),
    registrationAuthProof: origin => gatewaySessions.registrationAuthProof(origin),
    setRegistrationAuthProof: (origin, proof) => gatewaySessions.setRegistrationAuthProof(origin, proof),
    cachedCookie: origin => gatewaySessions.cachedCookie(origin),
    invalidate: origin => gatewaySessions.invalidate(origin),
  })

  // S24 非秘密审计叶（design 17 §13.4.4, JSONL append + 5 MiB 轮换, 0600——
  // audit-log.ts 模块；main 同参：appendAuditEvent({file})。序列化白名单/凭据值
  // 绝不入日志纪律在 serializeAuditEvent（control-plane 审计单源）——本叶只做
  // 文件绑定）。
  const audit = (event: AuditEvent): void => appendAuditEvent({ file: auditLogPath }, event)

  // Transport manager（design 03 §2.2/05 §7-§8）：与 main 1437-1451 同源同参。
  // provider 缺省 = sshProvider（legacy kind-keyed 条目解析）；providers 按
  // TRANSPORT 注册 {ssh, http}（design 17 §2.2）；instancesFile =
  // <userData>/ssh-instances.json；logger → stderr（sidecar-entry 已把 console
  // 重定向到 stderr），[transport-manager] 前缀同 main。
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
    // Corrupt instance file: loud failure — PRESERVE the file (rename to
    // *.corrupt, reversible) before starting empty; the next authoritative
    // save_connection rebuilds the registry (never silently faked as empty).
    // 语义与 main 1452-1466 逐字同向。
    console.error('[sidecar] 加载 SSH 实例失败：', loadError)
    const file = instancesFilePath(runtimeBaseDir)
    const aside = preserveFileAside(file, '.corrupt')
    if (aside.ok) console.warn(`[sidecar] 已保留损坏的实例文件为 ${aside.path}`)
    else console.error('[sidecar] 保留损坏实例文件失败：', aside.error)
  }
  // 初始来源代际同步（main 1491——installIpcHandlers 之前建立首代证明，
  // 装配序与 main 相同：先 sync 后 handler 注册）。
  syncNotificationSourceRegistry(projectNotificationSourceInstances(sm.listInstances()))

  // Transport-manager 执行/状态投影面（main 1577-1578 同源——plugin-sync 在
  // 本地重新声明 exec/status 契约，经结构等价收窄别名桥接）。
  const execTransport = sm.exec as unknown as ExecFn
  const statusTransport: StatusFn = (id) => sm.status(id)
  // 插件管理面实例级恒等指纹（main 1470-1482 逐字——registry 变更生命周期与
  // F 组目标闭包共用）。
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
  // S24 audit transition dedupe（main 1565-1569 同源——PHASE TRANSITIONS only）。
  const lastAuditedPhase = new Map<string, string>()
  const auditRegistered = new Set<string>()

  // —— S-C-2 G 组：live-proxy 会话自愈（design 17 §9.3，main 1492-1564 行区
  // 装配镜像）。纯 Node 控制器（gateway-session-refresh.ts 零 electron——时钟/
  // 计时器注入为纯 Node 缺省）；ready 注册 arm / 离开 ready disarm 随下方
  // sm.onStatusChanged 订阅接线（与 main 1976/1998 同点）。register 腿 =
  // planeRef → plane.registerInstanceTransport（main 1525-1542 同参——隧道
  // Host authority 覆盖 + registeredAuthFingerprints 锁步，见下方共享面）。——
  const registeredAuthFingerprints = new Map<string, string>()
  const authHeadersFingerprint = (headers: Record<string, string> | undefined): string => {
    const canonical = headers === undefined
      ? 'none'
      : Object.keys(headers).sort().map(key => `${key}:${headers[key]}`).join('|')
    return createHash('sha256').update(canonical).digest('hex')
  }
  const sanitizedRegistrationHeaders = (headers: Record<string, string>): Record<string, string> | undefined =>
    Object.keys(headers).length === 0 ? undefined : headers
  const sessionRefresh: GatewaySessionRefresh = createGatewaySessionRefresh({
    sessionManager: gatewaySessions,
    passwordFor: id => getGatewayPassword(id),
    tokenFor: id => getGatewayToken(id),
    readyUrlFor: id => sm.readyUrl(id),
    tlsPinFor: id => sm.listInstances().find(instance => instance.id === id)?.spkiPin ?? null,
    // Tunnel Host override（main 1508-1518 同源注释：ssh 隧道 gateway 目标以远端
    // LOOPBACK 权威重注册——Host 头/稳定 connection-target scope/网络 origin 与
    // verifyUp-minted session key 同构；authority 只路由、非所有权）。
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
      const livePlane = planeRef.current
      const registered = sm.listInstances().find(instance => instance.id === id)
      if (livePlane !== null) livePlane.registerInstanceTransport(`gateway:${id}`, url, headers, {
        ...(registered === undefined ? {} : { transport: proxyTransport(registered.transport) }),
        ...(tls === undefined ? {} : tls),
        ...(authority === undefined ? {} : { authority }),
      })
      // Keep the registered-auth fingerprint in lockstep（main 1533-1541 同源：
      // refresh 重注册 REPLACES 代理 headers——onVerified 指纹门须看到已轮换
      // cookie 为 "already registered"，否则下次 ready 探针无条件再注册）。
      registeredAuthFingerprints.set(`gateway:${id}`, authHeadersFingerprint(
        headers === undefined ? undefined : sanitizedRegistrationHeaders(headers),
      ))
    },
    // Bounded dead-cookie recovery（main 1543-1562 同源注释 + 实现：disconnect
    // （idle → 控制面注销 + 本 refresh disarm）→ connect（verifyUp 用存储密码
    // 重认证——单次 re-login → terminal path）；每次 refresh fire 至多一次、
    // 仅 transport 仍 ready 且同 origin 时；disconnect/connect 抛错绝不击穿
    // refresh 控制器）。
    reconnect: (id) => {
      try {
        sm.disconnect(id)
        sm.connect(id)
      } catch (error) {
        console.warn(`[sidecar] session-refresh recovery reconnect failed for ${id}: ${String(error)}`)
      }
    },
    warn: message => console.warn(`[sidecar] ${message}`),
  })

  // —— S-C-2 F 组：chamber host 包源目录（main 1624-1635 分支的 sidecar 位——
  // 显式参数（打包 Resources 布局由 Swift 传 --host-*-dir）优先；缺省 = 具名
  // resolveHostPackageSourceDir：workspace 根检索（P-05，限定含
  // pnpm-workspace.yaml 的根）→ 打包锚点 <moduleDir>/dist/<pkg>（P-13，与
  // Swift AppDelegate / build-sidecar.sidecarLayout 同拼写）。目录本身不在此刻
  // 校验——seed 侧按 main 1699/1705 的 existsSync(dist/index.js) 运行时过滤 +
  // loud。——
  const moduleDir = path.dirname(fileURLToPath(import.meta.url))
  const hostPackageSourceDir = (packageDir: string, explicit: string | null): string =>
    resolveHostPackageSourceDir(packageDir, explicit, moduleDir)
  const hostDirs = inputs.hostPackageDirs ?? { graph: null, git: null, archive: null }
  // 本 flavor 的源目录解析：显式 CLI 目录（--host-*-dir）优先，缺省 = dev 布局
  // 向上检索（打包布局由 Swift 传显式目录）。**键 = 注册表包名**，单一来源 =
  // control-plane 的 CHAMBER_HOST_PACKAGES（与 main.ts 的 chamberHostSourceDirs
  // 同构）——2026-12 审查：原先这里手抄三行，注册表新增一行会被静默漏掉。
  // 包名 → 仓库目录名（去 scope）的单源纯函数（有单测）；映射表仍只登记需要
  // 显式 CLI 目录的三个包——注册表新增非 localOnly 行若漏登记，下面的构造会
  // loud 警告，绝不静默少 seed 一个域（2026-12 验证轮收口）。
  const hostPackageSourceDirs: Record<string, string> = {
    [CLIENT_GRAPH_PACKAGE_NAME]: hostPackageSourceDir(packageDirName(CLIENT_GRAPH_PACKAGE_NAME), hostDirs.graph),
    [GIT_WORKTREE_PACKAGE_NAME]: hostPackageSourceDir(packageDirName(GIT_WORKTREE_PACKAGE_NAME), hostDirs.git),
    [ARCHIVE_CLEANUP_PACKAGE_NAME]: hostPackageSourceDir(packageDirName(ARCHIVE_CLEANUP_PACKAGE_NAME), hostDirs.archive),
  }
  // Host 包种子数组：注册表驱动（main 1636-1655 同形——insertId/packageName/
  // sourceDir/label 全部来自 descriptor）。localOnly 行（open-in）保留在数组里但
  // sourceDir 恒为空——「哪一行可以去别的机器」只由
  // portableChamberHostPackageSeeds（下方 portableHostSeeds）判，它绝不会把该行
  // 交给远端 seed、gateway 上传或控制面注入；本地播种走 --host-open-in-dir →
  // 控制面 hostOpenInPackageSourceDir（design 20 §6）。
  const chamberHostPackageSeeds: ChamberHostPackageSeed[] = CHAMBER_HOST_PACKAGES.map(descriptor => {
    const sourceDir = descriptor.localOnly === true
      ? ''
      : (hostPackageSourceDirs[descriptor.insert.name] ?? '')
    if (descriptor.localOnly !== true && sourceDir === '') {
      // 注册表新增一行而本 flavor 没给源目录 = 该域在远端 seed 与 gateway 上传
      // 都会被静默跳过（界面无提示）。Electron 侧同款判据是 loud 的，这里对齐。
      console.warn(
        `[sidecar] chamber host 包 ${descriptor.insert.name} (${descriptor.insert.id}) 在注册表里非 localOnly 但本 flavor 无源目录映射：`
        + '远端 seed 与 gateway 上传都会跳过该域（需在 hostPackageSourceDirs 登记）',
      )
    }
    return {
      insertId: descriptor.insert.id,
      packageName: descriptor.insert.name,
      sourceDir,
      label: descriptor.insert.id,
      ...(descriptor.localOnly === true ? { localOnly: true as const } : {}),
    }
  })

  // 可移植（非 localOnly）seed 列表：本数组按构造已排除 open-in localOnly 行，
  // 但「哪一行可以去别的机器」的**规则**仍取自单一实现（design 20 §6；main.ts
  // 的 portableHostSeeds 同源）——Swift flavor 不再自带一份过滤判定，规则分叉
  // 在结构上不可能（2026-12 合并审计 advisory 收口）。
  const portableHostSeeds = portableChamberHostPackageSeeds(chamberHostPackageSeeds)

  // Exact-incarnation single-flight for ready/manual host-package seeds（main
  // 1615-1619 同源——changed same-id target 立即 supersede；stale finally/log/
  // result 路径绝不清理/写入其替换者）。
  const hostPackageSeeding = new ExactOwnershipRegistry()
  const readySeedEdges = new ReadyPhaseEdges()
  // Remote install-level fallback path shared by both chamber host packages
  // （main 1684-1686 同源）。
  const remoteHostPackageDir = (spec: RemoteSpec, packageName: string): string =>
    `${remoteHome(spec.remoteDshHome)}/profiles/node_modules/${packageName}`

  // —— S-C-2 F 组：ssh 插件管理目标闭包束（main 1656-1683 逐字搬）。目标 =
  // spec + operational fingerprint + 来源代际 token（F 组 owns 复验与 C 组来源
  // 证明同一代际面）。——
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
  // Live-effect probe for the chamber host packages（design 09 module A / 08 §11 /
  // 24 §7，与 main.ts 同源契约）：单个通用隧道 RPC 探针，由控制面注册表自带的
  // probe 描述子（method + args）驱动——不再有每包分支（合并前 host-graph /
  // git-worktree 各一个专用探针，main 已泛化）。无 ready 隧道 → null = "未探测"。
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
  // 自动 chamber host seed（main 1687-1734 逐字搬：单飞注册表 begin/owns/finish +
  // 构建产物 existsSync 过滤（缺失 loud 入实例环形日志）+ seedRemoteChamberHostPackages
  // 幂等注入）。自动路径与手动 seed 注册体共用同一 seed 数组/注册表/目标闭包。
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
        // 已构建判定与 main/shell-core 同一实现（空 sourceDir 绝不解析进程 CWD
        // 的 dist/index.js；可移植列表也不把 localOnly 行算作缺件）。
        const builtSeeds = builtChamberHostPackageSeeds(portableHostSeeds)
        if (builtSeeds.length === 0) {
          if (ownsSeed()) console.log(`[sidecar] chamber host seed skipped for ${id}: no built host package artifacts`)
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
          console.log(`[sidecar] chamber host packages seeded onto ${id} (${seeded}; wrote=${result.wrote}, patched=${result.patched})`)
          const packageSummary = result.packages.map(entry =>
            `${entry.insertId}${entry.wrote ? ' 已写入' : ' 已是最新'}（${remoteHostPackageDir(target.spec, entry.packageName)}）`).join('；')
          appendSeedLog('info', `chamber host 包注入完成：${packageSummary}；boot 层${result.patched ? '已合并挂载' : '无需改动'}（重启后生效）`)
        } else {
          console.warn(`[sidecar] chamber host seed failed for ${id}: ${result.error}`)
          appendSeedLog('error', `chamber host 包注入失败：${result.error}`)
        }
      } catch (err) {
        if (!ownsSeed()) return
        const detail = describeError(err)
        console.warn(`[sidecar] chamber host seed error for ${id}: ${detail}`)
        appendSeedLog('error', `chamber host 包注入异常：${detail}`)
      } finally {
        hostPackageSeeding.finish(token)
      }
    })()
  }

  // —— S-C-2 G 组：本地 chamber host 包源 + 手动 gateway 同步执行闭包（main
  // 1735-1794 逐字搬——2026-12 Phase 3 desktop-synced chamber host packages；
  // app.isPackaged 分支 = sidecar 源目录解析（上方 hostPackageSourceDir 同值）；
  // ready 注册自动 sync 与手动 gateway_plugin_sync re-entry 共用同一执行路径）。
  const localChamberHostPackageSources = (): Array<{ name: string; packageJsonPath: string; distIndexPath: string }> => {
    // 注册表驱动 + 可移植驱动（与 main.ts 的 localChamberHostPackageSources 同
    // 语义）：只遍历 portableHostSeeds，本地专属行绝不进 gateway 上传；源目录仍
    // 来自上方唯一的注册表映射。缺目录 = 响亮跳过（绝不静默少上传一个域）。
    return portableHostSeeds.flatMap(seed => {
      const dir = hostPackageSourceDirs[seed.packageName]
      if (dir === undefined || dir === '') {
        console.warn(
          `[sidecar] chamber host 包 ${seed.packageName} (${seed.insertId}) 缺源目录：`
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
      } catch {
        // Not built/bundled in this runtime — nothing to sync for this entry.
      }
    }
    return syncGatewayChamberPlugins({
      // Sync through the REGISTERED transport origin (the ready URL)（main
      // 1780-1786 同源注释：ssh 隧道 = 用户验证过的 loopback 端点，绝非远端
      // host:port；tunnel authority 覆盖呈现远端 gateway）。
      origin: url,
      authority: instance.transport === 'ssh' ? gatewayTunnelAuthority(instance.remotePort) : undefined,
      headers,
      spkiPin,
      packages,
      logger: { warn: message => console.warn(message), log: message => console.log(message) },
    })
  }

  // —— S-C-2 F/G 组：ready 注册期 auth 事实派生（main 1795-1834 逐字搬——S23
  // SPKI pin 随注册；token/password 存在性投影；会话 cookie 仅缓存读，值绝不
  // 出主进程）。——
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

  // —— S-C-2 F/G 组：sm.onStatusChanged 订阅（main 1857-2040 镜像）——S24 audit
  // transition 记录（非秘密 phase 转换，注册边沿一次）+ ready → 代理注册/凭据
  // 注入 + gateway 自动 sync + session refresh arm + 自动 chamber host seed
  // ready 边缘（readySeedEdges.observe）+ SSH_STATUS_CHANGED committed push。
  // Electron 差异注记：main 以 mainWindow 身份判据 + registryWindow !== null
  // 门；Swift flavor 无 window——同值判据 = edges.mainWindowAlive()（node-edges
  // 事实缓存）；plane 腿以 planeRef.current（bindPlane 前 = main cp===null 的
  // 跳过语义——同 main 1889-2014 的 if (cp !== null) 门）。——
  sm.onStatusChanged((id, status) => {
    // S24 audit（main 1857-1875 同源）：仅 phase TRANSITIONS；requiresUserAction
    // 终态分类同源。绝不落凭据/cookie/会话体。
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
    // Non-secret auth-mode marker（main 1876-1884 同源——存在性投影）。
    const auditAuth = status.kind === 'gateway'
      ? getGatewayToken(id) !== null && getGatewayPassword(id) !== null ? 'token+password'
        : getGatewayToken(id) !== null ? 'token'
          : getGatewayPassword(id) !== null ? 'password' : 'none'
      : 'none'
    const auditDetail = `auth:${auditAuth}${status.insecureHttp ? ',http_plaintext' : ''}`
    // Ready transport → per-instance reverse proxy（design 05 §7.1：main
    // 1885-2014 镜像——ready 注册/离开 ready 注销；transport URL 只在主进程）。
    const cp = planeRef.current
    if (cp !== null) {
      if (status.phase === 'ready') {
        const url = sm.readyUrl(id)
        if (url !== null) {
          if (status.kind === 'gateway') {
            const registered = sm.listInstances().find(instance => instance.id === id)
            const facts = currentGatewayAuth(id, url, registered)
            const auth = facts.auth
            if (!auth.ok) {
              // Fail closed on the verify→ready→register TOCTOU（main 1908-1934
              // 同源：密码 gateway 绝不因 cookie 在间隙被逐/失效而无头注册；
              // 有 token 时纯决策助手允许有意的 OR-principal bearer 回退）。
              cp.unregisterInstanceTransport(`${status.kind}:${id}`)
              registeredAuthFingerprints.delete(`${status.kind}:${id}`)
              sessionRefresh.disarm(id)
              sm.appendLog(id, 'warn', 'gateway session changed before proxy registration; re-authenticating')
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
            // 2026-12 Phase 3（main 1948-1964 同源）：每次 gateway ready 注册后
            // best-effort 把本地 chamber host 包 sync 进 gateway seed cache
            // （幂等：仅版本失配重传 + 上传请求 gateway 受控重启）。手动 sync
            // re-entry 参数（design 21 §6.5）经 setGatewaySyncRegistration 落
            // 注册表——C 组删除/离开 ready 撤销同表。
            setGatewaySyncRegistration(id, { url, headers: { ...auth.headers }, spkiPin: facts.spkiPin ?? null })
            void syncGatewayChamberPluginsFor(id, url, auth.headers, facts.spkiPin ?? null)
          } else {
            cp.registerInstanceTransport(`${status.kind}:${id}`, url, undefined, {
              transport: proxyTransport(status.transport),
            })
            registeredAuthFingerprints.set(`${status.kind}:${id}`, authHeadersFingerprint(undefined))
          }
          // Live-proxy session self-healing（main 1971-1976 同源）：ready 注册即
          // arm 预到期 refresh（无密码目标 no-op、重连后新隧道 origin 下幂等
          // re-arm）；dsh 目标无 auth 面 → 不 refresh。
          if (status.kind === 'gateway') sessionRefresh.arm(id)
          // S24: one registration edge per instance（main 1977-1990 同源）。
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
        // Leaving ready cancels the pre-expiry refresh（main 1995-1998 同源）。
        sessionRefresh.disarm(id)
        // Manual gateway_plugin_sync re-entry dies with the ready registration
        // （design 21 §6.5，main 1999-2002 同源）。
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
    // Remote chamber host-package seed ready 边缘（main 2015-2027 同源：kind dsh
    // + transport ssh 才 seed（seed 走 ssh exec 通道——http-direct/gateway 排除）；
    // 幂等 + 结果入环形日志 + 失败随下次 ready 重试；readySeedEdges.observe =
    // ready 边沿恰好一次门）。
    if (status.kind === 'dsh' && status.transport === 'ssh' && readySeedEdges.observe(id, status.phase)) {
      startAutomaticHostSeed(id)
    }
    // Committed status push（main 2028-2039 镜像——窗口门 = edges.mainWindowAlive；
    // push 前竞态复查同一叶；false → loud 等待下次查询兜底）。
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
        try { console.warn(`[sidecar] transport 状态已更新但 renderer push 失败：${pushed.error}`); } catch { /* callback boundary */ }
      }
    }
  })
  // Ready-state re-verification → proxy re-registration（main 2042-2078 镜像——
  // 心跳/用户探针可在 verifyUp 内轮换密码会话（401 → 一次存储密码 re-login），
  // 代理仍骑旧（死）cookie——仅当当前 auth headers 与已注册指纹不同才重注册
  // （注册会撤销在途流量——健康未变注册绝不重注册）；仅非秘密 sha256 指纹存
  // 储（headers VALUES 绝不进 map）；失败绝不 emit——翻转 phase 自愈）。
  sm.onVerified(id => {
    const cp = planeRef.current
    const current = sm.status(id)
    if (cp === null || current === null || current.phase !== 'ready' || current.kind !== 'gateway') return
    const url = sm.readyUrl(id)
    const registered = sm.listInstances().find(instance => instance.id === id)
    if (url === null || registered === undefined || registered.kind !== 'gateway') return
    const facts = currentGatewayAuth(id, url, registered)
    // Fail closed like the ready registration（main 2058-2062 同源注释）。
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

  // —— publishRegistryTransition 真实叶（main 2094-2159 纯逻辑部分的同源装配；
  // S-C-2 补回 reseed 调度行 main 2114/2125/2140-2142）——
  // registry 变更生命周期权威 sidecar（source-lifecycle）：投影计算/来源代际
  // 同步/journal 撤销/committed push。main 侧宿主对象中凡纯模块工厂者按 S6 字段
  // 注入真实实例：sshPluginJournal（上方 createSshPluginJournal）、
  // hostPackageSeeding（ExactOwnershipRegistry）、readySeedEdges（ReadyPhaseEdges
  // ——S-C-2 起自动 seed ready 边缘（sm.onStatusChanged 订阅）已装配，observe/
  // forget 同实例对自动与撤销路径同效）。
  /**
   * Finish every committed registry transition through the source-lifecycle
   * authority. Metadata/secret persistence is owned by the transaction
   * (connection-save.ts → sm.saveInstances); this sidecar rotates
   * renderer/native-notification proofs, revokes exact plugin-seed owners,
   * and publishes the committed roster.
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
    // Manual gateway-sync re-entry dies with the instance (design 21 §6.5):
    // a removed row must never keep a registration a later
    // gateway_plugin_sync(id) call could sync against. setGatewaySyncRegistration
    // = gateway-sync-registry.ts 纯模块级注册表（shell-core G 组同源直 import）。
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
        // The plugin undo journal is bound to the OPERATIONAL target: an
        // id-stable edit that changed host/user/service/home invalidates
        // every op recorded on the previous target (design 21 §6.4 review
        // P1) — drop them here AND at undo time (latestOkForTarget).
        sshPluginJournal.clear(previous.id)
        // main 2125：service/home 编辑后仍是 dsh+ssh 目标的同 id 替换 →
        // 若已完成即显式 reseed（普通重连由 ready 边缘拾取）。
        if (current?.kind === 'dsh' && current.transport === 'ssh') reseedIds.push(previous.id)
      }
    }

    // 代际同步 + 队列退役丢弃 = syncNotificationSourceRegistry（core 导出）；
    // 活跃原生通知驱逐 = edges.retireNotificationsForSources（node-edges →
    // Swift notify 'retireNotifications'）。
    const retiredNotificationSources = new Set(syncNotificationSourceRegistry(projected))
    if (retiredNotificationSources.size > 0) {
      edges.retireNotificationsForSources(retiredNotificationSources)
    }

    // A service/home edit may complete while the transport is already
    // ready. Seed the replacement owner explicitly; ordinary reconnects
    // are picked up by the ready edge above.（main 2137-2142 逐字——仅 ready
    // 实例可达：startAutomaticHostSeed 经 findRemoteTarget 解析 + 单飞注册表。）
    for (const id of reseedIds) {
      if (sm.status(id)?.phase === 'ready') startAutomaticHostSeed(id)
    }

    // Committed lifecycle push（{removedIds, retiredIds} 文本与 main 2144-2157
    // 逐字一致；renderer-trust 锚定）。Electron main 以 registryWindow !== null
    // 为门 + push 前窗口身份复查；Swift flavor 无 window 对象——同值判据 =
    // edges.mainWindowAlive()（node-edges 事实缓存，hostFacts 推送刷新），
    // push 前竞态复查同一叶。叶 false = 无存活主窗，折算失败 loud（与 main
    // 的「throw → {sent:false}」语义等价）；无窗口常驻期间由下次查询兜底。
    if (edges.mainWindowAlive()) {
      const pushed = attemptCommittedRegistryPush(() => {
        if (!edges.mainWindowAlive()) {
          throw new Error('registry renderer changed before push')
        }
        if (!edges.rendererPush(IPC_CHANNELS.SSH_INSTANCES_CHANGED, { removedIds, retiredIds })) {
          throw new Error('registry renderer push failed')
        }
      })
      if (!pushed.sent) {
        console.warn(`[sidecar] registry 已保存但 lifecycle push 失败（等待 renderer 重拉）：${pushed.error}`)
      }
    }
    return projectedSaved
  }

  // S-C-2 J/K 组：dsh runtime 管理宿主（design 18；main 2291-3560 行区的
  // 装配镜像——控制器现实例/证据刷新/启动门/启动事务/元数据恢复/apply-now
  // 门输入/事务槽/计时器；plane 依赖一律经 planeRef，runStartupTail 在
  // sidecar-entry bindPlane 后调用）。

  // pnpm 入口解析（main 2293-2295 的 packaged/dev 两分支 → sidecar 位）：
  //  - 装配（W-23 三审新增）：<moduleDir>/pnpm/bin/pnpm.cjs（build-sidecar
  //    把内嵌 pnpm 拷进 sidecar 装配目录，与 node/vendor-dsh 同层）；
  //  - 旧装配位：<moduleDir>/../pnpm/bin/pnpm.cjs（sidecar 装配于
  //    Resources/sidecar/ 时的 Electron 同构位 Resources/pnpm——main 2294）；
  //  - dev：<moduleDir>/node_modules/pnpm/bin/pnpm.cjs（pnpm 11.21.0 pinned
  //    dep——main 2295 dev 分支同值）。
  //  P-13：三条候选拼写全部收进打包布局具名函数（packagedPnpmEntry /
  //  legacyPackagedPnpmEntry / devPnpmEntry），Swift 布局锁步测试锚定源文本。
  const pnpmEntry = resolvePnpmEntry(moduleDir)
  let storePruneOperation: Promise<void> | null = null
  // The shared core's default node executor is plain node (design 18 §9.1);
  // the desktop injects its Electron-as-node branch for EVERY pnpm child —
  // installs AND store-prune（main 2297-2304 逐字：sidecar 自身可能跑在
  // Electron-as-node（测试/打包腿）或 Swift 捆绑纯 node 下——两分支同表达式
  // 自动选择，Electron-as-node 分支与 main 完全同参）。
  const runtimeNodeExecutor = (): { file: string; args: string[]; env: Record<string, string> } =>
    process.versions.electron !== undefined
      ? { file: process.execPath, args: ['--expose-internals'], env: { ELECTRON_RUN_AS_NODE: '1' } }
      : { file: process.execPath, args: [], env: {} }
  const runStorePruneIfNeeded = (): Promise<void> => {
    if (storePruneOperation !== null) return storePruneOperation
    if (quittingRequested || readStorePruneRequest(runtimeBaseDir) === null) return Promise.resolve()
    const operation = pruneRuntimeStore({ baseDir: runtimeBaseDir, pnpmEntry, deps: { node: runtimeNodeExecutor } })
      .then(() => { clearStorePruneRequest(runtimeBaseDir) })
      .catch((error) => {
        // Retain the marker: the next safe startup/operation retries. Prune
        // failure is disk hygiene, not permission to block a verified tree.
        console.error('[sidecar] dsh runtime store prune failed:', sanitizeErrorText(describeError(error)))
      })
      .finally(() => {
        if (storePruneOperation === operation) storePruneOperation = null
      })
    storePruneOperation = operation
    return operation
  }

  // —— DshRuntimeController 现实例（main 2321-2382 的 ControllerOptions + DI
  // 全参镜像；K 组注册体与启动/证据路径共用——状态权威单一）。——
  const runtimeHost = createRuntimeStartupHost({
    logTag: 'sidecar',
    rendererPush: (channel, payload) => edges.rendererPush(channel, payload),
    windowAlive: () => edges.mainWindowAlive(),
    isQuitting: () => quittingRequested,
    settings: {
      get registryOrigin() { return settings.registryOrigin },
    },
    plane: {
      connectionState: () => planeRef.current?.connectionState ?? null,
      localWritersQuiescent: () => planeRef.current?.localWritersQuiescent ?? false,
      localProcessAlive: () => planeRef.current?.localProcessAlive ?? false,
      localDshPort: () => planeRef.current?.localDshPort ?? null,
      seededProbeDomains: () => planeRef.current?.seededProbeDomains ?? [],
      startLocal: () => planeRef.current?.startLocal(),
      stopLocal: () => planeRef.current?.stopLocal() ?? Promise.resolve(),
      refreshLocalExposure: () => planeRef.current?.refreshLocalExposure(),
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
    pnpmEntry,
    runtimeNodeExecutor,
    runStorePruneIfNeeded,
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

  // H 组本地插件执行叶（main 1270-1286 逐字搬——runtime writer fence 租约 +
  // runtimeState.startBlocked 启动门 + resolveActiveRuntime(runtimeBaseDir,
  // builtinDshWorkspace) workspace 解析——fence/启动门是装配侧运行时事务状态；
  // workspace 只在 fence 租约内解析，绝不跨运行时 swap 保留）。
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

  // —— ctx 完成形态：真实字段 + Proxy 兜底（未实现字段 = loud 抛
  // 'sidecar-ctx-unavailable:<field>'——绝不静默）。——
  const hostFacts = {
    flavor: 'swift' as const,
    controlPlaneUrl: '',
    platform: process.platform,
    trayPresent: () => true,
  }
  const real: Record<string, unknown> = {
    hostFacts,
    runtimeBaseDir,
    localDshHome,
    settingsIO: {
      current: () => settings,
      commit: (next: ChamberSettings) => {
        settings = next
      },
      persist: (next: ChamberSettings) => {
        writeSettingsFile(settingsPath, next)
      },
    },
    isQuitting: () => quittingRequested,
    // S-C-2：runtimeFacts.dshVersion 真化（main 3612-3614 同参——resolveActiveRuntime
    // 即时解析：env > valid override/current > builtin；运行时重启/切换后返回
    // 新版本，绝不装配期定格；builtin workspace = inputs.builtinDshWorkspace）。
    runtimeFacts: {
      dshVersion: () => resolveActiveRuntime(runtimeBaseDir, builtinDshWorkspace).version,
    },
    // S-C-2 S-D 增补 + S-E async 化（A 组设置副作用叶真实化——main 3622-3623
    // 的 shellCtx setKeepAwake: enabled => setKeepAwakeActive(enabled) /
    // setLoginItem: enabled => applyLaunchAtLogin(enabled) 的 Swift flavor
    // 同形）：两叶 async，await 注入 edges.sendEdge 的 B 桥应答（见文件头
    // S-C-2/S-E 增补段）。失败语义与 main 同步叶逐字一致——Electron
    // setKeepAwakeActive 同步失败 throw（applySettingsPatch catch 回滚）与
    // Swift leg 失败 reject 同一条路径；Electron applyLaunchAtLogin 失败
    // {ok:false,error} 与 Swift leg 失败 {ok:false,error} 同形（leg 诚实错误
    // 串原样进 {error} → loud 返回 + keepAwake 回滚 + 绝不持久化）。
    setKeepAwake: async (enabled: boolean): Promise<void> => {
      try {
        // 应答 ok（transport resolve）→ resolve；应答体携带 {ok:false,error}
        // 或 transport 层失败（ok:false → sendEdge reject）→ throw（触发
        // applySettingsPatch 的 catch 回滚路径，与 main 同步失败同形）。
        const answer = await edges.sendEdge('setKeepAwake', { on: enabled })
        if (answer !== null && typeof answer === 'object') {
          const mapped = answer as { ok?: unknown; error?: unknown }
          if (mapped.ok === false || typeof mapped.error === 'string') {
            throw new Error(typeof mapped.error === 'string' ? mapped.error : 'setKeepAwake edge failed')
          }
        }
      } catch (error) {
        const detail = describeError(error)
        console.error(`[sidecar] keep-awake host leg failed: ${detail}`)
        throw error
      }
    },
    setLoginItem: async (
      enabled: boolean,
    ): Promise<{ ok: true } | { ok: false; error: string }> => {
      // await B 桥应答后折算 {ok:true}|{ok:false,error}：transport 层失败
      // （sendEdge reject——Swift legs no-bundle/unavailable/apply-failed 等
      // 诚实错误串）与应答体 {ok:false,error} 一律映射 {ok:false,error}——
      // applySettingsPatch 的 loud 返回路径（+ keepAwake 回滚 + 不持久化），
      // 与 main applyLaunchAtLogin 失败 {error} 同形——绝不静默。文案源差异
      // （Electron = electron app 报错；Swift = legs 文案）属宿主实现细节。
      try {
        const answer = await edges.sendEdge('setLoginItem', { enabled })
        if (answer !== null && typeof answer === 'object') {
          const mapped = answer as { ok?: unknown; error?: unknown }
          if (mapped.ok === false || typeof mapped.error === 'string') {
            const detail = typeof mapped.error === 'string' ? mapped.error : 'setLoginItem edge failed'
            console.error(`[sidecar] login-item host leg failed: ${detail}`)
            return { ok: false, error: detail }
          }
        }
        return { ok: true }
      } catch (error) {
        const detail = describeError(error)
        console.error(`[sidecar] login-item host leg failed: ${detail}`)
        return { ok: false, error: detail }
      }
    },
    // S-C-1 真实化字段（C/D/E 组注册体装配依赖）：
    audit,
    transportManager: sm,
    gatewaySessions,
    publishRegistryTransition,
    confirmRegistryOriginSwitch: async (currentOrigin: string, nextOrigin: string) => {
      // registryOrigin 切换确认（SETTINGS_SET——design 18 trust boundary 变更需
      // 原生用户确认）。文案/按钮/默认序与 main.ts 3752-3766 闭包逐字一致；
      // 宿主腿 = edges.showMessage（node-edges → Swift NSAlert，按钮序号应答）。
      // 无存活主窗预检 = edges.mainWindowAlive()（与 main 的 win===null||destroyed
      // 同值）；预检与调用间窗口销毁的竞态 = showMessage 叶抛错 → loud + 折算
      // 'unavailable'（与 electron-edges S6 的 'native confirmation unavailable'
      // 语义同形——绝不误报 cancelled）。
      if (!edges.mainWindowAlive()) return 'unavailable' as const
      let response = 0
      try {
        response = await edges.showMessage({
          type: 'warning',
          title: '切换 dsh 运行时版本源？',
          message: '切换 dsh 运行时版本源？',
          detail: `版本检查、下载与安装的信任边界将从\n${currentOrigin}\n切换到\n${nextOrigin}`,
          buttons: ['取消', '切换版本源'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        })
      } catch (err) {
        console.error(`[sidecar] registryOrigin 切换确认失败（按不可用处理）：${String(err)}`)
        return 'unavailable' as const
      }
      return response === 1 ? ('confirmed' as const) : ('cancelled' as const)
    },
    // S-C-1 部分注资（S6 字段——publish 叶撤销清理依赖；F 组落地共用实例）：
    sshPluginJournal,
    hostPackageSeeding,
    // —— S-C-2 真化字段（F/G/H/J/K 组注册体装配依赖；runtimeBaseDir /
    // localDshHome 已在顶部 real 字段（S-C-1 值 = 本作用域同值常量）——
    // chamberHostPackageSeeds / sshPluginTargets / syncGatewayChamberPluginsFor
    // / runLocalPluginMutation 与 runtime 控制器族为本片新增。——
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
    runtimeController: runtimeInstance,
    runtimeOperationBusy: () => runtimeState.operation !== null,
    runtimeWriterFence,
    runtimeActionAllowed,
    refreshRuntimeEvidence,
    runStorePruneIfNeeded,
    restartLocalDsh: async () => {
      // PlaneHandle 宿主腿（main 3716-3720 同形——controlPlane null 门 +
      // restartLocal() + resolve 后实时 connectionState 读；resolve ≠ success
      // 的白名单判据留 core 注册体）。
      const livePlane = planeRef.current
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
      // cp.stopLocal 宿主叶（main 3745 同形——PlaneHandle 不进入 core）。
      const livePlane = planeRef.current
      if (livePlane === null) throw new Error('control plane not initialized')
      await livePlane.stopLocal()
    },
    runtimeOperationSlot: {
      begin: (operation: Promise<StartupResult | null>) => { runtimeState.operation = operation },
      end: () => { runtimeState.operation = null },
      inFlight: () => runtimeState.operation,
    },
    bundledRuntimeVersion: bundledVersion,
    // 2026-12 合并（main 的插件受保护集合判定，design 21 §6.11）：core 的
    // localProtectionFacts 需要内建工作区路径（resolveActiveRuntime 第二参）与
    // 运行时线锚锁文件路径叶。Swift 装配的内建树 = inputs.builtinDshWorkspace
    // （<sidecar>/vendor/dsh）；锚锁文件即该树自己的 pnpm-lock.yaml。更新退出腿
    // 回撤叶不提供（v1 blocked-available 从不武装 ⇒ ctx 可选字段缺省）。
    builtinDshWorkspacePath: builtinDshWorkspace,
    pinnedRuntimeLockfilePath: () => {
      // 装配形态：--dsh-path = <sidecar>/vendor/dsh（build-sidecar 随包拷贝
      // package.json + pnpm-lock.yaml + pnpm-workspace.yaml），与 Electron 的
      // <resources|pkgDir>/vendor/dsh/pnpm-lock.yaml 是同一份锚。
      // dev 形态：runbook 把 DSH_CHAMBER_DSH_PATH 指向 packages/desktop/vendor/dsh（同一
      // 锚）；若有人把它指向源码线 ref-dsh，该树的锁文件带 opt-in 段会被 F 信任
      // 判据拒绝 ⇒ familyNames=null ⇒ 官方 scope 安装一律拒（保守降级、绝不按
      // 另一条线误判），这是有意的 fail-closed 行为而非路径错误。
      if (builtinDshWorkspace === null) return null
      const candidate = path.join(builtinDshWorkspace, 'pnpm-lock.yaml')
      return existsSync(candidate) ? candidate : null
    },
    // 更新退出腿回撤叶：Swift v1 blocked-available 从不武装（无 quitAndInstall 腿），
    // 这里是显式惰性 no-op——**不能省略**：本文件末尾的 ctx Proxy 把「缺失成员」变成
    // 调用即抛的 methodStub，而 core 的 I 组状态订阅在每个非 downloaded 相位都调它
    // （shell-core 的 disarmUpdaterQuit?.(...)，首个 'checking' 相位也算），省略会让
    // 首次「检查更新」在订阅回调里抛错、headless 控制器 checking 卡死（2026-12 审查
    // blocker）。update-headless 的 setState 亦已加固为「listener 抛错不反噬控制器」。
    disarmUpdaterQuit: () => {},
  }
  /** 递归 stub：可调用（调用即抛）+ 任意成员访问返回同款 stub（供
   *  installIpcHandlers 顶部解构对象字段/方法后、在 handler 运行时才调用
   *  的形态）；个别装配期必须可调用的成员在 real 中显式提供（见
   *  updateController.subscribe）。 */
  const methodStub = (prefix: string): ((..._args: never[]) => never) =>
    new Proxy(
      function stub(): never {
        throw new Error('sidecar-ctx-unavailable:' + prefix)
      },
      {
        get(target, key) {
          const own = Reflect.get(target, key)
          if (own !== undefined) return own
          if (key === 'apply' || key === 'bind' || key === 'call') {
            return Function.prototype[key as 'apply' | 'bind' | 'call']
          }
          if (typeof key === 'string') return methodStub(prefix + '.' + key)
          return undefined
        },
      },
    ) as ((..._args: never[]) => never)
  // - updateController（I 组；W-22 真化——design 25 §7「v1 blocked-available
  //   诚实形态」）：Swift flavor 用 update-headless.ts 的纯 Node 控制器。
  //   发现单源（S-21）：inputs.nativeUpdater 在场（壳声明 --native-updater
  //   sparkle）时，check 经冻结边 updateNativeAction kind=check 交壳内 Sparkle
  //   （appcast 单源），相位经 __host.nativeUpdatePhase 回来，sidecar 绝不再跑
  //   GitHub releases 查询、也不排静默检查定时器；未声明原生腿时（dev /
  //   dry-run / 未配置密钥）才走 GitHub 发现 + installBlockedReason 恒为
  //   「原生壳不支持自动安装」+ download/restart 核心层显式拒绝。**不是**
  //   electron-updater 的伪造注入：Electron 版 createUpdateController 的
  //   autoUpdater 依赖 app 生命周期（quitAndInstall/autoInstallOnAppQuit），
  //   本 flavor 明确不做自带的安装实现。
  //   契约零改动（UpdateState 七值/字段集不变），消费面 settings-bridge
  //   UpdateSection 只按 phase + installBlockedReason 呈现。
  real.updateController = createHeadlessUpdateController({
    version: chamberVersion,
    // 原生安装腿（可选）：壳声明 --native-updater sparkle 时启用 Sparkle 转发。
    nativeUpdater: inputs.nativeUpdater ?? undefined,
    logger: {
      log: (...args: unknown[]) => console.log('[updater-headless]', ...args),
      warn: (...args: unknown[]) => console.warn('[updater-headless]', ...args),
      error: (...args: unknown[]) => console.error('[updater-headless]', ...args),
    },
  })
  // - setKeepAwake / setLoginItem（A 组 SETTINGS_SET 副作用叶）已于 S-C-2 真化、
  //   S-E async 化（见上方 real 字段——async 叶经注入 edges.sendEdge（node-edges
  //   公开转发）await B 桥应答；不再走 node-edges 的 HostEdges 同步叶）。
  // - ctx 无其他残留 stub：A 组两叶真化后，注册体可达字段全部真实（I 组
  //   updateController 于 W-22 真化，见上方注记）。
  const ctx = new Proxy(real as object, {
    get(target: Record<string, unknown>, key: string | symbol) {
      if (typeof key === 'symbol') return undefined
      if (key in target) return target[key]
      return methodStub(String(key))
    },
  }) as unknown as ShellAssemblyCtx

  // —— 装配面返回（S-C-2）：本地 spawn 门 + plane 晚绑定 + 启动尾部 + 优雅
  // 回收腿。——

  // 本地 dsh spawn 门（main 1203-1220 三闭包逐字——事务特权 workspace 优先、
  // writers quiescent 门 + runtimeState.startBlocked && !runtimeState.internalStart 公共门、
  // canExposeLocal = !runtimeState.startBlocked）。sidecar-entry 的 createControlPlane
  // 装配原样接线；闭包在 startLocal/暴露求值时经 planeRef 实时读 plane 自身
  // 状态（main 模块级 controlPlane 引用同义）。
  const localSpawnGates: HeadlessLocalSpawnGates = {
    getDshWorkspacePath: () => {
      if (runtimeState.transactionWorkspace !== null) return runtimeState.transactionWorkspace
      const resolved = resolveActiveRuntime(runtimeBaseDir, builtinDshWorkspace)
      if (resolved.path === null) throw new Error(resolved.blockedReason ?? 'dsh workspace not found')
      return resolved.path
    },
    canStartLocal: () => {
      if (planeRef.current?.localWritersQuiescent === false) {
        return { ok: false, reason: 'managed dsh writer ownership could not be proven quiescent' }
      }
      return runtimeState.startBlocked && !runtimeState.internalStart
        ? { ok: false, reason: runtimeState.startBlockedReason }
        : { ok: true }
    },
    canExposeLocal: () => !runtimeState.startBlocked,
  }

  let boundPlane = false
  const bindPlane = (plane: PlaneHandle): void => {
    if (boundPlane) {
      console.warn('[sidecar] bindPlane 重复调用（忽略——单装配不变式）')
      return
    }
    boundPlane = true
    planeRef.current = plane
    console.log(`[sidecar] control plane bound (connectionState=${plane.connectionState})`)
    // cp.onLocalStateChange 订阅（main 3332-3340 同源：degraded/restarting/error/
    // restart-exhausted → 关 known-good 候选健康窗口；restart-exhausted → 自动
    // 回退事务）。
    plane.onLocalStateChange((snapshot) => {
      if (snapshot.status === 'degraded' || snapshot.status === 'restarting'
        || snapshot.status === 'error' || snapshot.status === 'restart-exhausted') {
        try { resetCandidateHealthWindow(runtimeBaseDir) } catch (error) {
          console.error('[sidecar] known-good 健康窗口重置失败：', sanitizeErrorText(describeError(error)))
        }
      }
      if (snapshot.status === 'restart-exhausted') void runRestartExhaustedRollback()
    })
  }

  // 启动尾部（main 3785-3789 同形：refreshRuntimeEvidence().then(runRuntimeStartup)
  // ——catch 折叠为 loud + 启动门关闭 + failed 投影，绝不静默）。
  const runStartupTail = async (): Promise<void> => {
    if (!boundPlane) {
      console.error('[sidecar] runStartupTail 在 bindPlane 之前被调用（跳过——装配序错误，绝不让启动事务在无 plane 下跑）')
      return
    }
    // 无内建 dsh 树（--dsh-path 缺省）时，启动事务的终态恒为「无法确认内建
    // 版本 → blocked」，其发布无紧急性：延迟一个静默窗再跑，使 ready 后的
    // 首屏/门禁采样窗口内不存在 RUNTIME_STATE_CHANGED push 竞态（W-13 ②
    // 的 rendererPush 采样以「注册后第一个 push」为判据）；有内建树（真实
    // product 路径）不延迟——本地实例起动与 Electron 同序不引入额外时延。
    if (builtinDshWorkspace === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1500)
        timer.unref?.()
      })
    }
    try {
      await refreshRuntimeEvidence().then(() => runRuntimeStartup())
    } catch (error) {
      console.error('[sidecar] dsh 运行时启动事务失败：', error)
      runtimeState.startBlocked = true
      runtimeInstance.setLifecycle({ phase: 'failed', error: describeError(error) })
    }
  }

  // 优雅回收腿：传输层（SSH 隧道/在途 exec）+ 插件子进程 + runtime 安装器 +
  // gateway 会话内存 + session refresh 计时器（main will-quit 同源：1027-1063
  // ——quitting 门先置位（K 组事务/写路径看到即让路）→ abort 在飞运行时事务 →
  // 并行回收 → session refresh/gateway 会话清理）。
  const dispose = async (): Promise<void> => {
    quittingRequested = true
    runtimeState.startBlocked = true
    // G15：abort 文案单源（shell-core RUNTIME_ABORT_REASON）——与 main.ts will-quit 同串。
    runtimeState.operationAbort?.abort(new Error(RUNTIME_ABORT_REASON))
    try {
      await Promise.allSettled([
        transportManager?.disposeAsync().catch((err) => console.error('[sidecar] 传输层关闭失败：', err)),
        disposePluginSyncChildren().catch((err) => console.error('[sidecar] 插件子进程关闭失败：', err)),
        disposeRuntimeInstaller().catch((err) => console.error('[sidecar] 运行时安装器关闭失败：', err)),
        runtimeState.operation?.catch((err) => console.error('[sidecar] 运行时事务关闭失败：', err)),
      ])
    } finally {
      // 计时器先停：refresh 触发绝不可竞态已 dispose 的 manager（main 1058-1063）。
      sessionRefresh.dispose()
      gatewaySessions.dispose()
    }
  }
  // 关窗/退出事实投影（E1/E9/E20）：chamber settings 实时 holder + 本地实例
  // 在跑判据（main.ts before-quit 同源：状态机显示 running 不够，必须
  // localProcessAlive——restart backoff/死亡未探活期间可能误报 running）。
  const quitFacts = (): {
    windowCloseBehavior: ChamberSettings['windowCloseBehavior']
    quitConfirmation: boolean
    localRunning: boolean
    updateDownloadReady: boolean
  } => {
    const plane = planeRef.current
    const localRunning = plane !== null
      && LOCAL_RUNNING_STATES.has(plane.connectionState)
      && plane.localProcessAlive
    // updateDownloadReady（S-19 parity）：原生 Sparkle 阶段经
    // __host.nativeUpdatePhase 进同一个更新投影后，downloaded/installing 就是
    // Electron before-quit 的「更新已下载豁免」等价态（main.ts:1042
    // updateState.phase === 'downloaded'）——退出确认不得拦下即将安装的重启。
    // 无原生安装腿时相位永不到 downloaded，恒 false（原语义不变）。
    const updatePhase = (real.updateController as HeadlessUpdateController).state().phase
    return {
      windowCloseBehavior: settings.windowCloseBehavior,
      quitConfirmation: settings.quitConfirmation,
      localRunning,
      updateDownloadReady: updatePhase === 'downloaded' || updatePhase === 'installing',
    }
  }

  return {
    ctx,
    localSpawnGates,
    bindPlane,
    runStartupTail,
    dispose,
    quitFacts,
    // S3·D2：闭包绑定本装配的传输管理器单例 + 退出在途门（main 的模块级
    // transportManager / quitRequested 对偶；判据见模块级叶注释）。
    reconnectStaleTransports: () => reconnectStaleTransports(
      transportManager,
      () => quittingRequested,
      (message, error) => console.warn(message, error),
      '[sidecar]',
    ),
  }
}
