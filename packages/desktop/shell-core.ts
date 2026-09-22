/**
 * dsh-chamber desktop shell core (design 25 §4.1).
 *
 * Electron-free business logic: pure parameterizations and seam-leaf
 * replacements, no semantic rewrites, no state-machine reordering. The
 * Electron main process imports these functions and constants; the
 * Swift-native flavor reuses the same core.
 *
 * Hard invariants:
 * - Electron-free by construction: never import the electron package. The
 *   sole IPC registration point is installIpcHandlers: the registrar
 *   (deps.ipc) is injected by the assembly side — Electron main wraps it
 *   with the trustedIpc fence, so this file never spells ipcMain /
 *   webContents.send (electron-free-gate face C). IPC_CHANNELS constants
 *   (ipc-events.ts — a pure constants module) are legitimately referenced
 *   here.
 * - Host state is parameterized: userData-scoped paths and the runtime base
 *   dir arrive as arguments (resolveActiveRuntime / the path templates), argv
 *   arrives as an argument (scanDeepLinkUrls); nothing reads Electron host
 * state implicitly. State is parameterized per function (the
 * installIpcHandlers ctx seam). 渲染器投递状态机（队列/ready
 * 位/drain/来源代际/held resume/badge holder）是 core 业务状态，以模块作用域
 * 单例承载（装配侧 glue/IPC 与 core 共享同一实例——单装配不变式：
 * installIpcHandlers 每进程恰一次、先于任何窗口/渲染器事件，装配时快照
 * edges 子集与 quit 门）；宿主状态仍绝无模块作用域隐式读取。
 *
 * Responsibilities:
 * - Control-plane port resolution (design 05 §3.3): resolveControlPlanePort
 *   with its dev backoff base/attempts constants.
 * - Synchronous spawn-time dsh runtime/workspace resolution (design 18):
 *   resolveActiveRuntime / readDshVersion / ActiveRuntimeSource /
 *   ActiveRuntimeResolution.
 * - Proxy transport normalization: proxyTransport.
 * - Shared shell constants: LOCAL_RUNNING_STATES, QUIT_CLEANUP_TIMEOUT_MS,
 *   NPM_SEARCH_MAX_BODY_BYTES.
 * - Defensive deep-link argv scan: scanDeepLinkUrls.
 * - userData-scoped path templates: chamberSettingsFilePath /
 *   sshPasswordsFilePath / gatewaySecretsFilePath / auditLogFilePath /
 *   instancesFilePath / stateRootDir / localDshHomeDir.
 *
 * Responsibilities:
 * - Shell IPC registration point: installIpcHandlers with the IpcRegistrar /
 *   ShellAssemblyCtx seams (hostFacts / runtimeFacts / settingsIO and the
 *   settings side-effect leaves injected by the Electron main assembly).
 * - INFO / SETTINGS_GET / SETTINGS_SET handler bodies plus their helpers
 *   chamberSettingsStatus / applySettingsPatch / pushSettingsChanged
 *
 * Responsibilities:
 * - B 组 6 个注册体（NOTIFY / NOTIFICATIONS_READY / NOTIFICATION_OPEN_ACK /
 *   BADGE_COUNT / DEEP_LINK_READY / DEEP_LINK_ACK）——见 installIpcHandlers ②；
 *   NOTIFY 主链路（maybeShowNativeNotification）与其 claim/限速编排。
 * - 渲染器投递状态机（design 16 §4.2 / design 19 §3.3）：renderer 深链与通知
 *   打开的有界 ACK 队列 + ready 位 + drain（send 叶 = edges.rendererPush，
 *   requeue/rollback/acknowledge 语义原样）、来源代际/证明实例
 *   （NotificationSourceIncarnations / NotificationSourceProofs）、held
 *   lastResume 补发（handleSystemResume / handleMainWindowShown +
 *   pushHeldSystemResume）、badge 意图 holder 与平台门裁决。装配侧经导出入口
 *   访问（onRendererLifecycle / enqueueRendererDeepLinkIntent /
 *   captureNotificationSource / ownsNotificationSource /
 *   matchesNotificationSource / projectNotificationSourceInstances /
 *   syncNotificationSourceRegistry / clearBadgeIntentForQuit）——决策注记
 *   见「Renderer delivery state machines」段注释。
 *  Responsibilities:
 *  - C 组 6 个注册体：SSH_INSTANCES_GET / SSH_SAVE_CONNECTION /
 *    SSH_DELETE_CONNECTION / SSH_SET_PASSWORD /
 *    GATEWAY_SET_TOKEN / GATEWAY_SET_PASSWORD——见 installIpcHandlers ② 段；
 *    注册体侧纯辅助（gatewayOriginFor /
 *    normalizeConnectionInput）与 registry 非秘密投影链（projectInstances /
 *    projectInstanceSecrets——模块级导出，publishRegistryTransition
 *    沿用：core→main 单向依赖）。事务（connection-save）、canonicalize
 *    （transport-provider）与凭据写入口（ssh/gateway-provider）等纯模块直接
 *    import；装配依赖经 ctx：transportManager 句柄（registry 读写 + 状态/
 *    生命周期投影）/ audit / gatewaySessions / publishRegistryTransition（后
 *    三者宿主定义在 main 装配侧——publishRegistryTransition 的插件
 *    seed/journal 生命周期体与其 SSH_INSTANCES_CHANGED push 文本）。
 *  Responsibilities:
 *  - D 组 7 个注册体：SSH_CONFIG_LIST / SSH_CONNECT / SSH_DISCONNECT /
 *    SSH_STATUS / SSH_REVERIFY / SSH_LOGS / SSH_LOGS_CLEAR——见
 *    installIpcHandlers ② 段；CONFIG_LIST 经纯模块
 *    ssh-config.ts 的 discoverSshConfigHosts（非秘密投影纪律），其余
 *    6 个注册体全走 ctx 注入的 transportManager 句柄（Pick 面扩
 *    reverify / logs / clearLogs——connect/disconnect/status 为 C 组已有成员）。
 *    status/logs 的非秘密投影形状不变（localPort/phase 等元数据；URL/密钥绝不
 *    出主进程、绝不进载荷/日志）。
 *  Responsibilities:
 *  - E 组 4 个注册体：SSH_START_SERVICE / SSH_STOP_SERVICE / SSH_IS_ACTIVE /
 *    SSH_RESTART_SERVICE——见 installIpcHandlers
 *    ② 段；全走 ctx 注入的 transportManager 句柄 exec 面（Pick 扩
 *    exec——restart 注册体经 sm.exec 调同一执行面，决策注记见 E 组段）。
 *    systemctl argv
 *    固定参数数组与服务名白名单（SERVICE_NAME_PATTERN）及 generation 复验纪律
 *    是 transport-manager/ssh-provider 纯模块内部逻辑（spawn 前白名单拒绝 /
 *    execEpoch 复验）；注册体只做 {status} / {error} 结果投影（loud
 *    纪律注释）。
 *  Responsibilities:
 *  - F 组 6 个注册体：SSH_PLUGIN_LIST / SSH_PLUGIN_APPLY / SSH_PLUGIN_UNDO /
 *    SSH_SEED_HOST_GRAPH / SSH_PLUGIN_MATERIALIZE_ADD /
 *    SSH_PLUGIN_MATERIALIZE_ADD_PICK——见
 *    installIpcHandlers ② 段。编排纯模块（plugin-sync / ssh-apply-rows /
 *    plugin-tarball）直接 import；共享现实例与目标闭包束经 ctx 注入
 *    （sshPluginJournal / hostPackageSeeding / chamberHostPackageSeeds /
 *    sshPluginTargets——自动 seed/ready 撤销路径与 F 组共用同一
 *    实例/闭包族，语义不分叉；localDshHome 为装配期解析路径，core 不碰
 *    Electron paths）。确认对话框宿主腿 = HostEdges.showMessage、插件源 picker
 *    宿主腿 = HostEdges.pickPluginSource（electron-edges.ts；
 *    classifyPluginPick 留 core）；mainWindowAlive 预检 = edges 门。
 *    transportManager Pick 扩 appendLog（seed 结果入实例环形日志）。
 *  Responsibilities:
 *  - G 组 3 个注册体：GATEWAY_PLUGIN_SYNC / GATEWAY_PLUGIN_APPLY /
 *    GATEWAY_PLUGIN_MATERIALIZE——见
 *    installIpcHandlers ② 段。编排纯模块直接 import
 *    （gateway-ipc-shared / gateway-sync-registry / gateway-provider /
 *    plugin-tarball）。确认对话框复用 edges 版 confirmPluginAction 助手
 *    （core 内——宿主腿 = HostEdges.showMessage）、无存活主窗预检 =
 *    edges.mainWindowAlive、插件源 pick = edges.pickPluginSource。手动 sync 的
 *    上传执行闭包 syncGatewayChamberPluginsFor 经 ctx 注入（main 装配侧定义
 *    ——ready 自动 sync 与手动 re-entry 共用同一执行路径与注册参数，语义
 *    不分叉）。
 *  Responsibilities:
 *  - H 组 5 个注册体：LOCAL_PLUGIN_LIST / NPM_SEARCH / LOCAL_PLUGIN_ADD_FILE /
 *    LOCAL_PLUGIN_ADD / LOCAL_PLUGIN_REMOVE——见
 *    installIpcHandlers ② 段。编排纯模块直接 import
 *    （plugin-sync：localPluginList / runLocalDshPlugin /
 *    describeLocalPluginAddConfirmation / describeLocalPluginRemoveConfirmation；
 *    @dsh-chamber/dsh-runtime isAllowedRegistryUrl——npm 搜索的 registry URL
 *    白名单纪律）。本地安装的宿主子进程编排（runtime writer fence 租约
 *    + 启动门 + resolveActiveRuntime workspace 解析）经 ctx 注入叶
 *    runLocalPluginMutation（main 装配侧定义——fence/启动门是装配侧运行时事务
 *    状态；add 子进程 env 装配在 plugin-sync runLocalDshPlugin 纯模块内）。
 *    确认对话框复用 edges 版 confirmPluginAction
 *    助手（按钮序/取消默认/无窗文案一致）、ADD_FILE 的无存活主窗预检 =
 *    edges.mainWindowAlive、插件源 pick = edges.pickPluginSource。
 *  Responsibilities:
 *  - I 组 7 个注册体：OPEN_IN_APPS / OPEN_IN / UPDATE_STATE / UPDATE_CHECK /
 *    UPDATE_DOWNLOAD / UPDATE_RESTART / OPEN_RELEASE——见
 *    installIpcHandlers ② 段。open-in 面经 openInCtx/wiredCtx 共享
 *    宿主依赖束（app 能力协商经纯模块 open-in.ts；来源指纹 owns/matches 复查与
 *    来源代际捕获在 core；lookupInstance 经 ctx transportManager（sm 现实例）；
 *    宿主打开/揭示叶 = HostEdges openExternal/openPath/showItemInFolder——在
 *    electron-edges.ts）。update 面经 ctx 注入的 updateController 现实例
 *    （main 装配侧构造的 electron-updater 包装；类型 import 自 updater.ts——纯
 *    类型面，core 零 electron 运行时字样）与状态 push 订阅（committed-push 包装
 *    + edges.rendererPush，主窗身份折算见 I 组段注释）。
 *  - OS 深链启动队列与消费循环（design 16 §4.2）：pendingIntents（有界 64
 *    single-flight 队列）+ drain 闭包装配 + enqueueDeepLink（OS 三入口 glue 经
 *    导出入口调用）+ 启动尾部 drain 入口（drainDeepLinkLaunches）；
 *    装配点 = installIpcHandlers
 *    ② I 组段（wiredCtx 依赖束就绪后），见「OS 深链启动队列 + 外链打开预算器」段。
 *  - 外链打开统一入口（openExternally）：URL 规范化 + 10s/8 次预算 + 30s
 *    冷却（glue 经 core 导出 + 装配期快照的 edges.openExternal 宿主叶）。
 *  Responsibilities:
 *  - J 组 6 个注册体：RUNTIME_STATE / RUNTIME_RESTART / RUNTIME_CHECK /
 *    RUNTIME_INSTALL / RUNTIME_CLEANUP_VERSION / RUNTIME_CLEAR_FAILURE——见
 *    installIpcHandlers ② 段（trustedIpc 围栏由装配侧注入 registrar 包装）；
 *    dsh-runtime 控制器现实例
 *    （DshRuntimeController——main 装配侧 whenReady 构造）与 fence/门/宿主叶经
 *    ctx 注入（runtimeController / runtimeOperationBusy / runtimeWriterFence /
 *    runtimeActionAllowed / runtimeBaseDir / refreshRuntimeEvidence /
 *    runStorePruneIfNeeded / restartLocalDsh——main 侧 K 组注册体与启动/证据
 *    路径共用同一实例/闭包，语义不分叉）；@dsh-chamber/dsh-runtime 纯逻辑
 *    （isSafeVersion / cleanupExplicitRuntimeVersion /
 *    listExplicitlyInstalledVersions / listRuntimeFailures / clearRuntimeFailure
 *    ——electron-free 共享核）core 直接 import；确认对话框 = core 内
 *    confirmRuntimeMutation 助手（edges.showMessage 宿主腿——按钮序/取消默认/
 *    文案一致；无窗 → false = 'native confirmation unavailable' 不确认语
 *    义）；runRuntimeCheck（周期/首检计时器归 main 装配侧，经导出入口
 *    runRuntimeCheckCycle 调用同一实现）。
 *  Responsibilities:
 *  - K 组 6 个注册体：RUNTIME_RECOVER_METADATA / RUNTIME_RESET_BUILTIN /
 *    RUNTIME_RETRY_APPLY / RUNTIME_APPLY_NOW / RUNTIME_RETRY_RESTORE /
 *    RUNTIME_RESTORE_PRE_ROLLBACK——见
 *    installIpcHandlers ② 段。「运行时启动事务宿主」
 *    （runRuntimeStartup 与共享闭包族——executeMetadataRecovery 等恢复事务腿、
 *    publishBlockedStartup/setRuntimeGate 宿主门、authoritativeMetadataRecoveryStatus /
 *    runUserMetadataRecovery 元数据恢复资格投影与事务宿主、readApplyNowGateInput
 *    APPLY_NOW 门输入构造、selectedJournalIntent、stopLocalDsh（cp.stopLocal 叶）、
 *    runtimeOperationSlot 事务槽 begin/end/inFlight、bundledVersion 值）在
 *    main 装配侧、经 ctx 注入——K 组注册体与启动/证据路径共用同一实现/同一
 *    运行时事务槽，语义不分叉。dsh-runtime 纯逻辑直接 import
 *    （queueActivationIntent / writeActivationIntent / restoreMarkerAuthorityStatus /
 *    readActivationJournalState / writeOverride / listPreRollbackStashes /
 *    restorePreRollback——electron-free 共享核）；evaluateApplyNowGate 直 import
 *    apply-now-gate.ts（纯模块）。
 *
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { ChamberHostPackageDescriptor } from './control-plane-module.ts';
import { findFreePort } from './free-port.ts';
import { computeSupported } from './chamber-settings.ts';
import { createKeyedMemo, lockfileIdentityKey } from './lockfile-facts-memo.ts';
import type { ChamberSettings, ChamberSettingsStatus } from './chamber-settings.ts';
import { attemptCommittedRegistryPush, type TransportManager } from './transport-manager.ts';
import { IPC_CHANNELS } from './ipc-events.ts';
// Domain registrars (order of the calls below is the registration order).
import { registerConnectionHandlers } from './shell-ipc-connections.ts';
import { registerOpenInHandlers } from './shell-ipc-open-in.ts';
import { registerGatewayPluginHandlers } from './shell-ipc-plugins-gateway.ts';
import { registerLocalPluginHandlers } from './shell-ipc-plugins-local.ts';
import { registerSshPluginHandlers } from './shell-ipc-plugins-ssh.ts';
import { registerRuntimeHandlersA, registerRuntimeHandlersB, registerRuntimeHandlersC } from './shell-ipc-runtime.ts';
import { registerSettingsHandlers } from './shell-ipc-settings.ts';
import { registerUpdateHandlers } from './shell-ipc-update.ts';
import type { NotificationOpenIntent, NotificationSourceToken } from './notifications.ts';
import { type TransportInstanceSpec } from './transport-provider.ts';
import { getSshPassword } from './ssh-provider.ts';
import { gatewaySecretStorageCrossFlavorUnreadable, gatewaySecretStorageMode, getGatewayPassword, getGatewayToken } from './gateway-provider.ts';
import { type GatewaySessionManager } from './gateway-session.ts';
import type { AuditEvent } from './audit-log.ts';
import { adjudicateBadgeCount, badgePlatformGate } from './badge.ts';
import {
  BoundedAckDeliveryQueue,
  BoundedVscodeIntentQueue,
  canDeliverRendererDeepLink,
  describeUnknownError,
  detectVscodeAvailability,
  parseOpenVscodeIntent,
  runVscodeLaunch,
} from './deep-link.ts';
import type { VscodeLaunchContext, VscodeLaunchRequest } from './deep-link.ts';
// open-in.ts 为 electron-free 纯模块（openInCtx 宿主能力
// 注入面——stat/openPath/showItemInFolder 等叶由本文件装配侧经 edges 提供）；
// openReleasePage 自 updater.ts 运行时 import（updater.ts 模块加载零 electron——
// electron/electron-updater 均经 createRequire 惰性解析，见其文件头注记；本文件
// 只调用纯 URL 白名单 + 宿主叶路径）。update 面只做**类型** import（UpdateController
// 结构纯类型，无 electron 依赖——实例本体仍在 main 装配侧构造、经 ctx 注入）。
import type { OpenInLaunchContext } from './open-in.ts';
import type { UpdateController } from './updater.ts';

/** macOS「系统设置 → 通知」面板深链（Ventura+ 的 Notifications 扩展）。
 *  固定常量、只由 OPEN_NOTIFICATION_SETTINGS 注册体使用——renderer 不能传
 *  URL，避免把 OPEN_RELEASE 的 URL 白名单纪律扩成任意打开面。 */
export const MACOS_NOTIFICATION_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.Notifications-Settings.extension';
import { BoundedRateLimiter, MAX_PENDING_NOTIFICATION_OPENS, NotificationSourceIncarnations, NotificationSourceProofs } from './notifications.ts';
import { readCurrentPointerState, readOverrideState, shouldInvalidate, validateVersionTree } from '@dsh-chamber/dsh-runtime';
// J 组 6 注册体直 import 的 @dsh-chamber/dsh-runtime
// 纯逻辑（electron-free 共享核）；控制器现实例与
// fence/门/宿主叶经 ctx 注入（实例态与装配期单写者归 main 装配侧）。
import type { RuntimeAction, RuntimeOperationFence } from '@dsh-chamber/dsh-runtime';
// K 组 6 注册体直 import 的 @dsh-chamber/dsh-runtime
// 纯逻辑（electron-free 共享核——activation intent/journal/override 的持久化写与
// pre-rollback stash 的只读/恢复、restore marker 权威读）；
// StartupResult / ActivationJournalState 为类型面（ctx 宿主叶签名与 K 组
// 段内联事务注解用）。启动事务宿主（runRuntimeStartup 等）与共享闭包经 ctx
// 注入——实例态与装配期单写者归 main 装配侧。
import type { ActivationJournalState, StartupResult } from '@dsh-chamber/dsh-runtime';
// apply-now-gate.ts 为 electron-free 纯模块（主进程侧 RUNTIME_APPLY_NOW
// 注册体的纯门矩阵——evaluateApplyNowGate 直 import；其输入构造 readApplyNowGateInput
// 读 controlPlane/env/事务槽等装配侧状态，经 ctx 注入，见 ShellAssemblyCtx）。
import type { ApplyNowGateInput } from './apply-now-gate.ts';
// dsh-runtime-controller.ts 为 electron-free 纯编排模块（只 import
// @dsh-chamber/dsh-runtime + sanitize-error，零 electron）——core 只做**类型**
// import（DshRuntimeController / RuntimeLifecycleProjection 为结构纯类型面；
// 注册体返回的 state 形状经控制器方法类型推断，无需另行具名）；
// 控制器现实例在 main 装配侧构造、经 ctx.runtimeController 注入。
import type { DshRuntimeController, RuntimeLifecycleProjection } from './dsh-runtime-controller.ts';
// F 组编排纯模块直接 import——plugin-sync /
// ssh-apply-rows / plugin-tarball 均为 electron-free 纯模块（无 electron、
// 无 shell-core 反向依赖）。ssh-plugin-journal /
// plugin-sync 的**现实例**（createSshPluginJournal / ExactOwnershipRegistry /
// chamberHostPackageSeeds / 目标闭包束）经 ctx 注入——自动
// seed/撤销路径与 F 组注册体必须共享同一实例（单写者/单飞语义不分叉）。
import { portableChamberHostPackageSeeds, shouldPreferPinnedRuntimeLockfile, WEB_PROFILE } from './plugin-sync.ts';
import type { ChamberHostPackageSeed, ExactOwnershipRegistry, ExecFn, PluginProtectionFacts, RemoteSpec, StatusFn } from './plugin-sync.ts';
// 插件受保护集合判定（design 21 §6.11）：F 来源解析与装后
// 族一致性复验是 control-plane-module 的纯函数——core 直接 import；事实输入经
// ctx（builtinDshWorkspacePath / pinnedRuntimeLockfilePath / bundledRuntimeVersion，
// 见 ShellAssemblyCtx 字段注释）。localProtectionFacts / verifyLocalProfileFamily
// 为 core 内助手（F/H 组注册体共用同一实现）。
import {
  describeFamilyFindings,
  resolveRuntimeFamily,
  verifyProfileFamilyConsistency,
} from './control-plane-module.ts';
import type { SshPluginJournal } from './ssh-plugin-journal.ts';

// Control-plane port (design 05 §3.3): the packaged app keeps the documented
// default 17500; the dev launcher (electron-dev.mjs) runs with an isolated
// user-data dir, so its control plane must also avoid the packaged app's port.
// Dev starts at 17520 and auto-backs off to the first free port (parallel
// worktrees each land on their own port); DSH_CHAMBER_CP_PORT pins a fixed
// port. The renderer origin is derived from the actually bound port at
// runtime (controlPlane.port), so nothing else hardcodes the address. Port 0
// lets the OS pick an ephemeral port — the last resort when the whole dev
// backoff range is exhausted.
const DEV_CONTROL_PLANE_PORT_BASE = 17520;
const DEV_CONTROL_PLANE_PORT_ATTEMPTS = 200;
export async function resolveControlPlanePort(): Promise<number> {
  const fromEnv = process.env.DSH_CHAMBER_CP_PORT;
  if (fromEnv !== undefined && fromEnv !== '') {
    const parsed = Number(fromEnv);
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) return parsed;
    const fallback = process.env.DSH_CHAMBER_ELECTRON_DEV === '1' ? 'dev 自动退避端口' : '默认端口 17500';
    console.error(`[dsh-chamber] 忽略非法 DSH_CHAMBER_CP_PORT="${fromEnv}"（须为 1–65535 整数），使用${fallback}`);
  }
  if (process.env.DSH_CHAMBER_ELECTRON_DEV !== '1') return 17500;
  try {
    return await findFreePort(DEV_CONTROL_PLANE_PORT_BASE, { attempts: DEV_CONTROL_PLANE_PORT_ATTEMPTS });
  } catch {
    console.warn(
      `[dsh-chamber] dev 端口 ${DEV_CONTROL_PLANE_PORT_BASE}..${DEV_CONTROL_PLANE_PORT_BASE + DEV_CONTROL_PLANE_PORT_ATTEMPTS - 1} 均被占用，回退到系统临时端口（0）`,
    );
    return 0;
  }
}

/** The control-plane proxy currently ships the same two transport adapters as
 * the desktop registry. Keep the open-ended provider type at its boundary,
 * then fail loudly if a future adapter reaches registration before the proxy
 * has learned its trust/origin rules. */
export function proxyTransport(transport: TransportInstanceSpec['transport']): 'ssh' | 'http' {
  if (transport === 'ssh') return 'ssh';
  if (transport === 'http') return 'http';
  throw new TypeError(`unsupported proxy transport: ${transport}`);
}

export type ActiveRuntimeSource = 'env' | 'user' | 'bundled';
export interface ActiveRuntimeResolution {
  path: string | null
  version: string | null
  source: ActiveRuntimeSource
  blockedReason: string | null
}

// Shell (dsh-chamber desktop package) version: read from this module's
// sibling package.json — the same file in dev and packaged layouts (the
// resolver compares the override's recorded shellVersion against this
// version fact).
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

/**
 * Synchronous spawn-time resolver: env > valid override/current > builtin.
 * Selection metadata corruption and pointer/override disagreement fail closed;
 * they never alias the absence of a user runtime.
 */
export function resolveActiveRuntime(baseDir: string, builtinWorkspace: string | null): ActiveRuntimeResolution {
  const envPath = process.env.DSH_CHAMBER_DSH_PATH;
  if (envPath) return { path: envPath, version: readDshVersion(envPath), source: 'env', blockedReason: null };

  const overrideState = readOverrideState(baseDir);
  const pointerState = readCurrentPointerState(baseDir);
  // Unreadable (EACCES/EIO/ESTALE) material is exactly as un-resolvable as
  // corrupt material: it proves neither absence nor corruption, so it must
  // fail closed too — the same direction as dsh-runtime apply-phase.ts's
  // currentPointer() throw (B1 §2.3 / Phase B contract §2).
  if (overrideState.kind === 'corrupt' || overrideState.kind === 'unknown') {
    return {
      path: null,
      version: null,
      source: 'bundled',
      blockedReason: overrideState.kind === 'corrupt'
        ? 'dsh runtime override metadata is corrupt'
        : `dsh runtime override metadata is unreadable: ${overrideState.detail}`,
    };
  }
  if (pointerState.kind === 'corrupt' || pointerState.kind === 'unknown') {
    return {
      path: null,
      version: null,
      source: 'bundled',
      blockedReason: pointerState.kind === 'corrupt'
        ? 'dsh runtime current pointer is corrupt'
        : `dsh runtime current pointer is unreadable: ${pointerState.detail}`,
    };
  }
  const override = overrideState.kind === 'valid' ? overrideState.record : null;
  const pointer = pointerState.kind === 'valid' ? pointerState.version : null;
  // Override validity (invalidatedAt / shell-version mismatch) is decided by
  // the shared dsh-runtime core predicate (shouldInvalidate — the same replay
  // gate the runtime startup and the gateway shape consume).
  if (
    override !== null
    && !shouldInvalidate(override, version)
  ) {
    if (pointer !== null) {
      const tree = validateVersionTree(baseDir, pointer);
      if (tree.ok) return { path: tree.path, version: pointer, source: 'user', blockedReason: null };
      return {
        path: null,
        version: pointer,
        source: 'user',
        blockedReason: `dsh runtime pointer tree is invalid: ${tree.error}`,
      };
    }
    const builtinIsAuthoritative = override.pending !== null
      || override.chosenVersion === null
      || override.resolvedVersion === null
      || override.lastOutcome === 'rolled-back'
      || override.lastOutcome === 'failed';
    if (!builtinIsAuthoritative) {
      return {
        path: null,
        version: override.resolvedVersion,
        source: 'user',
        blockedReason: 'active user override is missing its authoritative current pointer',
      };
    }
  }
  if (pointer !== null) {
    return {
      path: null,
      version: pointer,
      source: 'user',
      blockedReason: 'dsh runtime pointer has no matching active override',
    };
  }
  return {
    path: builtinWorkspace,
    version: readDshVersion(builtinWorkspace),
    source: 'bundled',
    blockedReason: builtinWorkspace === null ? 'bundled dsh workspace not found' : null,
  };
}

export function readDshVersion(workspace: string | null): string | null {
  if (workspace === null) return null;
  try {
    const manifest = JSON.parse(readFileSync(path.join(workspace, 'package.json'), 'utf8'));
    return manifest.dependencies?.['@deepseek-ai/dsh'] ?? null;
  } catch {
    return null;
  }
}

// Dual-flavor parity helpers (deviations register).
// The two flavors share these so a policy or a gate cannot drift into a
// silently different behavior on one side; the Swift side consumes the same
// spellings through the B bridge/assembly where one exists.

/** The ONLY runtime-transaction abort reason (main.ts will-quit's
 *  runtimeOperationAbort.abort and the startup transaction's quit guard; the
 *  Swift sidecar's same site -- sidecar-ctx dispose -- must reference this
 *  constant instead of spelling its own text). Renderer-invisible, but once
 *  sourced here there is no "same semantics, two different strings" face to
 *  drift. */
export const RUNTIME_ABORT_REASON = 'application is quitting';

/** The ONLY rendererPush delivery gate. Both flavor implementations must
 *  fold their return value through it: mainWindowAlive && webViewContentAlive
 *  (Electron's webViewContentAlive carries the isCrashed predicate; the Swift
 *  side reads hostFacts.webViewContentAlive). A send on a crashed renderer
 *  never reaches the page, so not folding it to false would let core's
 *  hold/rollback/ready-reset semantics silently diverge (held pushes never
 *  replay, dedupe claims never release). */
export function rendererPushDelivered(mainWindowAlive: boolean, webViewContentAlive: boolean): boolean {
  return mainWindowAlive && webViewContentAlive;
}

/** The pure decision core of the Electron renderer-recovery policy
 *  (same parameters as the
 *  Swift RendererRecoveryPolicy/HangWatchdog: at most 3 reloads inside a 60s
 *  window, no hang reload before the first load finishes, clean-exit/quitting
 *  never reload). main.ts keeps only the timers and the window-destroyed
 *  guard; every decision goes through here. */
export const RENDERER_RECOVERY_WINDOW_MS = 60_000;
/** Maximum automatic reloads inside one window (the 4th attempt stops self-heal
 *  and shows the loud error box). */
export const RENDERER_RECOVERY_MAX_RELOADS = 3;
/** How long an unresponsive renderer may take to recover before a reload. */
export const RENDERER_HANG_RELOAD_DELAY_MS = 15_000;
/** Reload delay after render-process-gone (abnormal exit) -- clears the crash
 *  teardown window. */
export const RENDERER_CRASH_RELOAD_DELAY_MS = 500;

/** Reload-budget state (main.ts holds one instance for the window lifetime). */
export interface RendererReloadBudgetState {
  /** Current 60s window start in ms (0 = no window yet; the first reload opens one). */
  windowStart: number
  /** Reload attempts already made inside the current window. */
  count: number
}

/** Record one reload attempt and decide whether it is allowed (a window older
 *  than 60s resets the count -- the strict greater-than comparison). The
 *  returned attempt number drives the
 *  loud log/error box (attempt 4 = exhausted). */
export function noteRendererReload(
  state: RendererReloadBudgetState,
  now: number,
): { allowed: boolean; attempt: number } {
  if (now - state.windowStart > RENDERER_RECOVERY_WINDOW_MS) {
    state.windowStart = now;
    state.count = 0;
  }
  state.count += 1;
  return { allowed: state.count <= RENDERER_RECOVERY_MAX_RELOADS, attempt: state.count };
}

/** Whether an abnormal renderer exit triggers an automatic reload: clean-exit
 *  (normal window teardown) and a quit in flight never do. */
export function shouldReloadAfterCrash(reason: string, quitRequested: boolean): boolean {
  return reason !== 'clean-exit' && !quitRequested;
}

/** Before the first load finishes, an unresponsive renderer is only logged --
 *  the dsh frontend's boot (dozens of plugin modules) legitimately blocks the
 *  main thread; reloading would interrupt a normal startup (gate on both
 *  flavors). */
export function shouldScheduleHangReload(loadedOnce: boolean): boolean {
  return loadedOnce;
}

/** dev-shape in-repo dsh workspace candidates (order: <repoRoot>/ref-dsh then
 *  <packageDir>/vendor/dsh). Packaged shapes never use this -- Electron uses
 *  resources/vendor/dsh, and the Swift assembly passes --dsh-path explicitly. */
export function devBuiltinDshWorkspaceCandidates(packageDir: string): string[] {
  return [
    path.join(packageDir, '..', '..', 'ref-dsh'),
    path.join(packageDir, 'vendor', 'dsh'),
  ];
}

/** First existing dev candidate, or null. The injectable exists predicate
 *  lets the unit test cover both branches (defaults to existsSync). */
export function resolveDevBuiltinDshWorkspace(
  packageDir: string,
  exists: (candidate: string) => boolean = existsSync,
): string | null {
  for (const candidate of devBuiltinDshWorkspaceCandidates(packageDir)) {
    if (exists(candidate)) return candidate;
  }
  return null;
}

/** The Electron-free sidecar's builtin-workspace resolution -- an
 *  explicit --dsh-path wins; the packaged shape never probes the repository
 *  (the assembly always carries the path, and a failed probe keeps the loud
 *  blocked semantics); the dev shape falls back through the same candidate
 *  order. */
export function resolveSidecarBuiltinDshWorkspace(input: {
  explicit: string | null
  packaged: boolean
  packageDir: string
  exists?: (candidate: string) => boolean
}): string | null {
  if (input.explicit !== null) return input.explicit;
  if (input.packaged) return null;
  return resolveDevBuiltinDshWorkspace(input.packageDir, input.exists ?? existsSync);
}

// 本地实例「运行中/在途」状态（design 14 D2）：进程存活
// （ready/degraded）或 spawn/重启在途（starting/restarting）——退出会中断
// 它们，需确认。stopped / error / restart-exhausted 无进程可中断，不触发
// 确认。状态字符串不是存活事实——restart 序列里
// `restarting` 期间新进程可能尚未 spawn（backoff 1s→60s），死亡进程在下次
// 探活前也可能滞留在 ready/degraded；退出确认必须同时要求**实际有存活进程**
// （localProcessAlive），否则"本地明明没有实例在运行"也会误弹确认。注意
// `starting` 全程 child 尚未赋值（spawn 解析后才挂到连接上），hasLiveProcess()
// 恒为 false，配合 AND 门实际不参与确认——spawn 在途由控制面的 epoch/stopping
// 守卫在 stop() 时终止（绝不孤儿化），故「无进程则不确认」是安全的。
export const LOCAL_RUNNING_STATES: ReadonlySet<string> = new Set(['starting', 'ready', 'degraded', 'restarting']);

/** 深链 scheme 前缀（小写基准；比较时对 argv 前缀做 lower-case）。 */
export const DEEP_LINK_SCHEME_PREFIX = 'dsh-chamber://';

/** 扫描 argv 中的 dsh-chamber:// 深链（防御式：非深链 argv 零副作用、绝不 throw）。 */
export function scanDeepLinkUrls(argv: readonly string[]): string[] {
  const urls: string[] = [];
  for (const arg of argv) {
    // Scheme 按 RFC 3986 §3.1 大小写不敏感（WHATWG `new URL()` 也把 url.protocol
    // 小写化），Windows 注册表查找同样不区分大小写：`DSH-CHAMBER://…` 会唤起本应用，
    // 必须在此被收集。只比较前缀，path/query 原样保留、不参与小写化。
    if (typeof arg === 'string' && arg.slice(0, DEEP_LINK_SCHEME_PREFIX.length).toLowerCase() === DEEP_LINK_SCHEME_PREFIX) {
      urls.push(arg);
    }
  }
  return urls;
}

/** 退出清理（will-quit：transport dispose + 控制面 stop）的最长等待；超时强制
 *  退出，防「窗口已关、主进程永久滞留」的半退出态。子进程回收用短窗口
 *  （transport 1s / 本地 dsh 1s → SIGKILL）+ 传输层与控制面并行化，正常
 *  ~1-2s 完成；5s 硬顶仅为异常路径（如残留连接使 server.close 不回调）兜底。 */
export const QUIT_CLEANUP_TIMEOUT_MS = 5_000;
/** Cap on the npm search JSON body (registry search responses are ~KB-scale;
 * 256 KiB bounds a hostile or misbehaving registry). */
export const NPM_SEARCH_MAX_BODY_BYTES = 256 * 1024;

// userData-scoped path templates (design 25 §4.1 resource-path 收口):
// every persistent file / state root under <userData> is spelled
// here once; main.ts passes app.getPath('userData') at each call site.
/** <userData>/chamber-settings.json（design 14 D7）。 */
export function chamberSettingsFilePath(userData: string): string {
  return path.join(userData, 'chamber-settings.json');
}

/** <userData>/ssh-passwords.json（design 05 §8 plaintext fallback, 0600）。 */
export function sshPasswordsFilePath(userData: string): string {
  return path.join(userData, 'ssh-passwords.json');
}

/** <userData>/gateway-secrets.json（design 17 §12, schema v3）。 */
export function gatewaySecretsFilePath(userData: string): string {
  return path.join(userData, 'gateway-secrets.json');
}

/** <userData>/audit-log.jsonl（design 17 §13.4.4, JSONL append）。 */
export function auditLogFilePath(userData: string): string {
  return path.join(userData, 'audit-log.jsonl');
}

/** <userData>/ssh-instances.json（design 03 §2.2 persisted registry）。 */
export function instancesFilePath(userData: string): string {
  return path.join(userData, 'ssh-instances.json');
}

/** <userData>/state（控制面 stateDir）。 */
export function stateRootDir(userData: string): string {
  return path.join(userData, 'state');
}

/** <userData>/state/dsh-home（本地 dsh 实例 home）。 */
export function localDshHomeDir(userData: string): string {
  return path.join(userData, 'state', 'dsh-home');
}

// HostEdges — the host side-effect seam (design 25 §4.1).
// Core business code reaches every Electron/host side effect ONLY through
// this injected interface. The Electron main process implements it in
// electron-edges.ts (createElectronEdges — the rendererPush
// leaf); the Swift-native
// flavor will implement the same seam over the B bridge (node-edges.ts).
// Electron-free by construction: member types are strings/numbers/booleans/
// Promises/local structural types — never electron types,
// and no IPC registration or bare channel literals live here. Member-level
// deviations from the design 25 §4.1 draft are annotated per member (v2
// field set per design 25 §0.1 rows A10/B1/B3/B4/B9/B11/D3).

/** 原生通知 open intent / 来源代际 token（design 19 §3.3）——re-export 自纯逻辑
 *  模块 notifications.ts（electron-free，结构类型可直接跨 core/edges 使用）。 */
export type { NotificationOpenIntent, NotificationSourceToken };

/** 原生通知构造规格（§4.1 NativeNotificationSpec 的最小结构形态：通知叶
 *  new Notification({title, body, silent, sound…}) 所需字段；平台分支
 *  （macOS sound 等）属实现侧）。 */
export interface NativeNotificationSpec {
  title: string
  body: string
  silent?: boolean
  sound?: string
}

/** dialog.showMessageBox 选项（最小结构形态：按现用调用点
 *  type/title/message/detail/buttons/defaultId/cancelId/noLink 收口）。 */
export interface HostMessageOptions {
  type?: 'none' | 'info' | 'error' | 'question' | 'warning'
  title?: string
  message: string
  detail?: string
  buttons?: string[]
  defaultId?: number
  cancelId?: number
  noLink?: boolean
}

/** 插件源一体化 picker 结果（E8/A10：插件源 folder|.tgz，无 pickDirectory）。
 *  与 §4.1 草案 {kind:'folder'|'tgz';path}|null 的偏差：v2 以 status 判别
 *  cancelled/picked（path 非空即 picked；folder|tgz 的 kind 归实现/调用侧按
 *  design 21 §10 ⑧ 判定）。 */
export type HostPluginSourcePick =
  | { status: 'cancelled' }
  | { status: 'picked'; path: string };

/** badge 应用结果。与 §4.1 草案 setBadge(count): boolean 的偏差：v2 用判别
 *  形态区分「已应用」与「未应用 + 原因」（reason 取 string）。 */
export type HostSetBadgeResult =
  | { applied: true }
  | { applied: false; reason: string };

/** HostEdges — core 侧唯一可见的宿主边沿契约（design 25 §4.1 v2 字段集）。
 *  notifyClicked 与 resolveResource 两个**零消费者**成员不在契约内——Swift
 *  宿主对 notifyClicked（经 notify 到达）判为
 *  unexpected 并 loud 忽略、resolveResource 在两侧都恒不可达（core Pick 不含、
 *  无调用方），保留它们等于保留一条语义不同、无法锁步的死面。hostFacts 的
 *  resources 推送不被消费（Swift 侧可继续推送，未知事实键按前向兼容
 *  忽略）。
 *  electron-edges.ts 头注释列出已实现集合；每个成员标注其设计行来源，
 *  未实现前 core/main.ts 不得调用（Pick 收窄在编译期保证）。 */
export interface HostEdges {
  /** 主窗口渲染器 push 叶：channel 为 opaque
   *  通道名（Electron 侧恒为 IPC_CHANNELS 常量值），payload 为纯非秘密投影；
   *  返回 false = 当前无存活主窗（单窗身份），调用侧自行折算失败语义。 */
  rendererPush(channel: string, payload: unknown): boolean
  // —— 原生显示/系统集成 ——
  /** 构造并显示原生通知（B4：宿主对象登记/淘汰/evict 全留实现侧私有）。clickRoute
   *  携带 click 回灌路由——null = 'test'
   *  通知（无会话上下文，原生 click 只恢复窗口）；否则宿主 click 腿在宿主内先
   *  activate/restore/focus 主窗口（无窗则重建，showMainWindow 语义），成功后才
   *  回调 onActivated（core 的 owns+入队闭包——来源代际校验在 core）。honest-show
   *  结算（showNativeNotificationHonestly 语义）在实现侧内部执行；返回句柄的
   *  shown 暴露结算结果（NOTIFY IPC 返回值与 claim 释放依赖它），dispose 注销
   *  click 回执（注销后该通知的后续 click 只恢复窗口）。实现侧不 throw——构造/
   *  登记/监听失败一律结算为 shown:false 且登记清理内部完成。
   *  macOS 授权在 Electron 侧无可查询/可申请 API，实现
   *  侧只能把 OS 拒绝投递（failed）与限时无回执（timeout）如实映成带原因文本
   *  的 shown:false（notifications.describeNativeNotificationFailure）；预检
   *  查询/申请面的缺失登记为精确残余（见 electron-edges showNativeNotification），
   *  绝不冒充「已授权但普通失败」。 */
  showNativeNotification(
    spec: NativeNotificationSpec,
    clickRoute: { token: NotificationSourceToken; onActivated(): void } | null,
  ): { dispose(): void; shown: Promise<{ shown: true } | { shown: false; error: string }> }
  /** Notification.isSupported 平台探测（异常安全由实现侧保证）。 */
  notificationSupported(): boolean
  /** 未读徽标 apply 叶（design 19 §3.7；E5——平台门与 badgeEnabled 裁决留 core
   *  badge.ts：core 以 badgePlatformGate(platform, badgeCountApiAvailable())
   *  先裁决、supported 后才调用本叶）：异常安全，绝不 throw。 */
  setBadge(count: number): HostSetBadgeResult
  /** app.setBadgeCount API 可用性事实（badgePlatformGate 第二参；win32 的平台
   *  原因由 core 侧平台门区分）。 */
  badgeCountApiAvailable(): boolean
  /** 托盘可用性（design 14 D1 恢复入口判定）。 */
  trayAvailable(): boolean
  /** keep-awake（design 14 D5）：powerSaveBlocker prevent-app-suspension
   *  start/stop（blocker id 属实现侧宿主态）。 */
  setKeepAwake(on: boolean): void
  /** 系统 resume 事件订阅（design 14 D4；held-resume 补发点在 core）。 */
  onSystemResume(cb: (timestamp: number) => void): void
  /** 主窗口 'show' 事件订阅（B9：held-resume/通知补发点）。 */
  onMainWindowShown(cb: () => void): void
  /** 任一窗口是否聚焦（通知裁决的窗口焦点事实）。 */
  isFocused(): boolean
  /** 通知 click 激活腿（D3）：restore+focus，无窗则重建，完成后 resolve。 */
  focusMainWindow(): Promise<void>
  /** 渲染器可用性门（B3）：webContents 是否仍在加载。实现侧窗口守卫：无主窗/
   *  已销毁视同加载中（投递门恒不通过）。 */
  webViewLoading(): boolean
  /** 渲染器可用性门（B3）：webContents 是否存活（非 crashed/destroyed）。 */
  webViewContentAlive(): boolean
  /** 主窗口存在性门（B3 族）：win!=null 且未销毁——隐藏到
   *  托盘/后台的窗口仍为 true（与 loading/alive 区分：窗口在但不一定可用）。
   *  rendererPush 返回 false 与 mainWindowAlive() 为 false 语义等价。 */
  mainWindowAlive(): boolean
  /** 来源退役驱逐（B4 registry 私有）：注册表退役路径把
   *  sourceId ∈ retiredSourceIds 的活跃原生通知关闭并注销（click 回执随对象
   *  消亡），返回驱逐数。 */
  retireNotificationsForSources(retiredSourceIds: ReadonlySet<string>): number
  // —— 打开/拉起 ——
  /** shell.openExternal 叶（B11：URL 白名单判定/预算/冷却/规范化留 core）。 */
  openExternal(url: string): Promise<void>
  /** shell.openPath 叶（打开本地路径，失败 loud）。 */
  openPath(p: string): Promise<void>
  /** shell.showItemInFolder 叶（Finder 揭示）。 */
  showItemInFolder(p: string): void
  /** open-in 原生拉起（design 25 §5 E12）。 */
  launchApp(appId: string, path: string): Promise<boolean>
  // —— 对话框 ——
  /** 插件源一体化 picker（E8/A10：folder|.tgz；design 21 §10 ⑧）。 */
  pickPluginSource(): Promise<HostPluginSourcePick>
  /** dialog.showErrorBox 包装。 */
  showError(title: string, detail: string): void
  /** dialog.showMessageBox 包装（与草案 Promise<buttonId> 的偏差：buttonId
   *  收敛为 number = showMessageBox response）。 */
  showMessage(opts: HostMessageOptions): Promise<number>
  // —— 系统/身份/资源 ——
  /** 登录项开关（setLoginItemSettings）。 */
  setLoginItem(enabled: boolean): void
  /** app.isPackaged 能力位（B1）。 */
  isPackaged: boolean
}

// Renderer delivery state machines.
// 渲染器侧队列状态机（design 16 §4.2 / design 19 §3.3 /
// design 14 D4）：pendingRendererIntents + deepLinkRendererReady + drain、
// pendingNotificationOpens + notificationOpenDrainReady + drain、来源代际/
// 证明实例（notificationSourceIncarnations / NotificationSourceProofs）、held
// lastResume 补发、badge 意图 holder。本段是 core 业务状态（非宿主状态）——
// 「状态一律参数化、绝不模块作用域读」的例外：装配侧窗口
// glue / open-in IPC / 深链消费循环与 installIpcHandlers 必须共享同一实例。
// 单装配不变式：installIpcHandlers 每进程恰一次、先于任何窗口/渲染器事件（
// 调用点纪律：whenReady 内、createMainWindow 之前），装配时把 HostEdges 投递
// 子集（deliveryEdges）与 quit 门（quittingLeaf）快照进本段——此后所有导出
// 入口可用。Electron-free 不变式不变：本文件零 electron import，投递 send 叶
// 一律 edges.rendererPush、窗口事实一律 edges 门。
// 决策注记（逐条）：
// - drainPendingRendererDeepLinkIntents / drainPendingNotificationOpens：
//   send 叶 = edges.rendererPush(IPC_CHANNELS.DEEP_LINK_INTENT /
//   NOTIFICATION_OPEN,…)，requeue/rollback/ACK/ready 位语义；窗口身份
//   复查折算为「投递门只对当前主窗求值」——所有 drain
//   触发点（glue 的 mainWindow===win 守卫 / trusted IPC = 当前主窗 / 入队调用）
//   都锚定当前主窗，mid-drain 的 Electron 同步拆除竞态由每项 edges 门复检兜住；
//   ready 位只在投递失败时复位（= 「仅发送失败的窗口失去握手」语义——单窗下
//   该窗即当前主窗，且 ready 位只由当前主窗的 trusted IPC 置位，无条件复位安全）。
// - enqueueRendererDeepLinkIntent：导出（main.ts 的 open-in IPC 与深链
//   消费循环调用；签名与语义不变）。
// - enqueueNotificationOpen：唯一调用方 = NOTIFY 流构造的 click 回灌
//   闭包（见 installIpcHandlers；不导出）。
// - captureVscodeSource：**在 main.ts**（依赖 transportManager registry 查
//   找 = 装配侧所有物；代际捕获经导出的 captureNotificationSource 代理）。
// - notificationSourceIncarnations / NotificationSourceProofs 实例（NOTIFY
//   流、入队 owns 校验与 registry 退役共用；main.ts 侧经导出的 capture / owns /
//   matches / project / sync 入口访问）。
// - held lastResume 补发（handleSystemResume / handleMainWindowShown +
//   pushHeldSystemResume 经 edges.rendererPush 推送 SYSTEM_RESUME——committed
//   push 包装）；订阅点 = installIpcHandlers ① 段注册
//   edges.onSystemResume / onMainWindowShown。传输层唤醒重探
//   （reconnectStaleTransports）在 main 装配侧另挂 powerMonitor 监听。
// - badge 意图 holder（BADGE_COUNT 注册体；平台门 = badgePlatformGate
//   (platform, edges.badgeCountApiAvailable()) 在 core——E5「门控逻辑留
//   core」）；quit 兜底清除经 clearBadgeIntentForQuit 导出（main will-quit
//   调用，原生清除叶由调用侧注入）。
// - ready 位挂钩收敛为 onRendererLifecycle(event) 单一入口：did-start-loading /
//   did-finish-load / crashed / closed 由 main 窗口 glue 调用（每处先做
//   mainWindow===win 身份守卫）；'show'（held-resume 补发点）经
//   edges.onMainWindowShown → handleMainWindowShown，不占本入口。

/** 投递状态机实际使用的 HostEdges 子集（装配时自 installIpcHandlers 的
 *  deps.edges 快照——见上「单装配不变式」）。 */
type DeliveryEdgeSet = Pick<
  HostEdges,
  'rendererPush' | 'mainWindowAlive' | 'webViewLoading' | 'webViewContentAlive'
>;

let deliveryEdges: DeliveryEdgeSet | null = null;
/** quit 在途门（装配侧 ctx.isQuitting——入队/通知投递循环的 ignore 语义）。 */
let quittingLeaf: () => boolean = () => false;

// 来源生命周期权威（design 19 §3.3）：移除或传输身份编辑推进代际，原生通知
// click 闭包与 held opens 无法跨进同 id 替换。
const notificationSourceIncarnations = new NotificationSourceIncarnations();
// 来源证明 sidecar（非秘密投影；presentation/service/home 编辑后存活，退役轮换）。
const notificationSourceProofs = new NotificationSourceProofs();

// 桌面通知（design 19 §3.3）：pendingNotificationOpens 照搬 pendingIntents 的
// 队列 + drain 模式——点击通知时窗口可能正在重建/加载，事件不能丢。
const pendingNotificationOpens = new BoundedAckDeliveryQueue<NotificationOpenIntent>(MAX_PENDING_NOTIFICATION_OPENS);
let notificationOpenDrainReady = false;
let drainingNotificationOpens = false;

// 成功启动 VS Code 与 renderer 来源激活是两条独立链：前者不等待 UI，后者必须
// 等 App 安装 onIntent 后通过 deep-link-ready 握手才能发送。窗口加载/崩溃会复位
// ready；成功 intent 在有界队列中 hold/replay，绝不发给 about:blank 或尚未订阅
// 的 renderer。
type RendererVscodeIntent = VscodeLaunchRequest & {
  sourceId: string
  sourceFingerprint: string
  sourceGeneration: number
}
const pendingRendererIntents = new BoundedAckDeliveryQueue<RendererVscodeIntent>(
  64,
  intent => BoundedVscodeIntentQueue.key(intent),
);
let deepLinkRendererReady = false;
let drainingRendererDeepLinkIntents = false;

// 最近一次 OS 唤醒时间戳（design 14 D4）：无窗口常驻（托盘态）期间 held，窗口
// show 时一次性补发（push 成功后清空，避免 hide→show 补发过期事件）。
let lastResume: number | null = null;

// 未读徽标（design 19 §3.7）：renderer 推真实未读计数，core 持「最近一次意图」
// 并按当前设置裁决呈现（badgeEnabled 关闭 → 强制 0 清除；重新开启 →
// reconcileBadgeCount 恢复）。quit 在途兜底清除（clearBadgeIntentForQuit）。
// badgeUnsupportedLogged / badgeApplyErrorLogged 把平台不支持（win32 / API 缺
// 失）与持续抛错的 loud 日志压成一次——防重复推送刷屏。
let pendingBadgeCount: number | null = null;
let badgeUnsupportedLogged = false;
let badgeApplyErrorLogged = false;

/** shell-ipc-settings.ts 经 ctx.state 读写这三个模块级
 *  let（单一权威；destructure 拷贝会使深链/徽标就绪位失联）。 */
const shellMutableState = {
  get notificationOpenDrainReady(): boolean { return notificationOpenDrainReady },
  set notificationOpenDrainReady(value: boolean) { notificationOpenDrainReady = value },
  get deepLinkRendererReady(): boolean { return deepLinkRendererReady },
  set deepLinkRendererReady(value: boolean) { deepLinkRendererReady = value },
  get pendingBadgeCount(): number | null { return pendingBadgeCount },
  set pendingBadgeCount(value: number | null) { pendingBadgeCount = value },
};


/** 全局原生通知发送限速（含 kind:'test'，与 claim 同款有界滑动窗口）。 */
const nativeNotificationRateLimiter = new BoundedRateLimiter();

/** SYSTEM_RESUME 推送叶包装：单窗身份 send（edges.rendererPush 返回 false =
 *  无存活主窗）折算为 push 失败并 loud——窗口身份变更即 throw 语义；无窗口
 *  常驻期间由 show 补发兜底。 */
function pushHeldSystemResume(timestamp: number): boolean {
  const edges = deliveryEdges;
  if (edges === null) return false;
  const pushed = attemptCommittedRegistryPush(() => {
    if (!edges.rendererPush(IPC_CHANNELS.SYSTEM_RESUME, { timestamp })) {
      throw new Error('system-resume renderer push failed');
    }
  });
  if (!pushed.sent) {
    try { console.warn(`[dsh-chamber] system-resume push 失败，保留待重试：${pushed.error}`); } catch { /* best effort */ }
  }
  return pushed.sent;
}

/** OS 唤醒（design 14 D4，core 侧）：held 最近一次唤醒时间戳；窗口存活（含隐
 *  藏）已即时收到则立即推送并清空 held，避免 hide→show 补发过期事件。 */
function handleSystemResume(timestamp: number): void {
  lastResume = timestamp;
  const heldResume = lastResume;
  const edges = deliveryEdges;
  if (heldResume !== null && edges !== null && edges.mainWindowAlive() && pushHeldSystemResume(heldResume)) {
    if (lastResume === heldResume) lastResume = null;
  }
}

/** 主窗口 'show' 补发点（B9）：无窗口常驻（托盘态）期间的唤醒事件 held
 *  （lastResume），窗口恢复可见时一次性补发。 */
function handleMainWindowShown(): void {
  const heldResume = lastResume;
  if (heldResume !== null && pushHeldSystemResume(heldResume)) {
    if (lastResume === heldResume) lastResume = null;
  }
}

/** 通知点击入队（design 19 §3.3）：quit 在途 ignore；来源代际校验（捕获 token
 *  必须仍为当前代际——同 sourceId 重加后旧 click 不回灌新 shell）；入队后立即
 *  drain（窗口已加载则直接推送，重建/加载中由 did-finish-load 补发——窗口关闭
 *  期间点击通知不丢事件，照搬 pendingIntents 模式）。有界队列（64 条上限，与
 *  renderer 深链队列同款防御）：窗口长期无法加载时超限丢弃最旧，绝不无限增长。 */
function enqueueNotificationOpen(sourceToken: NotificationSourceToken, sessionId: string): void {
  if (quittingLeaf()) return;
  if (!notificationSourceIncarnations.owns(sourceToken)) return;
  const { sourceId, fingerprint: sourceFingerprint, generation: sourceGeneration } = sourceToken;
  const queued = pendingNotificationOpens.enqueue({ sourceId, sourceFingerprint, sessionId, sourceGeneration });
  if (!queued.accepted) {
    console.warn(`[dsh-chamber] 通知打开队列容量全部被未确认事件占用，拒绝新事件：${sourceId}/${sessionId}`);
    return;
  }
  if (queued.dropped !== null) {
    console.warn(`[dsh-chamber] 通知打开队列已满，丢弃最旧待发事件：${queued.dropped.sourceId}/${queued.dropped.sessionId}`);
  }
  drainPendingNotificationOpens();
}

/** 通知打开事件统一 drain（design 19 §3.3，retain-until-ACK）：窗口存在、已完
 *  成加载且 renderer 已就绪（onOpen 监听注册后经 dsh-chamber:notifications-ready
 *  置位）→ 直接推送；任一条件不满足 → 重新 hold，did-finish-load / ready IPC
 *  后再补发。send 叶 = edges.rendererPush（返回 false 折算
 *  为该次 send 失败）；send 只转 in-flight，renderer 精确 ACK deliveryId+attempt
 *  后才消费；reload/crash 会重发所有未 ACK 项。 */
function drainPendingNotificationOpens(): boolean {
  const edges = deliveryEdges;
  if (edges === null) return true;
  if (drainingNotificationOpens) return true;
  if (
    !notificationOpenDrainReady
    || !edges.mainWindowAlive()
    || edges.webViewLoading()
    || !edges.webViewContentAlive()
  ) return true;
  drainingNotificationOpens = true;
  try {
    for (;;) {
      if (quittingLeaf()) return true;
      const delivery = pendingNotificationOpens.shift();
      if (delivery === null) return true;
      try {
        // Re-check every item: Electron can synchronously tear down/replace a
        // window while send() crosses the native boundary（窗口身份折算见段注释）。
        if (
          !edges.mainWindowAlive()
          || edges.webViewLoading()
          || !edges.webViewContentAlive()
        ) throw new Error('notification renderer changed while draining');
        if (!edges.rendererPush(IPC_CHANNELS.NOTIFICATION_OPEN, {
          sourceId: delivery.payload.sourceId,
          sourceFingerprint: delivery.payload.sourceFingerprint,
          sessionId: delivery.payload.sessionId,
          deliveryId: delivery.deliveryId,
          attempt: delivery.attempt,
        })) {
          throw new Error('notification renderer push failed');
        }
        // Deliberately retain in-flight ownership until renderer ACK.
      } catch (error) {
        const restored = pendingNotificationOpens.rollback(delivery);
        if (!restored) {
          console.error(`[dsh-chamber] 通知打开事件回滚失败：delivery=${delivery.deliveryId}`);
        }
        // Only the window whose send failed may lose its handshake——单窗接缝下
        // 「当前主窗」即该窗（ready 位只由当前主窗的 trusted IPC 置位），复位
        // 安全：renderer 的有界就绪重试建立下一次握手（NOTIFICATIONS_READY 的
        // 「返回 false → 重试」语义原样保留）。
        notificationOpenDrainReady = false;
        console.error('[dsh-chamber] 通知打开推送失败，等待 renderer 重试：', describeUnknownError(error));
        return false;
      }
    }
  } finally {
    drainingNotificationOpens = false;
  }
}

/** 深链 renderer 队列 drain（design 16 hold/replay）：窗口存活、完成加载、非崩
 *  溃且 ready 位已置（App 安装 onIntent 后经 deep-link-ready 握手）→ 顺序推送；
 *  任一条件不满足 → hold。send 叶 = edges.rendererPush；
 *  mid-drain 变更/失败 → rollback 保留 + ready 复位 + 返回 false（renderer 有界
 *  重试重建握手）。 */
function drainPendingRendererDeepLinkIntents(): boolean {
  const edges = deliveryEdges;
  if (edges === null) return true;
  if (drainingRendererDeepLinkIntents) return true;
  // 门以 canDeliverRendererDeepLink + mainWindow===win 求值；窗口
  // 身份折算见段注释（currentWindow 恒 true——触发点全部锚定当前主窗），
  // destroyed/loading/crashed 折算为 edges 三门的取反。
  if (
    !canDeliverRendererDeepLink({
      ready: deepLinkRendererReady,
      currentWindow: true,
      destroyed: !edges.mainWindowAlive(),
      loading: edges.webViewLoading(),
      crashed: !edges.webViewContentAlive(),
    })
  ) return true;

  drainingRendererDeepLinkIntents = true;
  try {
    for (;;) {
      const delivery = pendingRendererIntents.shift();
      if (delivery === null) return true;
      const intent = delivery.payload;
      try {
        // Re-check every item（同通知 drain：Electron 可在 send 跨界时同步拆除/
        // 替换窗口）。
        if (
          !edges.mainWindowAlive()
          || edges.webViewLoading()
          || !edges.webViewContentAlive()
        ) {
          throw new Error('deep-link renderer changed while draining');
        }
        if (!edges.rendererPush(IPC_CHANNELS.DEEP_LINK_INTENT, {
          instanceId: intent.instanceId,
          path: intent.path,
          sourceFingerprint: intent.sourceFingerprint,
          deliveryId: delivery.deliveryId,
          attempt: delivery.attempt,
        })) {
          throw new Error('deep-link renderer push failed');
        }
      } catch (error) {
        // Preserve the failed item for the next renderer handshake instead of
        // converting a transient send race into a lost/reordered activation.
        if (!pendingRendererIntents.rollback(delivery)) {
          console.error(`[dsh-chamber] renderer 深链 intent 回滚失败：${intent.instanceId}`);
        }
        deepLinkRendererReady = false;
        console.error('[dsh-chamber] 深链 intent 推送失败，等待 renderer 重试：', describeUnknownError(error));
        return false;
      }
    }
  } finally {
    drainingRendererDeepLinkIntents = false;
  }
}

/** 深链 renderer 入队（hold/replay 队列；main.ts 的 open-in IPC 与深链消费循环
 *  调用——签名与语义不变）。 */
export function enqueueRendererDeepLinkIntent(intent: VscodeLaunchRequest, sourceToken: NotificationSourceToken): void {
  if (!notificationSourceIncarnations.owns(sourceToken)) return;
  const queued = pendingRendererIntents.enqueue({
    ...intent,
    sourceId: sourceToken.sourceId,
    sourceFingerprint: sourceToken.fingerprint,
    sourceGeneration: sourceToken.generation,
  });
  if (!queued.accepted) {
    if (queued.reason === 'saturated') {
      console.warn(`[dsh-chamber] renderer 深链队列容量全部被在途 intent 占用，拒绝新 intent：${intent.instanceId}`);
    }
    return;
  }
  if (queued.dropped !== null) {
    console.warn(`[dsh-chamber] renderer 深链队列已满，丢弃最旧 intent：${queued.dropped.instanceId}`);
  }
  drainPendingRendererDeepLinkIntents();
}

/** 渲染器生命周期事件（main 窗口 glue 调用——did-start-loading / closed 在
 *  createMainWindow，did-finish-load / crashed 在 installRendererRecovery；
 *  'show' 不占本入口，走 edges.onMainWindowShown；每处 glue 先做
 *  mainWindow===win 身份守卫，仅当前主窗的事件到达本入口）。 */
export type RendererLifecycleEvent = 'did-start-loading' | 'did-finish-load' | 'crashed' | 'closed';

/** ready 位挂钩收敛入口：窗口事件 → 队列状态机复位/重放。did-start-loading 必先于页面脚本执行（ready IPC 恒在
 *  其后），顺序保证成立——复位点选在 start-loading 而非 finish-load 的原因：
 *  did-finish-load 可能被 >500ms 的慢子资源拖迟到 ready() invoke 之后，在 finish
 *  时重置会把已置位的标志 clobber 成永久 false。 */
export function onRendererLifecycle(event: RendererLifecycleEvent): void {
  if (event === 'did-start-loading') {
    notificationOpenDrainReady = false;
    deepLinkRendererReady = false;
    pendingNotificationOpens.requeueInFlight();
    pendingRendererIntents.requeueInFlight();
    drainPendingNotificationOpens();
    return;
  }
  if (event === 'did-finish-load') {
    // ready() can run while late subresources still keep isLoading() true. The
    // first drain then correctly holds; finish is the deterministic replay edge.
    // 渲染器重新可投递**也是**一次补发边沿。Swift 形态没有窗口
    // 'show' 事件（mainWindowShown 只在 NSApplication.didBecomeActive 发），于是「唤醒时
    // 渲染器不可投递 ⇒ lastResume 被 hold ⇒ 等下一次应用激活才 flush」——即时重连退化成
    // 等 15–45s 看门狗。按这个 flavor 无关的边沿补发一次；无滞留时 handleMainWindowShown
    // 是 no-op（幂等，Electron 同样受益）。
    handleMainWindowShown();
    drainPendingRendererDeepLinkIntents();
    drainPendingNotificationOpens();
    return;
  }
  // crashed / closed：通知就绪标志立即失效（崩溃到 reload 之间没有导航事件，
  // 不重置则向死 frame 推送丢事件）+ in-flight 全部重排回待发（reload 后按
  // 原 FIFO 重发，attempt 自增使旧 document 的迟到 ACK 失效）。
  notificationOpenDrainReady = false;
  deepLinkRendererReady = false;
  pendingNotificationOpens.requeueInFlight();
  pendingRendererIntents.requeueInFlight();
}

/** 来源代际捕获代理（main.ts 的 captureVscodeSource / 插件播种所有权沿用）。 */
export function captureNotificationSource(sourceId: string): NotificationSourceToken | null {
  return notificationSourceIncarnations.capture(sourceId);
}

/** 来源代际持有校验代理（open-in / 深链消费循环的所有权复查沿用）。 */
export function ownsNotificationSource(token: NotificationSourceToken): boolean {
  return notificationSourceIncarnations.owns(token);
}

/** 来源 fingerprint 匹配代理（open-in IPC 的入场校验沿用）。 */
export function matchesNotificationSource(sourceId: string, fingerprint: string): boolean {
  return notificationSourceIncarnations.matches(sourceId, fingerprint);
}

/** 注册表投影类型：TransportInstanceSpec + 非秘密来源证明（design 19 §3.3）。 */
export type ProjectedTransportInstanceSpec = TransportInstanceSpec & { sourceFingerprint: string }

/** 来源证明投影（main.ts 的 registry
 *  查询/投影沿用——证明在 presentation/service/home 编辑后仍存活，renderer 生命
 *  周期退役（删除/传输身份编辑）时轮换）。 */
export function projectNotificationSourceInstances(
  instances: readonly TransportInstanceSpec[],
): ProjectedTransportInstanceSpec[] {
  return notificationSourceProofs.replaceRemoteInstances(instances);
}

// registry 读时非秘密投影链。
// sshPasswordSet/tokenSet/passwordSet 为凭据**存在性**布尔标记（读侧只判
// null——写入口经 ssh/gateway-provider 模块直调，值绝不回读进载荷或日志）；
// secretStorage 是凭据镜像的存储模式投影（'safeStorage' | 'plaintext'）。
// main.ts 的 publishRegistryTransition（registry 生命周期 sidecar，经 ctx
// 注入）沿用本模块导出——core→main 单向依赖：
// 注册表投影先经 projectNotificationSourceInstances 挂来源证明，再经
// projectInstanceSecrets 挂凭据存在性标记。
export type ProjectedRegistryInstance = TransportInstanceSpec & {
  sshPasswordSet: boolean
  tokenSet: boolean
  passwordSet: boolean
  secretStorage: ReturnType<typeof gatewaySecretStorageMode>
  /** 非秘密投影：凭据镜像由 Electron flavor 以 safeStorage 写出，本
   *  Electron-free 进程无壳 Keychain 适配器、无法解密（文件原地保留、条目
   *  fail closed）。renderer 据此给出「跨 flavor 凭据不可读」的精确提示。 */
  secretStorageUnreadable?: boolean
}

/** 单行凭据存在性投影（设计 17 §2.3/§9.1/§13.4.1：registry 保持无凭据元数据；
 *  标记只在行当前使用的凭据维度上为 true——sshPasswordSet 仅对 SSH 传输行）。 */
export function projectInstanceSecrets(instance: TransportInstanceSpec): ProjectedRegistryInstance {
  return {
    ...instance,
    sshPasswordSet: instance.transport === 'ssh' && getSshPassword(instance.id) !== null,
    tokenSet: instance.kind === 'gateway' && getGatewayToken(instance.id) !== null,
    passwordSet: instance.kind === 'gateway' && getGatewayPassword(instance.id) !== null,
    secretStorage: gatewaySecretStorageMode(),
    ...(gatewaySecretStorageCrossFlavorUnreadable() ? { secretStorageUnreadable: true as const } : {}),
  };
}

/** 注册表整表读时投影（instances_get / save / delete 的返回路径；
 *  语义与 projectInstances 完全一致）。 */
export function projectInstances(instances: readonly TransportInstanceSpec[]): ProjectedRegistryInstance[] {
  return projectNotificationSourceInstances(instances).map(projectInstanceSecrets);
}

/** 来源 registry 同步（退役权威 + 队列清理）：replaceRemoteSources 后
 *  把退役 sourceId 的在途/待发事件从两条队列全部丢弃（同 id 替换绝不继承旧代际
 *  的 held 工作）；返回退役 id 集合——装配侧注册表退役路径再经
 *  edges.retireNotificationsForSources 驱逐活跃原生通知。 */
export function syncNotificationSourceRegistry(
  projected: readonly ProjectedTransportInstanceSpec[],
): string[] {
  const retired = notificationSourceIncarnations.replaceRemoteSources(
    projected.map(instance => ({
      sourceId: `${instance.kind}-${instance.id}`,
      fingerprint: instance.sourceFingerprint,
    })),
  );
  if (retired.length > 0) {
    const retiredIds = new Set(retired);
    pendingNotificationOpens.discardWhere(intent => retiredIds.has(intent.sourceId));
    pendingRendererIntents.discardWhere(intent => retiredIds.has(intent.sourceId));
  }
  return retired;
}

/** will-quit 兜底清除（design 19 §3.7）：退出在途不留 Dock 残留；曾有意图才触
 *  碰（避免无谓日志）。清空意图并调用注入的原生清除叶（main 装配侧以
 *  typeof 守卫的 app.setBadgeCount(0) 实现）。 */
export function clearBadgeIntentForQuit(applyNativeClear: () => void): void {
  // 兜底清除（退出在途不留 Dock 残留；曾有意图才触碰，避免无谓日志）。
  if (pendingBadgeCount !== null) {
    try { applyNativeClear(); } catch { /* best-effort on the way out */ }
    pendingBadgeCount = null;
  }
}

// OS 深链启动队列 + 外链打开预算器。
// 模块级业务状态（design 16 §4.2）：pendingIntents（有界 64
// single-flight OS 启动队列）+ draining 位 + 消费循环装配槽 + enqueueDeepLink
// （OS 三入口 glue：macOS open-url / Win+Linux second-instance argv / 冷启动
// argv——装配侧经导出入口调用）与启动尾部 drain 入口（drainDeepLinkLaunches）。
// 消费循环本体（drainPendingIntents 闭包——依赖 wiredCtx/captureVscodeSource，
// 见 installIpcHandlers ② I 组段）在装配时就绪；装配前到达的深链只入队、装配
// 后按触发消费（「drainPendingIntents 在 whenReady 尾部赋值、冷启动
// 到达的深链只入队、drain 就绪后消费」语义）。quit 在途门 = quittingLeaf
// （与模块级 quitRequested 同语义）。
// 外链打开统一入口（openExternally）：URL 规范
// 化 + 10s 窗口 8 次预算 + 超限 30s 冷却（log-and-drop）。宿主打开叶 = 装配期
// 快照的 edges.openExternal（externalOpenLeaf——B11「URL 白名单判定/预算/冷却/
// 规范化留 core，edge 只执行 open」）；main.ts 窗口 glue（setWindowOpenHandler /
// will-navigate / will-redirect 的 handleUntrustedNavigation）与后续边沿共用本
// 入口。
const pendingIntents = new BoundedVscodeIntentQueue(64);
let drainingPendingIntents = false;
/** 消费循环装配槽：installIpcHandlers ② I 组段在 wiredCtx 宿主依赖束就绪后
 *  装配（enqueueDeepLink 触发 + drainDeepLinkLaunches 显式 drain）；null = 未
 *  装配（只入队不消费——装配前无窗口/无消费循环）。 */
let drainPendingIntents: (() => void) | null = null;

/** 深链入队（design 16 §4.2；OS 三入口 glue 经本导出入口调用）：
 *  quit 在途 ignore（不启动 VS Code）；归一化目标
 *  single-flight；解析失败 loud。 */
export function enqueueDeepLink(rawUrl: string): void {
  if (quittingLeaf()) return;
  const parsed = parseOpenVscodeIntent(rawUrl);
  if (!parsed.ok) {
    console.error(`[dsh-chamber] 深链解析失败：${parsed.error}`);
    return;
  }
  const queued = pendingIntents.enqueue(parsed.intent);
  if (!queued.accepted) {
    if (queued.reason === 'saturated') {
      console.warn(`[dsh-chamber] 深链启动队列容量全部被在途 intent 占用，拒绝新 intent：${parsed.intent.instanceId}`);
    }
    return;
  }
  if (queued.dropped !== null) {
    console.warn(`[dsh-chamber] 深链启动队列已满，丢弃最旧 intent：${queued.dropped.instanceId}`);
  }
  drainPendingIntents?.();
}

/** 启动尾部的深链 drain 入口（startup
 *  完成、装配就绪后顺序消费冷启动到达的 intent；装配前调用为 no-op）。 */
export function drainDeepLinkLaunches(): void {
  drainPendingIntents?.();
}

// 外链打开速率限制（防脚本 spam 反复弹浏览器标签；用户手动点击远低于该
// 阈值）：10s 窗口内最多 8 次，超限进入 30s 冷却（log-and-drop）。常量与状态
// （预算器只此一份——窗口 glue 与其他入口共用同一语义）。
const OPEN_EXTERNAL_BUDGET = 8;
const OPEN_EXTERNAL_WINDOW_MS = 10_000;
const OPEN_EXTERNAL_COOLDOWN_MS = 30_000;
const externalOpenTimes: number[] = [];
let externalOpenCooldownUntil = 0;
/** 宿主打开叶（装配期快照 deps.edges.openExternal——installIpcHandlers 内赋值；
 *  null = 未装配，openExternally 静默跳过——装配前无窗口 glue 调用点，该
 *  差异仅存在于不可达路径）。 */
let externalOpenLeaf: ((url: string) => Promise<void>) | null = null;

/**
 * 打开外链的统一入口（宿主叶 = 装配期快照
 * 的 externalOpenLeaf；setWindowOpenHandler / handleUntrustedNavigation 共用）：
 * 以解析后的规范化 href 交给宿主打开叶（避免 raw 字符串里 Chromium 已剥离而 OS
 * 层未剥离的空白/换行差异），失败 loud 记录，绝不抛出；超速率预算时静默丢弃并
 * 冷却。
 */
export function openExternally(url: string): void {
  let normalized: string;
  try {
    normalized = new URL(url).href;
  } catch {
    return;
  }
  const now = Date.now();
  if (now < externalOpenCooldownUntil) return;
  const recent = externalOpenTimes.filter((t) => now - t < OPEN_EXTERNAL_WINDOW_MS);
  if (recent.length >= OPEN_EXTERNAL_BUDGET) {
    externalOpenCooldownUntil = now + OPEN_EXTERNAL_COOLDOWN_MS;
    console.warn('[dsh-chamber] 外部链接打开过于频繁，30s 内暂停（疑似脚本 spam）');
    return;
  }
  externalOpenTimes.length = 0;
  externalOpenTimes.push(...recent, now);
  const leaf = externalOpenLeaf;
  if (leaf === null) return;
  void leaf(normalized).catch((error) => {
    console.error('[dsh-chamber] 打开外部链接失败：', describeUnknownError(error));
  });
}

// Runtime check cycle slot.
// runRuntimeCheck 在
// installIpcHandlers ② J 组段——main 装配侧的首检/周期计时器（15s 首检 +
// 6h 周期）经本导出入口调用与 IPC 注册体**同一**实现与门（quit/事务在飞/动作
// 不允许时 no-op 返回当前 state——apply/restore 挂起检查、下个周期恢复的共享
// 门不变）。装配槽 = 下方 installIpcHandlers ② J 组段赋值（单装配不变式：
// installIpcHandlers 先于任何计时器 tick——计时器在装配后创建并 15s/6h 才首
// 次触发，槽位必已就绪；未装配时导出入口静默 no-op，同既有导出入口先例）。
let runtimeCheckRunner: (() => void) | null = null;

/** 触发一次 idle-gated dsh runtime 检查（main 装配侧启动/周期计时器入口——
 *  RUNTIME_CHECK 注册体与周期路径共用同一实现，语义不分叉）。 */
export function runRuntimeCheckCycle(): void {
  const runner = runtimeCheckRunner;
  if (runner !== null) runner();
}

// Shell IPC registration (design 25 §4.1 seam).
// installIpcHandlers is the single shell-core IPC registration point: the
// Electron main only assembles it (main.ts — trustedIpc fence injected at the
// registrar wrapper, core stays electron-free by construction). The
// registration groups have only the Electron leaves replaced by
// injected seams:
//   Group A — INFO / SETTINGS_GET / SETTINGS_SET registrations and their
//   settings helpers (chamberSettingsStatus / applySettingsPatch /
//   pushSettingsChanged): leaves via settingsIO / setKeepAwake / setLoginItem /
//   confirmRegistryOriginSwitch (ctx) + SETTINGS_CHANGED send via
//   edges.rendererPush. Registration order inside this function is the
//   registration order; the surrounding steps are annotated
//   in place:
//   ① edges 回灌订阅段：onSystemResume / onMainWindowShown 的 core 回调
//     在此注册——held-resume 补发在 core，见上段状态机）；
//   ② A 组 3 个注册体 + B 组 6 个注册体（NOTIFY /
//     NOTIFICATIONS_READY / NOTIFICATION_OPEN_ACK / BADGE_COUNT /
//     DEEP_LINK_READY / DEEP_LINK_ACK）+ C 组 6 个
//     注册体（SSH_INSTANCES_GET / SSH_SAVE_CONNECTION /
//     SSH_DELETE_CONNECTION / SSH_SET_PASSWORD /
//     GATEWAY_SET_TOKEN / GATEWAY_SET_PASSWORD——全零 Electron：事务/canonicalize/凭据写入口为纯模块直接 import，
//     装配依赖经 ctx——transportManager/audit/gatewaySessions/
//     publishRegistryTransition，见 ShellAssemblyCtx 与「registry
//     投影链」段注释）+ D 组 7 个注册体（SSH_CONFIG_LIST / SSH_CONNECT /
//     SSH_DISCONNECT / SSH_STATUS / SSH_REVERIFY / SSH_LOGS / SSH_LOGS_CLEAR
//     ——CONFIG_LIST 经纯模块 ssh-config.ts
//     import，其余 6 个经 ctx transportManager——Pick 扩 reverify/logs/
//     clearLogs，见 ShellAssemblyCtx）+ E 组 4 个注册体（SSH_START_SERVICE /
//     SSH_STOP_SERVICE / SSH_IS_ACTIVE / SSH_RESTART_SERVICE——全走 ctx transportManager 的 exec 面——Pick 扩 exec，见
//     ShellAssemblyCtx；systemctl argv 固定参数数组/服务名白名单与 generation
//     复验纪律在 transport-manager/ssh-provider 纯模块内部）+ F 组 6 个
//     注册体（SSH_PLUGIN_LIST / SSH_PLUGIN_APPLY / SSH_PLUGIN_UNDO /
//     SSH_SEED_HOST_GRAPH / SSH_PLUGIN_MATERIALIZE_ADD /
//     SSH_PLUGIN_MATERIALIZE_ADD_PICK——编排
//     纯模块 plugin-sync/ssh-apply-rows/plugin-tarball 直接 import，共享现实例/
//     闭包束经 ctx——sshPluginJournal/hostPackageSeeding/chamberHostPackageSeeds/
//     sshPluginTargets/localDshHome，Pick 扩 appendLog，见 ShellAssemblyCtx；
//     确认对话框与插件源 picker = edges.showMessage/pickPluginSource 宿主腿，
//     mainWindowAlive 预检 = edges 门）+ G 组 3 个注册体（
//     GATEWAY_PLUGIN_SYNC / GATEWAY_PLUGIN_APPLY / GATEWAY_PLUGIN_MATERIALIZE
//     ——编排纯模块 gateway-ipc-shared /
//     gateway-sync-registry / gateway-provider / plugin-tarball 直接 import，
//     手动 sync 上传执行闭包经 ctx.syncGatewayChamberPluginsFor（ready 自动
//     sync 与手动 re-entry 共用同一执行路径，语义不分叉）；确认对话框复用
//     edges 版 confirmPluginAction 助手，pick 与窗口预检 = edges 宿主腿，见
//     ShellAssemblyCtx）+ H 组 5 个注册体（LOCAL_PLUGIN_LIST /
//     NPM_SEARCH / LOCAL_PLUGIN_ADD_FILE / LOCAL_PLUGIN_ADD / LOCAL_PLUGIN_REMOVE
//     ——编排纯模块 plugin-sync 直接 import
//     （npm 搜索 registry URL 白名单 = @dsh-chamber/dsh-runtime
//     isAllowedRegistryUrl），本地安装执行叶 runLocalPluginMutation 经 ctx（main
//     装配侧 runtime writer fence 编排），确认/无窗预检/pick 经 edges 宿主腿，
//     见 ShellAssemblyCtx）+ J 组 6 个注册体（RUNTIME_STATE /
//     RUNTIME_RESTART / RUNTIME_CHECK / RUNTIME_INSTALL / RUNTIME_CLEANUP_VERSION /
//     RUNTIME_CLEAR_FAILURE——控制器现实例/
//     fence/动作门/宿主叶经 ctx（runtimeController / runtimeOperationBusy /
//     runtimeWriterFence / runtimeActionAllowed / runtimeBaseDir /
//     refreshRuntimeEvidence / runStorePruneIfNeeded / restartLocalDsh——K 组
//     注册体与启动/证据路径共用同一实例，语义不分叉），dsh-runtime 纯逻辑直接
//     import，确认对话框 = J 组段 confirmRuntimeMutation 助手 +
//     edges.showMessage，runRuntimeCheck 经导出入口 runRuntimeCheckCycle
//     供 main 侧计时器调用同一实现，见 ShellAssemblyCtx）+ K 组 6 个注册体
//     （RUNTIME_RECOVER_METADATA / RUNTIME_RESET_BUILTIN /
//     RUNTIME_RETRY_APPLY / RUNTIME_APPLY_NOW / RUNTIME_RETRY_RESTORE /
//     RUNTIME_RESTORE_PRE_ROLLBACK——启动事务
//     宿主与共享闭包族经 ctx 宿主叶（runRuntimeStartup / publishBlockedStartup /
//     setRuntimeGate / authoritativeMetadataRecoveryStatus / runUserMetadataRecovery /
//     readApplyNowGateInput / selectedJournalIntent / stopLocalDsh /
//     runtimeOperationSlot / bundledRuntimeVersion，见 ShellAssemblyCtx），
//     dsh-runtime 纯逻辑与 evaluateApplyNowGate 直接 import，确认对话框复用 J 组段
//     confirmRuntimeMutation）。

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

/** 装配 shell IPC 面（A–K 组注册体与辅助；各组顺序为注册顺序）。edges
 *  参数以 Pick 收窄到实际调用的成员（createElectronEdges 返回同形超集）；
 *  新成员实现时同步扩宽两侧。
 *  调用点纪律：whenReady 内、createMainWindow 之前（窗口加载前注册完毕）——
 *  本函数同时完成渲染器投递状态机的 edges/quit 快照（单装配不变式，见上段）。 */
/** Context for the domain registrars: the ShellAssemblyCtx deps plus the
 *  shared local helpers/module state they close over.
 *  Local helpers defined after the context object are exposed as getters so the
 *  object can stay a single construction point (no forward references at build). */
export interface ShellIpcCtx {
  deps: Parameters<typeof installIpcHandlers>[0];
  MACOS_NOTIFICATION_SETTINGS_URL: typeof MACOS_NOTIFICATION_SETTINGS_URL;
  NPM_SEARCH_MAX_BODY_BYTES: typeof NPM_SEARCH_MAX_BODY_BYTES;
  applyBadgePresentation: (count: number) => boolean;
  applySettingsPatch: (patch: Partial<ChamberSettings>) => Promise<{ ok: true } | { ok: false; error: string }>;
  captureVscodeSource: (instanceId: string) => NotificationSourceToken | null;
  chamberSettingsStatus: () => ChamberSettingsStatus;
  confirmPluginAction: (copy: { message: string; detail: string }) => Promise<{ ok: true } | { ok: false; error: string } | { cancelled: true }>;
  confirmRuntimeMutation: (message: string, detail: string, confirmLabel: string) => Promise<boolean>;
  deepLinkRendererReady: typeof deepLinkRendererReady;
  drainPendingNotificationOpens: typeof drainPendingNotificationOpens;
  drainPendingRendererDeepLinkIntents: typeof drainPendingRendererDeepLinkIntents;
  enqueueNotificationOpen: typeof enqueueNotificationOpen;
  enqueueRendererDeepLinkIntent: typeof enqueueRendererDeepLinkIntent;
  localProtectionFacts: () => PluginProtectionFacts;
  matchesNotificationSource: typeof matchesNotificationSource;
  nativeNotificationRateLimiter: typeof nativeNotificationRateLimiter;
  notificationOpenDrainReady: typeof notificationOpenDrainReady;
  notificationSourceIncarnations: typeof notificationSourceIncarnations;
  openInCtx: OpenInLaunchContext;
  ownsNotificationSource: typeof ownsNotificationSource;
  pendingBadgeCount: typeof pendingBadgeCount;
  pendingNotificationOpens: typeof pendingNotificationOpens;
  pendingRendererIntents: typeof pendingRendererIntents;
  projectInstances: typeof projectInstances;
  pushSettingsChanged: () => void;
  quittingLeaf: () => boolean;
  reconcileBadgeCount: () => void;
  runRuntimeCheck: () => Promise<ReturnType<DshRuntimeController['getState']>>;
  verifyLocalProfileFamily: (facts: PluginProtectionFacts) => { ok: true } | { ok: false; error: string };
  portableHostSeeds: () => readonly ChamberHostPackageSeed[];
  version: typeof version;
  state: typeof shellMutableState;
}
export function installIpcHandlers(deps: {
  ipc: IpcRegistrar
  edges: Pick<
    HostEdges,
    | 'rendererPush'
    | 'showNativeNotification'
    | 'notificationSupported'
    | 'setBadge'
    | 'badgeCountApiAvailable'
    | 'isFocused'
    | 'onSystemResume'
    | 'onMainWindowShown'
    | 'mainWindowAlive'
    | 'webViewLoading'
    | 'webViewContentAlive'
    | 'showMessage'
    | 'pickPluginSource'
    | 'openExternal'
    | 'openPath'
    | 'showItemInFolder'
    | 'showError'
  >
  ctx: ShellAssemblyCtx
}): void {
  // 单装配不变式（渲染器投递状态机段注释）：快照投递 edges 子集与 quit 门——
  // 本函数先于任何窗口/渲染器事件执行（调用点纪律见上），此后 onRendererLifecycle /
  // enqueueRendererDeepLinkIntent / handleSystemResume 等导出入口可用。
  deliveryEdges = {
    rendererPush: deps.edges.rendererPush,
    mainWindowAlive: deps.edges.mainWindowAlive,
    webViewLoading: deps.edges.webViewLoading,
    webViewContentAlive: deps.edges.webViewContentAlive,
  };
  quittingLeaf = deps.ctx.isQuitting;
  // —— 外链打开宿主叶快照（openExternally 预算器经本快照调用——B11
  // 「规范化/预算/冷却留 core，edge 只执行 open」；装配先于任何窗口 glue，快照
  // 后导出入口 openExternally 可用，同 deliveryEdges 单装配不变式）。——
  externalOpenLeaf = deps.edges.openExternal;
  const {
    hostFacts,
    settingsIO,
    setKeepAwake,
    setLoginItem,
    // transportManager → sm（main.ts 的
    // sm 局部常量同名）；D 组（ssh 连接
    // 状态 7 注册体）、E 组（exec/systemd 4 注册体）与
    // F 组（ssh plugin 6 注册体）同用该句柄（Pick 扩 reverify/logs/clearLogs /
    // exec / appendLog）。audit / gatewaySessions / publishRegistryTransition
    // 为装配侧宿主叶（定义在 main，经 ctx 注入）。F 组字段：
    // localDshHome / sshPluginJournal / hostPackageSeeding /
    // chamberHostPackageSeeds 与 sshPluginTargets 目标闭包束（main 装配侧
    // 现实例/闭包——自动 seed/撤销路径共用，语义不分叉；解构后 F 组注册体
    // 以原名调用）。G 组字段：syncGatewayChamberPluginsFor
    // （main 装配侧的 ready 自动 sync 上传执行闭包——手动 gateway_plugin_sync
    // 注册体经 ctx 调用，同一执行路径、语义不分叉）。
    transportManager: sm,
    localDshHome,
    chamberHostPackageSeeds,
    // H 组字段：runLocalPluginMutation（main 装配侧执行叶——runtime
    // writer fence 租约/启动门/workspace 解析归装配侧；H 组本地插件注册体经 ctx
    // 调用同一执行路径，语义不分叉）。
    // I 组字段：updateController → updater（与 ctx 字段名的映射同
    // transportManager → sm——update 注册体与状态 push 订阅以原名调用
    // updater.xxx；实例本体在 main 装配侧构造，start() 由装配侧在
    // installIpcHandlers 之后调用（保持「先订阅后 start」序））。
    // J 组字段：runtimeController → runtimeInstance（同 updater
    // 映射——J 组注册体以原名调用；控制器现实例在 main 装配侧构造，
    // K 组注册体与启动/证据路径共用）、runtimeOperationBusy（模块级 runtimeOperation
    // 事务槽在飞读门——`runtimeOperation !== null` 替换）、
    // runtimeWriterFence（同一 fence 现实例——owner 名一致）、
    // runtimeActionAllowed（K 组同用同一门实现）、runtimeBaseDir（装配期解析值）、
    // refreshRuntimeEvidence / runStorePruneIfNeeded（宿主叶——K 组与启动路径同用
    // 同一实现）与 restartLocalDsh（PlaneHandle 宿主腿）。
    runtimeController: runtimeInstance,
    runtimeOperationBusy,
    runtimeWriterFence,
    runtimeActionAllowed,
    runtimeBaseDir,
    // K 组字段：运行时启动事务宿主叶与共享闭包族
    // ——runRuntimeStartup（启动事务本体）/ publishBlockedStartup / setRuntimeGate
    // （宿主启动门与阻塞发布）/ authoritativeMetadataRecoveryStatus /
    // runUserMetadataRecovery（元数据恢复资格投影与事务宿主）/ readApplyNowGateInput
    // （APPLY_NOW 门输入构造——controlPlane/env 宿主读在装配侧）/ selectedJournalIntent
    // （启动路径 readActivationFacts 共用同一实现）/ stopLocalDsh（cp.stopLocal 叶）/
    // runtimeOperationSlot（事务槽 begin/end/inFlight——槽本体为模块级
    // runtimeOperation，单写者归装配侧）/ bundledRuntimeVersion（装配期值，解构改名
    // bundledVersion——K 组注册体以原名调用）。evaluateApplyNowGate 与
    // dsh-runtime 纯逻辑直接 import。K 组注册体与启动/证据路径
    // 共用同一实现/同一槽，语义不分叉（注册体中的替换
    // `runtimeOperation !== null` → runtimeOperationBusy()、`quitRequested` →
    // quittingLeaf()、`cp.stopLocal()` → stopLocalDsh()、槽登记/清槽/在飞值 →
    // runtimeOperationSlot.* 见 K 组段注释）。
    bundledRuntimeVersion: bundledVersion,
    // 插件受保护集合判定的 F 事实源叶与更新退出腿回撤叶（见
    // ShellAssemblyCtx 字段注释——builtinDshWorkspacePath 为活动树解析第二参，
    // pinnedRuntimeLockfilePath 为锚锁文件宿主路径叶，disarmUpdaterQuit 为可选
    // 装配叶；Swift flavor 不提供后者）。
    builtinDshWorkspacePath,
    pinnedRuntimeLockfilePath,
  } = deps.ctx

  // ① edges 回灌订阅段：OS 唤醒与主窗口 'show' 的事件源，订阅点统一走本函数
  //    单点——held lastResume 补发在 core（上段状态机）。
  deps.edges.onSystemResume((timestamp) => {
    handleSystemResume(timestamp);
  });
  deps.edges.onMainWindowShown(() => {
    handleMainWindowShown();
  });

  /** 非秘密 chamber 设置投影（design 14 D7）：当前值 + 平台能力门控。 */
  function chamberSettingsStatus(): ChamberSettingsStatus {
    return {
      settings: settingsIO.current(),
      supported: computeSupported(hostFacts.platform, hostFacts.trayPresent()),
    };
  }

  /** 设置变更推送（SETTINGS_CHANGED send 源）：committed-push 包装 +
   *  rendererPush 叶。叶返回 false = 无存活主窗（含窗口在 push 前已被关/换的
   *  竞态），折算为 push 失败并 loud——「throw → {sent:false}」语义
   *  （committed 状态 push 同款形状）；无窗口常驻期间由下次查询
   *  兜底。 */
  function pushSettingsChanged(): void {
    const pushed = attemptCommittedRegistryPush(() => {
      if (!deps.edges.rendererPush(IPC_CHANNELS.SETTINGS_CHANGED, chamberSettingsStatus())) {
        throw new Error('settings renderer push failed');
      }
    });
    if (!pushed.sent) {
      try { console.warn(`[dsh-chamber] settings 已保存但变更 push 失败（等待 renderer 重拉）：${pushed.error}`); } catch { /* best effort */ }
    }
  }

  /** 应用一个已校验的设置 patch（design 14 D7）：先应用副作用（keep-awake /
   *  登录自启），**全部成功并持久化成功后才更新 holder**——任何失败 loud 返回
   *  {error} 并回滚已应用的副作用（绝不落半个设置、绝不内存与磁盘不一致）。
   *  windowCloseBehavior 无副作用（影响未来的 close 事件）。副作用叶与持久化
   *  均经 ctx 注入（main 宿主腿）；回滚路径读 current()——commit 只在全链
   *  成功尾部发生，回滚时 current() 恒为旧值，holder 语义一致。
   *  async（双 flavor）：叶返回 Promise 兼容（见 ShellAssemblyCtx 两叶
   *  注释——Electron 同步返回被 await 吸收；Swift await B 桥应答，
   *  leg 失败 = reject/{ok:false,error}，与 Electron 同步失败同一回滚/不持久化
   *  路径：Electron 同步失败 = rejected promise，Swift 异步失败 = rejected
   *  promise——SETTINGS_SET 返回 {error} 的形状两边一致）。 */
  async function applySettingsPatch(
    patch: Partial<ChamberSettings>,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    // notifications / sessionTodo 是嵌套对象：patch 可能只带部分子键
    // （validatePatch 允许 partial），必须 deep-merge 到当前值，绝不整组
    // 替换丢开关。
    const current = settingsIO.current();
    const next: ChamberSettings = {
      ...current,
      ...patch,
      notifications: patch.notifications !== undefined
        ? { ...current.notifications, ...patch.notifications }
        : current.notifications,
      sessionTodo: patch.sessionTodo !== undefined
        ? { ...current.sessionTodo, ...patch.sessionTodo }
        : current.sessionTodo,
    };
    // 副作用应用包 try：keep-awake / 登录自启叶意外抛异常（或 Swift leg 应答
    // reject）时 loud 失败并 best-effort 回滚 keepAwake，绝不带病继续（绝不落
    // 半个设置）。
    try {
      if (patch.keepAwake !== undefined) await setKeepAwake(patch.keepAwake);
      if (patch.launchAtLogin !== undefined) {
        const result = await setLoginItem(patch.launchAtLogin);
        if (!result.ok) {
          // 副作用失败：回滚已应用的 keepAwake（保持原状），绝不持久化。
          if (patch.keepAwake !== undefined) await setKeepAwake(current.keepAwake);
          return result;
        }
      }
    } catch (error) {
      console.error('[dsh-chamber] 应用 chamber 设置副作用失败：', error);
      try {
        if (patch.keepAwake !== undefined) await setKeepAwake(current.keepAwake);
      } catch {
        // 回滚失败已记日志，不叠加异常。
      }
      return { ok: false, error: 'settings apply failed' };
    }
    try {
      settingsIO.persist(next);
    } catch (error) {
      console.error('[dsh-chamber] 写入 chamber 设置失败：', error);
      // 持久化失败：回滚已应用的副作用，holder 保持旧值——内存/磁盘/实际行为一致。
      if (patch.keepAwake !== undefined) await setKeepAwake(current.keepAwake);
      if (patch.launchAtLogin !== undefined) {
        const rollback = await setLoginItem(current.launchAtLogin);
        if (!rollback.ok) console.error(`[dsh-chamber] 登录自启回滚失败：${rollback.error}`);
      }
      return { ok: false, error: 'settings persist failed' };
    }
    settingsIO.commit(next);
    return { ok: true };
  }

  /** 平台门 + 宿主 apply 的 core 侧编排（E5——「平台门与裁决留 core（badge.ts）」）：
   *  badgePlatformGate(platform, edges.badgeCountApiAvailable()) 先裁决
   *  （win32 的专属平台原因在此区分），supported 后才经 edges.setBadge apply。
   *  unsupported 与 apply 失败各压成一次 loud（badgeUnsupportedLogged /
   *  badgeApplyErrorLogged——防重复推送刷屏）。 */
  function applyBadgePresentation(count: number): boolean {
    const gate = badgePlatformGate(hostFacts.platform, deps.edges.badgeCountApiAvailable());
    if (!gate.supported) {
      if (!badgeUnsupportedLogged) {
        badgeUnsupportedLogged = true;
        console.warn(`[dsh-chamber] 应用图标未读徽标不可用：${gate.reason}`);
      }
      return false;
    }
    const applied = deps.edges.setBadge(count);
    if (!applied.applied) {
      if (!badgeApplyErrorLogged) {
        badgeApplyErrorLogged = true;
        console.warn(`[dsh-chamber] 应用图标未读徽标设置失败：${applied.reason}`);
      }
      return false;
    }
    return true;
  }

  /** 按当前设置重新裁决最近一次 renderer 计数意图（设置切换后的即时收敛——
   *  SETTINGS_SET 的 badgeEnabled 翻转收敛点；holder/裁决在本函数）。 */
  function reconcileBadgeCount(): void {
    if (pendingBadgeCount === null) return;
    const count = adjudicateBadgeCount(
      { badgeEnabled: settingsIO.current().notifications.badgeEnabled },
      pendingBadgeCount,
    );
    applyBadgePresentation(count);
  }

  /** 桌面原生通知主链路（design 19 §3.3——宿主腿全在
   *  electron-edges：构造/登记/淘汰/click 腿/honest-show 结算 = showNativeNotification、
   *  能力探测 = notificationSupported、焦点事实 = isFocused）：payload 白名单 →
   *  平台支持 → 设置裁决 → 有界 claim / 全局速率 → 显示。
   *
   *  返回 `{shown, error?}`：`shown=false` 时 `error` 区分
   *  裁决侧主动抑制（设置/焦点/去重/速率）与宿主/OS 拒绝（未授权/调度失败/
   *  超时，宿主原文透传）——设置页据此给出可操作提示。'test' 绕过 claim 与设置门禁，
   *  但仍受全局宿主预算约束；通知失败降级且 loud，不误报成功，会话业务/侧边栏
   *  蓝点不受影响。 */
  // 域拆分上下文：单点构造，晚定义的 helper 以 getter 延迟解析，
  // 注册体经 shellIpcCtx 取共享 helper/模块状态（顺序/错误语义不变）。
  const shellIpcCtx = {
    deps,
    deliveryEdges,
    quittingLeaf,
    externalOpenLeaf,
    chamberSettingsStatus,
    pushSettingsChanged,
    applyBadgePresentation,
    applySettingsPatch,
    reconcileBadgeCount,
    get MACOS_NOTIFICATION_SETTINGS_URL() { return MACOS_NOTIFICATION_SETTINGS_URL },
    get NPM_SEARCH_MAX_BODY_BYTES() { return NPM_SEARCH_MAX_BODY_BYTES },
    get captureVscodeSource() { return captureVscodeSource },
    get confirmPluginAction() { return confirmPluginAction },
    get confirmRuntimeMutation() { return confirmRuntimeMutation },
    get deepLinkRendererReady() { return deepLinkRendererReady },
    get drainPendingNotificationOpens() { return drainPendingNotificationOpens },
    get drainPendingRendererDeepLinkIntents() { return drainPendingRendererDeepLinkIntents },
    get enqueueNotificationOpen() { return enqueueNotificationOpen },
    get enqueueRendererDeepLinkIntent() { return enqueueRendererDeepLinkIntent },
    get localProtectionFacts() { return localProtectionFacts },
    get matchesNotificationSource() { return matchesNotificationSource },
    get nativeNotificationRateLimiter() { return nativeNotificationRateLimiter },
    get notificationOpenDrainReady() { return notificationOpenDrainReady },
    get notificationSourceIncarnations() { return notificationSourceIncarnations },
    get openInCtx() { return openInCtx },
    get ownsNotificationSource() { return ownsNotificationSource },
    get pendingBadgeCount() { return pendingBadgeCount },
    get pendingNotificationOpens() { return pendingNotificationOpens },
    get pendingRendererIntents() { return pendingRendererIntents },
    get projectInstances() { return projectInstances },
    get runRuntimeCheck() { return runRuntimeCheck },
    get verifyLocalProfileFamily() { return verifyLocalProfileFamily },
    get portableHostSeeds() { return portableHostSeeds },
    version,
    state: shellMutableState,
  } as ShellIpcCtx;
  registerSettingsHandlers(shellIpcCtx);

  // ② A 组 3 个注册体（trustedIpc 围栏由装配侧在 ipc 注入点
  //    包装，本文件零 electron）+ B 组 6 个注册体。
  // 桌面身份/版本信息（dsh-chamber:info）：控制面 URL + 平台为宿主事实，
  // shell 版本为模块自读（package.json），dshVersion 即时
  // 解析（ctx.runtimeFacts）。

  registerConnectionHandlers(shellIpcCtx);

  // —— 插件受保护集合判定（design 21 §6.11）：F 事实解析与
  // 装后族一致性复验（F/H 组注册体共用同一实现）。事实输入
  // 全部来自 ctx：活动树 = resolveActiveRuntime(runtimeBaseDir,
  // builtinDshWorkspacePath)（core 纯解析）、内建线世代 = bundledRuntimeVersion
  // （装配期快照）、锚锁文件 = pinnedRuntimeLockfilePath()、profile 目录 =
  // localDshHome。两条语义：①「同版优先锚」——
  // 用户选装 / env 树不得用内建锚判跨代（shouldPreferPinnedRuntimeLockfile 只在
  // 活动世代 == 内建世代时为真），env 树另有内建锚兜底解析；② familySource 恒
  // 'runtime'，解析失败 = familyNames null ⇒ plugin-sync 侧保守降级（官方 scope
  // install 一律拒），绝不静默放行拆组合。
  /** Protection facts for the LOCAL profile (design 21 §6.11.1): F parsed from
   *  the ACTIVE runtime's lockfile closure (platform-independent, never the
   *  source-line vendor tree), the effective runtime version, and whether the
   *  profile manifest already exists (absent ⇒ the write face defers — the
   *  first install is what creates it). */
  /** One-entry memo for the lockfile-derived family facts (see memoKey). */
  const familyFactsMemo = createKeyedMemo<{
    names: readonly string[] | null;
    versions: PluginProtectionFacts['familyVersions'];
  }>();
  const localProtectionFacts = (): PluginProtectionFacts => {
    const resolved = resolveActiveRuntime(runtimeBaseDir, builtinDshWorkspacePath);
    let familyNames: readonly string[] | null = null;
    // The version half of the SAME resolution (design 21 §6.11.3): the
    // post-install verification compares an installed family member against
    // the versions this runtime actually provides, so a re-scoped vendored
    // package (which keeps its upstream version, never the generation string)
    // is judged on its own scale. Absent key = no version fact ⇒ generation arm.
    let familyVersions: PluginProtectionFacts['familyVersions'] = null;
    const activePath = resolved.path;
    if (activePath !== null) {
      // The built-in anchor describes the BUILT-IN runtime line only. A
      // user-selected runtime (design 18 §3.6) — or an env-provided tree — is
      // another line whose own lockfile is the right fact source; handing it
      // the pin would judge a consistent profile against versions it never
      // had. Same-version trees still prefer the pin, because
      // a source-line lockfile carries the opt-in segment and gets refused by
      // the trust criterion.
      const usePinned = shouldPreferPinnedRuntimeLockfile(resolved.version, bundledVersion);
      const pinnedPath = pinnedRuntimeLockfilePath();
      // This function runs on every local plugin IPC
      // read/judgement; the up-to-512 KiB lockfile is parsed behind this memo.
      // The family resolution is memoized by the full input identity —
      // active tree + version + source, pin selection, and the mtime+size of
      // BOTH candidate lockfiles — so any file change (or runtime switch)
      // reloads while a hot read pays one stat pair. profileState below is
      // deliberately NOT memoized: the first install creates the profile
      // manifest.
      const memoKey = [
        activePath, resolved.version ?? '', resolved.source ?? '',
        usePinned ? 'pinned' : 'tree', bundledVersion ?? '', pinnedPath ?? '',
        lockfileIdentityKey([pinnedPath ?? '', path.join(activePath, 'pnpm-lock.yaml')]),
      ].join('|');
      const family = familyFactsMemo.read(memoKey, () => {
        let resolvedFamily = resolveRuntimeFamily(activePath, {
          pinnedLockfilePath: usePinned ? pinnedPath : null,
        });
        // A dev/env tree (DSH_CHAMBER_DSH_PATH) at another generation normally
        // carries a source-line lockfile (opt-in segment ⇒ refused) and a
        // source-line tree (forbidden names ⇒ refused), so it would resolve to
        // NO family facts and degrade the write face to "official installs
        // refused". For an explicit developer override the built-in anchor is
        // still the closest usable source; a user-SELECTED released runtime
        // never gets this stand-in (that is exactly the cross-line misjudgement
        // this gate fixes).
        if (!resolvedFamily.ok && !usePinned && resolved.source === 'env') {
          resolvedFamily = resolveRuntimeFamily(activePath, { pinnedLockfilePath: pinnedPath });
        }
        return {
          names: resolvedFamily.ok ? resolvedFamily.names : null,
          versions: resolvedFamily.ok ? resolvedFamily.versions : null,
        };
      });
      familyNames = family.names;
      familyVersions = family.versions;
    }
    const profileManifest = path.join(localDshHome, 'profiles', WEB_PROFILE, 'package.json');
    return {
      familyNames,
      familyVersions,
      runtimeVersion: resolved.version,
      profileState: existsSync(profileManifest) ? 'ready' : 'absent',
      familySource: 'runtime',
    };
  };
  /** 可移植（非 localOnly）chamber host 包种子（design 20 §6 单一实现：另一台
   *  主机上「应该有什么」只读本列表——localOnly 行的空 sourceDir 不得当缺件，
 *  见 portableChamberHostPackageSeeds 的注记）。 */
  const portableHostSeeds = (): readonly ChamberHostPackageSeed[] =>
    portableChamberHostPackageSeeds(chamberHostPackageSeeds);
  /** Post-install family verification (design 21 §6.11.4): a successful install
   *  is not a success until the profile tree is proven consistent — a hoisted
   *  transitive copy of a runtime-family package that the pinned release does
   *  not provide (outside-family) or that sits on another generation
   *  (generation-mismatch) is exactly the composition split the judgement alone
   *  cannot see (the judgement only sees the direct spec).
   *
   *  v1 semantics (matching the gateway's existing preImage discipline): the
   *  finding is LOUD and the op reports failure; automatic rollback of the
   *  mutated profile is open work in STATUS. */
  const verifyLocalProfileFamily = (facts: PluginProtectionFacts): { ok: true } | { ok: false; error: string } => {
    if (!Array.isArray(facts.familyNames) || facts.familyNames.length === 0) return { ok: true };
    const familyVersions = facts.familyVersions ?? null;
    const verdict = verifyProfileFamilyConsistency({
      profileDir: path.join(localDshHome, 'profiles', WEB_PROFILE),
      familyNames: facts.familyNames,
      runtimeVersion: facts.runtimeVersion ?? null,
      familyVersions,
    });
    if (verdict.ok) {
      // A skip is NOT a pass: record it loudly (the install itself succeeded,
      // but the profile tree was never proven consistent).
      if (verdict.skipped !== undefined) {
        console.warn(`[dsh-chamber] 插件族一致性复验被跳过：${verdict.skipped}`);
      }
      return { ok: true };
    }
    return {
      ok: false,
      error: `installed, but the profile tree no longer matches the instance runtime: ${describeFamilyFindings(verdict.findings, facts.runtimeVersion ?? null, familyVersions)}`,
    };
  };

  // —— F 组 ——
  // ssh plugin 6 注册体（SSH_PLUGIN_LIST / SSH_PLUGIN_APPLY / SSH_PLUGIN_UNDO /
  // SSH_SEED_HOST_GRAPH / SSH_PLUGIN_MATERIALIZE_ADD /
  // SSH_PLUGIN_MATERIALIZE_ADD_PICK，全零 Electron）。编排纯模块直接 import（plugin-sync /
  // ssh-apply-rows / plugin-tarball）；共享现实例与
  // 目标闭包束经 ctx（localDshHome / sshPluginJournal / hostPackageSeeding /
  // chamberHostPackageSeeds / sshPluginTargets——自动 seed 与
  // registry 撤销路径与 F 组共用同一实例/闭包族：journal 单写者、seed 单飞、
  // 目标指纹同一实现；findRemoteTarget / ownsRemoteTarget / scoped* /
  // liveProbeFor 等原名经 sshPluginTargets 解构）。
  // 宿主对话框腿 = edges.showMessage / edges.pickPluginSource（electron-edges
  // 实现：confirmPluginAction 与 pickPluginSource 的
  // 函数体——按钮序/编号与 darwin 一体 folder|.tgz 双模式；当前主窗
  // 为父窗 sheet）；无存活主窗预检 = edges.mainWindowAlive（与
  // mainWindow === null || isDestroyed 判据同值）。确认对话框助手（下方
  // confirmPluginAction）语义：无窗 → 'native
  // confirmation unavailable'；response===1（'继续'）→ ok；否则 cancelled；
  // 异常 → loud 'native confirmation failed: …'。
  const confirmPluginAction = async (
    copy: { message: string; detail: string },
  ): Promise<{ ok: true } | { ok: false; error: string } | { cancelled: true }> => {
    if (!deps.edges.mainWindowAlive()) return { ok: false, error: 'native confirmation unavailable' };
    try {
      const response = await deps.edges.showMessage({
        type: 'warning',
        title: copy.message,
        message: copy.message,
        detail: copy.detail,
        buttons: ['取消', '继续'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      return response === 1 ? { ok: true } : { cancelled: true };
    } catch (error) {
      return { ok: false, error: `native confirmation failed: ${describeUnknownError(error)}` };
    }
  };

  registerSshPluginHandlers(shellIpcCtx);

  registerGatewayPluginHandlers(shellIpcCtx);

  registerLocalPluginHandlers(shellIpcCtx);

  // —— I 组 ——
  // open-in（OPEN_IN_APPS / OPEN_IN）与 update（UPDATE_STATE / UPDATE_CHECK /
  // UPDATE_DOWNLOAD / UPDATE_RESTART / OPEN_RELEASE）7 注册体（trustedIpc 围栏由装配侧注入
  // registrar 包装）：
  //  - openInCtx/wiredCtx 共享宿主依赖束（open-in 注册表 + OS 深链 drain 共用）：
  //    lookupInstance 经 ctx transportManager（sm）、
  //    vscodeAvailable 经 detectVscodeAvailability(hostFacts.platform)（同一平台
  //    事实）、vscodeOpenInNewWindow 经 settingsIO.current()（chamber settings
  //    内存 holder 的 core 读面）、宿主打开/
  //    揭示叶 = deps.edges 的 openExternal / openPath / showItemInFolder
  //    （electron-edges.ts——shell-core 零 electron）；stat 叶经 node:fs
  //    fsp。编排纯模块直接 import（open-in.ts：
  //    listOpenInApps / runOpenInLaunch / classifyLocalPath / invokeOpenPath；
  //    deep-link.ts：runVscodeLaunch）。来源指纹 owns/matches 复查与来源代际捕获
  //    （captureVscodeSource）在 core（经 ctx transportManager 参数化）。
  //  - update 面：updater 现实例（main 装配侧构造的 createUpdateController
  //    包装）经 ctx.updateController 注入——注册体以原名调用
  //    updater.xxx；状态 push 订阅（committed-push 包装 +
  //    edges.rendererPush——主窗身份折算：「const updateWindow = mainWindow /
  //    updateWindow !== null」快照与「mainWindow !== updateWindow ||
  //    updateWindow.isDestroyed()」复查折算为 mainWindowAlive 门 + rendererPush
  //    对当前主窗求值（push 与 send 之间窗口被换 → 换窗推
  //    送；新窗未装监听的事件丢失由 renderer 重拉兜底）；无存活主窗不 push 不 warn）。
  //    updater.start() 由装配侧调用（installIpcHandlers 之后——「先订阅
  //    后 start」序，见 main.ts 装配点）。
  //  - OS 深链启动消费循环（drainPendingIntents 闭包）（pendingIntents
  //    队列在模块级段；本段在 wiredCtx 依赖束就绪后装配槽位；
  //    失败 loud = edges.showError（dialog.showErrorBox 叶，
  //    electron-edges.ts）+ 日志，quit 门 = quittingLeaf）。
  //  - OPEN_RELEASE 的宿主打开叶 = deps.edges.openExternal（updater.ts
  //    openReleasePage 的 isAllowedReleaseUrl 白名单纪律在 updater.ts 纯模块内；
  //    leaf 只执行打开）。

/** Hold a successful launch intent until the current renderer explicitly says
 *  its onIntent listener is installed. Used by both OS deep links and open-in.
 *  registry 查找经 ctx transportManager（sm；装配后恒非 null，同 D 组注册
 *  体）；来源代际捕获经 captureNotificationSource 代理。 */
  function captureVscodeSource(instanceId: string): NotificationSourceToken | null {
    if (instanceId === 'local') return captureNotificationSource('local');
    const instance = sm.listInstances().find(candidate => candidate.id === instanceId);
    return instance === undefined
      ? null
      : captureNotificationSource(`${instance.kind}-${instance.id}`);
  }

  // VS Code 深链（design 16 §4/§5）+ open-in 注册表（open-in.ts）的共享宿主
  // 依赖束：wiredCtx 同时供 OS 深链 drain（runVscodeLaunch）与 open-in 执行
  // 管线复用。lookupInstance 查 ctx transportManager 实查；vscodeAvailable
  // 每次实探（getter 惰性、无缓存
  // 陈旧）；openVscodeUrl 白名单判定留 core、宿主打开叶 = deps.edges.openExternal
  // （catch → loud error，返回 {error} 由调用方处理）。
  const wiredCtx: VscodeLaunchContext = {
    lookupInstance: (id) => {
      const instance = sm.listInstances().find(entry => entry.id === id);
      if (instance === undefined) return null;
      // v2 (design 17 §2): the vscode-remote URL is an ssh-TRANSPORT
      // feature — expose the transport, not the target kind.
      return { id: instance.id, host: instance.host, user: instance.user, sshPort: instance.sshPort, transport: instance.transport };
    },
    vscodeAvailable: () => detectVscodeAvailability(hostFacts.platform).available,
    // Chamber setting `vscodeOpenInNewWindow`（design 16 §3.3）：每次拉起惰性
    // 读取（与 vscodeAvailable 同款 getter），设置变更即时作用于下一次拉起；
    // 由 open-in 按钮与 OS 深链两条入口共享（同一 wiredCtx）。
    vscodeOpenInNewWindow: () => settingsIO.current().vscodeOpenInNewWindow,
    openVscodeUrl: async (url) => {
      // Injection-point scheme re-verification (mirror
      // of isAllowedReleaseUrl's discipline): only our constructed targets
      // may ever reach the host open leaf — the ssh-remote URL for remote
      // sources and the file URL for the local source (user decision:
      // local workspaces open as local folders).
      if (typeof url !== 'string' || !(url.startsWith('vscode://vscode-remote/') || url.startsWith('vscode://file/'))) {
        const message = 'refused to open a non-vscode URL';
        console.error(`[dsh-chamber] ${message}:`, url);
        return { ok: false, error: message };
      }
      try {
        await deps.edges.openExternal(url);
        return { ok: true };
      } catch (error) {
        const message = describeUnknownError(error);
        console.error('[dsh-chamber] 打开 vscode URL 失败：', error);
        return { ok: false, error: `open vscode url failed: ${message}` };
      }
    },
  };

  // open-in 注册表（open-in.ts）：apps() 能力协商 + 统一执行管线。wiredCtx
  // 复用 registry/availability/openVscodeUrl 依赖，补宿主文件系统面
  // （stat/openPath/showItemInFolder——stat 经 node:fs fsp、open/show 经
  // deps.edges 宿主叶）。design 16
  // 的 vscode-availability / open-vscode 两个 IPC 不在——
  // 渲染层唯一入口收敛为 open-in 两个通道。
  const openInCtx: OpenInLaunchContext = {
    platform: hostFacts.platform,
    lookupInstance: wiredCtx.lookupInstance,
    vscodeAvailable: wiredCtx.vscodeAvailable,
    vscodeOpenInNewWindow: wiredCtx.vscodeOpenInNewWindow,
    openVscodeUrl: wiredCtx.openVscodeUrl,
  }
  registerOpenInHandlers(shellIpcCtx);

  registerUpdateHandlers(shellIpcCtx);

  // OS 深链消费循环装配（design 16 §4.2；模块级 pendingIntents 队列见上段）：
  // startup 完成（装配就绪、transportManager 装载）后顺序消费有界队列。VS Code
  // 启动不等待 renderer；成功 intent 进入独立的 renderer hold/replay 队列
  // （enqueueRendererDeepLinkIntent + ownsNotificationSource），直到
  // onIntent + ready 握手完成。失败 loud（edges.showError 错误框 + 日志）。quit
  // 在途的新深链已在 enqueueDeepLink 被 ignore（quittingLeaf）。装配槽 = 上方
  // 模块级 drainPendingIntents——装配后 OS 入口（enqueueDeepLink）即触发，启动
  // 尾部由装配侧经导出入口 drainDeepLinkLaunches 显式消费一次（冷启动入队）。
  drainPendingIntents = () => {
    if (drainingPendingIntents || quittingLeaf()) return;
    drainingPendingIntents = true;
    void (async () => {
      for (;;) {
        if (quittingLeaf()) return;
        const intent = pendingIntents.shift();
        if (intent === null) return;
        try {
          const sourceToken = captureVscodeSource(intent.instanceId);
          const result = await runVscodeLaunch(intent, wiredCtx);
          if (result.ok && sourceToken !== null && ownsNotificationSource(sourceToken)) {
            enqueueRendererDeepLinkIntent(intent, sourceToken);
          } else {
            const error = result.ok ? 'instance changed while VS Code launch was in progress' : result.error;
            console.error(`[dsh-chamber] 深链执行失败：${error}`);
            deps.edges.showError('打开 VS Code 失败', error);
          }
        } catch (error) {
          // runVscodeLaunch is exception-safe; retain a last-resort boundary
          // for Electron dialog/send regressions without leaking the key.
          console.error('[dsh-chamber] 深链执行异常：', describeUnknownError(error));
        } finally {
          pendingIntents.complete(intent);
        }
      }
    })().finally(() => {
      drainingPendingIntents = false;
      if (!quittingLeaf() && pendingIntents.pendingCount > 0) drainPendingIntents?.();
    });
  };

  // —— J 组 ——
  // runtime 6 注册体（RUNTIME_STATE / RUNTIME_RESTART / RUNTIME_CHECK /
  // RUNTIME_INSTALL / RUNTIME_CLEANUP_VERSION / RUNTIME_CLEAR_FAILURE，trustedIpc 围栏由
  // 装配侧注入 registrar 包装）：
  //  - 控制器现实例（DshRuntimeController——main 装配侧 whenReady 构造）经
  //    ctx.runtimeController 注入（core 类型面 import 自 dsh-runtime-controller.ts
  //    ——electron-free 纯编排模块；K 组注册体与启动/证据路径共用同一实例，状态
  //    权威单一）；J 组注册体以原名 runtimeInstance 调用（同 updater）。
  //  - runtime 事务槽在飞读门 = ctx.runtimeOperationBusy（`runtimeOperation !== null`——
  //    单写者为 main 的启动事务/K 组注册体，core 只读）。
  //  - runtime writer fence 现实例 = ctx.runtimeWriterFence（同一 fence——启动
  //    事务与 K 组路径共用，busy/tryAcquire/lease.release 语义；
  //    owner 名 'runtime:restart' / 'runtime:check' / 'runtime:install' /
  //    'runtime:cleanup-version'）。
  //  - 动作终态门 = ctx.runtimeActionAllowed（whenReady 闭包——K 组
  //    注册体同用单一实现）。
  //  - dsh-runtime 纯逻辑直接 import（isSafeVersion / listExplicitlyInstalledVersions /
  //    cleanupExplicitRuntimeVersion / listRuntimeFailures / clearRuntimeFailure——
  //    electron-free 共享核）；runtimeBaseDir 为装配期
  //    解析值经 ctx 注入（core 不碰 Electron paths）。
  //  - 宿主叶 = ctx.refreshRuntimeEvidence / ctx.runStorePruneIfNeeded（K 组与
  //    启动路径同用同一实现）；ctx.restartLocalDsh = PlaneHandle 宿主腿（
  //    controlPlane null 门 + restartLocal() + resolve 后实时 connectionState
  //    读封装在装配侧叶——resolve ≠ success 的白名单判据在本段注册体）。
  //  - 确认对话框 = 下方 confirmRuntimeMutation 助手（
  //    edges.mainWindowAlive 无窗预检 + edges.showMessage 宿主腿
  //    ——按钮序 ['取消', confirmLabel] / defaultId 0 / cancelId 0 / noLink 与
  //    文案一致；无窗 → false = 'native confirmation unavailable' 不确认
  //    语义，调用方静默返回当前 state；
  //    预检与调用间窗口销毁竞态 → showMessage 叶抛 'native confirmation
  //    unavailable' → 注册体 reject，与 showMessageBox(win) 抛出同形）。
  //  - runRuntimeCheck（quit 门 = quittingLeaf——ctx.isQuitting
  //    快照）；main 装配侧的首检/周期计时器
  //    经模块级导出入口 runRuntimeCheckCycle 调用本段同一实现（apply/restore
  //    挂起检查、下个周期恢复的共享门不变）——装配槽在 J 组段尾部赋值。
  const confirmRuntimeMutation = async (message: string, detail: string, confirmLabel: string): Promise<boolean> => {
    if (!deps.edges.mainWindowAlive()) return false;
    const response = await deps.edges.showMessage({
      type: 'warning',
      title: message,
      message,
      detail,
      buttons: ['取消', confirmLabel],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    return response === 1;
  };
  registerRuntimeHandlersA(shellIpcCtx);
  const runRuntimeCheck = async () => {
    if (quittingLeaf() || runtimeOperationBusy() || !runtimeActionAllowed('check')) {
      return runtimeInstance.getState();
    }
    const lease = runtimeWriterFence.tryAcquire('runtime:check');
    if (lease === null) return runtimeInstance.getState();
    try {
      return await runtimeInstance.check();
    } finally {
      lease.release();
    }
  };
  registerRuntimeHandlersB(shellIpcCtx);
  // 周期检查装配槽（模块级导出入口 runRuntimeCheckCycle 经它调用——main 装配
  // 侧计时器 15s 首检 + 6h 周期与 RUNTIME_CHECK 注册体共用同一实现与门）。
  runtimeCheckRunner = () => {
    void runRuntimeCheck();
  };

  registerRuntimeHandlersC(shellIpcCtx);

}
