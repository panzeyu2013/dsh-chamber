/**
 * dsh-chamber desktop shell core (design 25 §4.1; W-09 batch 1 + W-10 S1/S2).
 *
 * Electron-free business logic mechanically relocated from main.ts — pure
 * moves plus documented parameterizations/seam-leaf replacements, no semantic
 * rewrites, no state-machine reordering. The Electron main process imports
 * these functions and constants by their original names; the Swift-native
 * flavor reuses the same core.
 *
 * Hard invariants:
 * - Electron-free by construction: never import the electron package (W-14
 *   face A gate). The sole IPC registration point is installIpcHandlers
 *   (W-10 seam batch): the registrar (deps.ipc) is injected by the assembly
 *   side — Electron main wraps it with the trustedIpc fence, so this file
 *   never spells ipcMain / webContents.send (W-14 face C gate). IPC_CHANNELS
 *   constants (ipc-events.ts — a pure constants module) are legitimately
 *   referenced here since S1.
 * - Host state is parameterized: userData-scoped paths and the runtime base
 *   dir arrive as arguments (resolveActiveRuntime / the path templates), argv
 *   arrives as an argument (scanDeepLinkUrls); nothing reads Electron host
 *   state implicitly. W-09 state is parameterized per function (the
 *   installIpcHandlers ctx seam). W-10 S2 修订：渲染器投递状态机（队列/ready
 *   位/drain/来源代际/held resume/badge holder）是 core 业务状态，以模块作用域
 *   单例承载（装配侧 glue/IPC 与 core 共享同一实例——单装配不变式：
 *   installIpcHandlers 每进程恰一次、先于任何窗口/渲染器事件，装配时快照
 *   edges 子集与 quit 门）；宿主状态仍绝无模块作用域隐式读取。
 *
 * Responsibilities relocated from main.ts (W-09 batch 1):
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
 * Responsibilities relocated from main.ts (W-10 S1 info+settings batch):
 * - Shell IPC registration point: installIpcHandlers with the IpcRegistrar /
 *   ShellAssemblyCtx seams (hostFacts / runtimeFacts / settingsIO and the
 *   settings side-effect leaves injected by the Electron main assembly).
 * - INFO / SETTINGS_GET / SETTINGS_SET handler bodies plus their helpers
 *   chamberSettingsStatus / applySettingsPatch / pushSettingsChanged
 *   (verbatim relocations — see the S1 section below).
 *
 * Responsibilities relocated from main.ts (W-10 S2 notify/badge/ready batch):
 * - B 组 6 个注册体（NOTIFY / NOTIFICATIONS_READY / NOTIFICATION_OPEN_ACK /
 *   BADGE_COUNT / DEEP_LINK_READY / DEEP_LINK_ACK）——见 installIpcHandlers ②；
 *   NOTIFY 主链路（maybeShowNativeNotification）与其 claim/限速编排随迁。
 * - 渲染器投递状态机（design 16 §4.2 / design 19 §3.3）：renderer 深链与通知
 *   打开的有界 ACK 队列 + ready 位 + drain（send 叶 = edges.rendererPush，
 *   requeue/rollback/acknowledge 语义原样）、来源代际/证明实例
 *   （NotificationSourceIncarnations / NotificationSourceProofs）、held
 *   lastResume 补发（handleSystemResume / handleMainWindowShown +
 *   pushHeldSystemResume）、badge 意图 holder 与平台门裁决。装配侧经导出入口
 *   访问（onRendererLifecycle / enqueueRendererDeepLinkIntent /
 *   captureNotificationSource / ownsNotificationSource /
 *   matchesNotificationSource / projectNotificationSourceInstances /
 *   syncNotificationSourceRegistry / clearBadgeIntentForQuit）——逐条迁移决策
 *   见「Renderer delivery state machines」段注释。
 *  Responsibilities relocated from main.ts (W-10 S3 registry+credentials batch):
 *  - C 组 7 个注册体：SSH_INSTANCES_GET / SSH_SAVE_CONNECTION /
 *    SSH_DELETE_CONNECTION / SSH_INSTANCES_SET / SSH_SET_PASSWORD /
 *    GATEWAY_SET_TOKEN / GATEWAY_SET_PASSWORD——按原 main.ts 顺序追加在 B 组
 *    之后（installIpcHandlers ② 段）；随迁注册体侧纯辅助（gatewayOriginFor /
 *    normalizeConnectionInput）与 registry 非秘密投影链（projectInstances /
 *    projectInstanceSecrets——模块级导出，main.ts 的 publishRegistryTransition
 *    沿用：S2 同款 core→main 单向依赖）。事务（connection-save）、canonicalize
 *    （transport-provider）与凭据写入口（ssh/gateway-provider）等纯模块直接
 *    import；装配依赖经 ctx：transportManager 句柄（registry 读写 + 状态/
 *    生命周期投影）/ audit / gatewaySessions / publishRegistryTransition（后
 *    三者宿主定义仍留 main 装配侧——publishRegistryTransition 的插件
 *    seed/journal 生命周期体与其 SSH_INSTANCES_CHANGED push 文本留 main）。
 *  Responsibilities relocated from main.ts (W-10 S4 ssh-connection-state batch):
 *  - D 组 7 个注册体：SSH_CONFIG_LIST / SSH_CONNECT / SSH_DISCONNECT /
 *    SSH_STATUS / SSH_REVERIFY / SSH_LOGS / SSH_LOGS_CLEAR——按原 main.ts 顺序
 *    追加在 C 组之后（installIpcHandlers ② 段）；CONFIG_LIST 经纯模块
 *    ssh-config.ts 的 discoverSshConfigHosts（非秘密投影纪律注释随迁），其余
 *    6 个注册体全走 ctx 注入的 transportManager 句柄（Pick 面 S4 扩
 *    reverify / logs / clearLogs——connect/disconnect/status 为 C 组已有成员）。
 *    status/logs 的非秘密投影形状不变（localPort/phase 等元数据；URL/密钥绝不
 *    出主进程、绝不进载荷/日志——main.ts 原注释语义保留）。
 *  Responsibilities relocated from main.ts (W-10 S5 ssh exec/systemd batch):
 *  - E 组 4 个注册体：SSH_START_SERVICE / SSH_STOP_SERVICE / SSH_IS_ACTIVE /
 *    SSH_RESTART_SERVICE——按原 main.ts 顺序追加在 D 组之后（installIpcHandlers
 *    ② 段）；全走 ctx 注入的 transportManager 句柄 exec 面（Pick S5 扩
 *    exec——restart 注册体在 main.ts 原经 plugin-sync 的 ExecFn 别名
 *    execTransport（= sm.exec 的 as unknown 收窄）调同一执行面，迁入后直用
 *    sm.exec：运行时同一函数、行为零改，决策注记见 E 组段）。systemctl argv
 *    固定参数数组与服务名白名单（SERVICE_NAME_PATTERN）及 generation 复验纪律
 *    是 transport-manager/ssh-provider 纯模块内部逻辑（spawn 前白名单拒绝 /
 *    execEpoch 复验），不随迁；注册体只做 {status} / {error} 结果投影（loud
 *    纪律注释随迁）。
 *  Responsibilities relocated from main.ts (W-10 S6 ssh plugin batch):
 *  - F 组 6 个注册体：SSH_PLUGIN_LIST / SSH_PLUGIN_APPLY / SSH_PLUGIN_UNDO /
 *    SSH_SEED_HOST_GRAPH / SSH_PLUGIN_MATERIALIZE_ADD /
 *    SSH_PLUGIN_MATERIALIZE_ADD_PICK——按原 main.ts 顺序追加在 E 组之后
 *    （installIpcHandlers ② 段）。编排纯模块（plugin-sync / ssh-apply-rows /
 *    plugin-tarball）直接 import；共享现实例与目标闭包束经 ctx 注入
 *    （sshPluginJournal / hostPackageSeeding / chamberHostPackageSeeds /
 *    sshPluginTargets——main 装配侧的自动 seed/ready 撤销路径与 F 组共用同一
 *    实例/闭包族，语义不分叉；localDshHome 为装配期解析路径，core 不碰
 *    Electron paths）。确认对话框宿主腿 = HostEdges.showMessage、插件源 picker
 *    宿主腿 = HostEdges.pickPluginSource（electron-edges.ts S6 实现；
 *    classifyPluginPick 留 core）；mainWindowAlive 预检 = edges 门（S2 已有）。
 *    transportManager Pick 扩 appendLog（seed 结果入实例环形日志）。
 *  Responsibilities relocated from main.ts (W-10 S7 gateway plugin batch):
 *  - G 组 3 个注册体：GATEWAY_PLUGIN_SYNC / GATEWAY_PLUGIN_APPLY /
 *    GATEWAY_PLUGIN_MATERIALIZE——按原 main.ts 顺序追加在 F 组之后
 *    （installIpcHandlers ② 段）。注册体逐字随迁；编排纯模块直接 import
 *    （gateway-ipc-shared / gateway-sync-registry / gateway-provider /
 *    plugin-tarball）。确认对话框复用 S6 edges 版 confirmPluginAction 助手
 *    （core 内——宿主腿 = HostEdges.showMessage）、无存活主窗预检 =
 *    edges.mainWindowAlive、插件源 pick = edges.pickPluginSource。手动 sync 的
 *    上传执行闭包 syncGatewayChamberPluginsFor 经 ctx 注入（main 装配侧定义
 *    ——ready 自动 sync 与手动 re-entry 共用同一执行路径与注册参数，语义
 *    不分叉）。
 *  Responsibilities relocated from main.ts (W-10 S8 local plugin + npm batch):
 *  - H 组 5 个注册体：LOCAL_PLUGIN_LIST / NPM_SEARCH / LOCAL_PLUGIN_ADD_FILE /
 *    LOCAL_PLUGIN_ADD / LOCAL_PLUGIN_REMOVE——按原 main.ts 顺序追加在 G 组之后
 *    （installIpcHandlers ② 段）。注册体逐字随迁；编排纯模块直接 import
 *    （plugin-sync：localPluginList / runLocalDshPlugin /
 *    describeLocalPluginAddConfirmation / describeLocalPluginRemoveConfirmation；
 *    @dsh-chamber/dsh-runtime isAllowedRegistryUrl——npm 搜索的 registry URL
 *    白名单纪律注释随迁）。本地安装的宿主子进程编排（runtime writer fence 租约
 *    + 启动门 + resolveActiveRuntime workspace 解析）经 ctx 注入叶
 *    runLocalPluginMutation（main 装配侧定义——fence/启动门是装配侧运行时事务
 *    状态；add 子进程 env 装配在 plugin-sync runLocalDshPlugin 纯模块内，W-14
 *    关联 C-F12 纪律注释随原模块）。确认对话框复用 S6 edges 版 confirmPluginAction
 *    助手（按钮序/取消默认/无窗文案逐字一致）、ADD_FILE 的无存活主窗预检 =
 *    edges.mainWindowAlive、插件源 pick = edges.pickPluginSource。main 侧原
 *    confirmPluginAction 闭包随本批删除（无剩余使用点）。
 *  Responsibilities relocated from main.ts (W-10 S9 open-in + update batch):
 *  - I 组 7 个注册体：OPEN_IN_APPS / OPEN_IN / UPDATE_STATE / UPDATE_CHECK /
 *    UPDATE_DOWNLOAD / UPDATE_RESTART / OPEN_RELEASE——按原 main.ts 顺序追加在
 *    H 组之后（installIpcHandlers ② 段）。open-in 面随迁 openInCtx/wiredCtx 共享
 *    宿主依赖束（app 能力协商经纯模块 open-in.ts；来源指纹 owns/matches 复查与
 *    来源代际捕获在 core；lookupInstance 经 ctx transportManager（sm 现实例）；
 *    宿主打开/揭示叶 = HostEdges openExternal/openPath/showItemInFolder——均在
 *    electron-edges.ts S9 实现）。update 面经 ctx 注入的 updateController 现实例
 *    （main 装配侧构造的 electron-updater 包装；类型 import 自 updater.ts——纯
 *    类型面，core 零 electron 运行时字样）与状态 push 订阅（committed-push 包装
 *    + edges.rendererPush，主窗身份折算见 I 组段注释）。
 *  - OS 深链启动队列与消费循环（design 16 §4.2）：pendingIntents（有界 64
 *    single-flight 队列）+ drain 闭包装配 + enqueueDeepLink（OS 三入口 glue 经
 *    导出入口调用）+ 启动尾部 drain 入口（drainDeepLinkLaunches）——W-10 S2
 *    遗留项（队列/消费循环留 main 至 S9）在此闭合；装配点 = installIpcHandlers
 *    ② I 组段（wiredCtx 依赖束就绪后），见「OS 深链启动队列 + 外链打开预算器」段。
 *  - 外链打开统一入口（openExternally 迁入）：URL 规范化 + 10s/8 次预算 + 30s
 *    冷却（原 main.ts 窗口 glue 的模块级函数整体迁入——glue 改经 core 导出 +
 *    装配期快照的 edges.openExternal 宿主叶）。
 *  Responsibilities relocated from main.ts (W-10 S10 runtime A batch):
 *  - J 组 6 个注册体：RUNTIME_STATE / RUNTIME_RESTART / RUNTIME_CHECK /
 *    RUNTIME_INSTALL / RUNTIME_CLEANUP_VERSION / RUNTIME_CLEAR_FAILURE——按原
 *    main.ts 顺序追加在 I 组之后（installIpcHandlers ② 段）。注册体逐字随迁
 *    （trustedIpc 围栏由装配侧注入 registrar 包装）；dsh-runtime 控制器现实例
 *    （DshRuntimeController——main 装配侧 whenReady 构造）与 fence/门/宿主叶经
 *    ctx 注入（runtimeController / runtimeOperationBusy / runtimeWriterFence /
 *    runtimeActionAllowed / runtimeBaseDir / refreshRuntimeEvidence /
 *    runStorePruneIfNeeded / restartLocalDsh——main 侧 K 组注册体与启动/证据
 *    路径共用同一实例/闭包，语义不分叉）；@dsh-chamber/dsh-runtime 纯逻辑
 *    （isSafeVersion / cleanupExplicitRuntimeVersion /
 *    listExplicitlyInstalledVersions / listRuntimeFailures / clearRuntimeFailure
 *    ——electron-free 共享核）core 直接 import；确认对话框 = core 内 S6 版
 *    confirmRuntimeMutation 助手（edges.showMessage 宿主腿——按钮序/取消默认/
 *    文案逐字一致；无窗 → false = 'native confirmation unavailable' 不确认语
 *    义）；runRuntimeCheck 随迁（周期/首检计时器仍归 main 装配侧，经导出入口
 *    runRuntimeCheckCycle 调用同一实现）。
 *  Responsibilities relocated from main.ts (W-10 S11 runtime B + W-10 收口批):
 *  - K 组 6 个注册体：RUNTIME_RECOVER_METADATA / RUNTIME_RESET_BUILTIN /
 *    RUNTIME_RETRY_APPLY / RUNTIME_APPLY_NOW / RUNTIME_RETRY_RESTORE /
 *    RUNTIME_RESTORE_PRE_ROLLBACK——按原 main.ts 顺序追加在 J 组之后
 *    （installIpcHandlers ② 段）。注册体逐字随迁；「运行时启动事务宿主」
 *    （runRuntimeStartup 与共享闭包族——executeMetadataRecovery 等恢复事务腿、
 *    publishBlockedStartup/setRuntimeGate 宿主门、authoritativeMetadataRecoveryStatus /
 *    runUserMetadataRecovery 元数据恢复资格投影与事务宿主、readApplyNowGateInput
 *    APPLY_NOW 门输入构造、selectedJournalIntent、stopLocalDsh（cp.stopLocal 叶）、
 *    runtimeOperationSlot 事务槽 begin/end/inFlight、bundledVersion 值）按施工图
 *    留 main 装配侧、经 ctx 注入——K 组注册体与启动/证据路径共用同一实现/同一
 *    运行时事务槽，语义不分叉（S11 收口：main 侧同名 confirmRuntimeMutation 闭包
 *    随本批迁完删除，S10 遗留过渡双份消除）。dsh-runtime 纯逻辑直接 import
 *    （queueActivationIntent / writeActivationIntent / restoreMarkerAuthorityStatus /
 *    readActivationJournalState / writeOverride / listPreRollbackStashes /
 *    restorePreRollback——electron-free 共享核）；evaluateApplyNowGate 直 import
 *    apply-now-gate.ts（纯模块）。W-10 60 个 handler 至此全部迁入本文件
 *    installIpcHandlers（main.ts 零 ipcMain.handle/webContents.send 注册面）。
 *
 * 中文说明：自 main.ts 机械搬运的 Electron-free 业务核心（零缝阶段，行为零
 * 变化）；W-10 S1 起 IPC 注册点与 A 组 info+settings 处理器迁入本文件
 * （installIpcHandlers 单点注册，Electron 围栏由 main 注入包装）；S2 追加 B 组
 * notify/badge/ready 6 注册体与渲染器投递状态机（send 叶统一
 * edges.rendererPush）；S3 追加 C 组 registry+凭据 7 注册体与读时投影链（凭据
 * write-only/绝不回读纪律随迁，代码注释保留）；S4 追加 D 组 ssh 连接状态 7
 * 注册体（CONFIG_LIST 经纯模块 ssh-config.ts；其余经 ctx transportManager
 * ——非秘密投影纪律随迁）；S5 追加 E 组 exec/systemd 4 注册体（SSH_START/
 * STOP/IS_ACTIVE/RESTART_SERVICE——经 ctx transportManager 的 exec 面）；S6
 * 追加 F 组 ssh plugin 6 注册体（plugin list/apply/undo + host-graph seed +
 * 材料化 add/pick——编排纯模块直接 import，共享实例/目标闭包经 ctx，确认与
 * picker 经 edges 宿主腿，Pick 扩 appendLog）；S7 追加 G 组 gateway 插件 3
 * 注册体（sync/apply/materialize——编排纯模块直接 import，手动 sync 执行闭包
 * 经 ctx，确认/pick/窗口预检经 S6 edges 宿主腿）；S8 追加 H 组本地插件 + npm
 * 搜索 5 注册体（LOCAL_PLUGIN_LIST / NPM_SEARCH / LOCAL_PLUGIN_ADD_FILE /
 * LOCAL_PLUGIN_ADD / LOCAL_PLUGIN_REMOVE——编排纯模块直接 import，本地安装
 * 执行叶 runLocalPluginMutation 经 ctx，确认/无窗预检/pick 经 S6 edges 宿主腿；
 * main 侧 confirmPluginAction 闭包随本批删除）；S9 追加 I 组 open-in + update
 * 7 注册体（OPEN_IN_APPS / OPEN_IN / UPDATE_STATE / UPDATE_CHECK /
 * UPDATE_DOWNLOAD / UPDATE_RESTART / OPEN_RELEASE——open-in 面随迁
 * openInCtx/wiredCtx 宿主依赖束与消费循环装配，update 面经 ctx.updateController
 * 现实例注入；宿主打开/揭示/错误框叶 openExternal/openPath/showItemInFolder/
 * showError 在 electron-edges.ts S9 实现），并把深链 OS 启动队列 + 消费循环
 * 与 openExternally 外链预算器收进本文件（S2 遗留闭合）。
 * S10 追加 J 组 runtime A 6 注册体（RUNTIME_STATE / RUNTIME_RESTART /
 * RUNTIME_CHECK / RUNTIME_INSTALL / RUNTIME_CLEANUP_VERSION /
 * RUNTIME_CLEAR_FAILURE——控制器实例/fence/门/宿主叶经 ctx，dsh-runtime 纯
 * 逻辑直 import，确认对话框 = S6 edges 版助手同款宿主腿；runRuntimeCheck 随迁、
 * 周期检查经导出入口 runRuntimeCheckCycle）。
 * S11 追加 K 组 runtime B 6 注册体（RUNTIME_RECOVER_METADATA / RUNTIME_RESET_BUILTIN /
 * RUNTIME_RETRY_APPLY / RUNTIME_APPLY_NOW / RUNTIME_RETRY_RESTORE /
 * RUNTIME_RESTORE_PRE_ROLLBACK——注册体逐字随迁：启动事务宿主/共享闭包族经 ctx
 * 宿主叶（runRuntimeStartup / publishBlockedStartup / setRuntimeGate /
 * authoritativeMetadataRecoveryStatus / runUserMetadataRecovery / readApplyNowGateInput /
 * selectedJournalIntent / stopLocalDsh / runtimeOperationSlot / bundledVersion），
 * evaluateApplyNowGate 直 import apply-now-gate.ts，dsh-runtime 纯逻辑直 import；
 * `runtimeOperation !== null` 与 `quitRequested`、`cp.stopLocal()` 等宿主引用
 * 逐处机械替换并注记；main 侧同名 confirmRuntimeMutation 闭包随本批删除）。
 * **W-10 收口**：60 handler 全部迁入 installIpcHandlers（main.ts 零 ipcMain.handle /
 * webContents.send 注册面——收口验证见 main.ts 顶部注释与 electron-free-gate
 * 面 C 断言）。
 * HostEdges 其余边沿叶与双 flavor 属后续批（W-10 之外）。
 */

import { existsSync, promises as fsp, readFileSync } from 'node:fs';
import path from 'node:path';
import { findFreePort } from './free-port.ts';
import { computeSupported, validatePatch } from './chamber-settings.ts';
import type { ChamberSettings, ChamberSettingsStatus } from './chamber-settings.ts';
import { DEFAULT_CHAMBER_SETTINGS } from './chamber-settings.ts';
import {
  INSTANCE_ID_PATTERN,
  attemptCommittedRegistryPush,
  commitTransportCredentialUpdate,
  type TransportManager,
} from './transport-manager.ts';
import {
  deleteConnectionTransaction,
  saveConnectionTransaction,
  validateDeleteOnlyReplacement,
  type ConnectionCredentialMutations,
} from './connection-save.ts';
import { IPC_CHANNELS } from './ipc-events.ts';
import type { NotificationOpenIntent, NotificationSourceToken } from './notifications.ts';
import {
  canonicalizeTransportInstanceInput,
  type TransportInstanceInput,
  type TransportInstanceSpec,
} from './transport-provider.ts';
import { discoverSshConfigHosts } from './ssh-config.ts';
import { MAX_SSH_PASSWORD_CHARS, getSshPassword, setSshPassword, sshPasswordSupported, sshProvider } from './ssh-provider.ts';
import {
  gatewayChamberApplyBatch,
  gatewayChamberMaterialize,
  gatewayPasswordValidationError,
  gatewayProvider,
  gatewaySecretStorageMode,
  gatewayTokenValidationError,
  getGatewayPassword,
  getGatewayToken,
  setGatewayPassword,
  setGatewayToken,
  setInstanceSecrets,
} from './gateway-provider.ts';
import {
  gatewaySessionScopeForConnection,
  type GatewaySessionManager,
  type GatewaySessionOrigin,
} from './gateway-session.ts';
import { gatewaySessionOriginForUrl, gatewayTunnelAuthority } from './gateway-session-refresh.ts';
import type { AuditEvent } from './audit-log.ts';
import { adjudicateBadgeCount, badgePlatformGate, validateBadgeRequest } from './badge.ts';
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
// W-10 S9（open-in 批）：open-in.ts 为 electron-free 纯模块（openInCtx 宿主能力
// 注入面——stat/openPath/showItemInFolder 等叶由本文件装配侧经 edges 提供）；
// openReleasePage 自 updater.ts 运行时 import（updater.ts 模块加载零 electron——
// electron/electron-updater 均经 createRequire 惰性解析，见其文件头注记；本文件
// 只调用纯 URL 白名单 + 宿主叶路径）。update 面只做**类型** import（UpdateController
// 结构纯类型，无 electron 依赖——实例本体仍在 main 装配侧构造、经 ctx 注入）。
import { classifyLocalPath, invokeOpenPath, listOpenInApps, runOpenInLaunch } from './open-in.ts';
import type { OpenInLaunchContext, OpenInRequest } from './open-in.ts';
import { openReleasePage } from './updater.ts';
import type { UpdateController } from './updater.ts';
import {
  BoundedRateLimiter,
  MAX_PENDING_NOTIFICATION_OPENS,
  NotificationSourceIncarnations,
  NotificationSourceProofs,
  claimNotificationDetailed,
  decideNotification,
  isValidNotificationSourceFingerprint,
  releaseNotificationClaim,
  validateNotificationRequest,
} from './notifications.ts';
import type { NotificationSettingsLike } from './notifications.ts';
import {
  isAllowedRegistryUrl,
  readCurrentPointerState,
  readOverrideState,
  shouldInvalidate,
  validateVersionTree,
} from '@dsh-chamber/dsh-runtime';
// W-10 S10（runtime A 批）：J 组 6 注册体直 import 的 @dsh-chamber/dsh-runtime
// 纯逻辑（electron-free 共享核——与 main.ts 同款 import 面）；控制器现实例与
// fence/门/宿主叶仍经 ctx 注入（实例态与装配期单写者留 main）。
import {
  cleanupExplicitRuntimeVersion,
  clearRuntimeFailure,
  isSafeVersion,
  listExplicitlyInstalledVersions,
  listRuntimeFailures,
} from '@dsh-chamber/dsh-runtime';
import type { RuntimeAction, RuntimeOperationFence } from '@dsh-chamber/dsh-runtime';
// W-10 S11（runtime B 批）：K 组 6 注册体直 import 的 @dsh-chamber/dsh-runtime
// 纯逻辑（electron-free 共享核——activation intent/journal/override 的持久化写与
// pre-rollback stash 的只读/恢复、restore marker 权威读；与 main.ts 同款 import
// 面）；StartupResult / ActivationJournalState 为类型面（ctx 宿主叶签名与 K 组
// 段内联事务注解用）。启动事务宿主（runRuntimeStartup 等）与共享闭包仍经 ctx
// 注入——实例态与装配期单写者留 main。
import {
  listPreRollbackStashes,
  queueActivationIntent,
  readActivationJournalState,
  restoreMarkerAuthorityStatus,
  restorePreRollback,
  writeActivationIntent,
  writeOverride,
} from '@dsh-chamber/dsh-runtime';
import type { ActivationJournalState, StartupResult } from '@dsh-chamber/dsh-runtime';
// W-10 S11: apply-now-gate.ts 为 electron-free 纯模块（主进程侧 RUNTIME_APPLY_NOW
// 注册体的纯门矩阵——evaluateApplyNowGate 直 import；其输入构造 readApplyNowGateInput
// 读 controlPlane/env/事务槽等装配侧状态，经 ctx 注入，见 ShellAssemblyCtx）。
import { evaluateApplyNowGate } from './apply-now-gate.ts';
import type { ApplyNowGateInput } from './apply-now-gate.ts';
// W-10 S10: dsh-runtime-controller.ts 为 electron-free 纯编排模块（只 import
// @dsh-chamber/dsh-runtime + sanitize-error，零 electron）——core 只做**类型**
// import（DshRuntimeController / RuntimeLifecycleProjection 为结构纯类型面；
// 注册体返回的 state 形状经控制器方法类型推断，无需另行具名）；
// 控制器现实例在 main 装配侧构造、经 ctx.runtimeController 注入。
import type { DshRuntimeController, RuntimeLifecycleProjection } from './dsh-runtime-controller.ts';
// W-10 S6（ssh plugin 批）：F 组编排纯模块直接 import——plugin-sync /
// ssh-apply-rows / plugin-tarball 均为 electron-free 纯模块（main.ts 同款
// import 面，无 electron、无 shell-core 反向依赖）。ssh-plugin-journal /
// plugin-sync 的**现实例**（createSshPluginJournal / ExactOwnershipRegistry /
// chamberHostPackageSeeds / 目标闭包束）经 ctx 注入——main 装配侧的自动
// seed/撤销路径与 F 组注册体必须共享同一实例（单写者/单飞语义不分叉）。
import {
  applyPlugins,
  describeLocalPluginAddConfirmation,
  describeLocalPluginRemoveConfirmation,
  localPluginList,
  materializeAndAdd,
  materializeArchiveAndAdd,
  redactRemotePluginManifest,
  remotePluginList,
  resolveLocalMaterializeDirectory,
  runLocalDshPlugin,
  runWithFinalOwnership,
  seedRemoteChamberHostPackages,
} from './plugin-sync.ts';
import type { ChamberHostPackageSeed, ExactOwnershipRegistry, ExactOwnershipToken, ExecFn, RemoteSpec, StatusFn } from './plugin-sync.ts';
import {
  buildSshApplyRows,
  buildSshUndoDecision,
  describeReservedNameRefusal,
  describeSshUndoConfirmation,
} from './ssh-apply-rows.ts';
import type { SshPluginJournal } from './ssh-plugin-journal.ts';
import { buildPluginTarball, classifyPluginPick } from './plugin-tarball.ts';
import { buildApplyConfirmMessage, validateApplyPayload } from './gateway-ipc-shared.ts';
import { getGatewaySyncRegistration } from './gateway-sync-registry.ts';
import { sanitizeErrorText } from './sanitize-error.ts';

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
// sibling package.json exactly like main.ts reads its own — the same file in
// dev and packaged layouts (W-09: the moved resolver keeps comparing the
// override's recorded shellVersion against the same version fact it compared
// in main.ts).
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
  if (overrideState.kind === 'corrupt') {
    return { path: null, version: null, source: 'bundled', blockedReason: 'dsh runtime override metadata is corrupt' };
  }
  if (pointerState.kind === 'corrupt') {
    return { path: null, version: null, source: 'bundled', blockedReason: 'dsh runtime current pointer is corrupt' };
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

// 本地实例「运行中/在途」状态（design 14 D2，2026-08 修订）：进程存活
// （ready/degraded）或 spawn/重启在途（starting/restarting）——退出会中断
// 它们，需确认。stopped / error / restart-exhausted 无进程可中断，不触发
// 确认。**2026-08 二次修订**：状态字符串不是存活事实——restart 序列里
// `restarting` 期间新进程可能尚未 spawn（backoff 1s→60s），死亡进程在下次
// 探活前也可能滞留在 ready/degraded；退出确认必须同时要求**实际有存活进程**
// （localProcessAlive），否则"本地明明没有实例在运行"也会误弹确认。注意
// `starting` 全程 child 尚未赋值（spawn 解析后才挂到连接上），hasLiveProcess()
// 恒为 false，配合 AND 门实际不参与确认——spawn 在途由控制面的 epoch/stopping
// 守卫在 stop() 时终止（绝不孤儿化），故「无进程则不确认」是安全的。
export const LOCAL_RUNNING_STATES: ReadonlySet<string> = new Set(['starting', 'ready', 'degraded', 'restarting']);

/** 扫描 argv 中的 dsh-chamber:// 深链（防御式：非深链 argv 零副作用、绝不 throw）。 */
export function scanDeepLinkUrls(argv: readonly string[]): string[] {
  const urls: string[] = [];
  for (const arg of argv) {
    if (typeof arg === 'string' && arg.startsWith('dsh-chamber://')) urls.push(arg);
  }
  return urls;
}

/** 退出清理（will-quit：transport dispose + 控制面 stop）的最长等待；超时强制
 *  退出，防「窗口已关、主进程永久滞留」的半退出态。子进程回收用短窗口
 *  （transport 1s / 本地 dsh 1s → SIGKILL）+ 传输层与控制面并行化，正常
 *  ~1-2s 完成；5s 硬顶仅为异常路径（如残留连接使 server.close 不回调）兜底
 *  （2026-08 排查；2026-08 提速，15s → 5s）。 */
export const QUIT_CLEANUP_TIMEOUT_MS = 5_000;
/** Cap on the npm search JSON body (registry search responses are ~KB-scale;
 * 256 KiB bounds a hostile or misbehaving registry). */
export const NPM_SEARCH_MAX_BODY_BYTES = 256 * 1024;

// userData-scoped path templates (design 25 §4.1 resource-path 收口, W-09
// batch 1): every persistent file / state root under <userData> is spelled
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

// ---------------------------------------------------------------------------
// HostEdges — the host side-effect seam (design 25 §4.1; W-10 batch).
//
// Core business code reaches every Electron/host side effect ONLY through
// this injected interface. The Electron main process implements it in
// electron-edges.ts (createElectronEdges — W-10 S0 wires the rendererPush
// leaf; later batches move the remaining leaves verbatim); the Swift-native
// flavor will implement the same seam over the B bridge (node-edges.ts).
// Electron-free by construction: member types are strings/numbers/booleans/
// Promises/local structural types — never electron types (W-14 face A gate),
// and no IPC registration or bare channel literals live here. Member-level
// deviations from the design 25 §4.1 draft are annotated per member (v2
// field set per design 25 §0.1 rows A10/B1/B3/B4/B9/B11/D3).
// ---------------------------------------------------------------------------

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

/** dialog.showMessageBox 选项（最小结构形态：按 main.ts 现用调用点
 *  type/title/message/detail/buttons/defaultId/cancelId/noLink 收口；随对话
 *  框叶迁移批按需扩展）。 */
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
 *  design 21 §10 ⑧ 判定，待 picker 叶迁移批定稿）。 */
export type HostPluginSourcePick =
  | { status: 'cancelled' }
  | { status: 'picked'; path: string };

/** badge 应用结果。与 §4.1 草案 setBadge(count): boolean 的偏差：v2 用判别
 *  形态区分「已应用」与「未应用 + 原因」（reason 先取 string，细分联合随
 *  badge.ts 平台门迁移批定稿）。 */
export type HostSetBadgeResult =
  | { applied: true }
  | { applied: false; reason: string };

/** resolveResource 的资源位（B1：main.ts 直拼点参数化收口）。 */
export type HostResourceKind = 'builtin-dsh' | 'pnpm' | 'dist-web' | 'host-package' | 'icon';

/** HostEdges — core 侧唯一可见的宿主边沿契约（design 25 §4.1 v2 字段集）。
 *  S0 批实现 rendererPush、S2 批实现渲染器投递/通知/徽标批成员
 *  （electron-edges.ts 头注释按批列出已实现集合）；其余成员标注其后续批来源，
 *  未实现前 core/main.ts 不得调用（Pick 收窄在编译期保证）。 */
export interface HostEdges {
  /** 主窗口渲染器 push 叶（W-10 S0 seam 成员，草案新增）：channel 为 opaque
   *  通道名（Electron 侧恒为 IPC_CHANNELS 常量值），payload 为纯非秘密投影；
   *  返回 false = 当前无存活主窗（单窗身份），调用侧自行折算失败语义。 */
  rendererPush(channel: string, payload: unknown): boolean
  // —— 原生显示/系统集成 ——
  /** 构造并显示原生通知（B4：宿主对象登记/淘汰/evict 全留实现侧私有）。S2 形状
   *  （对 §4.1 草案的批内修订）：clickRoute 携带 click 回灌路由——null = 'test'
   *  通知（无会话上下文，原生 click 只恢复窗口）；否则宿主 click 腿在宿主内先
   *  activate/restore/focus 主窗口（无窗则重建，showMainWindow 语义），成功后才
   *  回调 onActivated（core 的 owns+入队闭包——来源代际校验在 core）。honest-show
   *  结算（showNativeNotificationHonestly 语义）在实现侧内部执行；返回句柄的
   *  shown 暴露结算结果（NOTIFY IPC 返回值与 claim 释放依赖它），dispose 注销
   *  click 回执（注销后该通知的后续 click 只恢复窗口）。实现侧不 throw——构造/
   *  登记/监听失败一律结算为 shown:false 且登记清理内部完成。 */
  showNativeNotification(
    spec: NativeNotificationSpec,
    clickRoute: { token: NotificationSourceToken; onActivated(): void } | null,
  ): { dispose(): void; shown: Promise<{ shown: true } | { shown: false; error: string }> }
  /** Notification.isSupported 平台探测（异常安全由实现侧保证）。 */
  notificationSupported(): boolean
  /** 通知 click → open-intent 回灌（design 25 §4.5 E4：宿主激活窗口腿成功后把
   *  click 送回 core 队列）。S2 的 Electron click 回灌经 showNativeNotification
   *  的 clickRoute 参数实现；本成员供后续批（Swift B flavor 的
   *  edge:notification-clicked 对应面）使用，未实现前不可经 Pick 触碰。 */
  notifyClicked(openIntent: NotificationOpenIntent): void
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
  /** 主窗口存在性门（W-10 S2 批内补充，B3 族）：win!=null 且未销毁——隐藏到
   *  托盘/后台的窗口仍为 true（与 loading/alive 区分：窗口在但不一定可用）。
   *  rendererPush 返回 false 与 mainWindowAlive() 为 false 语义等价。 */
  mainWindowAlive(): boolean
  /** 来源退役驱逐（W-10 S2 批内补充，B4 registry 私有）：注册表退役路径把
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
  /** 资源/打包路径解析（B1/B13：main.ts 直拼点参数化收口）。 */
  resolveResource(kind: HostResourceKind): string
}

// ---------------------------------------------------------------------------
// Renderer delivery state machines (W-10 S2 notify/badge/ready batch).
//
// 迁自 main.ts 的渲染器侧队列状态机（design 16 §4.2 / design 19 §3.3 /
// design 14 D4）：pendingRendererIntents + deepLinkRendererReady + drain、
// pendingNotificationOpens + notificationOpenDrainReady + drain、来源代际/
// 证明实例（notificationSourceIncarnations / NotificationSourceProofs）、held
// lastResume 补发、badge 意图 holder。本段是 core 业务状态（非宿主状态）——
// 对 W-09「状态一律参数化、绝不模块作用域读」头部注记的批内修订：装配侧窗口
// glue / open-in IPC / 深链消费循环与 installIpcHandlers 必须共享同一实例。
// 单装配不变式：installIpcHandlers 每进程恰一次、先于任何窗口/渲染器事件（S1
// 调用点纪律：whenReady 内、createMainWindow 之前），装配时把 HostEdges 投递
// 子集（deliveryEdges）与 quit 门（quittingLeaf）快照进本段——此后所有导出
// 入口可用。Electron-free 不变式不变：本文件零 electron import，投递 send 叶
// 一律 edges.rendererPush、窗口事实一律 edges 门。
//
// 迁移决策（逐条注记，施工图 S2）：
// - drainPendingRendererDeepLinkIntents / drainPendingNotificationOpens 随队列
//   迁入（send 叶改 edges.rendererPush(IPC_CHANNELS.DEEP_LINK_INTENT /
//   NOTIFICATION_OPEN,…)，requeue/rollback/ACK/ready 位语义原样保留；窗口身份
//   复查（原 mainWindow === win）折算为「投递门只对当前主窗求值」——所有 drain
//   触发点（glue 的 mainWindow===win 守卫 / trusted IPC = 当前主窗 / 入队调用）
//   都锚定当前主窗，mid-drain 的 Electron 同步拆除竞态由每项 edges 门复检兜住；
//   ready 位只在投递失败时复位（= 原「仅发送失败的窗口失去握手」语义——单窗下
//   该窗即当前主窗，且 ready 位只由当前主窗的 trusted IPC 置位，无条件复位安全）。
// - enqueueRendererDeepLinkIntent：迁入并导出（main.ts 的 open-in IPC 与深链
//   消费循环（S9 前留 main）继续调用；签名与语义不变）。
// - enqueueNotificationOpen：迁入（其唯一调用方 = NOTIFY 流构造的 click 回灌
//   闭包，见 installIpcHandlers；不导出）。
// - captureVscodeSource：**留在 main.ts**（依赖 transportManager registry 查
//   找 = 装配侧所有物；代际捕获改经导出的 captureNotificationSource 代理）。
// - notificationSourceIncarnations / NotificationSourceProofs 实例迁入（NOTIFY
//   流、入队 owns 校验与 registry 退役共用；main.ts 侧经导出的 capture / owns /
//   matches / project / sync 入口访问）。
// - held lastResume 补发迁入（handleSystemResume / handleMainWindowShown +
//   pushHeldSystemResume 经 edges.rendererPush 推送 SYSTEM_RESUME——committed
//   push 包装与搬迁前同款）；订阅点 = installIpcHandlers ① 段注册
//   edges.onSystemResume / onMainWindowShown。传输层唤醒重探
//   （reconnectStaleTransports）留在 main 装配侧另挂 powerMonitor 监听。
// - badge 意图 holder 迁入（BADGE_COUNT 注册体随迁；平台门 = badgePlatformGate
//   (platform, edges.badgeCountApiAvailable()) 留 core——E5「门控逻辑留
//   core」）；quit 兜底清除经 clearBadgeIntentForQuit 导出（main will-quit
//   调用，原生清除叶由调用侧注入）。
// - ready 位挂钩收敛为 onRendererLifecycle(event) 单一入口：did-start-loading /
//   did-finish-load / crashed / closed 由 main 窗口 glue 调用（每处先做
//   mainWindow===win 身份守卫）；'show'（held-resume 补发点）经
//   edges.onMainWindowShown → handleMainWindowShown，不占本入口。
// ---------------------------------------------------------------------------

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

/** 全局原生通知发送限速（含 kind:'test'，与 claim 同款有界滑动窗口）。 */
const nativeNotificationRateLimiter = new BoundedRateLimiter();

/** SYSTEM_RESUME 推送叶包装：单窗身份 send（edges.rendererPush 返回 false =
 *  无存活主窗）折算为 push 失败并 loud——与搬迁前「mainWindow 变更即 throw」
 *  语义等价；无窗口常驻期间由 show 补发兜底。 */
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
 *  后再补发。send 叶 = edges.rendererPush（W-10 S2 迁入后改法；返回 false 折算
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
 *  任一条件不满足 → hold。send 叶 = edges.rendererPush（W-10 S2 迁入后改法）；
 *  mid-drain 变更/失败 → rollback 保留 + ready 复位 + 返回 false（renderer 有界
 *  重试重建握手）。 */
function drainPendingRendererDeepLinkIntents(): boolean {
  const edges = deliveryEdges;
  if (edges === null) return true;
  if (drainingRendererDeepLinkIntents) return true;
  // 原门（main.ts）以 canDeliverRendererDeepLink + mainWindow===win 求值；窗口
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
 *  调用——随队列迁 core，签名与语义不变）。 */
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

/** ready 位挂钩收敛入口（W-10 S2）：窗口事件 → 队列状态机复位/重放，语义逐字
 *  迁自 main.ts 窗口 glue。did-start-loading 必先于页面脚本执行（ready IPC 恒在
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

/** 来源代际捕获代理（main.ts 的 captureVscodeSource / 插件播种所有权沿用——
 *  NotificationSourceIncarnations 实例随迁 W-10 S2）。 */
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

/** 来源证明投影（NotificationSourceProofs 实例随迁 W-10 S2；main.ts 的 registry
 *  查询/投影沿用——证明在 presentation/service/home 编辑后仍存活，renderer 生命
 *  周期退役（删除/传输身份编辑）时轮换）。 */
export function projectNotificationSourceInstances(
  instances: readonly TransportInstanceSpec[],
): ProjectedTransportInstanceSpec[] {
  return notificationSourceProofs.replaceRemoteInstances(instances);
}

// ---------------------------------------------------------------------------
// W-10 S3（registry+凭据批）：registry 读时非秘密投影链迁入（自 main.ts 的
// projectInstanceSecrets / projectInstances 局部闭包逐字搬迁，行为零变）。
// sshPasswordSet/tokenSet/passwordSet 为凭据**存在性**布尔标记（读侧只判
// null——写入口经 ssh/gateway-provider 模块直调，值绝不回读进载荷或日志）；
// secretStorage 是凭据镜像的存储模式投影（'safeStorage' | 'plaintext'）。
// main.ts 的 publishRegistryTransition（registry 生命周期 sidecar，S3 留
// main 装配侧经 ctx 注入）沿用本模块导出——S2 同款 core→main 单向依赖：
// 注册表投影先经 projectNotificationSourceInstances 挂来源证明，再经
// projectInstanceSecrets 挂凭据存在性标记。
// ---------------------------------------------------------------------------
export type ProjectedRegistryInstance = TransportInstanceSpec & {
  sshPasswordSet: boolean
  tokenSet: boolean
  passwordSet: boolean
  secretStorage: ReturnType<typeof gatewaySecretStorageMode>
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
  };
}

/** 注册表整表读时投影（instances_get / save / delete 的返回路径——W-10 S3
 *  随迁；语义与 main.ts 原 projectInstances 完全一致）。 */
export function projectInstances(instances: readonly TransportInstanceSpec[]): ProjectedRegistryInstance[] {
  return projectNotificationSourceInstances(instances).map(projectInstanceSecrets);
}

/** 来源 registry 同步（退役权威 + 队列清理，W-10 S2）：replaceRemoteSources 后
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

// ---------------------------------------------------------------------------
// OS 深链启动队列 + 外链打开预算器（W-10 S9 open-in + update 批）。
//
// 迁自 main.ts 的模块级业务状态（design 16 §4.2）：pendingIntents（有界 64
// single-flight OS 启动队列）+ draining 位 + 消费循环装配槽 + enqueueDeepLink
// （OS 三入口 glue：macOS open-url / Win+Linux second-instance argv / 冷启动
// argv——装配侧经导出入口调用）与启动尾部 drain 入口（drainDeepLinkLaunches）。
// W-10 S2 决策（本队列与消费循环留 main 至 S9——原 main.ts 段注释）在此闭合：
// 消费循环本体（drainPendingIntents 闭包——依赖 wiredCtx/captureVscodeSource，
// 见 installIpcHandlers ② I 组段）在装配时就绪；装配前到达的深链只入队、装配
// 后按触发消费（与原 main.ts「drainPendingIntents 在 whenReady 尾部赋值、冷启动
// 到达的深链只入队、drain 就绪后消费」同语义）。quit 在途门 = quittingLeaf
// （S2 快照——与原模块级 quitRequested 逐字同语义）。
//
// 外链打开统一入口（openExternally，原 main.ts 模块级函数整体迁入）：URL 规范
// 化 + 10s 窗口 8 次预算 + 超限 30s 冷却（log-and-drop）。宿主打开叶 = 装配期
// 快照的 edges.openExternal（externalOpenLeaf——B11「URL 白名单判定/预算/冷却/
// 规范化留 core，edge 只执行 open」）；main.ts 窗口 glue（setWindowOpenHandler /
// will-navigate / will-redirect 的 handleUntrustedNavigation）与后续边沿共用本
// 入口。
// ---------------------------------------------------------------------------
const pendingIntents = new BoundedVscodeIntentQueue(64);
let drainingPendingIntents = false;
/** 消费循环装配槽：installIpcHandlers ② I 组段在 wiredCtx 宿主依赖束就绪后
 *  装配（enqueueDeepLink 触发 + drainDeepLinkLaunches 显式 drain）；null = 未
 *  装配（只入队不消费——装配前无窗口/无消费循环，与搬迁前同）。 */
let drainPendingIntents: (() => void) | null = null;

/** 深链入队（design 16 §4.2；原 main.ts enqueueDeepLink 整体迁入——OS 三入口
 *  glue 经本导出入口调用）：quit 在途 ignore（不启动 VS Code）；归一化目标
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

/** 启动尾部的深链 drain 入口（main.ts 原「drainPendingIntents()」调用点——startup
 *  完成、装配就绪后顺序消费冷启动到达的 intent；装配前调用为 no-op）。 */
export function drainDeepLinkLaunches(): void {
  drainPendingIntents?.();
}

// 外链打开速率限制（防脚本 spam 反复弹浏览器标签；用户手动点击远低于该
// 阈值）：10s 窗口内最多 8 次，超限进入 30s 冷却（log-and-drop）。常量与状态
// 自 main.ts 原样随迁（预算器只此一份——窗口 glue 与后续已迁批共用同一语义）。
const OPEN_EXTERNAL_BUDGET = 8;
const OPEN_EXTERNAL_WINDOW_MS = 10_000;
const OPEN_EXTERNAL_COOLDOWN_MS = 30_000;
const externalOpenTimes: number[] = [];
let externalOpenCooldownUntil = 0;
/** 宿主打开叶（装配期快照 deps.edges.openExternal——installIpcHandlers 内赋值；
 *  null = 未装配，openExternally 静默跳过——装配前无窗口 glue 调用点，与搬迁前
 *  「shell 恒可用」的差异仅存在于不可达路径）。 */
let externalOpenLeaf: ((url: string) => Promise<void>) | null = null;

/**
 * 打开外链的统一入口（原 main.ts openExternally 整体迁入——宿主叶改装配期快照
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

// ---------------------------------------------------------------------------
// Runtime check cycle slot (W-10 S10 runtime A batch).
//
// runRuntimeCheck（原 main.ts whenReady 局部 const）随 RUNTIME_CHECK 注册体迁
// 入 installIpcHandlers ② J 组段——main 装配侧的首检/周期计时器（15s 首检 +
// 6h 周期）经本导出入口调用与 IPC 注册体**同一**实现与门（quit/事务在飞/动作
// 不允许时 no-op 返回当前 state——apply/restore 挂起检查、下个周期恢复的共享
// 门不变）。装配槽 = 下方 installIpcHandlers ② J 组段赋值（单装配不变式：
// installIpcHandlers 先于任何计时器 tick——计时器在装配后创建并 15s/6h 才首
// 次触发，槽位必已就绪；未装配时导出入口静默 no-op，同 S2 导出入口先例）。
// ---------------------------------------------------------------------------
let runtimeCheckRunner: (() => void) | null = null;

/** 触发一次 idle-gated dsh runtime 检查（main 装配侧启动/周期计时器入口——
 *  RUNTIME_CHECK 注册体与周期路径共用同一实现，语义不分叉）。 */
export function runRuntimeCheckCycle(): void {
  const runner = runtimeCheckRunner;
  if (runner !== null) runner();
}

// ---------------------------------------------------------------------------
// Shell IPC registration (design 25 §4.1 seam; W-10 S1 info+settings +
// S2 notify/badge/ready + S3 registry/credentials + S4 ssh-connection-state
// batch).
//
// installIpcHandlers is the single shell-core IPC registration point: the
// Electron main only assembles it (main.ts — trustedIpc fence injected at the
// registrar wrapper, core stays electron-free by construction). Relocated
// groups, VERBATIM from main.ts with only the Electron leaves replaced by
// injected seams — behavior unchanged:
//   S1 group A — INFO / SETTINGS_GET / SETTINGS_SET registrations and their
//   settings helpers (chamberSettingsStatus / applySettingsPatch /
//   pushSettingsChanged): leaves via settingsIO / setKeepAwake / setLoginItem /
//   confirmRegistryOriginSwitch (ctx) + SETTINGS_CHANGED send via
//   edges.rendererPush. Registration order inside this function = the original
//   main.ts order; the surrounding steps of the wider W-10 plan are annotated
//   in place:
//   ① edges 回灌订阅段（S2 转实：onSystemResume / onMainWindowShown 的 core 回调
//     在此注册——held-resume 补发语义随迁 core，见上段状态机）；
//   ② A 组 3 个注册体（S1 批）+ B 组 6 个注册体（S2 批：NOTIFY /
//     NOTIFICATIONS_READY / NOTIFICATION_OPEN_ACK / BADGE_COUNT /
//     DEEP_LINK_READY / DEEP_LINK_ACK——按原 main.ts 顺序追加）+ C 组 7 个
//     注册体（S3 批：SSH_INSTANCES_GET / SSH_SAVE_CONNECTION /
//     SSH_DELETE_CONNECTION / SSH_INSTANCES_SET / SSH_SET_PASSWORD /
//     GATEWAY_SET_TOKEN / GATEWAY_SET_PASSWORD——按原 main.ts 顺序追加在 B 组
//     之后；全零 Electron：事务/canonicalize/凭据写入口为纯模块直接 import，
//     装配依赖经 ctx——transportManager/audit/gatewaySessions/
//     publishRegistryTransition，见 ShellAssemblyCtx 与「W-10 S3 registry
//     投影链」段注释）+ D 组 7 个注册体（S4 批：SSH_CONFIG_LIST / SSH_CONNECT /
//     SSH_DISCONNECT / SSH_STATUS / SSH_REVERIFY / SSH_LOGS / SSH_LOGS_CLEAR
//     ——按原 main.ts 顺序追加在 C 组之后；CONFIG_LIST 经纯模块 ssh-config.ts
//     import，其余 6 个经 ctx transportManager——Pick 扩 reverify/logs/
//     clearLogs，见 ShellAssemblyCtx）+ E 组 4 个注册体（S5 批：SSH_START_SERVICE /
//     SSH_STOP_SERVICE / SSH_IS_ACTIVE / SSH_RESTART_SERVICE——按原 main.ts 顺序
//     追加在 D 组之后；全走 ctx transportManager 的 exec 面——Pick 扩 exec，见
//     ShellAssemblyCtx；systemctl argv 固定参数数组/服务名白名单与 generation
//     复验纪律在 transport-manager/ssh-provider 纯模块内部，不随迁）+ F 组 6 个
//     注册体（S6 批：SSH_PLUGIN_LIST / SSH_PLUGIN_APPLY / SSH_PLUGIN_UNDO /
//     SSH_SEED_HOST_GRAPH / SSH_PLUGIN_MATERIALIZE_ADD /
//     SSH_PLUGIN_MATERIALIZE_ADD_PICK——按原 main.ts 顺序追加在 E 组之后；编排
//     纯模块 plugin-sync/ssh-apply-rows/plugin-tarball 直接 import，共享现实例/
//     闭包束经 ctx——sshPluginJournal/hostPackageSeeding/chamberHostPackageSeeds/
//     sshPluginTargets/localDshHome，Pick 扩 appendLog，见 ShellAssemblyCtx；
//     确认对话框与插件源 picker = edges.showMessage/pickPluginSource 宿主腿，
//     mainWindowAlive 预检 = edges 门）+ G 组 3 个注册体（S7 批：
//     GATEWAY_PLUGIN_SYNC / GATEWAY_PLUGIN_APPLY / GATEWAY_PLUGIN_MATERIALIZE
//     ——按原 main.ts 顺序追加在 F 组之后；编排纯模块 gateway-ipc-shared /
//     gateway-sync-registry / gateway-provider / plugin-tarball 直接 import，
//     手动 sync 上传执行闭包经 ctx.syncGatewayChamberPluginsFor（ready 自动
//     sync 与手动 re-entry 共用同一执行路径，语义不分叉）；确认对话框复用 S6
//     edges 版 confirmPluginAction 助手，pick 与窗口预检 = edges 宿主腿，见
//     ShellAssemblyCtx）+ H 组 5 个注册体（S8 批：LOCAL_PLUGIN_LIST /
//     NPM_SEARCH / LOCAL_PLUGIN_ADD_FILE / LOCAL_PLUGIN_ADD / LOCAL_PLUGIN_REMOVE
//     ——按原 main.ts 顺序追加在 G 组之后；编排纯模块 plugin-sync 直接 import
//     （npm 搜索 registry URL 白名单 = @dsh-chamber/dsh-runtime
//     isAllowedRegistryUrl），本地安装执行叶 runLocalPluginMutation 经 ctx（main
//     装配侧 runtime writer fence 编排），确认/无窗预检/pick 经 S6 edges 宿主腿，
//     见 ShellAssemblyCtx）+ J 组 6 个注册体（S10 批 runtime A：RUNTIME_STATE /
//     RUNTIME_RESTART / RUNTIME_CHECK / RUNTIME_INSTALL / RUNTIME_CLEANUP_VERSION /
//     RUNTIME_CLEAR_FAILURE——按原 main.ts 顺序追加在 I 组之后；控制器现实例/
//     fence/动作门/宿主叶经 ctx（runtimeController / runtimeOperationBusy /
//     runtimeWriterFence / runtimeActionAllowed / runtimeBaseDir /
//     refreshRuntimeEvidence / runStorePruneIfNeeded / restartLocalDsh——K 组
//     注册体与启动/证据路径共用同一实例，语义不分叉），dsh-runtime 纯逻辑直接
//     import，确认对话框 = J 组段 S6 版 confirmRuntimeMutation 助手 +
//     edges.showMessage，runRuntimeCheck 随迁并经导出入口 runRuntimeCheckCycle
//     供 main 侧计时器调用同一实现，见 ShellAssemblyCtx）+ K 组 6 个注册体
//     （S11 批 runtime B + W-10 收口：RUNTIME_RECOVER_METADATA / RUNTIME_RESET_BUILTIN /
//     RUNTIME_RETRY_APPLY / RUNTIME_APPLY_NOW / RUNTIME_RETRY_RESTORE /
//     RUNTIME_RESTORE_PRE_ROLLBACK——按原 main.ts 顺序追加在 J 组之后；启动事务
//     宿主与共享闭包族经 ctx 宿主叶（runRuntimeStartup / publishBlockedStartup /
//     setRuntimeGate / authoritativeMetadataRecoveryStatus / runUserMetadataRecovery /
//     readApplyNowGateInput / selectedJournalIntent / stopLocalDsh /
//     runtimeOperationSlot / bundledRuntimeVersion，见 ShellAssemblyCtx），
//     dsh-runtime 纯逻辑与 evaluateApplyNowGate 直接 import，确认对话框复用 J 组段
//     confirmRuntimeMutation——main 侧同名闭包随本批删除；W-10 60 handler 全迁完）；
//   ③ W-10 收口注记（60 handler 已全部经 installIpcHandlers 注册：main.ts 仅剩
//      装配/窗口 glue/生命周期/启动事务宿主——控制面 ready 后的启动/恢复 push 与
//      OS 三入口 glue 本就是装配侧宿主职责，见 main.ts 顶部职责清单；Swift
//      sidecar flavor 装配点与 HostEdges 余下边沿叶属 W-10 之外后续批，
//      见 macos-swift-v1.md §四批 2）。
// ---------------------------------------------------------------------------

/** IPC 注册面：core 经它注册处理器（channel 为 opaque 通道名；Electron 侧
 *  装配为 `(ch, h) => ipcMain.handle(ch, trustedIpc(h))`——trustedIpc 围栏在
 *  注入点包装，Swift sidecar flavor 注入同形 B 桥注册）。 */
export interface IpcRegistrar {
  handle(channel: string, handler: (payload: unknown) => Promise<unknown> | unknown): void
}

/** ssh 插件管理目标（F 组注册体的解析结果形状；W-10 S6）：spec = plugin-sync
 *  RemoteSpec（registry id + remoteDshHome），fingerprint = main 装配侧
 *  operationalFingerprint（id 稳定编辑推进），sourceToken = 来源代际 token
 *  （F 组 owns 复验与 C 组来源证明同一代际面）。main.ts 的私有 RemoteTarget
 *  与此结构同形——ctx 闭包按结构赋值兼容。 */
export interface SshPluginTarget {
  spec: RemoteSpec
  fingerprint: string
  sourceToken: NotificationSourceToken
}

/** 元数据恢复可恢复状态联合（W-10 S11 ctx 签名用）——与 main.ts whenReady 内
 *  同名局部类型逐字同构（结构等价，宿主叶赋值兼容；core 不持有额外形状）。 */
type RecoverableMetadataStatus = 'selection-corrupt' | 'recovery-in-progress' | 'recovery-marker-corrupt'

/** ShellAssemblyCtx — installIpcHandlers 装配上下文。最小集原则：只放已迁注册
 *  体与其随迁辅助实际引用的字段，后续批按需扩展（S1 → S2：增 isQuitting、移除
 *  reconcileBadgeCount——意图 holder 与裁决随 BADGE_COUNT 批迁入 core 后
 *  SETTINGS_SET 直接调 core 内 reconcile，见 installIpcHandlers ②）；S3
 *  （registry+凭据批）增 transportManager / audit / gatewaySessions /
 *  publishRegistryTransition 四字段（宿主生命周期权威仍留 main，见字段注释）；
 *  S4（ssh 连接状态批）无新字段——D 组注册体复用 transportManager（Pick 扩
 *  reverify/logs/clearLogs）与纯模块 import，见字段注释；S5（exec/systemd
 *  批）亦无新字段——E 组注册体复用 transportManager（Pick 扩 exec），见字段
 *  注释；S6（ssh plugin 批）增 localDshHome / sshPluginJournal /
 *  hostPackageSeeding / chamberHostPackageSeeds / sshPluginTargets 五字段
 *  （F 组注册体的共享现实例/闭包束）+ transportManager Pick 扩 appendLog
 *  （见字段注释）；S7（gateway 插件批）增 syncGatewayChamberPluginsFor 一字段
 *  （G 组手动 sync 的执行闭包——main 装配侧 ready 自动 sync 共用同一执行路径，
 *  见字段注释）；S8（本地插件批）增 runLocalPluginMutation 一字段（H 组本地插件
 *  注册体的宿主执行叶——main 装配侧 runtime writer fence/启动门编排，见字段注释）；
 *  S11（runtime B + 收口批）增 K 组 10 字段（runRuntimeStartup / publishBlockedStartup /
 *  setRuntimeGate / authoritativeMetadataRecoveryStatus / runUserMetadataRecovery /
 *  readApplyNowGateInput / selectedJournalIntent / stopLocalDsh / runtimeOperationSlot /
 *  bundledRuntimeVersion——启动事务宿主与共享闭包族留装配侧，见字段注释）。
 *  chamber
 *  settings 的内存 holder 仍归装配侧（main.ts 尚余 20+ 处直读点，随各自批迁入时
 *  holder 一并搬家）；core 侧一律经 settingsIO 读写，权威单一、行为与搬迁前一
 *  致。各副作用叶与其 HostEdges 成员（setKeepAwake / setLoginItem /
 *  setBadge…）同名同语义——宿主腿迁入 electron-edges 时 core 无需改。 */
export interface ShellAssemblyCtx {
  /** INFO 载荷与 settings 平台投影的宿主事实。 */
  hostFacts: {
    /** 壳 flavor（E2/W-22）：'electron'（Electron 壳装配）| 'swift'
     *  （Swift 原生壳 sidecar 装配）——INFO 载荷透传，renderer 侧据此分派
     *  更新/通知等宿主机制语义。 */
    flavor: 'electron' | 'swift'
    /** 控制面 URL（原 main.ts INFO 载荷的 `http://127.0.0.1:${cp.port}`）。 */
    controlPlaneUrl: string
    /** 运行平台（原 process.platform——BADGE_COUNT 平台门 badgePlatformGate
     *  第一参同源）。 */
    platform: NodeJS.Platform
    /** 托盘恢复面存在性（SETTINGS 投影 closeToTray 门）——invoke 时求值：
     *  托盘在装配后才创建（main.ts maybeCreateTray），不得装配期定格。 */
    trayPresent(): boolean
  }
  /** INFO.dshVersion 的 dsh 运行事实（可选：未提供时 INFO 返回 null）。 */
  runtimeFacts?: {
    /** 当前活动 dsh 运行时版本——invoke 时求值，保持现语义（原 INFO 每次
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
  /** quit 在途门（design 14 D2——原 main.ts 模块级 quitRequested）：通知/深链
   *  入队的 ignore 语义与通知投递循环的退出检查经它求值（装配侧注入
   *  `() => quitRequested`；S2 起随入队/队列迁入 core 的依赖）。 */
  isQuitting(): boolean
  /** keep-awake 副作用叶（装配侧注入现 setKeepAwakeActive——HostEdges
   *  setKeepAwake 的 main.ts 宿主腿；失败 throw，由 applySettingsPatch 的
   *  catch 做 best-effort 回滚，与搬迁前语义一致）。
   *  返回 `void | Promise<void>`（S-E 双 flavor Promise 兼容）：Electron
   *  宿主腿同步（成功 void / 失败 throw）；Swift flavor 宿主腿在 B 桥另一
   *  侧——叶 await 桥应答后 resolve / leg 失败 reject——两条失败路径同汇于
   *  applySettingsPatch 的 catch 回滚（同步 throw 与异步 reject = 同一路径；
   *  await 吸收同步返回值，Electron 装配闭包无需 async 化）。 */
  setKeepAwake(enabled: boolean): void | Promise<void>
  /** 登录自启副作用叶（装配侧注入现 applyLaunchAtLogin——HostEdges
   *  setLoginItem 的 main.ts 宿主腿；失败 {error} 返回，绝不 throw）。
   *  返回 `{ok:true}|{ok:false;error:string}` 或其 Promise（S-E 双 flavor
   *  同前：Electron 同步；Swift await B 桥应答后映射同形判别联合——leg
   *  错误原样进 {error}，applySettingsPatch 两 flavor 收到同一形状）。 */
  setLoginItem(
    enabled: boolean,
  ):
    | { ok: true }
    | { ok: false; error: string }
    | Promise<{ ok: true } | { ok: false; error: string }>
  /** registryOrigin 切换确认对话框叶（SETTINGS_SET 现 dialog.showMessageBox
   *  腿；文案与无窗判定留在实现侧）：
   *  'confirmed' 放行；
   *  'cancelled' = 用户取消（原返回 { error: 'cancelled', code: 'cancelled' }）；
   *  'unavailable' = 无存活主窗（原返回 { error: 'native confirmation unavailable' }）。 */
  confirmRegistryOriginSwitch(
    currentOrigin: string,
    nextOrigin: string,
  ): Promise<'confirmed' | 'cancelled' | 'unavailable'>
  // —— W-10 S3（registry+凭据批）新增字段：C 组 7 注册体的装配依赖。registry
  // 读写/投影句柄（transportManager）为现实例注入；audit / gatewaySessions /
  // publishRegistryTransition 为宿主叶或宿主生命周期对象（定义仍留 main
  // 装配侧——publishRegistryTransition 的插件 seed/journal 撤销与
  // SSH_INSTANCES_CHANGED push 文本归装配侧，随后续批再迁）。W-10 S4（ssh
  // 连接状态批）不新增字段：D 组 7 注册体复用 transportManager（Pick 扩
  // reverify/logs/clearLogs，见字段注释）+ 纯模块 ssh-config.ts import。
  // W-10 S5（exec/systemd 批）不新增字段：E 组 4 注册体复用 transportManager
  // （Pick 扩 exec，见字段注释）。W-10 S6（ssh plugin 批）新增字段：F 组
  // 6 注册体的装配依赖（编排纯模块直接 import）——localDshHome /
  // sshPluginJournal / hostPackageSeeding / chamberHostPackageSeeds /
  // sshPluginTargets（main 装配侧自动 seed/撤销路径与 F 组共用同一现实例/
  // 闭包族：journal 单写者、seed 单飞、目标指纹同一实现，语义不分叉），
  // transportManager Pick 扩 appendLog（seed 结果入实例环形日志）。
  /** registry 读写 + transport 状态/生命周期投影句柄（C/D/E/F 组注册体直接
   *  读写面；装配侧注入 transport-manager 现实例——纯模块按引用共享，语义与
   *  搬迁前 main.ts 的 sm 局部常量一致；Pick 收窄到已迁批实际调用的方法面
   *  （W-10 S4 扩 reverify/logs/clearLogs——D 组状态/日志/重验证通道；W-10 S5
   *  扩 exec——E 组 exec/systemd 执行通道；W-10 S6 扩 appendLog——F 组
   *  host-graph seed 结果投影入实例环形日志），体内以 sm 名解构以保持注册体
   *  文本逐字）。 */
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
  /** S24 非秘密审计叶（原 main.ts 的 audit = appendAuditEvent({ file:
   *  auditLogPath })——装配侧绑定 <userData> 路径注入；JSONL append 只记非
   *  秘密事实，凭据值绝不入日志）。 */
  audit(event: AuditEvent): void
  /** gateway 密码会话管理器（design 17 §7.1/§9.3——主进程内存持有；C 组注册体
   *  invalidation 的直接面）。装配侧传模块级 `gatewaySessions` 的**装配期取
   *  值**：该 let 仅在 will-quit 清理置 null（届时窗口已关、IPC 处理器不可
   *  达），处理器可达期恒非空——null 分支判据与搬迁前逐字一致（有界收敛注记：
   *  同一 will-quit 竞态下原直读闭包可见 null 而装配捕获不可见的路径不可达）。 */
  gatewaySessions: GatewaySessionManager | null
  /** registry 变更生命周期权威 sidecar（main-branch source-lifecycle
   *  authority：来源证明/代际同步 + 插件 seed/journal 撤销 + 活跃通知退役驱逐
   *  + SSH_INSTANCES_CHANGED committed push 编排）——S3 留 main 装配侧经本叶
   *  注入（其宿主对象 readySeedEdges/hostPackageSeeding/sshPluginJournal/
   *  setGatewaySyncRegistration/startAutomaticHostSeed 归装配侧，push 文本被
   *  renderer-trust 锚定），C 组 save/delete 注册体经它发布 committed 结果。 */
  publishRegistryTransition(
    before: readonly TransportInstanceSpec[],
    after: readonly TransportInstanceSpec[],
  ): ProjectedRegistryInstance[]
  // —— W-10 S6（ssh plugin 批）新增字段：F 组 6 注册体的装配依赖。编排纯模块
  // （plugin-sync / ssh-apply-rows / plugin-tarball）在 core 直接 import；下列
  // 共享现实例与闭包为 main 装配侧所有物（自动 seed/ready 撤销路径与 F 组
  // 注册体共用——journal 单写者、seed 单飞、目标指纹同一实现，语义不分叉）。
  /** 权威本地 dsh home 路径（<userData>/state/dsh-home——装配期解析值注入，
   *  core 不碰 Electron paths；localPluginList / resolveLocalMaterializeDirectory
   *  读它，与 main 侧自动路径同一值）。 */
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
   *  seed 与 ready 边缘仍用同一族闭包；经 ctx 注入后 F 组注册体文本以原名
   *  逐字保留 findRemoteTarget / ownsRemoteTarget / scoped* 等）。目标结构
   *  = SshPluginTarget（spec + operational fingerprint + 来源代际 token）。 */
  sshPluginTargets: {
    findRemoteTarget(id: string): SshPluginTarget | null
    ownsRemoteTarget(target: SshPluginTarget): boolean
    scopedExecForTarget(target: SshPluginTarget, extraOwner?: () => boolean): ExecFn
    scopedStatusForTarget(target: SshPluginTarget): StatusFn
    scopedProbeForTarget(target: SshPluginTarget, probe: () => Promise<boolean | null>): () => Promise<boolean | null>
    liveProbeFor(id: string): () => Promise<boolean | null>
    gitWorktreeLiveProbeFor(id: string): () => Promise<boolean | null>
  }
  // —— W-10 S7（gateway 插件批）新增字段：G 组 3 注册体的装配依赖。编排纯模块
  // （gateway-ipc-shared / gateway-sync-registry / gateway-provider /
  // plugin-tarball——classifyPluginPick/buildPluginTarball 为 S6 已 import）在
  // core 直接 import；注册参数读取（getGatewaySyncRegistration）与 ready 位复验
  // 在注册体侧。确认对话框复用上方 S6 edges 版 confirmPluginAction 助手（main
  // 装配侧原 confirmPluginAction 闭包已随 W-10 S8 H 组删除——LOCAL_PLUGIN_ADD/
  // REMOVE 迁出后无使用点）、
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
  // —— W-10 S8（本地插件批）新增字段：H 组 3 个本地插件注册体（LOCAL_PLUGIN_ADD /
  // LOCAL_PLUGIN_ADD_FILE / LOCAL_PLUGIN_REMOVE）的本地执行叶。编排纯模块
  // （plugin-sync：runLocalDshPlugin 等）在 core 直接 import；本叶只承载宿主
  // 编排——本体定义留 main 装配侧（runtime writer fence（RuntimeOperationFence）
  // 租约 + runtimeStartBlocked/runtimeStartBlockedReason 启动门 +
  // resolveActiveRuntime(runtimeBaseDir, builtinDshWorkspace) workspace 解析均归
  // 装配侧：fence/启动门是装配侧运行时事务状态，不是 core 状态；workspace 只在
  // fence 租约内解析，绝不跨运行时 swap 保留）。经 ctx 注入后注册体文本以原名
  // 逐字保留 runLocalPluginMutation 调用（owner + mutate(dshWorkspace) 形状与
  // 搬迁前一致）；mutate 内实际子进程执行 = plugin-sync runLocalDshPlugin（add
  // 子进程 env 装配/白名单在纯模块内，W-14 关联 C-F12 纪律注释随原模块）。
  runLocalPluginMutation<T>(
    owner: string,
    mutate: (dshWorkspace: string) => Promise<T>,
  ): Promise<T | { ok: false; error: string }>
  // —— W-10 S9（open-in + update 批）新增字段：I 组 7 注册体的装配依赖。open-in
  // 面无新字段——wiredCtx/openInCtx 的宿主能力全部来自既有面（hostFacts.platform
  // / settingsIO.current()（vscodeOpenInNewWindow 惰性读）/ transportManager
  // （sm——lookupInstance 与来源捕获的实查）/ edges 打开叶）与纯模块 import
  // （open-in.ts / deep-link.ts，见 I 组段注释）；update 面新增本字段——updater
  // 现实例（main 装配侧构造的 createUpdateController 包装：electron-updater 与
  // autoInstallOnAppQuit 生命周期、设计 11 的静默检查/下载/quitAndInstall 编排
  // 与设计 14 D2 的退出豁免状态读取（main 模块级 updateController ref）均归装配
  // 侧）。I 组 UPDATE_* 注册体与状态 push 订阅共用同一实例；装配侧在
  // installIpcHandlers 之后调 updater.start()（保持「先订阅后 start」原序）。 */
  updateController: UpdateController
  // —— W-10 S10（runtime A 批）新增字段：J 组 6 个 runtime 注册体（RUNTIME_STATE /
  // RUNTIME_RESTART / RUNTIME_CHECK / RUNTIME_INSTALL / RUNTIME_CLEANUP_VERSION /
  // RUNTIME_CLEAR_FAILURE）的装配依赖。控制器现实例、fence 现实例、动作门与
  // 宿主叶全部由 main 装配侧定义并经 ctx 注入——main 侧 K 组注册体（RUNTIME_
  // RECOVER_METADATA / RESET_BUILTIN / RETRY_APPLY / APPLY_NOW / RETRY_RESTORE /
  // RESTORE_PRE_ROLLBACK，W-10 S11 批迁入——新增字段见本接口尾部）与启动/证据
  // 路径共用同一实例/闭包：状态权威单一、单飞/串行化语义不分叉。注册体文本经
  // 上方解构以原名逐字保留（除 `runtimeOperation !== null` →
  // `runtimeOperationBusy()` 与 `chamberSettings.registryOrigin` →
  // `settingsIO.current().registryOrigin` 两处机械替换——见 J 组段注释）。
  /** DshRuntimeController 现实例（main 装配侧 whenReady 构造——类型 import 自
   *  dsh-runtime-controller.ts（electron-free 纯编排模块），core 只做类型面；
   *  K 组注册体与启动/证据路径共用同一实例，状态权威单一）。 */
  runtimeController: DshRuntimeController
  /** runtime 事务槽在飞读门（原 main.ts 模块级 `runtimeOperation !== null`——
   *  槽位本体与单写者仍归 main：启动事务/自动回滚直接读写，K 组在飞事务的
   *  登记/清槽/在飞值经 runtimeOperationSlot 叶（S11，见本接口尾部），core
   *  只经本叶做 busy 布尔读）。
   *  J/K 组注册体文本中 `runtimeOperation !== null` 逐处机械替换为
   *  runtimeOperationBusy()。 */
  runtimeOperationBusy(): boolean
  /** runtime writer fence 现实例（原 whenReady runtimeWriterFence——启动事务
   *  （runtime:startup / runtime:restart-exhausted 等 acquire）与 K 组路径共用；
   *  busy 读与 tryAcquire 与原调用点同一实例，跨 core/main 的 writer 串行化
   *  语义不分叉；owner 名与搬迁前注册体逐字一致）。 */
  runtimeWriterFence: Pick<RuntimeOperationFence, 'busy' | 'tryAcquire'>
  /** runtime 动作终态门（原 main.ts whenReady runtimeActionAllowed 闭包——K 组
   *  注册体同用；单一实现经 ctx 注入 core，行为不分叉）。action 参数 = 共享核
   *  RuntimeAction 联合（allowedActions 的可见动作集）。 */
  runtimeActionAllowed(action: RuntimeAction): boolean
  /** 权威 runtime base dir（装配期解析 <userData> 路径注入——core 不碰 Electron
   *  paths；@dsh-chamber/dsh-runtime 纯 store 函数（listExplicitlyInstalledVersions /
   *  cleanupExplicitRuntimeVersion / listRuntimeFailures / clearRuntimeFailure）
   *  经它与 main 侧同一 baseDir 调用，行为与搬迁前一致）。 */
  runtimeBaseDir: string
  /** 磁盘/快照/失败证据刷新叶（原 whenReady refreshRuntimeEvidence 闭包——
   *  coalescer、lastDiskEvidence 与 projectMetadataHealth 宿主状态归装配侧；
   *  K 组注册体与启动路径同用同一实现）。 */
  refreshRuntimeEvidence(patch?: RuntimeLifecycleProjection): Promise<void>
  /** pnpm store prune 叶（原 whenReady runStorePruneIfNeeded——storePruneOperation
   *  单飞宿主状态归装配侧；清理路径与启动尾部共用同一实现）。 */
  runStorePruneIfNeeded(): Promise<void>
  /** 事务性 dsh 重启宿主叶（PlaneHandle 在 main——原 RUNTIME_RESTART 注册体的
   *  `controlPlane === null` 门 + controlPlane.restartLocal() + resolve 后实时
   *  connectionState 读封装在装配侧叶内）：controlPlane 未初始化 → throw
   *  'control plane not initialized'（与原注册体同文案）；resolve ≠ success——
   *  restartLocal() 从 restart-exhausted/error 等终态 resolve 时由 core 注册体
   *  按返回的 connectionState 白名单诚实拒绝。 */
  restartLocalDsh(): Promise<string>
  // —— W-10 S11（runtime B + 收口批）新增字段：K 组 6 个 runtime 注册体
  // （RUNTIME_RECOVER_METADATA / RUNTIME_RESET_BUILTIN / RUNTIME_RETRY_APPLY /
  // RUNTIME_APPLY_NOW / RUNTIME_RETRY_RESTORE / RUNTIME_RESTORE_PRE_ROLLBACK）的
  // 装配依赖。按施工图「运行时启动事务宿主经 ctx 宿主叶」：启动事务本体与其
  // 共享闭包族全部由 main 装配侧定义并经 ctx 注入——K 组注册体与启动/证据路径
  // 共用同一实现、同一运行时事务槽（模块级 runtimeOperation）与同一 gate/fence，
  // 语义不分叉（executeMetadataRecovery 等恢复事务腿、runtimeOperationAbort /
  // runtimeStartBlocked / runtimeInternalStart / runtimeTransactionWorkspace 等
  // 装配侧事务状态绝不进 core）。dsh-runtime 纯逻辑（queueActivationIntent /
  // writeActivationIntent / restoreMarkerAuthorityStatus / readActivationJournalState /
  // writeOverride / listPreRollbackStashes / restorePreRollback）与 apply-now-gate.ts
  // 的 evaluateApplyNowGate 为纯模块直接 import（见文件头 S11 段）。注册体文本的
  // 机械替换（`runtimeOperation !== null` → runtimeOperationBusy()、`quitRequested`
  // → quittingLeaf()、`cp.stopLocal()` → stopLocalDsh()、槽登记/清槽/在飞值 →
  // runtimeOperationSlot.*）逐处注记于 K 组段注释。
  /** 运行时启动事务宿主叶（原 whenReady runRuntimeStartup——装配侧事务本体；
   *  K 组注册体与启动尾部（装配侧 refreshRuntimeEvidence().then(runRuntimeStartup)）
   *  共用同一实现：内部 gate/fence/事务槽/abort 管理归装配侧，core 经本叶调用，
   *  行为与搬迁前逐字一致（槽忙 → 返回在飞事务同原守卫）。 */
  runRuntimeStartup(): Promise<StartupResult | null>
  /** 启动阻塞发布叶（原 whenReady publishBlockedStartup——setRuntimeGate(true) +
   *  refreshRuntimeEvidence 的组合宿主叶；reason 经 sanitizeErrorText 归一，patch
   *  追加到 failed 投影之上；K 组注册体与启动路径共用同一实现）。 */
  publishBlockedStartup(reason: string, patch?: RuntimeLifecycleProjection): Promise<void>
  /** 宿主启动门写叶（原 whenReady setRuntimeGate——模块级 runtimeStartBlocked /
   *  runtimeStartBlockedReason 槽与 cp.refreshLocalExposure 宿主刷新归装配侧；
   *  K 组 RESET_BUILTIN 等注册体与启动事务共用同一门）。 */
  setRuntimeGate(blocked: boolean, reason?: string | null): void
  /** 元数据恢复资格投影叶（原 whenReady authoritativeMetadataRecoveryStatus——
   *  quit/写进程安全/本地 writers quiescent/bundled 版本等宿主事实归装配侧；K 组
   *  RECOVER_METADATA 注册体与 runUserMetadataRecovery 共用同一实现，语义不分叉）。
   *  'incomplete' 为永久恢复终态（journaled 快照缺失/不可信），'half' 为瞬时可重试
   *  ——门语义随原闭包逐字保留。 */
  authoritativeMetadataRecoveryStatus(): RecoverableMetadataStatus | null
  /** 用户触发元数据恢复事务宿主叶（原 whenReady runUserMetadataRecovery——恢复事务
   *  在飞登记（事务槽/abort/workspace 写）与 executeMetadataRecovery 腿在装配侧；
   *  K 组 RECOVER_METADATA 注册体经本叶启动同一事务，行为与搬迁前一致）。
   *  返回 null = 资格不符/已在飞（注册体原样返回当前 state）。 */
  runUserMetadataRecovery(
    expectedStatus: RecoverableMetadataStatus,
  ): Promise<StartupResult | null> | null
  /** APPLY_NOW 门输入构造叶（原 whenReady readApplyNowGateInput——controlPlane
   *  connectionState / envOverrideActive / 事务槽等装配侧宿主读在叶内；
   *  evaluateApplyNowGate 纯门在 core 直接 import，同一输入形状（pending ??
   *  journalTarget ?? overridePending 三源解析与目标树 preflight 逐字保留）。 */
  readApplyNowGateInput(): ApplyNowGateInput
  /** activation journal intent 选择（原 whenReady selectedJournalIntent——main 启动
   *  路径 readActivationFacts 与 K 组 RETRY_APPLY 注册体共用同一实现；core 侧只消费
   *  targetVersion 投影，完整记录仍在装配侧闭包内使用）。 */
  selectedJournalIntent(state: ActivationJournalState): { targetVersion: string | null } | null
  /** 本机 dsh 宿主停止叶（PlaneHandle 在 main——原 `cp.stopLocal()`；K 组
   *  RESTORE_PRE_ROLLBACK 事务的 stop 腿经本叶，与 runRuntimeStartup 内部的
   *  同源 stop 语义一致；异常按原调用点的 .catch 折算）。 */
  stopLocalDsh(): Promise<void>
  /** runtime 事务槽（原 main.ts 模块级 runtimeOperation——槽本体与单写者仍归装配
   *  侧：启动事务/自动回滚/quit 路径直接读写同一槽）；core 的 busy 读经
   *  runtimeOperationBusy()（S10），K 组注册体的在飞值读与登记/清槽经本对象：
   *  - begin：登记一个在飞事务（原 `runtimeOperation = operation`——RESET_BUILTIN
   *    的 queue-behind-applying 与 RESTORE_PRE_ROLLBACK 事务登记）；
   *  - end：清槽（原 finally `runtimeOperation = null`）；
   *  - inFlight：在飞事务 promise 值读（原 `const inFlight = runtimeOperation`——
   *    RESET_BUILTIN 需 await 在飞 applying 事务本体后再启动）。 */
  runtimeOperationSlot: {
    begin(operation: Promise<StartupResult | null>): void
    end(): void
    inFlight(): Promise<StartupResult | null> | null
  }
  /** 内建 dsh 版本（whenReady 装配期解析值快照——原 main.ts bundledVersion 常量；
   *  K 组 RESET_BUILTIN 注册体与启动路径同一事实；core 不自行解析内置 workspace）。 */
  bundledRuntimeVersion: string | null
}

/** 装配 shell IPC 面（W-10 S1 A 组 + S2 B 组 + S3 C 组 + S4 D 组 + S5 E 组 +
 *  S6 F 组 + S7 G 组 + S8 H 组 + S9 I 组 + S10 J 组注册体与随迁辅助；各组注册顺序 = 原
 *  main.ts 顺序）。edges
 *  参数以 Pick 收窄到本批实际调用的成员（createElectronEdges 返回同形超集）；
 *  后续批实现新成员时同步扩宽两侧。
 *  调用点纪律：whenReady 内、createMainWindow 之前（窗口加载前注册完毕）——
 *  本函数同时完成渲染器投递状态机的 edges/quit 快照（单装配不变式，见上段）。 */
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
  // —— W-10 S9：外链打开宿主叶快照（openExternally 预算器经本快照调用——B11
  // 「规范化/预算/冷却留 core，edge 只执行 open」；装配先于任何窗口 glue，快照
  // 后导出入口 openExternally 可用，同 deliveryEdges 单装配不变式）。——
  externalOpenLeaf = deps.edges.openExternal;
  const {
    hostFacts,
    settingsIO,
    setKeepAwake,
    setLoginItem,
    confirmRegistryOriginSwitch,
    // W-10 S3（registry+凭据批）：transportManager → sm（与搬迁前 main.ts 的
    // sm 局部常量同名，C 组注册体文本逐字保留）；W-10 S4 的 D 组（ssh 连接
    // 状态 7 注册体）、W-10 S5 的 E 组（exec/systemd 4 注册体）与 W-10 S6 的
    // F 组（ssh plugin 6 注册体）同用该句柄（Pick 扩 reverify/logs/clearLogs /
    // exec / appendLog）。audit / gatewaySessions / publishRegistryTransition
    // 为装配侧宿主叶（定义在 main，经 ctx 注入）。W-10 S6 另增 F 组字段：
    // localDshHome / sshPluginJournal / hostPackageSeeding /
    // chamberHostPackageSeeds 与 sshPluginTargets 目标闭包束（main 装配侧
    // 现实例/闭包——自动 seed/撤销路径共用，语义不分叉；解构后 F 组注册体
    // 文本以原名逐字保留）。W-10 S7 另增 G 组字段：syncGatewayChamberPluginsFor
    // （main 装配侧的 ready 自动 sync 上传执行闭包——手动 gateway_plugin_sync
    // 注册体经 ctx 调用，同一执行路径、语义不分叉）。
    transportManager: sm,
    audit,
    gatewaySessions,
    publishRegistryTransition,
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
      gitWorktreeLiveProbeFor,
    },
    syncGatewayChamberPluginsFor,
    // W-10 S8 另增 H 组字段：runLocalPluginMutation（main 装配侧执行叶——runtime
    // writer fence 租约/启动门/workspace 解析归装配侧；H 组本地插件注册体经 ctx
    // 调用同一执行路径，文本以原名逐字保留，语义不分叉）。
    runLocalPluginMutation,
    // W-10 S9 另增 I 组字段：updateController → updater（与 ctx 字段名的映射同
    // transportManager → sm 先例——update 注册体与状态 push 订阅文本以原名
    // 逐字保留 updater.xxx 调用；实例本体在 main 装配侧构造，start() 由装配侧在
    // installIpcHandlers 之后调用（保持「先订阅后 start」原序））。
    updateController: updater,
    // W-10 S10 另增 J 组字段：runtimeController → runtimeInstance（同 updater
    // 映射先例——J 组注册体文本以原名逐字保留；控制器现实例在 main 装配侧构造，
    // K 组注册体与启动/证据路径共用）、runtimeOperationBusy（模块级 runtimeOperation
    // 事务槽在飞读门——`runtimeOperation !== null` 逐处机械替换）、
    // runtimeWriterFence（同一 fence 现实例——owner 名与原注册体逐字一致）、
    // runtimeActionAllowed（K 组同用同一门实现）、runtimeBaseDir（装配期解析值）、
    // refreshRuntimeEvidence / runStorePruneIfNeeded（宿主叶——K 组与启动路径同用
    // 同一实现）与 restartLocalDsh（PlaneHandle 宿主腿）。
    runtimeController: runtimeInstance,
    runtimeOperationBusy,
    runtimeWriterFence,
    runtimeActionAllowed,
    runtimeBaseDir,
    refreshRuntimeEvidence,
    runStorePruneIfNeeded,
    restartLocalDsh,
    // W-10 S11 另增 K 组字段（runtime B 批）：运行时启动事务宿主叶与共享闭包族
    // ——runRuntimeStartup（启动事务本体）/ publishBlockedStartup / setRuntimeGate
    // （宿主启动门与阻塞发布）/ authoritativeMetadataRecoveryStatus /
    // runUserMetadataRecovery（元数据恢复资格投影与事务宿主）/ readApplyNowGateInput
    // （APPLY_NOW 门输入构造——controlPlane/env 宿主读在装配侧）/ selectedJournalIntent
    // （启动路径 readActivationFacts 共用同一实现）/ stopLocalDsh（cp.stopLocal 叶）/
    // runtimeOperationSlot（事务槽 begin/end/inFlight——槽本体仍为模块级
    // runtimeOperation，单写者归装配侧）/ bundledRuntimeVersion（装配期值，解构改名
    // bundledVersion——K 组注册体文本以原名逐字保留）。evaluateApplyNowGate 与
    // dsh-runtime 纯逻辑直接 import（见文件头 S11 段）。K 组注册体与启动/证据路径
    // 共用同一实现/同一槽，语义不分叉（registering bodies 逐字随迁的机械替换
    // `runtimeOperation !== null` → runtimeOperationBusy()、`quitRequested` →
    // quittingLeaf()、`cp.stopLocal()` → stopLocalDsh()、槽登记/清槽/在飞值 →
    // runtimeOperationSlot.* 见 K 组段注释）。
    runRuntimeStartup,
    publishBlockedStartup,
    setRuntimeGate,
    authoritativeMetadataRecoveryStatus,
    runUserMetadataRecovery,
    readApplyNowGateInput,
    selectedJournalIntent,
    stopLocalDsh,
    runtimeOperationSlot,
    bundledRuntimeVersion: bundledVersion,
  } = deps.ctx

  // ① edges 回灌订阅段（S2 转实）：OS 唤醒与主窗口 'show' 的事件源语义自 main.ts
  //    逐字迁入，订阅点统一走本函数单点——held lastResume 补发在 core（上段状态
  //    机）。notifyClicked（Swift B flavor 对应面）留后续批。
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
   *  竞态），折算为 push 失败并 loud——与搬迁前「throw → {sent:false}」语义
   *  等价（S0 四个 committed 状态 push 同款形状）；无窗口常驻期间由下次查询
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
   *  成功尾部发生，回滚时 current() 恒为旧值，与搬迁前 holder 语义一致。
   *  async（S-E 双 flavor）：叶返回 Promise 兼容（见 ShellAssemblyCtx 两叶
   *  注释——Electron 同步返回被 await 吸收、语义零变；Swift await B 桥应答，
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
        // 回滚失败也 loud 已记日志，不再叠加异常。
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
   *  SETTINGS_SET 的 badgeEnabled 翻转收敛点；S2 起 holder/裁决随 BADGE_COUNT
   *  迁入本函数，S1 的 ctx.reconcileBadgeCount 注入叶移除）。 */
  function reconcileBadgeCount(): void {
    if (pendingBadgeCount === null) return;
    const count = adjudicateBadgeCount(
      { badgeEnabled: settingsIO.current().notifications.badgeEnabled },
      pendingBadgeCount,
    );
    applyBadgePresentation(count);
  }

  /** 桌面原生通知主链路（design 19 §3.3；W-10 S2 迁入——宿主腿全在
   *  electron-edges：构造/登记/淘汰/click 腿/honest-show 结算 = showNativeNotification、
   *  能力探测 = notificationSupported、焦点事实 = isFocused）：payload 白名单 →
   *  平台支持 → 设置裁决 → 有界 claim / 全局速率 → 显示。返回是否收到原生
   *  `show` 事件（异步 failed/close/timeout 均为 false）。'test' 绕过 claim 与
   *  设置门禁，但仍受全局宿主预算约束；通知失败降级且 loud，不误报成功，会话业
   *  务/侧边栏蓝点不受影响。 */
  async function maybeShowNativeNotification(payload: unknown): Promise<boolean> {
    const validated = validateNotificationRequest(payload);
    if (!validated.ok) {
      console.warn(`[dsh-chamber] 拒绝非法通知 payload：${validated.error}`);
      return false;
    }
    const request = validated.request;
    // 设置权威在装配侧内存 holder（settingsIO.current——settings-set 即时更新）；
    // 旧文件缺字段时用 DEFAULT 兜底（normalizeSettings 已归一，此处仅防御）。
    const settings: NotificationSettingsLike = {
      ...DEFAULT_CHAMBER_SETTINGS.notifications,
      ...(settingsIO.current().notifications ?? {}),
    };
    // 搬迁差异注记：原 readNotificationHostBoolean 区分「探测异常（拒发）」与
    // 「未聚焦」；接缝下 isFocused 由实现侧保证异常安全恒 boolean（单窗守卫内
    // isVisible/isFocused 探测不可达异常），两态同值——有意收敛，注释于
    // electron-edges isFocused。
    const anyWindowFocused = deps.edges.isFocused();
    const decision = decideNotification({
      request,
      settings,
      anyWindowFocused,
    });
    if (decision.action === 'skip') return false;
    if (!notificationSourceIncarnations.matches(request.sourceId, request.sourceFingerprint)) {
      console.warn(`[dsh-chamber] 通知来源 fingerprint 已过期：${request.sourceId}`);
      return false;
    }
    const sourceToken = request.kind === 'test' ? null : notificationSourceIncarnations.capture(request.sourceId);
    if (request.kind !== 'test' && sourceToken === null) {
      console.warn(`[dsh-chamber] 通知来源已不在当前 registry：${request.sourceId}`);
      return false;
    }
    // A disabled/kind/focus decision is terminal before consulting the host.
    // Unsupported-platform logging should describe an actual show attempt, not
    // every deliberately suppressed renderer edge（notificationSupported 探测失败
    // 与不支持同值——实现侧异常安全；与搬迁前区分「探测失败」消息的有意收敛）。
    if (!deps.edges.notificationSupported()) {
      console.warn('[dsh-chamber] 通知裁决跳过：平台不支持原生通知');
      return false;
    }
    // 去重 claim（5s TTL）：防同一事件双路径/重放双发；'test' 不走 claim。
    // 顺序在裁决之后：被设置/焦点跳过的请求不消费去重槽（design 19 §3.3）。
    const claim = claimNotificationDetailed(request);
    if (!claim.accepted) {
      if (claim.reason === 'saturated') {
        console.warn('[dsh-chamber] 通知去重窗口已达硬上限，拒绝新通知');
      }
      return false;
    }
    if (!nativeNotificationRateLimiter.tryAcquire()) {
      releaseNotificationClaim(claim.token);
      console.warn('[dsh-chamber] 原生通知发送速率达到硬上限，拒绝新通知');
      return false;
    }
    // 宿主腿（构造 + 有界登记/淘汰 + click 腿 + honest-show 结算全在实现侧，
    // B4——见 HostEdges.showNativeNotification 注释）：实现侧不 throw，shown 结
    // 算后 core 释放 claim 并如实返回 IPC 结果。
    const clickRoute = sourceToken === null
      ? null
      : {
        token: sourceToken,
        // click 回灌（宿主先 activate/restore/focus 成功才回调本闭包）：代际复
        // 查（旧来源代际的 click 不回灌同 id 替换后的新 shell）后入队打开意图。
        onActivated: () => {
          if (!notificationSourceIncarnations.owns(sourceToken)) {
            console.warn(`[dsh-chamber] 忽略旧来源代际的通知点击：${request.sourceId}`);
            return;
          }
          enqueueNotificationOpen(sourceToken, request.sessionId);
        },
      };
    const handle = deps.edges.showNativeNotification(
      { title: request.title, body: request.body },
      clickRoute,
    );
    const outcome = await handle.shown;
    if (!outcome.shown) {
      releaseNotificationClaim(claim.token);
      console.warn(`[dsh-chamber] 原生通知显示失败：${outcome.error}`);
      return false;
    }
    return true;
  }

  // ② A 组 3 个注册体（S1 迁自 main.ts；trustedIpc 围栏由装配侧在 ipc 注入点
  //    包装，本文件零 electron）+ B 组 6 个注册体（S2 批，按原 main.ts 顺序追加）。
  // 桌面身份/版本信息（dsh-chamber:info）：控制面 URL + 平台为宿主事实，
  // shell 版本为模块自读（与 main.ts 同源 package.json），dshVersion 即时
  // 解析（ctx.runtimeFacts）。
  deps.ipc.handle(IPC_CHANNELS.INFO, () => ({
    controlPlaneUrl: hostFacts.controlPlaneUrl,
    dshVersion: deps.ctx.runtimeFacts?.dshVersion() ?? null,
    version,
    platform: hostFacts.platform,
    flavor: hostFacts.flavor,
  }));

  // Chamber settings 查询：非秘密投影（当前值 + 平台能力门控）。
  deps.ipc.handle(IPC_CHANNELS.SETTINGS_GET, () => chamberSettingsStatus());

  // Chamber settings 应用并持久化 + 变更推送。失败 loud {error}，绝不静默假成功。
  deps.ipc.handle(IPC_CHANNELS.SETTINGS_SET, async (payload: unknown) => {
    const { patch } = payload as { patch?: unknown };
    const validated = validatePatch(patch);
    if (!validated.ok) return { error: validated.error };
    // Switching the dsh runtime version source moves the trust boundary of
    // version checks/downloads/installs — require native user confirmation
    // (design 18) before applying the patch.
    const currentSettings = settingsIO.current();
    const nextOrigin = validated.patch.registryOrigin;
    if (nextOrigin !== undefined && nextOrigin !== currentSettings.registryOrigin) {
      const verdict = await confirmRegistryOriginSwitch(currentSettings.registryOrigin, nextOrigin);
      if (verdict === 'unavailable') return { error: 'native confirmation unavailable' };
      if (verdict !== 'confirmed') return { error: 'cancelled', code: 'cancelled' };
    }
    // applySettingsPatch 现为 async（S-E：叶 Promise 兼容——Electron 同步叶被
    // await 吸收零变；Swift 叶 await B 桥应答）。失败 loud {error} 返回。
    const applied = await applySettingsPatch(validated.patch);
    if (!applied.ok) return applied;
    // badgeEnabled 翻转的即时收敛：仅在本次 patch 实际携带该键时重新裁决
    // 最近一次 renderer 计数意图（关闭 → 立即清零；开启 → 恢复当前未读数），
    // 绝不等到下一次推送；无关设置变更不重发 setBadgeCount。
    if (validated.patch.notifications?.badgeEnabled !== undefined) {
      reconcileBadgeCount();
    }
    pushSettingsChanged();
    return chamberSettingsStatus();
  });

  // —— B 组（S2 批；W-10 S2 施工图第 1 项）——
  // 桌面通知（design 19 §3.3）：渲染端检测会话边沿并组装 payload → notify
  // （invoke，返回是否实际显示）→ 主进程白名单/去重/裁决 + 原生通知。
  // 载荷形状 = 原 main.ts 的 trustedIpc(({ payload }) => …)——invoke 实参对象
  // 解构在处理器内完成（registrar 处理器只收单参 unknown）。
  deps.ipc.handle(IPC_CHANNELS.NOTIFY, (payload: unknown) =>
    maybeShowNativeNotification((payload as { payload?: unknown }).payload));
  // Renderer 通知就绪信号（design 19 §3.3）：onOpen 监听注册后调用——通知点击
  // 的推送只在就绪后放行（did-finish-load 早于监听注册，见 drain 条件）。
  // 返回 true 与 preload 的 Promise<boolean> 声明一致（成功置位信号）。
  deps.ipc.handle(IPC_CHANNELS.NOTIFICATIONS_READY, () => {
    notificationOpenDrainReady = true;
    const drainAccepted = drainPendingNotificationOpens();
    // A send race revokes ready inside the drain. Returning false makes the
    // renderer's bounded readiness retry establish the next handshake.
    return drainAccepted && notificationOpenDrainReady;
  });
  deps.ipc.handle(IPC_CHANNELS.NOTIFICATION_OPEN_ACK, (payload: unknown) => {
    if (payload === null || typeof payload !== 'object') return false;
    const { deliveryId, attempt } = payload as { deliveryId?: unknown; attempt?: unknown };
    return pendingNotificationOpens.acknowledge(deliveryId as number, attempt as number);
  });
  // 未读徽标计数（design 19 §3.7）：renderer 推真实计数（0 = 清除）→ 白名单
  // 校验 → 记录意图 → 设置裁决（badgeEnabled）→ 平台门 + edges.setBadge。
  // 返回是否实际应用；渲染端静默容忍 false（主进程已 loud 记平台/失败原因）。
  deps.ipc.handle(IPC_CHANNELS.BADGE_COUNT, (payload: unknown) => {
    const validated = validateBadgeRequest(payload);
    if (!validated.ok) {
      console.error(`[dsh-chamber] 徽标计数请求校验失败：${validated.error}`);
      return false;
    }
    pendingBadgeCount = validated.count;
    const count = adjudicateBadgeCount(
      { badgeEnabled: settingsIO.current().notifications.badgeEnabled },
      validated.count,
    );
    return applyBadgePresentation(count);
  });
  // Deep-link renderer readiness (design 16 hold/replay): App invokes this
  // only after installing deepLink.onIntent. Successful cold-start launches
  // held before that point are replayed now; navigation/crash resets the bit.
  deps.ipc.handle(IPC_CHANNELS.DEEP_LINK_READY, () => {
    deepLinkRendererReady = true;
    const drainAccepted = drainPendingRendererDeepLinkIntents();
    return drainAccepted && deepLinkRendererReady;
  });
  deps.ipc.handle(IPC_CHANNELS.DEEP_LINK_ACK, (payload: unknown) => {
    if (payload === null || typeof payload !== 'object') return false;
    const { deliveryId, attempt } = payload as { deliveryId?: unknown; attempt?: unknown };
    return pendingRendererIntents.acknowledge(deliveryId as number, attempt as number);
  });

  // —— C 组（S3 批；W-10 S3 施工图第 1 项）——
  // registry + 凭据 7 注册体（按原 main.ts 顺序紧接 B 组追加；注册体与下述纯
  // 辅助自 main.ts 逐字迁入，全零 Electron）。trustedIpc 围栏由装配侧在
  // registrar 注入点包装；事务（connection-save）/ canonicalize
  // （transport-provider）/ 凭据写入口（ssh/gateway-provider）与 session origin
  // 纯函数（gateway-session*）为 electron-free 纯模块直接 import。凭据
  // write-only 语义与「绝不回读」纪律保持：读侧只判存在性（!== null），值绝不
  // 进入载荷/日志。装配依赖经 ctx：sm = transportManager 句柄（registry 读写
  // + 状态/生命周期投影）、audit（S24 审计叶）、gatewaySessions（会话
  // invalidation 宿主面）、publishRegistryTransition（registry 变更生命周期
  // sidecar——宿主对象与 SSH_INSTANCES_CHANGED push 文本留 main，本组注册体
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
    const canonical = canonicalizeTransportInstanceInput(candidate) as TransportInstanceInput;
    if (canonical.transport === 'ssh') return sshProvider.validateSpec(canonical);
    if (canonical.transport === 'http') return gatewayProvider.validateSpec(canonical);
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
   * deletion has its own transaction/channel; legacy instances_set below
   * accepts only an unchanged no-op roster.
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
      saveInstances: instances => sm.saveInstances(instances),
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
      saveInstances: next => sm.saveInstances(next),
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
  deps.ipc.handle(IPC_CHANNELS.SSH_INSTANCES_SET, (payload: unknown) => {
    const instances = payload;
    if (!Array.isArray(instances)) {
      console.warn('[dsh-chamber] desktop_ssh_instances_set: non-array input refused');
      return projectInstances(sm.listInstances());
    }
    const before = sm.listInstances();
    // Compatibility channel is exact no-op only. Full-roster deletion is a
    // stale read-modify-write primitive (delete A + concurrent add C could
    // accidentally delete C); production deletion is id-addressed through
    // desktop_ssh_delete_connection, while add/edit use save_connection.
    const normalized = validateDeleteOnlyReplacement(before, instances, normalizeConnectionInput);
    if (normalized === null) {
      console.warn('[dsh-chamber] desktop_ssh_instances_set: only an exact unchanged no-op roster is allowed');
    }
    return projectInstances(before);
  });
  // Legacy explicit SSH-password CLEAR action. Non-empty writes are owned
  // exclusively by desktop_ssh_save_connection so metadata + all credential
  // domains share one compensated transaction.
  deps.ipc.handle(IPC_CHANNELS.SSH_SET_PASSWORD, (payload: unknown) => {
    const { id, password } = payload as { id?: unknown; password?: unknown };
    const spec = typeof id === 'string'
      ? sm.listInstances().find(instance => instance.id === id)
      : undefined;
    const clearing = password === null || password === '';
    if (typeof id !== 'string' || !INSTANCE_ID_PATTERN.test(id) || spec === undefined
      || (password !== null && typeof password !== 'string')) {
      return { error: 'invalid or unknown instance id' };
    }
    if (!clearing) return { error: 'desktop_ssh_set_password is clear-only; use desktop_ssh_save_connection to set credentials' };
    // Clearing remains available on platforms where accepting a new SSH
    // password is unsupported; non-empty writes never reach this handler.
    try {
      // Rebuild only a live SSH transport so it stops using the cleared
      // transport credential. Gateway/http transports are unaffected.
      // S24 audit records only the credential kind, never its value.
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
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });
  // Legacy explicit gateway-token CLEAR action. Non-empty writes use the
  // authoritative save_connection transaction above.
  deps.ipc.handle(IPC_CHANNELS.GATEWAY_SET_TOKEN, (payload: unknown) => {
    const { id, token } = payload as { id?: unknown; token?: unknown };
    const spec = typeof id === 'string'
      ? sm.listInstances().find(instance => instance.id === id)
      : undefined;
    const clearing = token === null || token === '';
    if (typeof id !== 'string' || !INSTANCE_ID_PATTERN.test(id) || spec === undefined
      || (token !== null && typeof token !== 'string')) {
      return { error: 'invalid or unknown instance id' };
    }
    if (!clearing) return { error: 'desktop_gateway_set_token is clear-only; use desktop_ssh_save_connection to set credentials' };
    try {
      // Revoke the currently registered Authorization header BEFORE
      // clearing the token. disconnect() synchronously emits the old
      // gateway idle projection, so the control plane unregisters
      // gateway:<id> before a replacement transport can register.
      // S24 audit names the credential kind, never its value.
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
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });
  // Legacy explicit gateway-password CLEAR action. It also invalidates the
  // corresponding cached sessions; non-empty writes use save_connection.
  deps.ipc.handle(IPC_CHANNELS.GATEWAY_SET_PASSWORD, (payload: unknown) => {
    const { id, password } = payload as { id?: unknown; password?: unknown };
    const spec = typeof id === 'string'
      ? sm.listInstances().find(instance => instance.id === id)
      : undefined;
    const clearing = password === null || password === '';
    // Same id whitelist + registry-existence gate as the token clear.
    if (typeof id !== 'string' || !INSTANCE_ID_PATTERN.test(id) || spec === undefined
      || (password !== null && typeof password !== 'string')) {
      return { error: 'invalid or unknown instance id' };
    }
    if (!clearing) return { error: 'desktop_gateway_set_password is clear-only; use desktop_ssh_save_connection to set credentials' };
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
      // S24 audit never records the password value.
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

  // —— D 组（S4 批；W-10 S4 施工图第 1 项）——
  // ssh 连接状态 7 注册体（按原 main.ts 顺序紧接 C 组追加；注册体自 main.ts
  // 逐字迁入，全零 Electron）。trustedIpc 围栏由装配侧在 registrar 注入点
  // 包装。CONFIG_LIST：~/.ssh/config 非秘密投影（alias/hostName/user/port——
  // keys/proxies/credentials 绝不离开主进程），经纯模块 ssh-config.ts 的
  // discoverSshConfigHosts 直接 import（原注释随迁）；CONNECT / DISCONNECT /
  // STATUS / REVERIFY / LOGS / LOGS_CLEAR 全走 ctx 注入的 transportManager
  // 句柄（sm；Pick 面扩 reverify/logs/clearLogs，见 ShellAssemblyCtx）。
  // status/logs 的非秘密投影纪律保持（localPort/phase 等元数据可读；URL/密钥
  // 绝不进投影/载荷/日志——main.ts 原注释语义随迁保留）。
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

  // —— E 组（S5 批；W-10 S5 施工图第 1 项）——
  // exec/systemd 4 注册体（SSH_START_SERVICE / SSH_STOP_SERVICE / SSH_IS_ACTIVE
  // / SSH_RESTART_SERVICE——按原 main.ts 顺序紧接 D 组追加；注册体自 main.ts
  // 逐字迁入，全零 Electron）。装配依赖经 ctx：transportManager（sm）的 exec
  // 面（Pick 扩 exec——装配侧注入完整现实例）。restart 注册体在 main.ts 原经
  // plugin-sync 的 ExecFn 别名 execTransport（= sm.exec 的 as unknown 收窄，
  // 为适配 plugin-sync 自身的执行契约）调同一执行面，迁入后直用 sm.exec：
  // 运行时同一函数、行为零改（决策注记）。systemctl argv 固定参数数组
  // `systemctl <action> -- <serviceName>` 与服务名白名单（`^[a-zA-Z0-9]
  // [a-zA-Z0-9_.-]*$`、首字符字母数字；design 02 §3.9）是 ssh-provider
  // provider exec 的纯逻辑（白名单拒绝发生在任何 spawn 前），generation 复验
  // 纪律（exec 结果/status/serviceActive 提交前经 execIsCurrent 复验，防旧代
  // 污染）在 transport-manager exec 实现内（execEpoch/execIdentityChanged）
  // ——均在纯模块内部、不随迁；注册体只做结果投影（下方原注释随迁）：
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
  // SSH_RESTART_SERVICE（design 13 M2+M3 contract B 的 ssh 服务重启腿）：
  // 语义同 provider exec channel——成功时投影最新 status（服务重启的即时
  // 状态；transport exec 的 ok 分支恒带 status，此处 ?? 兜底为 plugin-sync
  // ExecResult 契约保留的防御分支，运行时不可达分支行为与搬迁前一致）；
  // 失败 loud {error}。
  deps.ipc.handle(IPC_CHANNELS.SSH_RESTART_SERVICE, (payload: unknown) => {
    const { id } = payload as { id: string };
    return sm.exec(id, 'restart').then(result =>
      (result.ok ? (result.status ?? { error: 'restart completed but no status projection' }) : { error: result.error }),
    ).catch(err => ({ error: `exec failed: ${describeUnknownError(err)}` }));
  });

  // —— F 组（S6 批；W-10 S6 施工图第 1 项）——
  // ssh plugin 6 注册体（SSH_PLUGIN_LIST / SSH_PLUGIN_APPLY / SSH_PLUGIN_UNDO /
  // SSH_SEED_HOST_GRAPH / SSH_PLUGIN_MATERIALIZE_ADD /
  // SSH_PLUGIN_MATERIALIZE_ADD_PICK——按原 main.ts 顺序紧接 E 组追加；注册体自
  // main.ts 逐字迁入，全零 Electron）。编排纯模块直接 import（plugin-sync /
  // ssh-apply-rows / plugin-tarball——main.ts 同款 import 面）；共享现实例与
  // 目标闭包束经 ctx（localDshHome / sshPluginJournal / hostPackageSeeding /
  // chamberHostPackageSeeds / sshPluginTargets——main 装配侧的自动 seed 与
  // registry 撤销路径与 F 组共用同一实例/闭包族：journal 单写者、seed 单飞、
  // 目标指纹同一实现；findRemoteTarget / ownsRemoteTarget / scoped* /
  // liveProbeFor 等原名经 sshPluginTargets 解构保留，注册体文本逐字）。
  // 宿主对话框腿 = edges.showMessage / edges.pickPluginSource（electron-edges
  // S6 实现：原 main.ts confirmPluginAction 闭包与模块级 pickPluginSource 的
  // 函数体逐字复刻——按钮序/编号与 darwin 一体 folder|.tgz 双模式；当前主窗
  // 为父窗 sheet）；无存活主窗预检 = edges.mainWindowAlive（S2 已有，与原
  // mainWindow === null || isDestroyed 判据同值）。确认对话框助手（下方
  // confirmPluginAction）语义与 main 闭包逐字一致：无窗 → 'native
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

  deps.ipc.handle(IPC_CHANNELS.SSH_PLUGIN_LIST, async (payload: unknown) => {
    const { id } = payload as { id: string };
    const target = findRemoteTarget(id);
    if (target === null) return { ok: false, error: 'ssh instance not found' };
    const result = await runWithFinalOwnership(
      () => ownsRemoteTarget(target),
      () => remotePluginList(scopedExecForTarget(target), target.spec, {
        liveProbe: scopedProbeForTarget(target, liveProbeFor(id)),
        gitWorktreeLiveProbe: scopedProbeForTarget(target, gitWorktreeLiveProbeFor(id)),
      }),
    );
    // readManifest 投影统一掩码 (design 21 §6.2/§6.4, decision 18): the
    // renderer projection masks remote-local `file:` dependency values
    // (MATERIALIZED_VALUE_MASK, `file:` prefix preserved) exactly like the
    // gateway installed route — remote paths never leave the main process
    // through this RPC. The main-process-internal manifest (verifyApplied
    // read-backs, the undo journal snapshot, materialize resolution) is
    // never redacted — only this IPC response is.
    if (!result.ok) return result;
    return { ok: true, manifest: redactRemotePluginManifest(result.manifest) };
  });
  deps.ipc.handle(IPC_CHANNELS.SSH_PLUGIN_APPLY, async (payload: unknown) => {
    const { id, add, remove, restart } = payload as { id: string; add: string[]; remove: string[]; restart?: boolean };
    const target = findRemoteTarget(id);
    if (target === null) return { ok: false, error: 'ssh instance not found' };
    // A non-boolean `restart` (e.g. the string 'false') must never be
    // treated as truthy and trigger an unwanted restart — refused here
    // before any exec (applyPlugins re-checks too, defense in depth).
    if (restart !== undefined && typeof restart !== 'boolean') {
      return { ok: false, error: 'restart must be a boolean' };
    }
    // Reserved-name deny (design 21 §6.4/decision 19, same set as the
    // gateway): whole-batch refusal listing the denied names BEFORE any
    // transport work — @deepseek-ai/* and @dsh-chamber/* can never be
    // installed or removed through the plugin model. applyPlugins re-checks
    // (defense in depth) with the same copy.
    const assembled = buildSshApplyRows(add, remove);
    if (assembled.refused.length > 0) {
      return { ok: false, error: describeReservedNameRefusal(assembled.refused) };
    }
    // Known bundle packages for the §4.5 ④ bundles assertion (design 13):
    // the LOCAL manifest's bundle-declaring dependency names. When the
    // local profile is unreadable there is no local source to sync from,
    // so the bundles half of the assertion is skipped (dependencies
    // membership is still asserted); never a silent wrong assertion.
    let knownBundles: string[] | undefined;
    try {
      knownBundles = localPluginList(localDshHome).bundleLines;
    } catch (localError) {
      console.warn('[dsh-chamber] 本地清单不可读，bundle 激活层断言跳过：', localError);
      knownBundles = undefined;
    }
    return runWithFinalOwnership(
      () => ownsRemoteTarget(target),
      () => applyPlugins(
        scopedExecForTarget(target),
        scopedStatusForTarget(target),
        target.spec,
        { add, remove, restart },
        {
          knownBundles,
          ownershipKey: `${target.sourceToken.generation}:${target.fingerprint}`,
          journal: sshPluginJournal,
          targetFingerprint: target.fingerprint,
        },
      ),
    );
  });
  // Undo the latest ok ssh plugin change (design 21 §6.4, plan Phase 5 ssh
  // 统一增量): the undo journal (applyPlugins records every executed row
  // with its pre-change remote spec) answers 「撤销最近变更」. v1 undo =
  // the inverse row through the SAME ssh apply flow — undoing an ok add
  // removes that name; undoing an ok remove re-adds the previous REGISTRY
  // spec (a remove whose previous spec was a remote file: package cannot
  // be re-added in v1 → {ok:false, unavailable:'file-backed'}). The undo
  // is a user-initiated MAIN-process confirmation (default cancel, decision
  // 14) and re-executes with restart-to-apply, journaled, so further undos
  // chain. Never a silent script action.
  deps.ipc.handle(IPC_CHANNELS.SSH_PLUGIN_UNDO, async (payload: unknown) => {
    const { id } = payload as { id: unknown };
    if (typeof id !== 'string' || !INSTANCE_ID_PATTERN.test(id)) {
      return { ok: false as const, error: 'invalid or unknown instance id' };
    }
    const target = findRemoteTarget(id);
    if (target === null) return { ok: false as const, error: 'ssh instance not found' };
    // Target binding (design 21 §6.4 review P1): only ops recorded on the
    // CURRENT operational target are undoable — a connection edit under
    // the same id (new host/user/service/home) must never replay a change
    // onto the wrong machine. Ops recorded before target binding existed
    // (fingerprint null) are never undoable either (their target cannot be
    // proven).
    const op = sshPluginJournal.latestOkForTarget(id, target.fingerprint);
    if (op === null) return { ok: false as const, error: 'no recent plugin change to undo on this target', unavailable: 'none' as const };
    const decision = buildSshUndoDecision(op);
    if (!decision.ok) {
      return { ok: false as const, error: decision.error, unavailable: decision.info.unavailable };
    }
    // Main-process confirmation with the undo copy (default cancel — the
    // undo re-executes a remote write + restart, never a silent action).
    const instance = sm.listInstances().find(candidate => candidate.id === id);
    const confirm = await confirmPluginAction(describeSshUndoConfirmation({
      targetLabel: instance?.label ?? null,
      targetId: id,
      opKind: op.kind,
      name: op.name,
      spec: decision.action.kind === 'add' ? decision.action.spec : null,
    }));
    if ('cancelled' in confirm) return { ok: true as const, cancelled: true };
    if (!confirm.ok) return { ok: false as const, error: confirm.error };
    // Execute the inverse row through the same apply flow (journaled so
    // further undos chain) with restart-to-apply.
    const undoActions: { add: string[]; remove: string[]; restart: boolean } =
      decision.action.kind === 'add'
        ? { add: [decision.action.spec], remove: [], restart: true }
        : { add: [], remove: [decision.action.name], restart: true };
    return runWithFinalOwnership(
      () => ownsRemoteTarget(target),
      async () => {
        const result = await applyPlugins(
          scopedExecForTarget(target),
          scopedStatusForTarget(target),
          target.spec,
          undoActions,
          {
            ownershipKey: `${target.sourceToken.generation}:${target.fingerprint}`,
            journal: sshPluginJournal,
            targetFingerprint: target.fingerprint,
          },
        );
        if (!result.ok) return { ok: false as const, error: result.error };
        if (result.result.applied === 0 && result.result.failed.length > 0) {
          return { ok: false as const, error: `undo failed: ${result.result.failed[0].error}` };
        }
        // Honest undo outcome (P2-2): a change that EXECUTED but did not
        // fully take effect must never project as a clean success. The
        // undone arm carries the outcome fields ({restarted, ready,
        // readyNote}) whenever the undo is not clean — a failed restart,
        // a failed post-change verification, or a failed readiness
        // re-check. A clean undo (rows executed + restart ok + verified +
        // readiness ok or not-checked-with-note) omits the fields
        // entirely, so the PRESENCE of undone.restarted is the renderer's
        // "executed but not fully effective" signal (mirror shape,
        // backward compatible with the clean {kind, name} arm).
        const outcome = result.result;
        const cleanUndo =
          outcome.applied > 0
          && outcome.restarted
          && outcome.verified
          && outcome.ready !== false;
        if (cleanUndo) return { ok: true as const, undone: { kind: op.kind, name: op.name } };
        return {
          ok: true as const,
          undone: {
            kind: op.kind,
            name: op.name,
            restarted: outcome.restarted,
            ready: outcome.ready,
            ...(outcome.readyNote === undefined ? {} : { readyNote: outcome.readyNote }),
          },
        };
      },
    );
  });

  // Host-graph seed + remote materialize (design 13 M4): the M2 orchestration
  // functions that were implemented but not yet wired. Seed installs the
  // chamber host packages (module A host-graph + git-worktree +
  // archive-cleanup) onto the remote (09 遗留 1; the manual resend covers
  // BOTH chamber host packages — a remote connected before the git package
  // existed only picks it up through this path or the next ready
  // transition); materialize installs a local plugin source (folder or .tgz
  // archive) remotely — the ADD view goes through materialize_add_pick
  // (picker in the Electron main via edges.pickPluginSource, pick-only), the
  // sync view through materialize_add (dir resolved from the authoritative
  // local manifest, validated here as absolute + directory). LOCAL_PLUGIN_*
  // 本地腿（runLocalDshPlugin 执行面）仍留 main.ts。
  deps.ipc.handle(IPC_CHANNELS.SSH_SEED_HOST_GRAPH, async (payload: unknown) => {
    const { id } = payload as { id: string };
    const target = findRemoteTarget(id);
    if (target === null) return { ok: false, error: 'ssh instance not found' };
    // Not shipped is a loud error on the MANUAL path (the button must never
    // look like it succeeded while writing nothing) — the auto path skips
    // with an info log instead. The manual resend covers BOTH chamber host
    // packages (host-graph + git-worktree): a remote connected before the
    // git package existed only picks it up through this path or the next
    // ready transition.
    const missing = chamberHostPackageSeeds.filter(seed => !existsSync(path.join(seed.sourceDir, 'dist', 'index.js')));
    if (missing.length > 0) {
      return { ok: false, error: `chamber host 包未打包：${missing.map(seed => seed.label).join('、')} 的 dist/index.js 缺失——请先构建（pnpm run build:host-packages）` };
    }
    const begun = hostPackageSeeding.begin(id, target.fingerprint);
    if (!begun.accepted) return { ok: false, error: 'chamber host seed in progress' };
    const token: ExactOwnershipToken = begun.token;
    const ownsSeed = () => hostPackageSeeding.owns(token) && ownsRemoteTarget(target);
    try {
      const result = await seedRemoteChamberHostPackages(
        scopedExecForTarget(target, ownsSeed),
        target.spec,
        chamberHostPackageSeeds,
      );
      if (!ownsSeed()) return { ok: false, error: 'ssh instance changed while host seed was in progress' };
      // Surface the outcome in the instance's ring-buffer log (the connections
      // UI log panel) — the injection is never a silent modification.
      if (result.ok) {
        const summary = result.packages.map(entry => `${entry.insertId}${entry.wrote ? ' 已写入' : ' 已是最新'}`).join('、');
        if (ownsSeed()) sm.appendLog(id, 'info', `chamber host 包注入完成：${summary}；boot 层${result.patched ? '已挂载' : '无需改动'}（重启后生效）`);
      } else {
        if (ownsSeed()) sm.appendLog(id, 'error', `chamber host 包注入失败：${result.error}`);
      }
      return result;
    } finally {
      hostPackageSeeding.finish(token);
    }
  });
  // materialize_add (sync view): renderer supplies only the dependency NAME.
  // Main re-reads the authoritative local manifest and resolves/canonicalizes
  // its path; an IPC caller can never choose an arbitrary local directory.
  deps.ipc.handle(IPC_CHANNELS.SSH_PLUGIN_MATERIALIZE_ADD, async (payload: unknown) => {
    const { id, name } = payload as { id: string; name: unknown };
    const target = findRemoteTarget(id);
    if (target === null) return { ok: false, error: 'ssh instance not found' };
    if (typeof name !== 'string') return { ok: false, error: 'invalid plugin name' };
    const resolved = resolveLocalMaterializeDirectory(localDshHome, name);
    if (!resolved.ok) return resolved;
    return runWithFinalOwnership(
      () => ownsRemoteTarget(target),
      () => materializeAndAdd(scopedExecForTarget(target), target.spec, resolved.path),
    );
  });
  // materialize_add_pick (add view): PICK-ONLY — the picker runs here in
  // the main process, so a compromised renderer can never drive the pack
  // surface to an arbitrary local directory (design 13 §5.8 hardening).
  // The pick may be a plugin SOURCE FOLDER or a ready .tgz plugin archive
  // (design 21 §10 archive-pick): a folder is packed locally and uploaded;
  // an archive uploads verbatim (no local pnpm pack runs).
  deps.ipc.handle(IPC_CHANNELS.SSH_PLUGIN_MATERIALIZE_ADD_PICK, async (payload: unknown) => {
    const { id } = payload as { id: string };
    const target = findRemoteTarget(id);
    if (target === null) return { ok: false, error: 'ssh instance not found' };
    if (!deps.edges.mainWindowAlive()) return { ok: false, error: 'no main window' };
    const picked = await deps.edges.pickPluginSource();
    if (picked.status === 'cancelled') return { ok: true, cancelled: true };
    if (!ownsRemoteTarget(target)) return { ok: false, error: 'ssh instance changed while the plugin picker was open' };
    const classified = classifyPluginPick(picked.path);
    if (!classified.ok) return { ok: false, error: sanitizeErrorText(classified.error) };
    // Narrow the source BEFORE the ownership closures — TypeScript resets
    // property narrowing at closure boundaries, and the closure bodies must
    // not re-check the kind.
    const source = classified.source;
    if (source.kind === 'dir') {
      return runWithFinalOwnership(
        () => ownsRemoteTarget(target),
        () => materializeAndAdd(scopedExecForTarget(target), target.spec, source.path),
      );
    }
    const archiveName = source.name;
    const archiveBytes = source.bytes;
    return runWithFinalOwnership(
      () => ownsRemoteTarget(target),
      () => materializeArchiveAndAdd(scopedExecForTarget(target), target.spec, {
        name: archiveName,
        bytes: archiveBytes,
      }),
    );
  });

  // —— G 组（S7 批；W-10 S7 施工图第 1 项）——
  // gateway 插件 3 注册体（GATEWAY_PLUGIN_SYNC / GATEWAY_PLUGIN_APPLY /
  // GATEWAY_PLUGIN_MATERIALIZE——按原 main.ts 顺序紧接 F 组追加；注册体自
  // main.ts 逐字迁入，全零 Electron，trustedIpc 围栏由装配侧注入 registrar
  // 包装）。编排纯模块直接 import（gateway-provider / gateway-sync-registry /
  // gateway-ipc-shared / plugin-tarball——main.ts 同款 import 面）；注册参数
  // 读取（getGatewaySyncRegistration 纯模块——main 装配侧的 ready 注册/离开
  // ready/实例撤销路径（sm.onStatusChanged / publishRegistryTransition）经
  // setGatewaySyncRegistration 写同一注册表，读写同表不分叉）与 ready 位复验
  // 在注册体侧。手动 sync 的上传执行闭包经 ctx.syncGatewayChamberPluginsFor
  // （main 装配侧定义——ready 自动 sync 与手动 re-entry 共用同一执行路径与
  // 注册参数，语义不分叉）。确认对话框 = 上方 S6 edges 版 confirmPluginAction
  // 助手（单参 copy；无存活主窗 → 'native confirmation unavailable'；response
  // ===1（'继续'）→ ok；否则 cancelled；异常 → loud——语义与 main 闭包逐字一
  // 致；main 侧原 confirmPluginAction 闭包已随 W-10 S8 H 组删除（LOCAL_PLUGIN_ADD/
  // REMOVE 迁出后无使用点）——本组与 H 组注册体同经本助手）；无存活主窗预检 =
  // edges.mainWindowAlive、插件源 pick = edges.pickPluginSource（宿主腿均在
  // electron-edges.ts S6 实现）。

  // Manual chamber-plugin sync onto a gateway instance (design 21 §6.5,
  // Phase 3b): re-run the seed-cache sync the ready registration performs
  // automatically, over the REGISTERED transport origin/headers/SPKI pin —
  // never a renderer-supplied URL or credential. No ready registration →
  // loud {ok:false}; otherwise the awaited auto-sync path answers with the
  // same {uploaded, skipped} projection (or null → instance vanished).
  deps.ipc.handle(IPC_CHANNELS.GATEWAY_PLUGIN_SYNC, async (payload: unknown) => {
    const { id } = payload as { id: unknown };
    if (typeof id !== 'string' || !INSTANCE_ID_PATTERN.test(id)) {
      return { ok: false as const, error: 'invalid or unknown instance id' };
    }
    const reg = getGatewaySyncRegistration(id);
    if (reg === undefined) return { ok: false as const, error: 'no active gateway registration' };
    // Live-state re-check (design 21 §6.5, honesty): the registry entry is
    // cleared when the transport leaves ready, but a manual sync can still
    // race a disconnect after the hit — a stale-ready dead transport must
    // never be swallowed as a completed sync ({uploaded:false, skipped:false}
    // would read as success). Same `sm.status(id)?.phase` access as the
    // sibling seed/registration code paths.
    if (sm.status(id)?.phase !== 'ready') {
      return { ok: false as const, error: 'gateway is not ready' };
    }
    try {
      const result = await syncGatewayChamberPluginsFor(id, reg.url, reg.headers, reg.spkiPin);
      if (result === null) return { ok: false as const, error: 'gateway instance not found' };
      // Honesty (design 21 review P2-B1): a sync that failed on the wire is
      // {ok:false} — the both-false tuple must never masquerade as the
      // "already up to date" answer.
      if (result.failed === true) {
        return { ok: false as const, error: result.error ?? 'gateway plugin sync failed' };
      }
      return { ok: true as const, uploaded: result.uploaded, skipped: result.skipped };
    } catch (error) {
      return { ok: false as const, error: `gateway plugin sync failed: ${sanitizeErrorText(describeUnknownError(error))}` };
    }
  });
  // Gateway batch plugin apply (design 21 §6.5, plan Phase 4.6): registry
  // add/remove over the REGISTERED transport origin/headers/SPKI pin —
  // never a renderer-supplied URL or credential. Main-process confirmation
  // (decision 14 桌面通道纪律): the batch modifies the gateway's managed
  // dsh profile — a persistent, globally-visible (multi-desktop)
  // execution-surface change, never a silent script action. Cancelled →
  // {ok:true, cancelled:true}; partial failures (an op refused mid-batch
  // or a restart refused after execution) carry the executed
  // installed/removed lists honestly.
  deps.ipc.handle(IPC_CHANNELS.GATEWAY_PLUGIN_APPLY, async (payload: unknown) => {
    const { id, add, remove, deferRestart } = payload as { id: unknown; add: unknown; remove: unknown; deferRestart: unknown };
    if (typeof id !== 'string' || !INSTANCE_ID_PATTERN.test(id)) {
      return { ok: false as const, error: 'invalid or unknown instance id' };
    }
    const validated = validateApplyPayload({ add, remove, deferRestart });
    if (!validated.ok) return { ok: false as const, error: validated.error };
    const reg = getGatewaySyncRegistration(id);
    if (reg === undefined) return { ok: false as const, error: 'no active gateway registration' };
    // Live-state re-check (design 21 §6.5, honesty) — same
    // `sm.status(id)?.phase` access as the sibling sync handler.
    if (sm.status(id)?.phase !== 'ready') {
      return { ok: false as const, error: 'gateway is not ready' };
    }
    const instance = sm.listInstances().find(candidate => candidate.id === id);
    if (instance === undefined || instance.kind !== 'gateway') {
      return { ok: false as const, error: 'gateway instance not found' };
    }
    // Batch confirmation with the restart/multi-desktop copy (default
    // cancel — same convention as the local plugin actions). W-10 S7: 经上方
    // S6 edges 版 confirmPluginAction 助手（原 main.ts 调用为
    // confirmPluginAction(mainWindow, …) 双参闭包——宿主腿相同（showMessage +
    // 当前主窗为父窗 sheet）、按钮序/取消默认一致，行为零改；main 侧闭包已随
    // W-10 S8 H 组删除（LOCAL_PLUGIN_ADD/REMOVE 迁出后无使用点）。
    const confirm = await confirmPluginAction(buildApplyConfirmMessage({
      targetLabel: instance.label ?? null,
      targetId: id,
      add: validated.value.add,
      remove: validated.value.remove,
      deferRestart: validated.value.deferRestart,
    }));
    if ('cancelled' in confirm) return { ok: true as const, cancelled: true };
    if (!confirm.ok) return { ok: false as const, error: confirm.error };
    // Post-confirm re-check (design 21 review P2-B2, mirroring the
    // materialize handler): the user may have kept the dialog open across
    // a disconnect/reconnect — the batch must execute on the CURRENT
    // registration/ready state, never on the pre-dialog snapshot.
    const liveReg = getGatewaySyncRegistration(id);
    if (liveReg === undefined || sm.status(id)?.phase !== 'ready') {
      return { ok: false as const, error: 'gateway connection changed while the confirmation was open; nothing was applied' };
    }
    const liveInstance = sm.listInstances().find(candidate => candidate.id === id);
    if (liveInstance === undefined || liveInstance.kind !== 'gateway') {
      return { ok: false as const, error: 'gateway connection changed while the confirmation was open; nothing was applied' };
    }
    try {
      const result = await gatewayChamberApplyBatch({
        id,
        url: liveReg.url,
        headers: liveReg.headers,
        spkiPin: liveReg.spkiPin,
        // Tunnel Host override: the same discipline as
        // syncGatewayChamberPluginsFor — an ssh transport presents the
        // remote gateway authority, never the loopback tunnel endpoint.
        authority: liveInstance.transport === 'ssh' ? gatewayTunnelAuthority(liveInstance.remotePort) : undefined,
        options: {
          add: validated.value.add,
          remove: validated.value.remove,
          deferRestart: validated.value.deferRestart,
        },
      });
      if (!result.ok) {
        const partial = result.outcome !== undefined && (result.outcome.installed.length > 0 || result.outcome.removed.length > 0)
          ? { installed: result.outcome.installed, removed: result.outcome.removed }
          : undefined;
        return {
          ok: false as const,
          error: sanitizeErrorText(result.error),
          ...(partial === undefined ? {} : { partial }),
        };
      }
      const outcome = result.outcome;
      return {
        ok: true as const,
        installed: outcome.installed,
        removed: outcome.removed,
        restarted: outcome.restarted,
        ...(outcome.deferredOps.length > 0 ? { deferred: true } : {}),
      };
    } catch (error) {
      return { ok: false as const, error: `gateway plugin apply failed: ${sanitizeErrorText(describeUnknownError(error))}` };
    }
  });
  // Gateway local materialize (design 21 §6.5/§10 ⑧ archive-pick): PICK-ONLY —
  // the picker runs here in the main process, so a compromised renderer can
  // never drive the pack/upload surface to an arbitrary local path (the same
  // hardening as the ssh materialize_add_pick path). No separate confirmation
  // dialog is needed: choosing the local source IS the user intent (design 21
  // §6.5, pick-only per design). A picked SOURCE FOLDER is packed into a
  // plugin tgz in the main process (bounded caps); a picked .tgz archive
  // uploads verbatim. Either way the plugin package.json name/version become
  // the x-plugin-name/x-plugin-version headers, and the upload rides the
  // REGISTERED transport origin.
  deps.ipc.handle(IPC_CHANNELS.GATEWAY_PLUGIN_MATERIALIZE, async (payload: unknown) => {
    const { id } = payload as { id: unknown };
    if (typeof id !== 'string' || !INSTANCE_ID_PATTERN.test(id)) {
      return { ok: false as const, error: 'invalid or unknown instance id' };
    }
    const reg = getGatewaySyncRegistration(id);
    if (reg === undefined) return { ok: false as const, error: 'no active gateway registration' };
    if (sm.status(id)?.phase !== 'ready') {
      return { ok: false as const, error: 'gateway is not ready' };
    }
    // W-10 S7: 无存活主窗预检经 edges.mainWindowAlive（S2 已有——与原
    // mainWindow === null || isDestroyed 判据同值，F 组同款改法）。
    if (!deps.edges.mainWindowAlive()) return { ok: false as const, error: 'no main window' };
    const instance = sm.listInstances().find(candidate => candidate.id === id);
    if (instance === undefined || instance.kind !== 'gateway') {
      return { ok: false as const, error: 'gateway instance not found' };
    }
    // Pick-only (design 21 §6.5): the picker runs here in the main process,
    // so a compromised renderer can never drive the upload surface to an
    // arbitrary local path. The pick may be a plugin SOURCE FOLDER or a
    // ready .tgz plugin archive (design 21 §10 archive-pick).
    const picked = await deps.edges.pickPluginSource();
    if (picked.status === 'cancelled') return { ok: true as const, cancelled: true };
    // Post-pick re-check: the user browsed for a while — the registration
    // and ready phase must still hold before any upload (the same
    // discipline as the ssh picker's ownsRemoteTarget re-check).
    const liveReg = getGatewaySyncRegistration(id);
    if (liveReg === undefined || sm.status(id)?.phase !== 'ready') {
      return { ok: false as const, error: 'gateway connection changed while the plugin picker was open' };
    }
    try {
      const classified = classifyPluginPick(picked.path);
      if (!classified.ok) {
        return { ok: false as const, error: sanitizeErrorText(classified.error) };
      }
      let tarball: Buffer;
      let name: string;
      let version: string;
      if (classified.source.kind === 'dir') {
        const built = await buildPluginTarball(classified.source.path);
        if (!built.manifest.ok) {
          return { ok: false as const, error: sanitizeErrorText(built.manifest.error) };
        }
        tarball = built.buffer;
        name = built.manifest.name;
        version = built.manifest.version;
      } else {
        // A ready npm-pack archive uploads verbatim — no rebuild. Its
        // name/version come from the archive's own manifest (read by the
        // bounded reader in classifyPluginPick) and are re-validated by
        // gatewayChamberMaterialize before any byte is sent.
        tarball = classified.source.bytes;
        name = classified.source.name;
        version = classified.source.version;
      }
      const result = await gatewayChamberMaterialize({
        id,
        url: liveReg.url,
        headers: liveReg.headers,
        spkiPin: liveReg.spkiPin,
        tarball,
        name,
        version,
        authority: instance.transport === 'ssh' ? gatewayTunnelAuthority(instance.remotePort) : undefined,
      });
      return result.ok
        ? { ok: true as const, deferred: result.deferred }
        : { ok: false as const, error: sanitizeErrorText(result.error) };
    } catch (error) {
      // Builder errors carry machine codes (path too long / cap exceeded /
      // folder changed while packing / unreadable) whose message text is
      // already specific — keep it loud and sanitized.
      return { ok: false as const, error: `gateway plugin materialize failed: ${sanitizeErrorText(describeUnknownError(error))}` };
    }
  });

  // —— H 组（S8 批；W-10 S8 施工图第 1 项）——
  // 本地插件 + npm 搜索 5 注册体（LOCAL_PLUGIN_LIST / NPM_SEARCH /
  // LOCAL_PLUGIN_ADD_FILE / LOCAL_PLUGIN_ADD / LOCAL_PLUGIN_REMOVE——按原
  // main.ts 顺序紧接 G 组追加；注册体自 main.ts 逐字迁入，全零 Electron，
  // trustedIpc 围栏由装配侧注入 registrar 包装）。编排纯模块直接 import
  // （plugin-sync：localPluginList / runLocalDshPlugin /
  // describeLocalPluginAddConfirmation / describeLocalPluginRemoveConfirmation；
  // plugin-tarball classifyPluginPick 为 S6 已 import；npm 搜索的 registry URL
  // 白名单 = @dsh-chamber/dsh-runtime isAllowedRegistryUrl——§6 R3-5 P2-6
  // 纪律注释随迁，见 NPM_SEARCH 注册体）。本地安装的宿主子进程编排
  // （runLocalPluginMutation：runtime writer fence 租约 + 启动门 +
  // resolveActiveRuntime workspace 解析）经 ctx 注入叶——本体留 main 装配侧
  // （fence/启动门是装配侧运行时事务状态；add 子进程 env 装配在 plugin-sync
  // runLocalDshPlugin 纯模块内，W-14 关联 C-F12 纪律注释随原模块），core 注册体
  // 文本以原名逐字调用。确认对话框 = 上方 S6 edges 版 confirmPluginAction 助手
  // （单参 copy；无存活主窗 → 'native confirmation unavailable'；response === 1
  // （'继续'）→ ok；否则 cancelled——按钮序/取消默认/无窗文案与 main 闭包逐字
  // 一致）；ADD_FILE 的无存活主窗预检 = edges.mainWindowAlive、插件源 pick =
  // edges.pickPluginSource（宿主腿均在 electron-edges.ts S6 实现）。main 侧原
  // confirmPluginAction 闭包随本批删除（LOCAL_PLUGIN_ADD/REMOVE 迁出后无使用点）。

  // Local manifest read (design 13 M4 local leg): the authoritative local dsh
  // home manifest (<localDshHome>/… package.json 依赖投影 + bundle 激活层) —
  // localPluginList is a pure plugin-sync read of the same home the mutation
  // leaf writes; loud {error} on any unreadable/corrupt manifest, never a
  // silent empty success.
  deps.ipc.handle(IPC_CHANNELS.LOCAL_PLUGIN_LIST, () => {
    try {
      return { ok: true, manifest: localPluginList(localDshHome) };
    } catch (error) {
      return { ok: false, error: describeUnknownError(error) };
    }
  });
  // npm search (design 13 M2+M3 contract B): BEST-EFFORT npm registry search —
  // a main-process fetch (the renderer stays on 127.0.0.1), bounded in time and
  // body size, refusing any non-whitelisted URL/redirect loudly. Always a loud
  // {ok:false} on refusal/transport/parse failure — never a silent empty
  // success, never an unhandled rejection. Semantics comments carried verbatim
  // from main.ts with the registration body.
  deps.ipc.handle(IPC_CHANNELS.NPM_SEARCH, async (payload: unknown) => {
    const { query } = payload as { query: unknown };
    if (typeof query !== 'string' || query.trim() === '') return { ok: false, error: 'empty search query' };
    const text = query.trim();
    if (text.length > 256) return { ok: false, error: 'search query is too long' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    timer.unref?.();
    try {
      const searchUrl = new URL(`https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(text)}&size=20`);
      // §6 R3-5 P2-6: the search endpoint shares the registry URL whitelist
      // (origin + `/-/v1/search` path shape), never a raw hardcoded fetch.
      if (!isAllowedRegistryUrl(searchUrl.toString())) {
        return { ok: false, error: 'search URL is not whitelisted' };
      }
      // redirect: 'manual' — the same per-hop discipline as
      // fetchRegistryResponse: a redirected search answer is NOT accepted
      // from an arbitrary origin, so any 3xx is an explicit failure here.
      const response = await fetch(searchUrl, {
        signal: controller.signal,
        redirect: 'manual',
      });
      if (!response.ok) return { ok: false, error: `npm search failed (HTTP ${response.status})` };
      // Bounded read: an oversized or endless search response must never
      // accumulate in main-process memory.
      const reader = response.body?.getReader();
      let raw = '';
      if (reader !== undefined) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          raw += Buffer.from(value).toString('utf8');
          if (raw.length > NPM_SEARCH_MAX_BODY_BYTES) {
            await reader.cancel().catch(() => undefined);
            return { ok: false, error: 'npm search response is too large' };
          }
        }
      }
      let data: { objects?: Array<{ package?: { name?: unknown; version?: unknown; description?: unknown } }> };
      try {
        data = JSON.parse(raw) as { objects?: Array<{ package?: { name?: unknown; version?: unknown; description?: unknown } }> };
      } catch {
        return { ok: false, error: 'npm search returned malformed JSON' };
      }
      const objects = Array.isArray(data.objects) ? data.objects : [];
      const packages = objects
        .map(entry => entry.package)
        .filter((pkg): pkg is { name: string; version: unknown; description: unknown } => pkg !== undefined && typeof pkg.name === 'string')
        .map(pkg => ({
          name: pkg.name,
          version: typeof pkg.version === 'string' ? pkg.version : '',
          ...(typeof pkg.description === 'string' ? { description: pkg.description } : {}),
        }));
      return { ok: true, packages };
    } catch (error) {
      return { ok: false, error: `npm search failed: ${describeUnknownError(error)}` };
    } finally {
      clearTimeout(timer);
    }
  });

  deps.ipc.handle(IPC_CHANNELS.LOCAL_PLUGIN_ADD_FILE, async () => {
    if (!deps.edges.mainWindowAlive()) return { ok: false, error: 'no main window' };
    // Local same-machine install (design 13 §5.8 pick-only, design 21
    // §10 defect ① fix + archive-pick): the path was chosen through the
    // MAIN-process picker — a plugin SOURCE FOLDER or a ready .tgz plugin
    // archive — so the `file:` spec is main-chosen; pass allowFileSpec so
    // runLocalDshPlugin admits it through isAllowedLocalFileSpec (absolute
    // POSIX/Windows-drive/UNC path, no control characters, ≤ 4096 chars —
    // nothing beyond the existing whitelist is relaxed). Every
    // renderer-submitted spec channel (LOCAL_PLUGIN_ADD below) still
    // refuses `file:` outright; no filesystem privilege boundary widens.
    const picked = await deps.edges.pickPluginSource();
    if (picked.status === 'cancelled') return { ok: true, cancelled: true };
    // Structural pre-check (extension + archive cap + parseable manifest);
    // the local dsh CLI remains the authority for name/version semantics,
    // exactly as with folder picks.
    const classified = classifyPluginPick(picked.path);
    if (!classified.ok) return { ok: false, error: sanitizeErrorText(classified.error) };
    return runLocalPluginMutation('plugin:add-file', async (dshWorkspace) => {
      // design 21 §10 缺陷① fix (plan 24 小项④): the main-process picker
      // IS the sanctioned file: source — pass the capability flag so
      // the picked absolute path passes runLocalDshPlugin's gate (without it
      // every file: pick was refused as an invalid add spec).
      const result = await runLocalDshPlugin(dshWorkspace, localDshHome, 'add', `file:${picked.path}`, { allowFileSpec: true });
      return result.ok ? { ok: true } : { ok: false, error: result.error ?? 'local add failed' };
    });
  });
  deps.ipc.handle(IPC_CHANNELS.LOCAL_PLUGIN_ADD, async (payload: unknown) => {
    const { spec: specArg } = payload as { spec: string };
    // `file:` imports must go through the main-process local import picker
    // (desktop_local_plugin_add_file — a folder or a .tgz archive, design 21
    // §10 ⑧); this spec channel only accepts registry specs so a compromised
    // renderer can never drive the local install surface to an arbitrary
    // path (design 13 §5.8 hardening).
    if (typeof specArg === 'string' && specArg.startsWith('file:')) {
      return { ok: false, error: 'local file imports must use the local import picker' };
    }
    // User confirmation (design 09 §4 v1 mitigation): installing a registry
    // package into the LOCAL profile creates a persistent execution surface
    // on the next local boot — never a silent script action.
    // W-10 S8: 经上方 S6 edges 版 confirmPluginAction 助手（原 main.ts 调用为
    // confirmPluginAction(mainWindow, …) 双参闭包——宿主腿相同（showMessage +
    // 当前主窗为父窗 sheet）、按钮序/取消默认一致，行为零改；main 侧闭包已随
    // 本批删除——无剩余使用点）。
    const confirm = await confirmPluginAction(describeLocalPluginAddConfirmation(specArg));
    if ('cancelled' in confirm) return { ok: true, cancelled: true };
    if (!confirm.ok) return { ok: false, error: confirm.error };
    return runLocalPluginMutation('plugin:add', async (dshWorkspace) => {
      const result = await runLocalDshPlugin(dshWorkspace, localDshHome, 'add', specArg);
      return result.ok ? { ok: true } : { ok: false, error: result.error ?? 'local add failed' };
    });
  });
  deps.ipc.handle(IPC_CHANNELS.LOCAL_PLUGIN_REMOVE, async (payload: unknown) => {
    const { name } = payload as { name: unknown };
    if (typeof name !== 'string' || name === '') return { ok: false, error: 'invalid plugin name' };
    // User confirmation (design 09 §4 v1 mitigation): removal is destructive
    // — a page script must not be able to wipe the local profile silently.
    // W-10 S8: 经上方 S6 edges 版 confirmPluginAction 助手（原 main.ts 调用为
    // confirmPluginAction(mainWindow, …) 双参闭包——宿主腿相同、按钮序/取消默认
    // 一致，行为零改）。
    const confirm = await confirmPluginAction(describeLocalPluginRemoveConfirmation(name));
    if ('cancelled' in confirm) return { ok: true, cancelled: true };
    if (!confirm.ok) return { ok: false, error: confirm.error };
    return runLocalPluginMutation('plugin:remove', async (dshWorkspace) => {
      const result = await runLocalDshPlugin(dshWorkspace, localDshHome, 'remove', name);
      return result.ok ? { ok: true } : { ok: false, error: result.error ?? 'local remove failed' };
    });
  });

  // —— I 组（S9 批；W-10 S9 施工图第 1 项）——
  // open-in（OPEN_IN_APPS / OPEN_IN）与 update（UPDATE_STATE / UPDATE_CHECK /
  // UPDATE_DOWNLOAD / UPDATE_RESTART / OPEN_RELEASE）7 注册体按原 main.ts 顺序
  // 紧接 H 组追加（注册体自 main.ts 逐字迁入，trustedIpc 围栏由装配侧注入
  // registrar 包装）。随迁内容：
  //  - openInCtx/wiredCtx 共享宿主依赖束（open-in 注册表 + OS 深链 drain 共用）：
  //    lookupInstance 经 ctx transportManager（sm——与搬迁前同一现实例）、
  //    vscodeAvailable 经 detectVscodeAvailability(hostFacts.platform)（同一平台
  //    事实）、vscodeOpenInNewWindow 经 settingsIO.current()（chamber settings
  //    内存 holder 的 core 读面——搬迁前 chamberSettings 直读同源）、宿主打开/
  //    揭示叶 = deps.edges 的 openExternal / openPath / showItemInFolder
  //    （electron-edges.ts S9 实现——shell-core 零 electron）；stat 叶经 node:fs
  //    fsp（与搬迁前同一 fsp.stat 现实例）。编排纯模块直接 import（open-in.ts：
  //    listOpenInApps / runOpenInLaunch / classifyLocalPath / invokeOpenPath；
  //    deep-link.ts：runVscodeLaunch）。来源指纹 owns/matches 复查与来源代际捕获
  //    （captureVscodeSource）随迁 core（S2 遗留注记「S9 消费循环迁 core 时随迁
  //    或参数化」闭合——经 ctx transportManager 参数化）。
  //  - update 面：updater 现实例（main 装配侧构造的 createUpdateController
  //    包装）经 ctx.updateController 注入——注册体文本以原名逐字保留
  //    updater.xxx 调用；状态 push 订阅随迁（committed-push 包装 +
  //    edges.rendererPush——主窗身份折算：原「const updateWindow = mainWindow /
  //    updateWindow !== null」快照与「mainWindow !== updateWindow ||
  //    updateWindow.isDestroyed()」复查折算为 mainWindowAlive 门 + rendererPush
  //    对当前主窗求值（S2 同款单窗接缝折算：push 与 send 之间窗口被换 → 换窗推
  //    送；新窗未装监听的事件丢失由 renderer 重拉兜底——与搬迁前「throw → 不
  //    push」同向）；无存活主窗不 push 不 warn，与搬迁前 null → 静默跳过同语义）。
  //    updater.start() 仍由装配侧调用（installIpcHandlers 之后——保持「先订阅
  //    后 start」原序，见 main.ts 装配点）。
  //  - OS 深链启动消费循环（drainPendingIntents 闭包）随迁装配（pendingIntents
  //    队列在模块级 S9 段；本段在 wiredCtx 依赖束就绪后装配槽位——W-10 S2
  //    遗留项闭合；失败 loud = edges.showError（dialog.showErrorBox 叶，
  //    electron-edges.ts S9 实现）+ 日志，quit 门 = quittingLeaf）。
  //  - OPEN_RELEASE 的宿主打开叶 = deps.edges.openExternal（updater.ts
  //    openReleasePage 的 isAllowedReleaseUrl 白名单纪律在 updater.ts 纯模块内，
  //    随原模块；leaf 只执行打开——行为与搬迁前直包 shell.openExternal 一致）。

  /** Hold a successful launch intent until the current renderer explicitly says
   *  its onIntent listener is installed. Used by both OS deep links and open-in.
   *  W-10 S9：自 main.ts 随迁（S2 注记「S9 消费循环迁 core 时随迁或参数化」闭
   *  合）——registry 查找经 ctx transportManager（sm，与搬迁前模块级
   *  transportManager 同一现实例；装配后恒非 null，同 D 组注册体）；来源代际捕
   *  获经 captureNotificationSource 代理。 */
  function captureVscodeSource(instanceId: string): NotificationSourceToken | null {
    if (instanceId === 'local') return captureNotificationSource('local');
    const instance = sm.listInstances().find(candidate => candidate.id === instanceId);
    return instance === undefined
      ? null
      : captureNotificationSource(`${instance.kind}-${instance.id}`);
  }

  // VS Code 深链（design 16 §4/§5）+ open-in 注册表（open-in.ts）的共享宿主
  // 依赖束：wiredCtx 同时供 OS 深链 drain（runVscodeLaunch）与 open-in 执行
  // 管线复用。lookupInstance 查 ctx transportManager 实查（与搬迁前 main.ts
  // 装配注入同一 sm 现实例）；vscodeAvailable 每次实探（getter 惰性、无缓存
  // 陈旧）；openVscodeUrl 白名单判定留 core、宿主打开叶 = deps.edges.openExternal
  // （原 shell.openExternal——catch → loud error，返回 {error} 由调用方处理）。
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
      // Injection-point scheme re-verification (security-review P2-1, mirror
      // of isAllowedReleaseUrl's discipline): only our constructed targets
      // may ever reach the host open leaf — the ssh-remote URL for remote
      // sources and the file URL for the local source (user decision
      // 2026-08: local workspaces open as local folders).
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
  // deps.edges 宿主叶；均与搬迁前 main.ts 的主进程包装同一语义）。原 design 16
  // 的两个 vscode IPC（vscode-availability / open-vscode）随旧插件删除而移除——
  // 渲染层唯一入口收敛为 open-in 两个通道（复核 2026-08）。
  const openInCtx: OpenInLaunchContext = {
    platform: hostFacts.platform,
    lookupInstance: wiredCtx.lookupInstance,
    vscodeAvailable: wiredCtx.vscodeAvailable,
    vscodeOpenInNewWindow: wiredCtx.vscodeOpenInNewWindow,
    openVscodeUrl: wiredCtx.openVscodeUrl,
    stat: p => classifyLocalPath(value => fsp.stat(value), p),
    openPath: async (p) => {
      // shell.openPath 部分失败模式（win32/linux）存在 reject 路径——与
      // openVscodeUrl 封装同款纪律：reject 归一为错误串（loud），绝不落
      // transport rejection。invokeOpenPath 只返回原始宿主错误，公共
      // "open path failed" 前缀由 provider 添加一次。
      return invokeOpenPath(value => deps.edges.openPath(value), p)
    },
    showItemInFolder: (p) => deps.edges.showItemInFolder(p),
  }
  deps.ipc.handle(IPC_CHANNELS.OPEN_IN_APPS, () => ({
    apps: listOpenInApps(openInCtx, (appId, error) => {
      console.error(`[dsh-chamber] open-in provider ${appId} 可用性探测失败：${error}`)
    }),
  }))
  deps.ipc.handle(IPC_CHANNELS.OPEN_IN, async (payload: unknown) => {
    // 载荷形状守卫（复核 P2）：不可信渲染载荷直接解构会以 TypeError 落到
    // transport rejection——统一为 loud {error}，与其余失败面一致。
    const req = payload as Partial<OpenInRequest> | null
    if (req === null || typeof req !== 'object' || typeof req.appId !== 'string' || typeof req.instanceId !== 'string' || typeof req.path !== 'string' || typeof req.sourceFingerprint !== 'string') {
      return { ok: false, error: 'invalid open-in payload' }
    }
    const sourceInstance = req.instanceId === 'local'
      ? undefined
      : sm.listInstances().find(candidate => candidate.id === req.instanceId);
    const sourceId = req.instanceId === 'local'
      ? 'local'
      : sourceInstance === undefined ? '' : `${sourceInstance.kind}-${sourceInstance.id}`;
    if (!isValidNotificationSourceFingerprint(sourceId, req.sourceFingerprint)) {
      return { ok: false, error: 'invalid source fingerprint' };
    }
    if (!matchesNotificationSource(sourceId, req.sourceFingerprint)) {
      return { ok: false, error: 'source changed before open-in request was accepted' };
    }
    const sourceToken = captureVscodeSource(req.instanceId);
    if (sourceToken === null) return { ok: false, error: 'source not found' };
    const ownsSource = () => ownsNotificationSource(sourceToken);
    const scopedOpenInCtx: OpenInLaunchContext = {
      ...openInCtx,
      lookupInstance: id => ownsSource() ? openInCtx.lookupInstance(id) : null,
      openVscodeUrl: async url => {
        if (!ownsSource()) return { ok: false, error: 'source changed before VS Code launch' };
        const opened = await openInCtx.openVscodeUrl(url);
        return ownsSource() ? opened : { ok: false, error: 'source changed while VS Code launch was in progress' };
      },
    };
    const result = await runOpenInLaunch({ appId: req.appId, instanceId: req.instanceId, path: req.path }, scopedOpenInCtx)
    if (!ownsSource()) return { ok: false, error: 'source changed while open-in was in progress' };
    // vscode 启动成功后将 intent 放入 renderer hold/replay 队列（与 OS
    // 深链路径对齐；W-10 S2——队列/入队在 shell-core，enqueueRendererDeepLinkIntent
    // 为 core 导出）；finder 无对应激活语义。窗口未就绪也不丢，renderer
    // 安装监听并 ready 后再推送；该 UI 联动从不阻塞 vscode 启动。
    if (result.ok && req.appId === 'vscode') {
      enqueueRendererDeepLinkIntent({ instanceId: req.instanceId, path: req.path }, sourceToken);
    }
    return result;
  })

  // Update controller (design 11): the state projection is non-secret only
  // (versions / channel / release URL / short error text) and every failure is
  // silent (main-process log), never blocking startup — the settings section
  // renders the honest state. W-10 S9：控制器现实例仍在 main 装配侧构造
  // （createUpdateController——electron-updater 生命周期、autoDownload=false /
  // autoInstallOnAppQuit 语义、quitAndInstall 的 quit 腿均归装配侧实例），经
  // ctx.updateController 注入；本段注册状态 push 订阅与 4 个 UPDATE 注册体 +
  // OPEN_RELEASE（按原 main.ts 顺序）。
  updater.subscribe((updateState) => {
    // 状态 push（UPDATE_STATE_CHANGED send 源；主窗身份折算见组注释——S2 同款
    // committed-push 包装 + rendererPush 叶）：无存活主窗（原 updateWindow ===
    // null）静默跳过；push 失败 loud（等待 renderer 重拉兜底）。
    if (!deps.edges.mainWindowAlive()) return;
    const pushed = attemptCommittedRegistryPush(() => {
      if (!deps.edges.rendererPush(IPC_CHANNELS.UPDATE_STATE_CHANGED, updateState)) {
        throw new Error('updater renderer push failed');
      }
    });
    if (!pushed.sent) {
      try { console.warn(`[dsh-chamber] updater 状态 push 失败（等待 renderer 重拉）：${pushed.error}`); } catch { /* callback boundary */ }
    }
  });
  deps.ipc.handle(IPC_CHANNELS.UPDATE_STATE, () => updater.state());
  deps.ipc.handle(IPC_CHANNELS.UPDATE_CHECK, () => updater.checkNow());
  deps.ipc.handle(IPC_CHANNELS.UPDATE_DOWNLOAD, () => updater.download());
  // The settings update section's「重启并安装」button (2026-12 user
  // decision): a completed download restarts the app into the install
  // (quitAndInstall) — the user controls when the update applies instead of
  // relying on the quit-install leg alone. Controller-side gates mirror the
  // rendered state (phase downloaded + no install block) — not just UI
  // hiding; quitAndInstall then quits through before-quit (the
  // update-downloaded exemption) and will-quit (cleanup first).
  deps.ipc.handle(IPC_CHANNELS.UPDATE_RESTART, () => updater.restartAndInstall());
  // The settings update section's「前往下载页」link: popups are denied and
  // navigation is pinned to the control-plane origin, so opening a release
  // page must go through the main process. Strict allowlist — parsed, not
  // prefix-string matched: only this repo's GitHub pages can ever be opened
  // (never an arbitrary URL, subdomain, userinfo or path-root trick).
  // W-10 S9：宿主打开叶 = deps.edges.openExternal（原直包 shell.openExternal）。
  deps.ipc.handle(IPC_CHANNELS.OPEN_RELEASE, (payload: unknown) => {
    const { url } = payload as { url: unknown };
    return openReleasePage(url, value => deps.edges.openExternal(value));
  });

  // OS 深链消费循环装配（design 16 §4.2；模块级 pendingIntents 队列见 S9 段）：
  // startup 完成（装配就绪、transportManager 装载）后顺序消费有界队列。VS Code
  // 启动不等待 renderer；成功 intent 进入独立的 renderer hold/replay 队列（S2
  // 已迁 core——enqueueRendererDeepLinkIntent + ownsNotificationSource），直到
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

  // —— J 组（S10 批；W-10 S10 runtime A 批）——
  // runtime 6 注册体（RUNTIME_STATE / RUNTIME_RESTART / RUNTIME_CHECK /
  // RUNTIME_INSTALL / RUNTIME_CLEANUP_VERSION / RUNTIME_CLEAR_FAILURE——按原
  // main.ts 顺序紧接 I 组追加；注册体自 main.ts 逐字迁入，trustedIpc 围栏由
  // 装配侧注入 registrar 包装）。随迁内容：
  //  - 控制器现实例（DshRuntimeController——main 装配侧 whenReady 构造）经
  //    ctx.runtimeController 注入（core 类型面 import 自 dsh-runtime-controller.ts
  //    ——electron-free 纯编排模块；K 组注册体与启动/证据路径共用同一实例，状态
  //    权威单一）；J 组注册体文本以原名 runtimeInstance 逐字保留（同 updater 先例）。
  //  - runtime 事务槽在飞读门 = ctx.runtimeOperationBusy（原模块级
  //    `runtimeOperation !== null`——单写者仍为 main 的启动事务/K 组注册体，
  //    core 只读）；原文本逐处机械替换为 runtimeOperationBusy()。
  //  - runtime writer fence 现实例 = ctx.runtimeWriterFence（同一 fence——启动
  //    事务与 K 组路径共用，busy/tryAcquire/lease.release 语义与搬迁前一致；
  //    owner 名 'runtime:restart' / 'runtime:check' / 'runtime:install' /
  //    'runtime:cleanup-version' 逐字保留）。
  //  - 动作终态门 = ctx.runtimeActionAllowed（原 main.ts whenReady 闭包——K 组
  //    注册体同用单一实现）。
  //  - dsh-runtime 纯逻辑直接 import（isSafeVersion / listExplicitlyInstalledVersions /
  //    cleanupExplicitRuntimeVersion / listRuntimeFailures / clearRuntimeFailure——
  //    electron-free 共享核，与 main.ts 同款 import 面）；runtimeBaseDir 为装配期
  //    解析值经 ctx 注入（core 不碰 Electron paths）。
  //  - 宿主叶 = ctx.refreshRuntimeEvidence / ctx.runStorePruneIfNeeded（K 组与
  //    启动路径同用同一实现）；ctx.restartLocalDsh = PlaneHandle 宿主腿（原
  //    controlPlane null 门 + restartLocal() + resolve 后实时 connectionState
  //    读封装在装配侧叶——resolve ≠ success 的白名单判据仍在本段注册体）。
  //  - 确认对话框 = 下方 S6 版 confirmRuntimeMutation 助手（原 main.ts 同名闭包
  //    的 core 复刻：edges.mainWindowAlive 无窗预检 + edges.showMessage 宿主腿
  //    ——按钮序 ['取消', confirmLabel] / defaultId 0 / cancelId 0 / noLink 与
  //    文案逐字一致；无窗 → false = 'native confirmation unavailable' 不确认
  //    语义，调用方静默返回当前 state，与搬迁前 win==null||isDestroyed→false
  //    同向；预检与调用间窗口销毁竞态 → showMessage 叶抛 'native confirmation
  //    unavailable' → 注册体 reject，与搬迁前 showMessageBox(win) 抛出同形）。
  //    main 侧同名闭包原为 K 组注册体保留，已随 W-10 S11 K 组批迁完删除
  //    （S10 遗留过渡双份消除——K 组注册体同用本助手，见 K 组段注释）。
  //  - runRuntimeCheck 随迁（quit 门 = quittingLeaf——S2 装配的 ctx.isQuitting
  //    快照；原模块级 quitRequested 直读同值）；main 装配侧的首检/周期计时器
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
  deps.ipc.handle(IPC_CHANNELS.RUNTIME_STATE, () => runtimeInstance.getState());
  // Transactional managed-dsh restart (design 18 §3.6 项 8): refreshes mounted
  // plugins. Not a version mutation — the pointer/tree is untouched, so no
  // snapshot/probe gate; the control-plane restartLocal() is single-flight,
  // serialized with health restarts, and respects canStartLocal.
  deps.ipc.handle(IPC_CHANNELS.RUNTIME_RESTART, async () => {
    const state = runtimeInstance.getState();
    // RESTART-GATE RULING (stage2, 2026): core allowedActions offers
    // restart-dsh in idle/available/applied/rollback/failed/error only;
    // this refusal = busy set (the five no-restart phases) + explicit
    // snapshot-failed/runtimeBlocked + single-flight gates. NOT a pure
    // allowedActions gate: failed/error allow restart-dsh there yet are
    // refused here while runtimeBlocked — do not substitute one expression
    // for the other before ruling. Gateway route gate checks only
    // applying/installing for its REST restart surface.
    const busyPhase = state.phase === 'checking' || state.phase === 'downloading'
      || state.phase === 'installing' || state.phase === 'applying' || state.phase === 'pending';
    if (runtimeOperationBusy() || runtimeWriterFence.busy || busyPhase
      || state.runtimeBlocked === true
      || state.phase === 'snapshot-failed') {
      // Honest refusal (R7 review): a busy runtime must not resolve into a
      // silent no-op "success" — the renderer shows the failure line.
      // 2026-12：env 来源与只读平台（managementSupported=false）不再拒绝
      // 重启——「重启 dsh」是来源/平台无关动作（design 18 §3.6 项 8，
      // 与 gateway 行为一致）。
      const reason = state.runtimeBlocked === true
        ? state.runtimeBlockedReason ?? 'runtime blocked'
        : 'dsh runtime is busy (another runtime operation is in progress)'
      throw new Error(sanitizeErrorText(reason));
    }
    // Hold the shared writer fence for the transaction: other runtime
    // actions (retry-apply / restore-pre-rollback / reset-builtin) acquire
    // the same fence, so a restart cannot interleave with a stopLocal()
    // from a concurrent mutation (V2 review M1).
    const restartLease = runtimeWriterFence.tryAcquire('runtime:restart');
    if (restartLease === null) {
      throw new Error('dsh runtime is busy (another writer holds the fence)');
    }
    try {
      // W-10 S10：PlaneHandle 宿主腿 = ctx.restartLocalDsh（原 controlPlane null
      // 门 + restartLocal() + resolve 后实时 connectionState 读——封装在 main 装
      // 配侧叶，同序同值）。
      const connectionState = await restartLocalDsh();
      // CONTRACT (design 18 §9.3): resolve ≠ success — a restart that
      // exhausted the shared window settles into restart-exhausted (or
      // error) and RESOLVES; project that honestly instead of a silent
      // "healthy" runtime state.
      // Whitelist (round-3 fix): restartLocal() also resolves from
      // restart-exhausted / error / stopped and can bail on an epoch bump
      // while 'restarting' is still live — only ready/degraded (process
      // alive) is a success; resolve ≠ success, strictly.
      if (connectionState !== 'ready' && connectionState !== 'degraded') {
        throw new Error(`dsh restart did not reach ready (${connectionState})`);
      }
      return runtimeInstance.getState();
    } catch (error) {
      const message = sanitizeErrorText(error instanceof Error ? error.message : String(error));
      console.warn('[dsh-chamber] restart dsh failed:', message);
      // Honest failure (design 18 §3.6 项 8): reject so the renderer shows
      // the failure line instead of silently resolving.
      throw new Error(message);
    } finally {
      restartLease.release();
    }
  });
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
  deps.ipc.handle(IPC_CHANNELS.RUNTIME_CHECK, runRuntimeCheck);
  deps.ipc.handle(IPC_CHANNELS.RUNTIME_INSTALL, async (args) => {
    const v = args !== null && typeof args === 'object' ? (args as Record<string, unknown>).version : undefined;
    if (typeof v !== 'string' || v.length > 128 || !isSafeVersion(v)) return runtimeInstance.getState();
    const requestedVersion = v.trim();
    const before = runtimeInstance.getState();
    if (runtimeOperationBusy() || before.source === 'env' || !runtimeActionAllowed('install')) {
      return before;
    }
    if (!await confirmRuntimeMutation(
      `安装 dsh 运行时 ${requestedVersion}？`,
      // W-10 S10：registry origin 经 settingsIO.current() 读（与搬迁前
      // chamberSettings.registryOrigin 同一 live holder 值——确认框展示当前源）。
      `将从 ${settingsIO.current().registryOrigin} 下载并执行白名单依赖的安装脚本；切换将在下次启动应用。`,
      '安装',
    )) return runtimeInstance.getState();
    const current = runtimeInstance.getState();
    if (runtimeOperationBusy() || current.source === 'env' || !runtimeActionAllowed('install')) {
      return current;
    }
    const lease = runtimeWriterFence.tryAcquire('runtime:install');
    if (lease === null) return runtimeInstance.getState();
    try {
      await runtimeInstance.install(requestedVersion);
      await refreshRuntimeEvidence();
      return runtimeInstance.getState();
    } finally {
      lease.release();
    }
  });
  deps.ipc.handle(IPC_CHANNELS.RUNTIME_CLEANUP_VERSION, async (args) => {
    const rawVersion = args !== null && typeof args === 'object'
      ? (args as Record<string, unknown>).version
      : undefined;
    if (typeof rawVersion !== 'string' || rawVersion.length > 128 || !isSafeVersion(rawVersion)) {
      return runtimeInstance.getState();
    }
    const requestedVersion = rawVersion.trim();
    const before = runtimeInstance.getState();
    if (runtimeOperationBusy()
      || before.source === 'env'
      || before.active === requestedVersion
      || !runtimeActionAllowed('cleanup-version')
      || !listExplicitlyInstalledVersions(runtimeBaseDir).includes(requestedVersion)) {
      return before;
    }
    if (!await confirmRuntimeMutation(
      `清理 dsh 运行时 ${requestedVersion}？`,
      '仅删除该不可变版本树并回收 pnpm store；当前、待应用、回退、known-good 与失败现场保护版本不会被删除。',
      '清理版本',
    )) return runtimeInstance.getState();

    // Re-read eligibility after confirmation. cleanupExplicitRuntimeVersion
    // re-reads the complete protection set again while the writer fence is
    // held, so a new recovery/pending reference always wins the TOCTOU race.
    const current = runtimeInstance.getState();
    if (runtimeOperationBusy()
      || current.source === 'env'
      || current.active === requestedVersion
      || !runtimeActionAllowed('cleanup-version')
      || !listExplicitlyInstalledVersions(runtimeBaseDir).includes(requestedVersion)) {
      return current;
    }
    const lease = runtimeWriterFence.tryAcquire('runtime:cleanup-version');
    if (lease === null) return runtimeInstance.getState();
    try {
      const locked = runtimeInstance.getState();
      if (locked.source === 'env'
        || locked.active === requestedVersion
        || !listExplicitlyInstalledVersions(runtimeBaseDir).includes(requestedVersion)) {
        return locked;
      }
      const result = cleanupExplicitRuntimeVersion(runtimeBaseDir, requestedVersion);
      if (result.stillProtected) {
        throw new Error(`dsh ${requestedVersion} 仍被当前/回退/恢复/失败证据保护，拒绝清理`);
      }
      await runStorePruneIfNeeded();
      await refreshRuntimeEvidence();
      const refreshed = runtimeInstance.getState();
      const clearedDiskGate = locked.phase === 'error'
        && (locked.diskLimitExceeded === true || locked.diskError != null)
        && refreshed.diskLimitExceeded === false
        && refreshed.diskError === null;
      if (clearedDiskGate) runtimeInstance.setLifecycle({ phase: 'idle', error: null });
      return runtimeInstance.getState();
    } finally {
      lease.release();
    }
  });
  // 失败现场清除（settings polish D3-A）：仅本地入口（gateway 无现成路由，
  // 登记偏差）。版本必须真实存在于失败记录名集（主进程 re-read，绝不信任
  // renderer），且不得有在飞运行时事务；只删除 failures/*.json 记录本身，
  // 不动任何版本树/快照/回滚现场。清除后刷新磁盘与失败投影并返回最新 state。
  deps.ipc.handle(IPC_CHANNELS.RUNTIME_CLEAR_FAILURE, async (args) => {
    const rawVersion = args !== null && typeof args === 'object'
      ? (args as Record<string, unknown>).version
      : undefined;
    if (typeof rawVersion !== 'string' || rawVersion.length > 128 || !isSafeVersion(rawVersion)) {
      return runtimeInstance.getState();
    }
    const requestedVersion = rawVersion.trim();
    if (runtimeOperationBusy()
      || !listRuntimeFailures(runtimeBaseDir).some((failure) => failure.version === requestedVersion)) {
      return runtimeInstance.getState();
    }
    try {
      clearRuntimeFailure(runtimeBaseDir, requestedVersion);
    } catch (error) {
      const message = sanitizeErrorText(error instanceof Error ? error.message : String(error));
      console.warn('[dsh-chamber] clear runtime failure scene failed:', message);
      throw new Error(message);
    }
    await refreshRuntimeEvidence();
    return runtimeInstance.getState();
  });
  // 周期检查装配槽（模块级导出入口 runRuntimeCheckCycle 经它调用——main 装配
  // 侧计时器 15s 首检 + 6h 周期与 RUNTIME_CHECK 注册体共用同一实现与门）。
  runtimeCheckRunner = () => {
    void runRuntimeCheck();
  };

  // —— K 组（S11 批；W-10 runtime B + W-10 收口批）——
  // runtime 6 注册体（RUNTIME_RECOVER_METADATA / RUNTIME_RESET_BUILTIN /
  // RUNTIME_RETRY_APPLY / RUNTIME_APPLY_NOW / RUNTIME_RETRY_RESTORE /
  // RUNTIME_RESTORE_PRE_ROLLBACK——按原 main.ts 顺序紧接 J 组追加）。注册体自
  // main.ts 逐字迁入（trustedIpc 围栏由装配侧注入 registrar 包装），本段为 W-10
  // 收口批：60 handler 全部注册点落位本函数，main.ts 零 ipcMain.handle。随迁内容：
  //  - 确认对话框 = 上方 J 组段 S10 版 confirmRuntimeMutation 助手（按钮序/取消
  //    默认/文案与 main 侧原闭包逐字一致；无窗 → false = 'native confirmation
  //    unavailable' 不确认语义同向）。S11 收口：main 侧同名闭包已随本批迁完删除
  //    （S10 遗留过渡双份消除，见 main.ts 原定义处注记）。
  //  - 运行时启动事务宿主 = ctx 宿主叶 runRuntimeStartup（装配侧事务本体——内部
  //    gate/fence/事务槽/abort 管理与 executeMetadataRecovery 等恢复事务腿归装配
  //    侧；槽忙守卫「返回在飞事务」随原实现逐字保留）；宿主启动门与阻塞发布叶 =
  //    ctx.setRuntimeGate / ctx.publishBlockedStartup（RESET_BUILTIN / RETRY_APPLY /
  //    RESTORE_PRE_ROLLBACK 的 blocked 发布与 gate 写与启动路径同一实现）。
  //  - 元数据恢复资格投影/事务宿主 = ctx 宿主叶 authoritativeMetadataRecoveryStatus /
  //    runUserMetadataRecovery（RECOVER_METADATA 注册体与恢复事务启动共用同一实现，
  //    语义不分叉——executeMetadataRecovery 与槽/abort 写留装配侧）。
  //  - APPLY_NOW 门：evaluateApplyNowGate = apply-now-gate.ts 纯逻辑直接 import
  //    （纯门矩阵，无宿主依赖）；门输入构造 readApplyNowGateInput 经 ctx 注入
  //    （装配侧构造——controlPlane.connectionState / envOverrideActive / 事务槽等
  //    宿主读在叶内；pending ?? journalTarget ?? overridePending 三源解析与目标树
  //    preflight 逐字保留）。quit 在途门 = quittingLeaf()（S2 装配的 ctx.isQuitting
  //    快照——原注册体 `if (quitRequested)` 逐处机械替换，同 J 组段 runRuntimeCheck
  //    「quit 门 = quittingLeaf」先例；main 侧模块级 quitRequested 直读同值）。
  //  - runtime 事务槽：`runtimeOperation !== null` 逐处机械替换为
  //    runtimeOperationBusy()（S10 读门——live 读装配侧模块级槽，同一事实源）；
  //    RESET_BUILTIN 的 queue-behind-applying 需 await 在飞事务本体（原
  //    `const inFlight = runtimeOperation` → runtimeOperationSlot.inFlight()）；
  //    RESTORE_PRE_ROLLBACK 的在飞事务登记/清槽（原 `runtimeOperation = operation`
  //    与 finally `runtimeOperation = null` → runtimeOperationSlot.begin/end）——
  //    槽本体（模块级 runtimeOperation）单写者仍归装配侧（启动事务/自动回滚/K 组
  //    经同一槽串行化，语义不分叉）。
  //  - dsh-runtime 纯逻辑直接 import（queueActivationIntent / writeActivationIntent /
  //    restoreMarkerAuthorityStatus / readActivationJournalState / writeOverride /
  //    listPreRollbackStashes / restorePreRollback——electron-free 共享核，与
  //    main.ts 同款 import 面）；selectedJournalIntent 经 ctx（装配侧启动路径
  //    readActivationFacts 共用同一实现）；bundledVersion = ctx.bundledRuntimeVersion
  //    装配期值（解构改名，注册体文本以原名逐字保留）；本机宿主停止腿 =
  //    ctx.stopLocalDsh（原 `cp.stopLocal()` 机械替换——PlaneHandle 宿主不进入
  //    core，同 restartLocalDsh 先例）。
  deps.ipc.handle(IPC_CHANNELS.RUNTIME_RECOVER_METADATA, async () => {
    const before = runtimeInstance.getState();
    const expectedStatus = authoritativeMetadataRecoveryStatus();
    // First authority read occurs before showing a destructive native
    // confirmation. A forged renderer action cannot manufacture eligibility.
    if (runtimeOperationBusy()
      || !runtimeActionAllowed('recover-metadata')
      || expectedStatus === null) return before;
    if (!await confirmRuntimeMutation(
      '保留数据并恢复内建 dsh？',
      expectedStatus === 'recovery-marker-corrupt'
        ? '将停止本地实例，另存一份完整 DSH_HOME，把损坏的恢复标记按原始字节归档且不修改既有恢复数据，再用内建 dsh 执行完整只读探针。只有探针全部通过才会恢复本地访问。'
        : '将停止本地实例，先保留 DSH_HOME 完整数据副本和原始选择元数据证据，再用内建 dsh 执行完整只读探针。只有探针全部通过才会恢复本地访问。',
      '保留数据并恢复内建',
    )) return runtimeInstance.getState();
    // Re-read after the modal. A restore marker, env override, platform
    // change, writer, or another recovery transaction always wins the race.
    if (runtimeOperationBusy()
      || !runtimeActionAllowed('recover-metadata')
      || authoritativeMetadataRecoveryStatus() !== expectedStatus) return runtimeInstance.getState();
    const operation = runUserMetadataRecovery(expectedStatus);
    if (operation === null) return runtimeInstance.getState();
    await operation;
    return runtimeInstance.getState();
  });
  deps.ipc.handle(IPC_CHANNELS.RUNTIME_RESET_BUILTIN, async () => {
    const before = runtimeInstance.getState();
    const queueBehindApplying = runtimeOperationBusy() && before.phase === 'applying';
    if ((!queueBehindApplying && runtimeOperationBusy()) || before.source === 'env' || before.hasOverride !== true
      || !runtimeActionAllowed('reset-builtin')) return before;
    if (!queueBehindApplying && restoreMarkerAuthorityStatus(runtimeBaseDir) !== 'missing') {
      setRuntimeGate(true, '数据恢复未完成；恢复内建前须先重试恢复');
      return refreshRuntimeEvidence({
        phase: 'failed', canRetryRestore: true, restoreOutcome: 'incomplete',
        error: '数据恢复未完成；恢复内建前须先重试恢复',
        runtimeBlocked: true,
        runtimeBlockedReason: '数据恢复未完成；恢复内建前须先重试恢复',
      }).then(() => runtimeInstance.getState());
    }
    if (!await confirmRuntimeMutation('恢复内建 dsh 运行时？', '将停止本地实例并清除用户运行时指针；版本树与快照仍保留。', '恢复内建')) return runtimeInstance.getState();
    const current = runtimeInstance.getState();
    const inFlight = runtimeOperationSlot.inFlight();
    const stillQueueing = inFlight !== null && current.phase === 'applying';
    if ((!stillQueueing && runtimeOperationBusy()) || current.source === 'env' || current.hasOverride !== true
      || !runtimeActionAllowed('reset-builtin')) return current;
    if (stillQueueing) {
      try {
        if (bundledVersion === null || !isSafeVersion(bundledVersion)) throw new Error('无法确认内建 dsh 运行时版本');
        queueActivationIntent(runtimeBaseDir, {
          targetVersion: bundledVersion,
          targetIsBuiltin: true,
          manualRollback: false,
          intentKind: 'reset-builtin',
        });
      } catch (error) {
        runtimeInstance.setLifecycle({
          error: sanitizeErrorText(`无法排队恢复内建事务：${error instanceof Error ? error.message : String(error)}`),
        });
        return runtimeInstance.getState();
      }
      await inFlight.catch(() => null);
      await runRuntimeStartup();
      return runtimeInstance.getState();
    }
    if (restoreMarkerAuthorityStatus(runtimeBaseDir) !== 'missing') {
      setRuntimeGate(true, '数据恢复未完成；恢复内建前须先重试恢复');
      return refreshRuntimeEvidence({
        phase: 'failed', canRetryRestore: true, restoreOutcome: 'incomplete',
        error: '数据恢复未完成；恢复内建前须先重试恢复',
        runtimeBlocked: true,
        runtimeBlockedReason: '数据恢复未完成；恢复内建前须先重试恢复',
      }).then(() => runtimeInstance.getState());
    }
    try {
      if (bundledVersion === null || !isSafeVersion(bundledVersion)) {
        throw new Error('无法确认内建 dsh 运行时版本');
      }
      writeActivationIntent(runtimeBaseDir, {
        targetVersion: bundledVersion,
        targetIsBuiltin: true,
        manualRollback: false,
        intentKind: 'reset-builtin',
      });
    } catch (error) {
      await publishBlockedStartup(`无法持久化恢复内建事务：${error instanceof Error ? error.message : String(error)}`);
      return runtimeInstance.getState();
    }
    await runRuntimeStartup();
    return runtimeInstance.getState();
  });
  deps.ipc.handle(IPC_CHANNELS.RUNTIME_RETRY_APPLY, async () => {
    const before = runtimeInstance.getState();
    if (runtimeOperationBusy() || before.source === 'env'
      || !runtimeActionAllowed('retry-apply')) return before;
    const overrideState = readOverrideState(runtimeBaseDir);
    const journalState = readActivationJournalState(runtimeBaseDir);
    const retryTarget = selectedJournalIntent(journalState)?.targetVersion
      ?? (overrideState.kind === 'valid' ? overrideState.record.pending : null);
    if (retryTarget === null) return runtimeInstance.getState();
    if (!await confirmRuntimeMutation(`重试应用 dsh ${retryTarget}？`, '将停止本地实例并从持久化事务安全续作。', '重试应用')) return runtimeInstance.getState();
    const current = runtimeInstance.getState();
    if (runtimeOperationBusy() || current.source === 'env'
      || !runtimeActionAllowed('retry-apply')) return current;
    const latestOverride = readOverrideState(runtimeBaseDir);
    if (latestOverride.kind === 'valid') {
      writeOverride(runtimeBaseDir, {
        ...latestOverride.record,
        swapAttempted: false,
        lastOutcome: null,
        lastError: null,
      });
    }
    await runRuntimeStartup();
    return runtimeInstance.getState();
  });
  // Apply-now 入口语义（原 main.ts readApplyNowGateInput 上方注释——本文件只挂
  // 注册体；完整注记随 readApplyNowGateInput 留 main 装配侧，见 K 组段头注释）。
  deps.ipc.handle(IPC_CHANNELS.RUNTIME_APPLY_NOW, async () => {
    const before = runtimeInstance.getState();
    // Quit is in flight: never start a transaction that the quit path will
    // immediately abort (same gate as runRuntimeCheck——W-10 S10：runRuntimeCheck
    // 已随 RUNTIME_CHECK 注册体迁入 shell-core J 组段，同门语义不变）。
    if (quittingLeaf()) return before;
    const gate = evaluateApplyNowGate(readApplyNowGateInput());
    // F5: without a durable pending transaction a startup would only stop
    // and respawn the instance pointlessly. A snapshot-failed override must
    // be retried through the dedicated retry-apply path instead; a corrupt
    // target tree is rejected before any stopLocal is attempted.
    if (!gate.ok) return before;
    if (!await confirmRuntimeMutation(
      `立即切换到 dsh ${gate.target}？`,
      'dsh 将立即重启并切换到该版本（约 30–90 秒）。进行中的会话会中断，你的数据不受影响；若切换失败，dsh 会自动回滚并保留现场。',
      '立即应用并重启',
    )) return runtimeInstance.getState();
    // TOCTOU: re-read the full gate after the modal, exactly like retry-apply.
    // The input builder is identical to the first gate, so the second gate
    // covers the override.pending fallback and tree preflight too.
    const current = runtimeInstance.getState();
    const secondGate = evaluateApplyNowGate(readApplyNowGateInput());
    // The confirm dialog named gate.target: a re-read that resolves a
    // different target must not start a transaction for a version the user
    // never confirmed.
    if (!secondGate.ok || secondGate.target !== gate.target) return current;
    await runRuntimeStartup();
    return runtimeInstance.getState();
  });
  deps.ipc.handle(IPC_CHANNELS.RUNTIME_RETRY_RESTORE, async () => {
    const before = runtimeInstance.getState();
    if (runtimeOperationBusy()
      || !runtimeActionAllowed('retry-restore')) return before;
    if (!await confirmRuntimeMutation('重试恢复 dsh 数据？', '将停止本地实例并从已记录的快照事务继续恢复。', '重试恢复')) return runtimeInstance.getState();
    const current = runtimeInstance.getState();
    if (runtimeOperationBusy()
      || !runtimeActionAllowed('retry-restore')) return current;
    await runRuntimeStartup();
    return runtimeInstance.getState();
  });
  deps.ipc.handle(IPC_CHANNELS.RUNTIME_RESTORE_PRE_ROLLBACK, async (args) => {
    // Only a stash-shaped basename is accepted; the main process re-validates
    // it against its own private pre-rollback listing before any mutation.
    const stashName = args !== null && typeof args === 'object'
      ? (args as Record<string, unknown>).stashName
      : undefined;
    if (typeof stashName !== 'string' || !/^\d{13}-[0-9a-f]{8}$/.test(stashName)) {
      return runtimeInstance.getState();
    }
    const before = runtimeInstance.getState();
    if (runtimeOperationBusy()
      || !runtimeActionAllowed('restore-pre-rollback')) return before;
    if (!await confirmRuntimeMutation(
      '恢复回滚前数据？',
      '将停止本地实例，把当前 DSH_HOME 保留为 dsh-home.old，再用最近一次手动回滚前保存的数据覆盖恢复。恢复事务崩溃安全，可在下次启动续作。',
      '恢复回滚前数据',
    )) return runtimeInstance.getState();
    const current = runtimeInstance.getState();
    if (runtimeOperationBusy()
      || !runtimeActionAllowed('restore-pre-rollback')) return current;

    const restoreResult: {
      outcome: 'complete' | 'half' | 'incomplete' | 'blocked'
      error: string | null
    } = { outcome: 'blocked', error: null };
    const operation = (async (): Promise<StartupResult | null> => {
      const lease = runtimeWriterFence.tryAcquire('runtime:restore-pre-rollback');
      if (lease === null) return null;
      try {
        const stashes = await listPreRollbackStashes(runtimeBaseDir);
        if (!stashes.includes(stashName)) {
          throw new Error('回滚前数据暂存已不存在或不可信');
        }
        await stopLocalDsh();
        restoreResult.outcome = await restorePreRollback(runtimeBaseDir, localDshHome, stashName);
      } finally {
        lease.release();
      }
      return null;
    })().catch(async (error) => {
      await stopLocalDsh().catch(() => undefined);
      // Recorded, not hard-blocked: the startup transaction below restarts
      // the instance (a thrown transaction leaves a resumeable marker).
      restoreResult.error = sanitizeErrorText(error instanceof Error ? error.message : String(error));
      return null;
    }).finally(() => {
      runtimeOperationSlot.end();
    });
    runtimeOperationSlot.begin(operation);
    await operation;
    if (restoreResult.outcome === 'blocked') return runtimeInstance.getState();
    // A 'half' restore leaves the durable marker for retry-restore to resume
    // (the standard restore-half convention).
    if (restoreResult.outcome === 'half') {
      await publishBlockedStartup('恢复回滚前数据未完成（现场已保留），请重试恢复', {
        restoreOutcome: 'half',
        canRetryRestore: true,
      });
      return runtimeInstance.getState();
    }
    if (restoreResult.outcome === 'incomplete') {
      // The stash was missing/untrustworthy, so DSH_HOME was never touched.
      // Restart the instance (never a hard block), then THROW so the
      // renderer surfaces the failure in its persistent action-error slot —
      // a silent restart would hide the rejection from the user.
      await runRuntimeStartup();
      throw new Error('回滚前数据暂存缺失或不可信；拒绝恢复');
    }
    if (restoreResult.error !== null) {
      await runRuntimeStartup();
      throw new Error(`恢复回滚前数据失败：${restoreResult.error}`);
    }
    // 'complete': restart the local instance against the restored data.
    await runRuntimeStartup();
    return runtimeInstance.getState();
  });

  // ③ W-10 收口注记（60 handler 已全部经 installIpcHandlers 注册：main.ts 仅剩
  //    装配/窗口 glue/生命周期/启动事务宿主——控制面 ready 后的启动/恢复 push 与
  //    OS 三入口 glue 本就是装配侧宿主职责，见 main.ts 顶部职责清单；Swift
  //    sidecar flavor 装配点与 HostEdges 余下边沿叶属 W-10 之外后续批，
  //    见 macos-swift-v1.md §四批 2）。
}
