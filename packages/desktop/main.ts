/**
 * dsh-chamber desktop main process (design 05, connection-manager form).
 *
 * The single window loads the control plane origin directly
 * (loadURL http://127.0.0.1:<cp.port>/) — one frame, one origin; the
 * control plane serves the built dsh frontend (webDistDir = <pkg>/dist/web in
 * dev and packaged alike — P2-4 renderer/dist isolation — design 05 §7.1) and proxies every instance over
 * /api/i/<id>/*. There are no injected connection adapters anymore: remote
 * instances reach the control plane through registerInstanceTransport /
 * unregisterInstanceTransport (design 03 §2.2), driven by the transport
 * manager's ready phase — the transport URL stays in the main process and
 * never enters a renderer payload (design 05 §8).
 *
 * Responsibilities:
 * - Single-frame BrowserWindow (contextIsolation, no nodeIntegration).
 * - Control plane lifecycle: spawn on ready, stop() on will-quit.
 * - Transport manager (transport-manager.ts + the `ssh` and direct `gateway`
 *   providers): persisted instance registry (<userData>/ssh-instances.json),
 *   transport lifecycle, and SSH-only remote systemd exec.
 * - Transport registration: ready transport → registerInstanceTransport
 *   ('<kind>:<id>', readyUrl); leaving ready → unregisterInstanceTransport.
 *   (design 03 §2.2, driven by transport-manager + the `ssh` provider's
 *   tunnel phase).
 * - IPC (preload whitelist, design 05 §7.4): dsh-chamber:info, the
 *   desktop_ssh_* surface incl. start/stop/is-active, status pushes.
 * - Tray (packaged only, defensive), single-instance lock.
 */

import { app, BrowserWindow, crashReporter, dialog, ipcMain, Menu, Tray, nativeImage, powerMonitor, powerSaveBlocker, safeStorage, session, shell } from 'electron';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, promises as fsp } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PlaneHandle } from '@dsh-chamber/control-plane';
import { attemptCommittedRegistryPush, computeRemovedInstanceIds, computeRetiredInstanceIds, createTransportManager } from './transport-manager.ts';
import type { TransportManager } from './transport-manager.ts';
import type { TransportInstanceSpec } from './transport-provider.ts';
import { sshProvider, probeClientGraphLive, probeGitWorktreeLive } from './ssh-provider.ts';
import { cleanupStaleAskpassHelpers, configureSshPasswordStore } from './ssh-provider.ts';
import { applyWindowsAclTightening } from './win-acl.ts';
import { configureGatewaySecretStore, configureGatewaySessionProvider, gatewayProvider, getGatewayPassword, getGatewayToken, syncGatewayChamberPlugins } from './gateway-provider.ts';
import type { LocalChamberHostPackage } from './gateway-provider.ts';
import { setGatewaySyncRegistration } from './gateway-sync-registry.ts';
import { createGatewaySessionManager, gatewayRegistrationAuthHeaders, gatewaySessionScopeForConnection } from './gateway-session.ts';
import { createGatewaySessionRefresh, gatewaySessionOriginForUrl, gatewayTunnelAuthority } from './gateway-session-refresh.ts';
import type { GatewaySessionRefresh } from './gateway-session-refresh.ts';
import { appendAuditEvent, configureAuditLog, type AuditEvent } from './audit-log.ts';
import type { GatewayRegistrationAuthProof, GatewaySessionManager } from './gateway-session.ts';
import { createTrustedIpc, isExternalLinkUrl, isTrustedIpcSender, isTrustedRendererUrl } from './renderer-trust.ts';
import { call, createControlPlane } from './control-plane-module.ts';
import {
  attemptDeepLinkProtocolRegistration,
  BoundedVscodeIntentQueue,
  canRestoreMainWindow,
  decideDeepLinkProtocolRegistration,
  describeUnknownError,
  detectVscodeAvailability,
  ensureLinuxProtocolDesktopFile,
  linuxAutostartDesktopEntry,
  linuxAutostartDirectory,
  parseOpenVscodeIntent,
  resolveLinuxLaunchExecutable,
  runVscodeLaunch,
} from './deep-link.ts';
import type { VscodeLaunchContext } from './deep-link.ts';
import { classifyLocalPath, invokeOpenPath, listOpenInApps, runOpenInLaunch } from './open-in.ts';
import type { OpenInLaunchContext, OpenInRequest } from './open-in.ts';
import { createUpdateController, openReleasePage } from './updater.ts';
import { DEFAULT_RUNTIME_LOGICAL_DISK_LIMIT_BYTES, DshRuntimeController } from './dsh-runtime-controller.ts';
import type { RuntimeMetadataComponent, RuntimeMetadataHealthProjection } from './dsh-runtime-controller.ts';
import { disposeRuntimeInstaller, fetchRegistryMetadata, installRuntimeVersion, pruneRuntimeStore } from '@dsh-chamber/dsh-runtime';
import { sanitizeErrorText } from './sanitize-error.ts';
import { evaluateApplyNowGate, type ApplyNowGateInput } from './apply-now-gate.ts';
import { shouldSkipDiskRefresh } from './disk-evidence-gate.ts';
import {
  cleanupStaleInstalls,
  cleanupExplicitRuntimeVersion,
  clearActivationJournal,
  clearCurrentPointer,
  clearRuntimeFailure,
  clearStorePruneRequest,
  createCoalescedRefresher,
  deleteOverride,
  evictVersions,
  latestKnownGood,
  listKnownGoodVersions,
  listExplicitlyInstalledVersions,
  listRuntimeFailures,
  listValidVersionTrees,
  queueActivationIntent,
  readActivationJournalState,
  readCurrentPointer,
  readCurrentPointerState,
  readOverride,
  readOverrideState,
  readStorePruneRequest,
  recordExplicitInstall,
  recordRuntimeFailure,
  runtimeDiskSummaryAsync,
  runtimeFailureSummary,
  validateVersionTree,
  writeActivationIntent,
  writeActivationJournal,
  writeCurrentPointer,
  writeOverride,
} from '@dsh-chamber/dsh-runtime';
import type { ActivationJournalState } from '@dsh-chamber/dsh-runtime';
import {
  completeInterruptedRestore,
  listPreRollbackStashes,
  prepareManualRollbackData,
  pruneRuntimeSnapshots,
  resolveSnapshotName,
  restoreMarkerAuthorityStatus,
  restorePreRollback,
  restoreSnapshot,
  snapshotDshHome,
  snapshotSummary,
} from '@dsh-chamber/dsh-runtime';
import {
  noteBoot,
  promoteDueCandidates,
  recordProbePass,
  removeKnownGoodCandidate,
  resetCandidateHealthWindow,
} from '@dsh-chamber/dsh-runtime';
import { effectivePending, invalidate } from '@dsh-chamber/dsh-runtime';
import {
  FATAL_STARTUP_BLOCK_REASONS,
  runDelayedRollback,
  runStartupPhase,
  shouldProbeEnvWithDormantCorruptSelection,
  type StartupDeps,
  type StartupResult,
} from '@dsh-chamber/dsh-runtime';
import { planRestartExhaustedRollback } from '@dsh-chamber/dsh-runtime';
import { RuntimeOperationFence, type OperationLease } from '@dsh-chamber/dsh-runtime';
import { runRuntimeActivationProbes } from '@dsh-chamber/dsh-runtime';
import {
  detectRuntimeMetadataHealth,
  inspectCorruptMetadataRecoveryMarker,
  recoverRuntimeMetadata,
  rescueCorruptMetadataRecoveryMarker,
  type RuntimeMetadataHealth,
} from '@dsh-chamber/dsh-runtime';
import { allowedActions } from '@dsh-chamber/dsh-runtime';
import { isSafeVersion } from '@dsh-chamber/dsh-runtime';
import {
  ARCHIVE_CLEANUP_INSERT_ID,
  ARCHIVE_CLEANUP_PACKAGE_NAME,
  CLIENT_GRAPH_INSERT_ID,
  CLIENT_GRAPH_PACKAGE_NAME,
  ExactOwnershipRegistry,
  GIT_WORKTREE_INSERT_ID,
  GIT_WORKTREE_PACKAGE_NAME,
  remoteHome,
  ReadyPhaseEdges,
  reapStaleLocalPluginWriters,
  seedRemoteChamberHostPackages,
  disposePluginSyncChildren,
  scopeExecToOwnership,
} from './plugin-sync.ts';
import type { ChamberHostPackageSeed, ExecFn, StatusFn, RemoteSpec } from './plugin-sync.ts';
import {
  DEFAULT_CHAMBER_SETTINGS,
  computeQuitRisk,
  readSettingsFile,
  shouldHideToTray,
  writeSettingsFile,
} from './chamber-settings.ts';
import type { ChamberSettings } from './chamber-settings.ts';
import {
  isValidNotificationSourceFingerprint,
  shouldFocusApplicationBeforeShowing,
} from './notifications.ts';
import type { NotificationSourceToken } from './notifications.ts';
import { IPC_CHANNELS } from './ipc-events.ts';
// —— W-10 S6：ssh-apply-rows（buildSshApplyRows / describeReservedNameRefusal /
// buildSshUndoDecision / describeSshUndoConfirmation）全部调用点随 F 组注册体
// 迁入 shell-core（core 直接 import），本文件 import 随迁移除——
import { createSshPluginJournal } from './ssh-plugin-journal.ts';
import {
  auditLogFilePath,
  chamberSettingsFilePath,
  gatewaySecretsFilePath,
  instancesFilePath,
  LOCAL_RUNNING_STATES,
  localDshHomeDir,
  proxyTransport,
  QUIT_CLEANUP_TIMEOUT_MS,
  readDshVersion,
  resolveActiveRuntime,
  resolveControlPlanePort,
  scanDeepLinkUrls,
  sshPasswordsFilePath,
  stateRootDir,
  installIpcHandlers,
  captureNotificationSource,
  clearBadgeIntentForQuit,
  enqueueRendererDeepLinkIntent,
  matchesNotificationSource,
  onRendererLifecycle,
  ownsNotificationSource,
  projectInstanceSecrets,
  projectNotificationSourceInstances,
  syncNotificationSourceRegistry,
} from './shell-core.ts';
import type { ShellAssemblyCtx } from './shell-core.ts';
import { createElectronEdges } from './electron-edges.ts';

// Last-resort crash boundary. Expected socket/stream failures are handled at
// their owners; an unknown uncaught exception means the privileged main
// process may be inconsistent and must fail closed rather than keep serving
// IPC, transports and persistence from an indeterminate state.
let fatalExceptionInProgress = false;
function fatalMainError(reason: unknown): void {
  if (fatalExceptionInProgress) {
    try { process.abort(); } catch { /* no further recovery is trustworthy */ }
    return;
  }
  // Claim terminal ownership before any formatting/logging/host call: every
  // one of those boundaries can itself throw and must not recurse through an
  // apparently-unclaimed fatal path.
  fatalExceptionInProgress = true;
  let detail = 'unknown error';
  try { detail = describeUnknownError(reason); } catch { /* formatter is intended safe; retain belt-and-suspenders fallback */ }
  try { console.error('[dsh-chamber] fatal main-process error:', detail); } catch { /* console host boundary */ }
  try {
    app.exit(1);
    return;
  } catch {
    try { process.abort(); } catch { /* process is already terminally inconsistent */ }
  }
}
process.on('uncaughtException', (error) => {
  fatalMainError(error);
});
process.on('unhandledRejection', (reason) => {
  fatalMainError(reason);
});

// 本地崩溃记录（不上传）：主/渲染/GPU 等进程崩溃时由 Crashpad 落盘到
// <userData>/Crashpad——崩溃是静默的，没有本地记录就只能靠系统
// DiagnosticReports 事后考古"前端消失/白屏"类问题。uploadToServer=false
// 时 submitURL 可省略（仅上传时使用）。
crashReporter.start({
  productName: 'dsh-chamber',
  companyName: 'dsh-chamber',
  uploadToServer: false,
});

// 诊断留痕：GPU/Utility 等子进程异常退出（渲染进程由窗口级
// render-process-gone 恢复逻辑覆盖，不在此重复记录）。
app.on('child-process-gone', (_event, details) => {
  if (details.type === 'GPU' || details.type === 'Utility') {
    console.error(
      `[dsh-chamber] 子进程退出：type=${details.type} reason=${details.reason} exitCode=${details.exitCode} name=${details.name ?? ''}`,
    );
  }
});

const pkgDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(pkgDir, '..', '..');
const { version } = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));

// —— W-10 S6：插件源一体化 picker（PluginSourcePick + pickPluginSource——
// folder|.tgz 双模式、darwin 一体语义）已迁 electron-edges.ts 的 HostEdges
// pickPluginSource 宿主腿（原函数体逐字随迁；宿主 back-ref host.mainWindow()
// = 原 mainWindow 实参）。core 侧 ssh 插件材料化 pick 注册体经 edges 调用；
// 本文件余下的 gateway/local 调用点同改 edges.pickPluginSource()。——

function resolveBuiltinDshWorkspace(): string | null {
  if (app.isPackaged) {
    const bundled = path.join(process.resourcesPath, 'vendor', 'dsh');
    return existsSync(bundled) ? bundled : null;
  }
  for (const candidate of [
    path.join(repoRoot, 'ref-dsh'),
    path.join(pkgDir, 'vendor', 'dsh'),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const builtinDshWorkspace = resolveBuiltinDshWorkspace();
if (builtinDshWorkspace === null) {
  console.warn(
    '[dsh-chamber] 未找到 dsh 工作区（DSH_CHAMBER_DSH_PATH / <repoRoot>/ref-dsh / <pkg>/vendor/dsh 均不可用），连接页将显示错误',
  );
}

let mainWindow: BrowserWindow | null = null;
let controlPlane: PlaneHandle | null = null;
let transportManager: TransportManager | null = null;
// Gateway password-session manager (design 17 §7.1/§9.3, gateway-session.ts):
// the login exchange + the 12h session cookie, held in main-process memory
// only (never logged, never persisted, never renderer-visible). Created at
// startup, disposed on will-quit (cookie cache is pure memory — the dispose
// is hygiene, not a secret-persistence concern).
let gatewaySessions: GatewaySessionManager | null = null;
// Pre-expiry session refresh (design 17 §9.3 live-proxy self-healing,
// gateway-session-refresh.ts): re-logins each REGISTERED password-authenticated
// gateway target ~60s before its session expires and re-registers the
// transport with the fresh cookie — a healthy transport never rides an
// expired cookie (the ready registration's headers would otherwise answer 401
// until a reconnect). Armed on ready, disarmed on leaving ready/removal/quit.
let sessionRefresh: GatewaySessionRefresh | null = null;
let tray: Tray | null = null;
// 当前窗口 URL（控制面 origin，控制面启动后赋值）。窗口被关闭后可据此
// 重建（macOS activate 路径）——没有它，窗口一旦关闭应用就永久无窗。
let mainWindowUrl: string | null = null;

// W-10 S2：主窗口 'show' 事件订阅面（HostEdges.onMainWindowShown 的装配侧注册
// 点——createMainWindow glue 对每窗挂接，mainWindow===win 身份守卫在 glue；core
// 的 held-resume 补发经 createElectronEdges 的 onMainWindowShown 订阅）。
const mainWindowShownSubscribers = new Set<() => void>();

// Chamber settings (design 14 D7, v1 scope): loaded at startup from
// <userData>/chamber-settings.json, mutated via dsh-chamber:settings-set. The
// side effects (keep-awake / login autostart / close behavior) are applied
// here in the main process — never in any instance's dsh home (01 §2 P2).
let chamberSettings: ChamberSettings = { ...DEFAULT_CHAMBER_SETTINGS };
let keepAwakeBlockerId: number | null = null;
// Quit state machine (design 14 D2): quitRequested 置位后关窗不再 hide（真正
// 退出在途）；quitConfirmed 表示退出已获确认/豁免；confirmingQuit 是确认
// 对话框单飞闸（防连点/双路径重复弹窗）。
let quitRequested = false;
let quitConfirmed = false;
let confirmingQuit = false;
let quitCleanupInProgress = false;

// VS Code 深链（design 16 §4.2）：OS 级深链（macOS open-url / Win+Linux
// second-instance argv / 冷启动 argv）统一入有界、归一化 single-flight 队列，
// startup 完成后顺序 drain。key = (instanceId,path)，因此 open-url/argv 的不同
// URL 拼写仍会合并；complete 后允许用户稍后主动再次打开同一目标。
// drainPendingIntents 在 whenReady 内赋值（依赖 wiredCtx/transportManager），
// 冷启动到达的深链只入队、drain 就绪后消费。
// W-10 S2 决策：本队列（VS Code 启动消费循环）与 enqueueDeepLink 留在 main 至
// S9——renderer 侧 hold/replay 队列（pendingRendererIntents + drain）与来源代际
// 实例已迁 shell-core（W-10 S2 段），OS 三入口（open-url / second-instance /
// 冷启动 argv）继续经本地 enqueueDeepLink 入队。
const pendingIntents = new BoundedVscodeIntentQueue(64);
let drainPendingIntents: (() => void) | null = null;
let drainingPendingIntents = false;

// —— W-10 S2：原模块级渲染器投递状态在此删去（已迁 shell-core.ts「Renderer
// delivery state machines」段：pendingRendererIntents / pendingNotificationOpens
// 及 ready 位/drain/来源代际实例/held lastResume/badge 意图 holder；main.ts 经
// 导出入口访问——onRendererLifecycle / enqueueRendererDeepLinkIntent /
// captureNotificationSource / ownsNotificationSource / matchesNotificationSource
// / projectNotificationSourceInstances / syncNotificationSourceRegistry /
// clearBadgeIntentForQuit）——

/** 深链入队：quit 在途 ignore（不启动 VS Code）；归一化目标 single-flight；解析失败 loud。 */
function enqueueDeepLink(rawUrl: string): void {
  if (quitRequested) return;
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

/** Hold a successful launch intent until the current renderer explicitly says
 * its onIntent listener is installed. Used by both OS deep links and open-in.
 * W-10 S2 决策：本函数留在 main——唯一依赖 transportManager registry 查找
 * （装配侧所有物）；来源代际捕获改经 core 的 captureNotificationSource 代理
 * （NotificationSourceIncarnations 实例已迁 shell-core）。S9 消费循环迁 core 时
 * 随迁或参数化。 */
function captureVscodeSource(instanceId: string): NotificationSourceToken | null {
  if (instanceId === 'local') return captureNotificationSource('local');
  const instance = transportManager?.listInstances().find(candidate => candidate.id === instanceId);
  return instance === undefined
    ? null
    : captureNotificationSource(`${instance.kind}-${instance.id}`);
}

// Update controller ref (created in whenReady): the quit-confirmation exemption
// (design 14 D2) reads its state at will-quit time.
let updateController: { state(): { phase: string; installBlockedReason: string | null } } | null = null;
// dsh runtime version controller (design 18 M2): module-level ref so the
// settings「dsh 运行时」block's install/check/reset always reach the same
// instance; state pushes go to the (single) main window.
// Keep-alive binding: the controller is created per session and pushes
// state itself; this module-level ref is intentionally write-only (it keeps
// the instance alive across IPC handler closures). `void` marks the intent
// for noUnusedLocals.
let runtimeController: DshRuntimeController | null = null
void runtimeController
// Runtime lifecycle gate. Renderer REST starts and desktop pre-starts share
// the same control-plane guard; only the startup transaction may temporarily
// open the internal path while applying/restoring.
let runtimeStartBlocked = true;
let runtimeStartBlockedReason = '正在确认 dsh 运行时安全状态';
let runtimeInternalStart = false;
// Exact workspace selected by the privileged activation transaction. It is
// consulted only while public starts remain blocked; normal resolution never
// trusts this transient value.
let runtimeTransactionWorkspace: string | null = null;
let runtimeOperation: Promise<StartupResult | null> | null = null;
let runtimeOperationAbort: AbortController | null = null;
let willQuitCleanupComplete = false;

/**
 * Minimal tray（桌面一体形态的最小托盘：状态 tooltip + 显示/退出菜单）: status
 * tooltip + show/quit menu. Defensive by construction — only created when
 * packaged and an icon resource exists; any failure skips the tray with a
 * log and never blocks startup. The packaged icon resource is icon.png
 * (extraResources); dev checkouts log the skip reason and do nothing.
 */
function maybeCreateTray(cp: PlaneHandle) {
  if (!app.isPackaged) {
    console.log('[dsh-chamber] 跳过托盘：开发模式（app.isPackaged=false）');
    return;
  }
  // 打包闭包 P2（STATUS）：候选路径收敛到真实打包资源 resources/icon.png
  // （extraResources 将 resources/icon.png 拷入 resources/ 根）；原先的
  // resourcesPath/icons/tray.png 与 resourcesPath/tray.png 永不随包（两条
  // 永不命中路径）。未来引入专用托盘图标资产时改这里。
  const candidates = [
    path.join(process.resourcesPath, 'icon.png'),
  ];
  const iconPath = candidates.find((candidate) => existsSync(candidate));
  if (iconPath === undefined) {
    console.warn('[dsh-chamber] 未找到托盘图标资源（resourcesPath/icon.png），跳过托盘');
    return;
  }
  try {
    const image = nativeImage.createFromPath(iconPath);
    if (image.isEmpty()) throw new Error('icon image is empty');
    tray = new Tray(image);
    tray.setToolTip(`dsh-chamber · 控制面 http://127.0.0.1:${cp.port} · ${cp.connectionState}`);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: '显示窗口',
          click: () => showMainWindow(),
        },
        { type: 'separator' },
        // Quit goes through before-quit (confirmation / update exemption) →
        // will-quit cleanup (disposeAsync + cp.stop()) path.
        { label: '退出 dsh-chamber', click: () => app.quit() },
      ]),
    );
    console.log('[dsh-chamber] 托盘已创建');
  } catch (error) {
    tray = null;
    console.warn('[dsh-chamber] 托盘创建失败，跳过：', describeUnknownError(error));
  }
}

/**
 * 深链协议注册（design 16 §4.3 / 21 M4）：`app.isPackaged` 门控——开发态注册
 * 会把裸 Electron 注册成 scheme handler，污染 LaunchServices/注册表，与打包
 * 版身份冲突（镜像托盘先例）。打包 Linux/macOS/Windows 都使用无 relaunch
 * args 形态——argv[1] 可能正是本次冷启动 URL，绝不能将它固化到后续协议启动；
 * macOS 打包版另由 electron-builder `protocols` 键自动生成 CFBundleURLTypes，
 * Windows NSIS 安装器可能同样写 HKCU\Software\Classes（M0.5 实证项），此处
 * setAsDefaultProtocolClient 统一兜底（同目标幂等）。失败 loud，绝不打断启动。
 */
function registerDeepLinkProtocol(): void {
  const decision = decideDeepLinkProtocolRegistration({ isPackaged: app.isPackaged, platform: process.platform });
  if (decision.action === 'skip') return;
  // Packaged Linux is the same no-args form as packaged macOS. argv[1] may be
  // the cold-start protocol URL; persisting it as a relaunch arg poisons all
  // subsequent launches. The executable+script form is only for defaultApp
  // development, and development registration is deliberately gated off.
  // Linux additionally rewrites the per-user handler entry on EVERY launch
  // (design 21): the entry must target the running AppImage ($APPIMAGE), and
  // an upgraded AppImage changes path — a stale Exec would silently break
  // `dsh-chamber://` after the next upgrade.
  if (process.platform === 'linux') {
    const launchExecutable = resolveLinuxLaunchExecutable({ execPath: process.execPath });
    const ensured = ensureLinuxProtocolDesktopFile({
      executable: launchExecutable,
    });
    if (!ensured.ok) {
      console.error(`[dsh-chamber] Linux 协议 .desktop 写入失败：${ensured.error}`);
    }
    // Electron's Linux setAsDefaultProtocolClient resolves the handler
    // .desktop through $CHROME_DESKTOP (g_desktop_app_info_new); the AppImage
    // runtime usually does not export it, so point it at OUR per-user entry
    // unless the launcher already chose one. Electron never creates/overwrites
    // desktop files itself — the write above is the registration carrier.
    process.env.CHROME_DESKTOP ??= 'dsh-chamber.desktop';
  }
  const result = attemptDeepLinkProtocolRegistration(() => app.setAsDefaultProtocolClient('dsh-chamber'));
  if (!result.ok) {
    console.error(`[dsh-chamber] 深链协议注册失败：${result.error}`);
  }
}

/**
 * 显示/恢复主窗口；窗口已不存在（被关闭）时按控制面 origin 重建。Dock
 * 图标点击（macOS activate）、二次启动（second-instance）与托盘菜单共用
 * 这一条恢复路径——没有重建分支时，窗口一旦关闭应用就以无窗口状态常驻，
 * 点任何入口都毫无反应。
 */
function showMainWindow(): boolean {
  if (!canRestoreMainWindow(quitRequested)) return false;
  if (shouldFocusApplicationBeforeShowing(process.platform)) {
    try {
      app.focus({ steal: true });
    } catch (error) {
      console.warn('[dsh-chamber] macOS 应用聚焦失败，继续恢复窗口：', describeUnknownError(error));
    }
  }
  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return true;
  }
  if (mainWindowUrl !== null) {
    createMainWindow(mainWindowUrl, false);
    return true;
  }
  return false;
}

// —— W-10 S2：isAnyWindowFocused（→ edges.isFocused，electron-edges）、
// pushHeldSystemResume + held lastResume（→ shell-core 投递状态机，SYSTEM_RESUME
// 经 edges.rendererPush 推送）与 maybeShowNativeNotification（NOTIFY 主链路 →
// installIpcHandlers；宿主腿 = electron-edges showNativeNotification /
// notificationSupported）随 B 组批迁出，定义见 shell-core.ts 同段——
/** keep-awake（design 14 D5）：powerSaveBlocker prevent-app-suspension。 */
function setKeepAwakeActive(enabled: boolean): void {
  const current = keepAwakeBlockerId;
  const isActive = current !== null && powerSaveBlocker.isStarted(current);
  if (enabled) {
    if (!isActive) {
      keepAwakeBlockerId = powerSaveBlocker.start('prevent-app-suspension');
    }
    return;
  }
  if (isActive && current !== null) {
    powerSaveBlocker.stop(current);
    keepAwakeBlockerId = null;
  }
}

/**
 * 登录自启（design 14 D6）：macOS setLoginItemSettings；Linux XDG autostart
 * （手写最小 .desktop）；Windows setLoginItemSettings（HKCU Run 键,design 21
 * M4 解锁）。卸载残留由 NSIS 卸载段清理（scripts/nsis-uninstall-cleanup.nsh）。
 * 失败 loud 返回 {error}，绝不静默假成功。
 */
function applyLaunchAtLogin(enabled: boolean): { ok: true } | { ok: false; error: string } {
  try {
    if (process.platform === 'darwin' || process.platform === 'win32') {
      // Windows 上 Electron 写入 HKCU\...\Run（当前用户,无需管理员）;路径为
      // process.execPath(打包态=dsh-chamber.exe)。开发态同样可用,但仅打包
      // 形态属于产品承诺(design 14 D6 / 21 M4)。
      app.setLoginItemSettings({ openAtLogin: enabled });
      return { ok: true };
    }
    // Linux XDG autostart (design 14 D6 / 21): honor an absolute
    // XDG_CONFIG_HOME and target the RUNNING AppImage ($APPIMAGE) —
    // process.execPath under an AppImage is the per-launch squashfs mount,
    // dead after reboot.
    const autostartDir = linuxAutostartDirectory();
    const desktopFile = path.join(autostartDir, 'dsh-chamber.desktop');
    if (enabled) {
      const entry = linuxAutostartDesktopEntry({
        executable: resolveLinuxLaunchExecutable({ execPath: process.execPath }),
      });
      if (entry === null) {
        return { ok: false, error: 'refusing autostart entry for non-absolute executable' };
      }
      mkdirSync(autostartDir, { recursive: true });
      writeFileSync(desktopFile, entry, { mode: 0o600 });
    } else {
      rmSync(desktopFile, { force: true });
      // Env-change hygiene: if the autostart entry was written under the
      // OTHER XDG_CONFIG_HOME resolution (or by the pre-design-21 fixed
      // ~/.config path), remove it there too — disabling must never leave a
      // live entry behind with a silent ok:true.
      const legacyFile = path.join(os.homedir(), '.config', 'autostart', 'dsh-chamber.desktop');
      if (legacyFile !== desktopFile) rmSync(legacyFile, { force: true });
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: describeUnknownError(error) };
  }
}

/**
 * OS 唤醒即时重探（design 14 D4，主进程侧）：只触碰瞬时失败的实例——
 * phase=error/degraded 且 **非终态**（requiresUserAction=false；认证失败/
 * verifyUp 终态等确定性错误绝不自动重试，05 §7.6 纪律）；**绝不触碰 idle**
 * （保持手动断开语义）。connect() 对 connecting/ready 幂等，重复唤醒无副作用。
 */
function reconnectStaleTransports(): void {
  // 2026-08 review NIT：退出在途（will-quit 的 disposeAsync 已开始）时 OS
  // 唤醒不得再 spawn 新传输——否则可能在 dispose 完成后留下孤儿 ssh 子进程
  // （SIGKILL 升级计时器 unref 后随退出丢失）。
  if (quitRequested) return;
  const sm = transportManager;
  if (sm === null) return;
  for (const instance of sm.listInstances()) {
    const status = sm.status(instance.id);
    if (status === null) continue;
    if (status.phase !== 'error' && status.phase !== 'degraded') continue;
    if (status.requiresUserAction === true) continue;
    try {
      sm.connect(instance.id);
    } catch (error) {
      console.warn(`[dsh-chamber] 唤醒重探 ${instance.id} 失败：`, error);
    }
  }
}

/**
 * 渲染进程崩溃/卡死恢复（有界自动重载）：`render-process-gone` 或长时间
 * 无响应 → 60s 窗口内至多重载 3 次，超出即大声失败（错误框一次，绝不静默
 * 白屏）。正常退出（clean-exit，如用户关窗）不重载。
 */
function installRendererRecovery(win: BrowserWindow): void {
  let reloadCount = 0;
  let reloadWindowStart = 0;
  // 首次加载完成标志：dsh 前端 boot（加载数十个插件模块）期间渲染进程
  // 主线程长时间忙碌是合法的，unresponsive 只在"已成功加载过"之后才触发
  // 重载，避免打断正常启动。
  let loadedOnce = false;
  let unresponsiveTimer: NodeJS.Timeout | null = null;
  let crashReloadTimer: NodeJS.Timeout | null = null;
  const clearUnresponsiveTimer = (): void => {
    if (unresponsiveTimer === null) return;
    clearTimeout(unresponsiveTimer);
    unresponsiveTimer = null;
  };
  const clearCrashReloadTimer = (): void => {
    if (crashReloadTimer === null) return;
    clearTimeout(crashReloadTimer);
    crashReloadTimer = null;
  };
  const reload = () => {
    if (quitRequested || win.isDestroyed()) return;
    const now = Date.now();
    if (now - reloadWindowStart > 60_000) {
      reloadWindowStart = now;
      reloadCount = 0;
    }
    reloadCount += 1;
    if (reloadCount <= 3) {
      console.warn(`[dsh-chamber] 渲染进程异常，尝试重载 (${reloadCount}/3)`);
      win.webContents.reload();
    } else {
      console.error('[dsh-chamber] 渲染进程反复异常退出，停止自动恢复');
      dialog.showErrorBox('dsh-chamber 前端异常', '前端渲染进程反复崩溃，已停止自动恢复。请重新启动应用。');
    }
  };
  win.webContents.on('did-start-loading', () => {
    loadedOnce = false;
    clearUnresponsiveTimer();
    clearCrashReloadTimer();
  });
  win.webContents.on('did-finish-load', () => {
    loadedOnce = true;
    // ready() can run while late subresources still keep isLoading() true.
    // The first drain then correctly holds; finish is the deterministic replay
    // edge. Guard window identity so an old window cannot drain/reset a newer
    // main window's queues (W-10 S2: drains + ready bits live in shell-core —
    // this glue only forwards the lifecycle event of the current main window).
    if (mainWindow === win) {
      onRendererLifecycle('did-finish-load');
    }
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    clearUnresponsiveTimer();
    clearCrashReloadTimer();
    if (details.reason === 'clean-exit' || quitRequested) return; // 用户关窗/退出等正常路径
    // 通知就绪标志立即失效（design 19 §3.3）：崩溃到 500ms 后 reload 之间没有
    // 导航事件（did-start-loading 不会触发），不重置则向死 frame 推送丢事件。
    // （W-10 S2：ready 位复位 + in-flight 重排在 shell-core onRendererLifecycle。）
    if (mainWindow === win) {
      onRendererLifecycle('crashed');
    }
    console.error(
      `[dsh-chamber] 渲染进程退出：reason=${details.reason} exitCode=${details.exitCode}`,
    );
    // 稍候重载，避开崩溃拆除期（崩溃后立即 reload 偶发与拆除竞争）。
    crashReloadTimer = setTimeout(() => {
      crashReloadTimer = null;
      reload();
    }, 500);
  });
  win.webContents.on('unresponsive', () => {
    if (!loadedOnce) {
      console.warn('[dsh-chamber] 渲染进程无响应（首次加载中，仅记录不重载）');
      return;
    }
    if (unresponsiveTimer !== null) return;
    console.warn('[dsh-chamber] 渲染进程无响应，15s 内未恢复将重载');
    unresponsiveTimer = setTimeout(() => {
      unresponsiveTimer = null;
      reload();
    }, 15_000);
  });
  win.webContents.on('responsive', clearUnresponsiveTimer);
  win.on('closed', () => {
    clearUnresponsiveTimer();
    clearCrashReloadTimer();
  });
}

// 外链打开速率限制（防脚本 spam 反复弹浏览器标签；用户手动点击远低于该
// 阈值）：10s 窗口内最多 8 次，超限进入 30s 冷却（log-and-drop）。
const OPEN_EXTERNAL_BUDGET = 8;
const OPEN_EXTERNAL_WINDOW_MS = 10_000;
const OPEN_EXTERNAL_COOLDOWN_MS = 30_000;
const externalOpenTimes: number[] = [];
let externalOpenCooldownUntil = 0;

/**
 * 打开外链的统一入口（setWindowOpenHandler / handleUntrustedNavigation
 * 共用）：以解析后的规范化 href 交给 shell.openExternal（避免 raw 字符串
 * 里 Chromium 已剥离而 OS 层未剥离的空白/换行差异），失败 loud 记录，绝不
 * 抛出；超速率预算时静默丢弃并冷却。
 */
function openExternally(url: string): void {
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
  void shell.openExternal(normalized).catch((error) => {
    console.error('[dsh-chamber] 打开外部链接失败：', describeUnknownError(error));
  });
}

/**
 * 非可信导航统一处理（will-navigate / will-redirect 共用，与
 * setWindowOpenHandler 同款 scheme + 同源白名单）：非 shell 文档的导航一律
 * preventDefault；目标是外链（外部 http(s)/mailto）时再转交系统默认处理器。
 * 必须有这一步——vendor markdown 只给 http(s) 链接加 target=_blank（其余
 * 协议如 mailto: 不带 target，点击走导航事件而不是窗口打开事件），缺它
 * mailto: 链接仍是死链。
 */
function handleUntrustedNavigation(event: { preventDefault(): void }, url: string, rendererOrigin: string): void {
  if (isTrustedRendererUrl(url, rendererOrigin)) return;
  event.preventDefault();
  if (isExternalLinkUrl(url, rendererOrigin)) {
    openExternally(url);
  }
}

/**
 * 创建主窗口（单 frame，控制面 origin）。启动期与 activate 重建共用：
 * fatalOnLoadFailure=true（启动期）时加载失败 = 大声失败 + 退出；重建路径
 * 只记录不退出（应用仍可再点图标重建）。
 */
function createMainWindow(rendererOrigin: string, fatalOnLoadFailure: boolean): BrowserWindow {
  // Normalize a possibly-trailing-slash origin: the startup path passes the
  // bare origin, the rebuild path reuses mainWindowUrl (which already ends
  // with '/') — appending unconditionally would produce a `//`-leading path
  // that `new URL('//', base)` rejects and crashes the control plane's
  // request handler (2026-08 fix).
  const url = `${rendererOrigin.replace(/\/+$/, '')}/`;
  mainWindowUrl = url;
  // 打包闭包 P2（STATUS）：沙箱 preload 只接受 build:preload 的编译产物
  // dist/preload.cjs（纯 CJS，无 TS 类型擦除）。源码 preload.cts 不再是静默
  // 回退——Electron 在沙箱/CJS 语义下加载 .cts 会 SyntaxError，缺失即 loud
  // 失败（宁可启动失败也不带病开窗）。
  const preloadPath = path.join(pkgDir, 'dist', 'preload.cjs');
  if (!existsSync(preloadPath)) {
    // 打包闭包 P2:缺失 = 安装/构建回归。必须 loud——dev 终端可见抛错即可,
    // 但打包态(stderr 不可见)直接 throw 会让用户只见闪退;统一走启动失败
    // 对话框 + 退出(与 loadURL 失败同 UX,见 fatalOnLoadFailure 路径)。
    const message = `preload 构建产物缺失：${preloadPath}（先运行 build:preload）`;
    console.error(`[dsh-chamber] ${message}`);
    dialog.showErrorBox('dsh-chamber 启动失败', message);
    app.exit(1);
  }
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    // 首帧前的窗口底色：与 dsh 前端深色主题一致，消除白屏闪烁。
    backgroundColor: '#0f1115',
    // 固定窗口标题：官方 dsh 前端（rc.8 起标题投影在 ui-renderer 行内）
    // 会把当前会话名投影到 document.title——若不拦截 page-title-updated，
    // 原生标题栏会随选中会话变化。单 frame 壳的品牌标识恒定，会话名在应用内可见。
    title: 'dsh-chamber',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      // Keep Electron's renderer sandbox explicit: this window only needs the
      // narrow contextBridge surface from preload, never Electron/Node powers.
      sandbox: true,
      // 隐藏到托盘后渲染进程计时器不被 Chromium 节流（design 14 D1）：唤醒
      // 「立即重连」依赖 SSE 心跳/重连计时器，节流会把它拖慢到 ~1 次/秒。
      // 单窗口 + 控制面 origin + 无第三方内容，安全。
      backgroundThrottling: false,
    },
  });
  mainWindow = win;
  // 冻结窗口标题（与上方 title 配套）：document.title 的每次变化都会触发
  // page-title-updated，不 preventDefault 则原生标题栏仍会跟随会话切换。
  win.on('page-title-updated', (event) => {
    event.preventDefault();
  });
  // The preload exposes host-impacting IPC. Keep it confined to the exact
  // control-plane document: never open a popup or a new WebContents (a new
  // window would inherit the preload bridge), and cancel cross-origin
  // navigation or redirects before another page can receive the same preload.
  // Vendor markdown/tool-card links render as <a target="_blank">; instead of
  // a dead click, hand genuinely external http(s)/mailto targets (different
  // origin from the control plane) to the OS default handler while always
  // denying the window itself. Same-origin targets, file:/custom schemes and
  // parse failures stay denied.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalLinkUrl(url, rendererOrigin)) {
      openExternally(url);
    }
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    handleUntrustedNavigation(event, url, rendererOrigin);
  });
  win.webContents.on('will-redirect', (event, url) => {
    handleUntrustedNavigation(event, url, rendererOrigin);
  });
  installRendererRecovery(win);
  // 通知点击的重建竞态兜底（design 19 §3.3）：点击时窗口若在重建/加载中，打开
  // 意图入队；renderer 就绪后统一补发（照搬 pendingIntents 模式，不丢事件）。
  // 就绪标志的重置点选在 did-start-loading（而非 did-finish-load）：页面刚加载
  // 完成时 renderer 的 onOpen 监听尚未注册（preload 桥异步 expose → React mount
  // → sshBridgeReady effect），而 did-finish-load 可能被 >500ms 的慢子资源拖迟
  // 到 ready() invoke 之后——若在 finish 时重置会把已置位的标志 clobber 成永久
  // false。start-loading 必先于页面脚本执行（invoke 恒在其后），顺序保证成立。
  // （W-10 S2：ready 位复位/requeue/drain 在 shell-core onRendererLifecycle——
  // 本 glue 只转发当前主窗的生命周期事件，语义逐字保留。）
  win.webContents.on('did-start-loading', () => {
    if (mainWindow === win) {
      onRendererLifecycle('did-start-loading');
    }
  });
  win.on('closed', () => {
    if (mainWindow === win) {
      onRendererLifecycle('closed');
      mainWindow = null;
    }
  });
  // 关窗到托盘（design 14 D1）：设置 = hide-to-tray 且存在恢复入口（win/linux
  // 需托盘；macOS Dock 常驻）且非真正退出在途 → hide（不 destroy），控制面/
  // 传输层/dsh 子进程继续运行。托盘缺失时回退现状（关窗即退，受 D2 确认保护）
  // ——绝不允许窗口被隐藏后无任何恢复入口。
  win.on('close', (event) => {
    const recoveryAvailable = process.platform === 'darwin' || tray !== null;
    if (shouldHideToTray(chamberSettings.windowCloseBehavior, recoveryAvailable, quitRequested)) {
      event.preventDefault();
      win.hide();
    }
  });
  // 无窗口常驻（托盘态）期间的唤醒事件由 core held（lastResume），窗口恢复可见
  // 时一次性补发（design 14 D4；W-10 S2——补发逻辑在 shell-core
  // handleMainWindowShown，本 glue 经 mainWindowShownSubscribers 通知订阅面；
  // 身份守卫：'show' 只可能是当前主窗，防御性保留 mainWindow===win 检查）。
  win.on('show', () => {
    if (mainWindow !== win) return;
    for (const subscriber of mainWindowShownSubscribers) {
      try { subscriber(); } catch (error) {
        try { console.warn(`[dsh-chamber] 主窗口 show 订阅回调失败：${describeUnknownError(error)}`); } catch { /* subscriber boundary must never throw */ }
      }
    }
  });
  void win.loadURL(url).catch((loadError) => {
    // Closing/quitting intentionally aborts navigation; it is not a startup
    // failure and must not show a fatal dialog or re-enter teardown.
    if (quitRequested || win.isDestroyed()) return;
    const detail = describeUnknownError(loadError);
    if (fatalOnLoadFailure) {
      dialog.showErrorBox('dsh-chamber 启动失败', `前端加载失败：\n${detail}`);
      void controlPlane?.stop().catch(err => console.error('[dsh-chamber] 控制面停止失败：', err));
      app.exit(1);
    } else {
      console.error('[dsh-chamber] 重建窗口加载失败：', detail);
    }
  });
  return win;
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, commandLine) => {
    // Win/Linux 二次启动：扫描 argv 中的 dsh-chamber:// 深链。无深链 argv →
    // 仅 showMainWindow()（保持现有行为）；深链 argv 且 quit 在途 → ignore
    // （不启动 VS Code、不重建窗口，design 16 §4.2）；否则入队并恢复窗口。
    const urls = scanDeepLinkUrls(commandLine);
    if (urls.length === 0) {
      showMainWindow();
      return;
    }
    if (quitRequested) return;
    for (const url of urls) enqueueDeepLink(url);
    showMainWindow();
  });

  // macOS 深链（design 16 §4.2）：冷启动深链先于 startup 完成到达，必须入
  // pendingIntents 队列；与冷启动 argv 扫描的双触发由归一化 intent key 去重。
  // 在模块顶层（whenReady 之前）注册，冷启动 URL 不丢。
  app.on('open-url', (event, url) => {
    event.preventDefault();
    enqueueDeepLink(url);
  });

  // 终止信号（终端 Ctrl+C / Activity Monitor「退出」/ 进程管理器 SIGTERM）：
  // 转 app.quit() 优雅路径——will-quit 会先回收传输层/控制面/本地 dsh 实例，
  // 而不是让 Electron 直接终止，把 detached 的 dsh 子进程留成孤儿。
  // **2026-08 实机验证**：macOS Electron 43 主进程的 `process.on('SIGTERM')`
  // **不触发**——Chromium 消费信号并走自身的默认优雅退出（同样触发
  // before-quit → will-quit，资源回收完整）；本 handler 在 macOS 上是死代码，
  // 保留作为 linux/win 等 process.on 生效平台的兜底。信号场景（macOS）因此走
  // 正常退出确认（quitConfirmation=true 且本地实例在跑时会弹确认框，等待用户
  // 确认后走 will-quit 清理——不是卡死）。信号本身是明确的退出意图，handler
  // 触发时跳过确认框（quitConfirmed 提前置位）。
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      if (quitRequested) return;
      quitRequested = true;
      quitConfirmed = true;
      app.quit();
    });
  }

  // macOS：Dock 图标点击触发 activate。没有此处理时，窗口一旦关闭
  // （window-all-closed 在 darwin 不退出），应用以无窗口状态常驻，点
  // 图标毫无反应——"前端消失后点图标回不来"的根源。
  app.on('activate', () => {
    showMainWindow();
  });

  app.on('window-all-closed', () => {
    // macOS 默认常驻（Dock 恢复入口，activate 重建窗口）——但设置 = quit 的
    // 关窗路径（design 14 D1）用户意图是退出：此时 darwin 也必须走
    // app.quit()，经 before-quit 的 D2 确认（取消时窗口由取消分支重建，绝不
    // 无窗滞留）。非 darwin 恒退出。
    if (process.platform !== 'darwin' || chamberSettings.windowCloseBehavior === 'quit') app.quit();
  });

  // 退出确认（design 14 D2，2026-08 修订）在 **before-quit**（窗口关闭前）拦截：
  // 显式退出（Cmd+Q / 托盘退出 / Dock 退出 / 设置=quit 的关窗）仅在「退出确认
  // 开关开启 且 本地 dsh 实例运行中」时先确认（远程隧道不影响关闭，用户拍板）；
  // 更新已下载待装（设计 11 autoInstallOnAppQuit，用户已确认过「更新」）时豁免。
  // 关键时序：close-to-tray 的 close 处理器靠 quitRequested 区分「退出在途」
  // vs「普通关窗」——而 will-quit 要等所有窗口关闭后才触发，在 will-quit 内置
  // 位为时已晚（close 先 hide+preventDefault 会把退出吞掉）。before-quit 先
  // 置位/拦截：确认后重触发才放行；取消时窗口从未关闭（拦截在先），不丢窗口。
  // async handler：preventDefault 在第一个 await 前同步执行（Electron 不等待
  // handler 的 promise）；await 仅用于把确认框的同步/异步失败统一进 try/catch。
  app.on('before-quit', async (event) => {
    if (quitConfirmed) return; // 已确认/豁免：放行（重入）
    const cp = controlPlane;
    if (cp === null) return; // 控制面未就绪：无可保护内容，放行
    if (confirmingQuit) {
      event.preventDefault(); // 确认框已打开：忽略重入（单飞）
      return;
    }
    const updateState = updateController?.state();
    const updateDownloadReady = updateState !== undefined
      && updateState.phase === 'downloaded'
      && updateState.installBlockedReason === null;
    // 2026-08 修订：远程隧道不影响关闭（用户拍板）——风险只看本地实例；退出
    // 确认开关（quitConfirmation）关闭时永不确认。2026-08 二次修订：状态机
    // 显示 running 还不够——必须实际有存活进程（restart backoff / 死亡未探活
    // 期间状态机可能误报 running）。
    const localRunning = LOCAL_RUNNING_STATES.has(cp.connectionState) && cp.localProcessAlive;
    const risk = computeQuitRisk({
      quitConfirmation: chamberSettings.quitConfirmation,
      localRunning,
      updateDownloadReady,
    });
    if (!risk.needsConfirm) {
      // 无风险或更新安装豁免：置位后直接 return 放行本次退出（未 preventDefault，
      // 退出继续走 will-quit）——不在此处再调 app.quit() 重入（2026-08 review：
      // 重入虽被 quitConfirmed 早退兜住，但属不必要的退出重入）。
      quitRequested = true;
      quitConfirmed = true;
      return;
    }
    // 需确认：**在关窗前**拦截（preventDefault 只在此路径调用——风险计算在
    // 前，意外异常不会静默吞掉退出）。
    event.preventDefault();
    confirmingQuit = true;
    const detail = `退出将停止${risk.reasons.join('与')}。确定退出？`;
    try {
      await dialog.showMessageBox({
        type: 'warning',
        title: '退出 dsh-chamber？',
        message: '退出 dsh-chamber？',
        detail,
        buttons: ['退出', '取消'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      }).then(({ response }) => {
        confirmingQuit = false;
        if (response === 0) {
          quitRequested = true;
          quitConfirmed = true;
          app.quit();
          return;
        }
        // 取消：quitRequested 保持 false。app.quit() 发起的退出在关窗前被拦截、
        // 窗口未关闭；但 X 关窗路径（windowCloseBehavior='quit'）窗口已先销毁
        // （window-all-closed → app.quit()），取消后重建——绝不让应用以无窗
        // 状态滞留（恢复入口不应只剩托盘/二次启动）。SIGTERM 已置位
        // quitRequested 的退出在途（窗口已关、清理进行中）则**不**重建——
        // 取消对已确认的退出无效力，重建只会闪烁（2026-08 review）。
        if (!quitRequested && (mainWindow === null || mainWindow.isDestroyed())) {
          showMainWindow();
        }
      });
    } catch (error) {
      // showMessageBox 同步/异步失败都必须复位 confirmingQuit，否则后续所有
      // before-quit 都被单飞闸拦死、应用再也退不出（2026-08 review）。
      confirmingQuit = false;
      console.error('[dsh-chamber] 退出确认对话框失败，取消退出：', error);
      if (mainWindow === null || mainWindow.isDestroyed()) {
        showMainWindow();
      }
    }
  });

  app.on('will-quit', (event) => {
    if (willQuitCleanupComplete) return;
    // 真正退出在途（窗口已全部关闭）：close 分支不再 hide；keep-awake 停止
    // （design 14 D5）。确认/豁免已在 before-quit 完成，这里只剩清理。
    quitRequested = true;
    setKeepAwakeActive(false);
    // 兜底清除未读徽标（退出在途不留 Dock 残留；曾有意图才触碰，避免无谓日志）。
    // W-10 S2：意图 holder（pendingBadgeCount）随 BADGE_COUNT 迁 core——
    // clearBadgeIntentForQuit 内部做「曾有意图」守卫与意图清空，原生清除叶在此
    // 注入（typeof 守卫照旧，语义与搬迁前一致）。
    clearBadgeIntentForQuit(() => {
      if (typeof app.setBadgeCount === 'function') app.setBadgeCount(0);
    });
    // 立即移除托盘：退出在途不需要恢复入口，残留托盘图标是「退不干净」观感。
    if (tray !== null) {
      try {
        tray.destroy();
      } catch { /* already gone */ }
      tray = null;
    }
    if (quitCleanupInProgress) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    quitCleanupInProgress = true;
    runtimeStartBlocked = true;
    runtimeOperationAbort?.abort(new Error('application is quitting'));
    // 传输层（SSH 隧道/在途 exec）与控制面（本地 dsh + HTTP 门面）的回收互不
    // 依赖，并行等待（总耗时 = max 而非 sum）。各自的 SIGTERM→SIGKILL 窗口已
    // 压到 1s（transport-manager / spawn-dsh），正常 ~1-2s 完成。disposeAsync
    // 仍 WAITS 每个 SIGKILL 升级（否则 SIGTERM 忽略的 ssh 子进程会因 unref
    // 计时器随退出丢失而孤儿化）。兜底：清理链若挂起（残留连接使
    // server.close 不回调），超时强制退出，绝不无期限滞留成「窗口已关、进程
    // 仍在」的半退出态。
    const cleanupTimer = setTimeout(() => {
      // 超时强制退出走 app.exit()：quit 事件不会触发，electron-updater 的
      // autoInstallOnAppQuit（退出腿）不执行——退出腿下「已下载」更新会被
      // 跳过。注意（2026-12 review L1）：「重启并安装」腿（restartAndInstall
      // 已点击）不受此影响——NSIS 安装器在 quit 前已 detached 先行、
      // AppImage 点击时已原位替换，即使 app.exit(1) 安装也照常完成；
      // mac 原生腿未实机确证（见 design 11 §9 断言清单）。
      console.error('[dsh-chamber] 退出清理超时，强制退出（可能有子进程残留；退出腿的已下载更新不会安装）');
      app.exit(1);
    }, QUIT_CLEANUP_TIMEOUT_MS);
    const cp = controlPlane;
    controlPlane = null;
    void Promise.allSettled([
      disposePluginSyncChildren().catch((err) => console.error('[dsh-chamber] 插件子进程关闭失败：', err)),
      transportManager?.disposeAsync().catch((err) => console.error('[dsh-chamber] 传输层关闭失败：', err)),
      cp?.stop().catch((err) => console.error('[dsh-chamber] 控制面停止失败：', err)),
      disposeRuntimeInstaller().catch((err) => console.error('[dsh-chamber] 运行时安装器关闭失败：', err)),
      runtimeOperation?.catch((err) => console.error('[dsh-chamber] 运行时事务关闭失败：', err)),
    ]).finally(() => {
      // Drop every cached gateway login session (pure-memory hygiene; the
      // cookies are gone with the process anyway — the dispose keeps the
      // manager honest, design 17 §13.5 会话仅主进程内存) and cancel every
      // pending pre-expiry refresh timer (the transports are already down).
      // Timers first: a refresh fire must never race a disposed manager.
      sessionRefresh?.dispose();
      sessionRefresh = null;
      gatewaySessions?.dispose();
      gatewaySessions = null;
      clearTimeout(cleanupTimer);
      quitCleanupInProgress = false;
      willQuitCleanupComplete = true;
      // Will-quit cleanup completion marker (2026-12 review M1): the mac
      //「重启并安装」real-machine gate asserts this line appears BEFORE the
      // new version launches — it proves the native Squirrel termination
      // actually ran through the Electron will-quit cleanup (transports +
      // local dsh disposed) instead of a raw Cocoa terminate.
      console.log('[dsh-chamber] will-quit 清理完成，进程退出');
      app.quit();
    });
  });

  app.whenReady().then(async () => {
    // Windows toast identity (design 21 M3): native notifications require the
    // AppUserModelID to match the NSIS-installed shortcut; set it explicitly
    // so packaged builds bind Action Center reliably. Dev/portable builds
    // stay best-effort (Electron toasts without a shortcut may be suppressed
    // by Action Center — documented in design 21 F5). POSIX unaffected.
    if (process.platform === 'win32') app.setAppUserModelId('com.dshchamber.desktop');
    // 冷启动深链 argv（design 16 §4.2）：macOS argv 含 -psn_ 噪声，防御式扫描
    // （非深链 argv 零副作用、绝不 throw 打断启动）；与 open-url 双触发由去重兜底。
    for (const url of scanDeepLinkUrls(process.argv)) enqueueDeepLink(url);
    // W-10 S0（design 25 §4.1 seam）：HostEdges 的 Electron 实现。S2 批起宿主
    // 背参扩展：showMainWindow = 通知 click 激活腿（本函数模块级语义——
    // restore/show/focus、无窗则重建）；onMainWindowShown = 主窗口 'show' 事件
    // 订阅面（createMainWindow glue 每窗挂接）。S2 已实现的成员见 electron-edges
    // 头注释；通知/徽标宿主腿、渲染器投递窗口事实与 resume/show 订阅随本批迁入。
    const edges = createElectronEdges({
      mainWindow: () => mainWindow,
      showMainWindow: () => showMainWindow(),
      onMainWindowShown: subscriber => {
        mainWindowShownSubscribers.add(subscriber);
        return () => { mainWindowShownSubscribers.delete(subscriber); };
      },
    });
    const runtimeBaseDir = app.getPath('userData');
    const localDshHome = localDshHomeDir(runtimeBaseDir);
    const runtimeWriterFence = new RuntimeOperationFence();
    const envOverrideActive = Boolean(process.env.DSH_CHAMBER_DSH_PATH);
    // Windows runtime mutations stay read-only until the M2a ability gate is
    // validated on real win32 runners (design 21 M2a/M2b discipline — 能力先于
    // 开关): DSH_CHAMBER_WINDOWS_RUNTIME_MUTATIONS=1 is the development-only
    // opt-in that enables the mutation path for validation; it must never be
    // on by default, and the UI flip (M2b) waits for the validation record.
    const runtimeManagementSupported = process.platform !== 'win32'
      || process.env.DSH_CHAMBER_WINDOWS_RUNTIME_MUTATIONS === '1';
    const bundledVersion = readDshVersion(builtinDshWorkspace);
    const stalePluginWriter = await reapStaleLocalPluginWriters(localDshHome);
    const runtimeBootstrapWriterUnsafe = !stalePluginWriter.ok;
    let runtimeBootstrapFailure: string | null = stalePluginWriter.ok
      ? null
      : `无法证明旧的本地插件写进程已回收：${stalePluginWriter.error}`;

    let startupMetadataHealth: RuntimeMetadataHealth | null = null;
    try {
      startupMetadataHealth = detectRuntimeMetadataHealth(runtimeBaseDir, version);
    } catch (error) {
      runtimeBootstrapFailure = `无法检查 dsh 运行时选择元数据：${sanitizeErrorText(error instanceof Error ? error.message : String(error))}`;
    }

    // A shell-version fallback is itself a runtime/data switch. Persist the
    // builtin activation intent before invalidating the override so a crash
    // cannot start builtin against user-migrated DSH_HOME without a snapshot.
    // Reuse the single hardened health snapshot. Re-reading these paths here
    // would both create a startup TOCTOU and let a malicious hardlink/symlink
    // reach permission-tightening side effects after health already rejected it.
    const startupOverrideState = startupMetadataHealth?.override ?? { kind: 'corrupt' as const };
    const startupPointerState = startupMetadataHealth?.current ?? { kind: 'corrupt' as const };
    if (runtimeBootstrapFailure !== null) {
      // Writer ownership outranks runtime-selection mutation. Preserve every
      // pointer/journal byte until the stale process is proven gone.
    } else if (startupMetadataHealth?.status === 'recovery-in-progress') {
      runtimeBootstrapFailure = 'dsh 运行时元数据恢复事务未完成；已隔离本地实例并将在启动事务中续作';
    } else if (startupMetadataHealth?.status === 'selection-corrupt') {
      runtimeBootstrapFailure = 'dsh runtime 选择元数据损坏；已阻止本地实例启动';
    } else if (startupMetadataHealth?.status === 'recovery-marker-corrupt') {
      runtimeBootstrapFailure = 'dsh runtime 元数据恢复标记损坏；已阻止本地实例启动';
    } else if (startupOverrideState.kind === 'corrupt') {
      runtimeBootstrapFailure = 'dsh runtime override metadata 损坏；已阻止本地实例启动';
    } else if (startupPointerState.kind === 'corrupt') {
      runtimeBootstrapFailure = 'dsh runtime current pointer 损坏；已阻止本地实例启动';
    } else if (
      runtimeManagementSupported
      && !envOverrideActive
      && startupOverrideState.kind === 'valid'
      // A newly observed shell-version mismatch starts F4. A durable
      // invalidation normally means the builtin fallback verdict already
      // committed — do not manufacture a fresh snapshot/switch transaction on
      // every later boot. EXCEPTION: an interrupted first transaction whose
      // journal was lost (e.g. an update rollback booted an older shell that
      // consumed the newer shell's journal) strands the current pointer on
      // the old tree with no resumable evidence; resolveActiveRuntime then
      // blocks every later boot on 'pointer has no matching active override'.
      // Re-arm F4 in that case so the snapshot + probe-gated builtin switch
      // finishes the stranded transaction — a settled invalidation always
      // leaves the pointer cleared (applied) or the record reactivated
      // (rolled back), so pointer-valid + invalidatedAt-set + journal-missing
      // uniquely identifies the stranded state.
      && (
        (startupOverrideState.record.invalidatedAt == null
          && startupOverrideState.record.shellVersion !== version)
        || (startupOverrideState.record.invalidatedAt != null
          && startupPointerState.kind === 'valid'
          && readActivationJournalState(runtimeBaseDir).kind === 'missing')
      )
    ) {
      if (bundledVersion === null || !isSafeVersion(bundledVersion)) {
        runtimeBootstrapFailure = '无法确认内建 dsh 运行时版本；拒绝执行 shell 更新回落';
      } else {
        try {
          writeActivationIntent(runtimeBaseDir, {
            targetVersion: bundledVersion,
            targetIsBuiltin: true,
            manualRollback: false,
            intentKind: 'shell-invalidation',
          });
          if (startupOverrideState.record.invalidatedAt == null) {
            writeOverride(
              runtimeBaseDir,
              invalidate(startupOverrideState.record, `shell updated to ${version}`),
            );
          }
        } catch (error) {
          runtimeBootstrapFailure = `无法持久化 shell 更新回落事务：${sanitizeErrorText(error instanceof Error ? error.message : String(error))}`;
        }
      }
    }
    try {
      const controlPlanePort = await resolveControlPlanePort();
      const portSourceLabel = process.env.DSH_CHAMBER_CP_PORT
        ? 'DSH_CHAMBER_CP_PORT 固定覆盖'
        : process.env.DSH_CHAMBER_ELECTRON_DEV === '1'
          ? 'dev 自动退避（17520 起，首个空闲端口）'
          : '打包默认';
      console.log(`[dsh-chamber] 控制面端口：${controlPlanePort}（${portSourceLabel}${controlPlanePort === 0 ? '；0 = 系统临时分配' : ''}）`);
      controlPlane = createControlPlane({
        port: controlPlanePort,
        stateDir: stateRootDir(app.getPath('userData')),
        getDshWorkspacePath: () => {
          if (runtimeTransactionWorkspace !== null) return runtimeTransactionWorkspace;
          const resolved = resolveActiveRuntime(runtimeBaseDir, builtinDshWorkspace);
          if (resolved.path === null) throw new Error(resolved.blockedReason ?? 'dsh workspace not found');
          return resolved.path;
        },
        canStartLocal: () => {
          if (controlPlane?.localWritersQuiescent === false) {
            return { ok: false, reason: 'managed dsh writer ownership could not be proven quiescent' };
          }
          return runtimeStartBlocked && !runtimeInternalStart
            ? { ok: false, reason: runtimeStartBlockedReason }
            : { ok: true };
        },
        // A privileged activation may internally spawn a candidate while
        // public starts remain blocked. Keep its HTTP/WS and ready projection
        // quarantined until the full probe verdict opens runtimeStartBlocked.
        canExposeLocal: () => !runtimeStartBlocked,
        // The built dsh frontend (renderer vite output) served by the control
        // plane (design 05 §3.3): <pkg>/dist/web in dev and packaged (asar)
        // alike (P2-4 isolation: renderer owns dist/web only; preload.cjs /
        // control-plane / host packages live beside it in dist/).
        webDistDir: path.join(pkgDir, 'dist', 'web'),
        // Host-graph package source (design 09 §3.5): the control plane seeds
        // it into the local web profile at start. Dev reads the source tree;
        // the packaged app uses the copy bundled into dist/ by
        // build-host-graph-package.mjs (inside the asar). Missing → the seed
        // degrades gracefully (no --patch overlay, v4 baseline spawn).
        hostGraphPackageSourceDir: app.isPackaged
          ? path.join(pkgDir, 'dist', 'host-graph-package')
          : path.join(repoRoot, 'packages', 'dsh-host-client-graph'),
        hostGitWorktreePackageSourceDir: app.isPackaged
          ? path.join(pkgDir, 'dist', 'host-git-worktree-package')
          : path.join(repoRoot, 'packages', 'dsh-chamber-host-git-worktree'),
        hostArchiveCleanupPackageSourceDir: app.isPackaged
          ? path.join(pkgDir, 'dist', 'host-archive-cleanup-package')
          : path.join(repoRoot, 'packages', 'dsh-host-archive-cleanup'),
      });
      await controlPlane.start();
    } catch (err) {
      const detail = describeUnknownError(err);
      dialog.showErrorBox('dsh-chamber 启动失败', `控制面启动失败：\n${detail}`);
      app.exit(1);
      return;
    }

    // Capture the non-null control plane before registering closures over it
    // (the handler runs later, after startup).
    const cp = controlPlane;
    const rendererOrigin = `http://127.0.0.1:${cp.port}`;
    const trustedIpc = createTrustedIpc({
      isTrustedSender: event => {
        const win = mainWindow;
        return win !== null
          && !win.isDestroyed()
          && isTrustedIpcSender(event, win.webContents, rendererOrigin);
      },
      isQuitting: () => quitRequested,
    });
    // W-10 S8：本地插件执行叶（runtime writer fence 租约 + runtimeStartBlocked
    // 启动门 + resolveActiveRuntime(runtimeBaseDir, builtinDshWorkspace) workspace
    // 解析——fence/启动门是装配侧运行时事务状态）。本体留本文件、经
    // ctx.runLocalPluginMutation 注入 core：H 组本地插件注册体（LOCAL_PLUGIN_ADD/
    // ADD_FILE/REMOVE，shell-core installIpcHandlers ② H 组段）的 mutate 编排经
    // 它走同一执行路径，语义与搬迁前不分叉；mutate 内的实际子进程执行
    // （runLocalDshPlugin——add 子进程 env 装配/白名单，W-14 关联 C-F12 纪律）
    // 在 plugin-sync 纯模块，core 直接 import。
    const runLocalPluginMutation = async <T>(
      owner: string,
      mutate: (dshWorkspace: string) => Promise<T>,
    ): Promise<T | { ok: false; error: string }> => {
      const lease = runtimeWriterFence.tryAcquire(owner);
      if (lease === null) return { ok: false, error: 'dsh runtime/data operation in progress' };
      try {
        if (runtimeStartBlocked) return { ok: false, error: runtimeStartBlockedReason };
        // Resolve only after acquiring the writer fence. A queued IPC or open
        // picker must never retain a workspace across a runtime swap.
        const resolved = resolveActiveRuntime(runtimeBaseDir, builtinDshWorkspace);
        if (resolved.path === null) return { ok: false, error: resolved.blockedReason ?? 'dsh workspace not found' };
        return await mutate(resolved.path);
      } finally {
        lease.release();
      }
    };
    // —— W-10 S8：原 confirmPluginAction 双参闭包（mainWindow, copy）随 H 组
    // LOCAL_PLUGIN_ADD/REMOVE 注册体迁出删除——注册体改经 shell-core 内 S6 edges
    // 版 confirmPluginAction 助手（宿主腿 = HostEdges.showMessage，electron-edges
    // S6 实现；按钮序/取消默认/无窗文案逐字一致），本闭包无剩余使用点。
    // ssh plugin undo journal (design 21 §6.4, plan Phase 5 ssh 统一增量): the
    // desktop main-process-persisted journal of every executed remote plugin
    // change (applyPlugins records each row with its pre-change remote spec).
    // File <userData>/ssh-plugin-journal.json — 0600, atomic, no-follow reads
    // bounded to 64 KiB, newest-50 retention, corrupt → aside + fresh. The
    // journal instance is inert until an apply records into it.
    const sshPluginJournal = createSshPluginJournal(app.getPath('userData'), {
      log: (...args) => console.log('[dsh-chamber]', ...args),
      warn: (...args) => console.warn('[dsh-chamber]', ...args),
    });
    // Chamber settings（design 14 D7）：启动加载 + 应用副作用（keep-awake /
    // 登录自启 reconcile）；损坏 loud（*.corrupt 保留），绝不静默假默认。
    const settingsLoad = readSettingsFile(chamberSettingsFilePath(app.getPath('userData')));
    if (settingsLoad.notice !== null) console.error(`[dsh-chamber] ${settingsLoad.notice}`);
    chamberSettings = settingsLoad.settings;
    setKeepAwakeActive(chamberSettings.keepAwake);
    // 登录自启 reconcile 覆盖全部三平台（design 21 M4:win32 已解锁）。
    {
      const loginItemResult = applyLaunchAtLogin(chamberSettings.launchAtLogin);
      if (!loginItemResult.ok) {
        console.warn(`[dsh-chamber] 登录自启 reconcile 失败：${loginItemResult.error}`);
      }
    }

    // —— W-10 S2：NOTIFY / NOTIFICATIONS_READY / NOTIFICATION_OPEN_ACK /
    // BADGE_COUNT / DEEP_LINK_READY / DEEP_LINK_ACK 六个注册体与其状态机随
    // B 组批迁出（shell-core installIpcHandlers ② 段，trustedIpc 围栏由下方
    // 装配的注入 registrar 统一包装）——

    // OS 唤醒即时重探（design 14 D4，传输层腿）：主进程对 error/degraded 实例
    // 立即重探（绝不触碰 idle）。held lastResume 补发 + SYSTEM_RESUME 推送已迁
    // shell-core（electron-edges 的 onSystemResume 订阅 = 装配于 installIpcHandlers
    // ① 段；另挂一条独立监听专做重探——双监听语义与搬迁前单 handler 等价）。
    powerMonitor.on('resume', () => {
      reconnectStaleTransports();
    });

    maybeCreateTray(controlPlane);
    registerDeepLinkProtocol();

    // Transport manager (design 03 §2.2 / 05 §7-§8): persisted instance
    // registry under <userData>/ssh-instances.json; instance CRUD, transport
    // lifecycle and the provider exec channel (ssh: remote systemd) stay in
    // the main process; outputs to the renderer are non-secret status
    // projections (never a transport URL or credential material). The only
    // credential-bearing direction is save_connection's transient write-only input.
    //
    // SSH password store (design 05 §8, user decision 2026-08 — plaintext
    // file fallback): passwords mirror to <userData>/ssh-passwords.json
    // (0600, atomic write) and load back at startup so password-only hosts
    // auto-connect after a restart. Values never enter the registry/logs or
    // return to/prefill the renderer; a corrupt file is preserved as *.corrupt and
    // reported loudly.
    const askpassNotice = cleanupStaleAskpassHelpers();
    if (askpassNotice !== null) console.error(`[dsh-chamber] ${askpassNotice}`);
    const resolveCredentialSpec = (id: string): TransportInstanceSpec | null =>
      transportManager?.listInstances().find(instance => instance.id === id) ?? null;
    const passwordNotice = configureSshPasswordStore(
      sshPasswordsFilePath(app.getPath('userData')),
      resolveCredentialSpec,
    );
    if (passwordNotice !== null) console.error(`[dsh-chamber] ssh password store: ${passwordNotice}`);
    // Gateway credentials store (design 17 §12): token + password secrets
    // mirror to <userData>/gateway-secrets.json (schemaVersion 3, 0600,
    // atomic write) — encrypted via Electron safeStorage (macOS Keychain /
    // Windows DPAPI / Linux libsecret) when available, else the documented
    // 0600 plaintext fallback (user decision 2026-08). Never in the registry,
    // never logged, and never returned to/prefilled in the renderer. Non-empty
    // legacy files without a binding have
    // no credential-domain binding and are therefore
    // preserved uniquely as unbound evidence and disabled until re-entry.
    const gatewaySecretsCrypto = safeStorage.isEncryptionAvailable()
      ? {
        isAvailable: () => safeStorage.isEncryptionAvailable(),
        encrypt: (plain: string) => safeStorage.encryptString(plain).toString('base64'),
        decrypt: (blob: string) => safeStorage.decryptString(Buffer.from(blob, 'base64')),
      }
      : undefined;
    // design 21 C16: on Windows, DPAPI (Electron safeStorage) is available in
    // every interactive session; an unavailable keychain must NEVER silently
    // fall back to a plaintext mirror whose 0600 cannot be expressed there.
    // The store is configured memory-only (file null) so credentials survive
    // only for the session and re-entry is required per connect.
    const windowsRefusePlaintext = process.platform === 'win32' && gatewaySecretsCrypto === undefined;
    if (gatewaySecretsCrypto === undefined) {
      if (windowsRefusePlaintext) {
        // S22 does not apply on win32: loud refusal instead of the plaintext
        // fallback (design 17 §12 exception bounded by design 21 C16).
        console.error('[dsh-chamber] Windows safeStorage (DPAPI) 不可用 — 拒绝明文镜像回退 (design 21 C16)；gateway 凭据仅本次会话内存驻留，每次连接需重录');
      } else {
        // S22 (design 17 §13.4.1): the OS keychain is unavailable — the store
        // falls back to the documented 0600 plaintext mirror. LOUD registration
        // (never silent) AND a renderer-visible read-only projection
        // (instances_get merges secretStorage: 'plaintext') so the settings
        // page shows the fallback path.
        console.warn('[dsh-chamber] OS keychain (Electron safeStorage) is unavailable — gateway credentials will be mirrored to the 0600 plaintext file fallback (design 17 §12/S22)');
      }
    }
    const gatewaySecretNotice = configureGatewaySecretStore(
      windowsRefusePlaintext ? null : gatewaySecretsFilePath(app.getPath('userData')),
      gatewaySecretsCrypto,
      resolveCredentialSpec,
    );
    if (gatewaySecretNotice !== null) console.error(`[dsh-chamber] gateway secrets store: ${gatewaySecretNotice}`);
    // Windows privacy tightening (design 21 M2a / C1): POSIX 0700/0600 has no
    // Windows equivalent, so the owner-private state root and any pre-existing
    // secret leaves are given explicit user-only ACLs at startup. Directory
    // grants propagate (OI)(CI) to future children. Failures are loud and
    // never block startup; POSIX hosts are unaffected (win32-gated executor).
    if (process.platform === 'win32') {
      const aclErrors = applyWindowsAclTightening([
        { path: runtimeBaseDir, kind: 'directory' },
        { path: stateRootDir(runtimeBaseDir), kind: 'directory' },
        { path: sshPasswordsFilePath(runtimeBaseDir), kind: 'file' },
        { path: gatewaySecretsFilePath(runtimeBaseDir), kind: 'file' },
        { path: chamberSettingsFilePath(runtimeBaseDir), kind: 'file' },
        { path: auditLogFilePath(runtimeBaseDir), kind: 'file' },
      ]);
      for (const aclError of aclErrors) console.error(`[dsh-chamber] windows ACL tightening failed: ${aclError}`);
    }
    // Gateway password-session manager (design 17 §7.1/§9.3): the login
    // exchange (POST /auth/login → 3xx + dsh_gateway_session cookie) and the
    // 12h session cookie live ONLY in this manager's main-process memory,
    // owned by origin/Host plus a stable connection-target scope. The complete
    // generation/proof hook set fences invalidated login/probe/fallback work;
    // provider verifyUp proves the session and ready registration injects the
    // bounded Cookie header — the cookie never leaves main or enters a log/file.
    gatewaySessions = createGatewaySessionManager();
    configureGatewaySessionProvider({
      ensureSession: (origin, password) => gatewaySessions!.ensureSession(origin, password),
      generation: origin => gatewaySessions!.generation(origin),
      registrationAuthProof: origin => gatewaySessions!.registrationAuthProof(origin),
      setRegistrationAuthProof: (origin, proof) => gatewaySessions!.setRegistrationAuthProof(origin, proof),
      cachedCookie: origin => gatewaySessions!.cachedCookie(origin),
      invalidate: origin => gatewaySessions!.invalidate(origin),
    });
    // S24 lightweight non-secret audit log (design 17 §13.4.4): JSONL append
    // at <userData>/audit-log.jsonl (0600, 5 MiB rotation) recording ONLY
    // non-secret facts — time/source/auth result. Credentials, cookies and
    // session bodies NEVER enter: the audit-log serializer is a fixed field
    // whitelist, and the callers below pass existence markers (token|password|
    // none) and phases, never values (S24).
    const auditLogPath = auditLogFilePath(app.getPath('userData'));
    const auditLogNotice = configureAuditLog(auditLogPath);
    if (auditLogNotice !== null) console.error(`[dsh-chamber] audit log: ${auditLogNotice}`);
    const audit = (event: AuditEvent) => appendAuditEvent({ file: auditLogPath }, event);
    transportManager = createTransportManager({
      provider: sshProvider,
      // v2 (design 17 §2.2): providers register BY TRANSPORT — `ssh` (tunnel
      // subprocess + systemd exec, serving both the dsh and gateway target
      // kinds) and `http` (the gateway provider's direct endpoint). The
      // default `provider` stays the ssh provider so legacy kind-keyed
      // entries and unknown transports resolve there.
      providers: { ssh: sshProvider, http: gatewayProvider },
      instancesFile: instancesFilePath(app.getPath('userData')),
      logger: {
        log: (...args) => console.log('[transport-manager]', ...args),
        warn: (...args) => console.warn('[transport-manager]', ...args),
        error: (...args) => console.error('[transport-manager]', ...args),
      },
    });
    try {
      transportManager.loadInstances();
    } catch (loadError) {
      // Corrupt instance file: loud failure — PRESERVE the file (rename to
      // *.corrupt, reversible) before starting empty; the next authoritative
      // save_connection rebuilds the registry (never silently faked as empty).
      console.error('[dsh-chamber] 加载 SSH 实例失败：', loadError);
      const file = instancesFilePath(app.getPath('userData'));
      try {
        renameSync(file, `${file}.corrupt`);
        console.warn(`[dsh-chamber] 已保留损坏的实例文件为 ${file}.corrupt`);
      } catch (renameError) {
        console.error('[dsh-chamber] 保留损坏实例文件失败：', renameError);
      }
    }
    // Capture the non-null manager before registering closures over it (the
    // ipc handlers run later, after startup).
    const sm = transportManager;
    const transportIdentityFingerprint = (instance: TransportInstanceSpec): string => JSON.stringify([
      instance.kind,
      instance.transport,
      instance.host,
      instance.user,
      instance.sshPort,
      instance.remotePort,
    ]);
    const operationalFingerprint = (instance: TransportInstanceSpec): string => JSON.stringify([
      transportIdentityFingerprint(instance),
      instance.serviceName,
      instance.remoteDshHome,
    ]);
    // —— W-10 S2：来源证明/代际实例（NotificationSourceProofs /
    // NotificationSourceIncarnations）与其投影/同步闭包已迁 shell-core（导出
    // projectNotificationSourceInstances / syncNotificationSourceRegistry /
    // captureNotificationSource / ownsNotificationSource /
    // matchesNotificationSource）——
    // Native notifications can be requested only for sources in the loaded
    // authoritative registry. This also establishes the initial incarnation
    // before the notify IPC handler can run.
    syncNotificationSourceRegistry(projectNotificationSourceInstances(sm.listInstances()));
    // Live-proxy session self-healing (design 17 §9.3): for every REGISTERED
    // password-authenticated gateway target (ssh tunnel AND http direct), arm
    // a pre-expiry re-login ~60s before the session's expiry instant and
    // re-register the transport with the fresh cookie — without this a
    // healthy transport rides its registration-time Cookie past expiry and
    // the proxy answers 401 until a reconnect (the S2 gap fixed here). The
    // controller is armed/disarmed by the ready-phase status transitions
    // below; the residual window (a refresh that fails after the old cookie
    // died) is honestly warned and recovers through the disconnect→reconnect
    // verifyUp re-login path.
    sessionRefresh = createGatewaySessionRefresh({
      sessionManager: gatewaySessions!,
      passwordFor: id => getGatewayPassword(id),
      tokenFor: id => getGatewayToken(id),
      readyUrlFor: id => sm.readyUrl(id),
      tlsPinFor: id => sm.listInstances().find(instance => instance.id === id)?.spkiPin ?? null,
      // Tunnel Host override (design 17 §9.3 隧道 Host 覆盖): an ssh-tunneled
      // gateway target re-registers with the remote LOOPBACK destination
      // authority (never the SSH hostname/alias) so the proxy's Host header,
      // stable connection-target scope, and network origin reproduce the
      // verifyUp-minted session key. Authority routes; it is not ownership.
      authorityFor: id => {
        const instance = sm.listInstances().find(candidate => candidate.id === id);
        return instance !== undefined && instance.kind === 'gateway' && instance.transport === 'ssh'
          ? gatewayTunnelAuthority(instance.remotePort)
          : undefined;
      },
      scopeFor: id => {
        const instance = sm.listInstances().find(candidate => candidate.id === id);
        return instance !== undefined && instance.kind === 'gateway'
          ? gatewaySessionScopeForConnection(instance)
          : undefined;
      },
      register: (id, url, headers, tls, authority) => {
        const livePlane = controlPlane;
        const registered = sm.listInstances().find(instance => instance.id === id);
        if (livePlane !== null) livePlane.registerInstanceTransport(`gateway:${id}`, url, headers, {
          ...(registered === undefined ? {} : { transport: proxyTransport(registered.transport) }),
          ...(tls === undefined ? {} : tls),
          ...(authority === undefined ? {} : { authority }),
        });
        // Keep the registered-auth fingerprint in lockstep: the refresh
        // re-registration REPLACES the proxy headers, so the onVerified
        // fingerprint gate must see the rotated cookie as "already
        // registered" — otherwise the next successful ready-state probe
        // (≤60s later) re-registers AGAIN, an unconditional traffic
        // revocation the gate exists to prevent.
        registeredAuthFingerprints.set(`gateway:${id}`, authHeadersFingerprint(
          headers === undefined ? undefined : sanitizedRegistrationHeaders(headers),
        ));
      },
      // Bounded dead-cookie recovery (design 17 §9.3, P2-1): a re-login that
      // failed AFTER the old cookie died would otherwise leave a healthy
      // transport riding it, so the proxy answers 401 indefinitely.
      // transport-manager has no single "reconnect" entry, so this uses its
      // EXISTING public API: disconnect (emits idle → the control plane
      // unregisters gateway:<id> and this refresh disarms) then connect (a
      // fresh transport whose verifyUp re-authenticates with the stored
      // password — the single re-login → terminal path). The refresh
      // controller calls this at most once per refresh fire and only while
      // the transport is still ready on the same origin, so there is no
      // reconnect storm; a throwing disconnect/connect must never take the
      // refresh controller down.
      reconnect: (id) => {
        try {
          sm.disconnect(id);
          sm.connect(id);
        } catch (error) {
          console.warn(`[dsh-chamber] session-refresh recovery reconnect failed for ${id}: ${String(error)}`);
        }
      },
      warn: message => console.warn(`[dsh-chamber] ${message}`),
    });
    // S24 audit transition dedupe (design 17 §13.4.4): record PHASE
    // TRANSITIONS only (a summary-only status push keeps the same phase and is
    // not a transition) and one register/unregister edge per instance.
    const lastAuditedPhase = new Map<string, string>();
    const auditRegistered = new Set<string>();
    // Plugin-sync dependency injection (design 13 M2+M3, contract A): the
    // orchestration in plugin-sync.ts is decoupled from the transport runtime,
    // so it is adapted here onto transport-manager.exec(id, action, payload?).
    // plugin-sync re-declares the exec/status contract locally (no transport
    // import); the `as unknown as ExecFn` cast bridges that contract onto the
    // transport manager's structurally-identical runtime surface. `status`
    // matches the runtime status(id) projection directly.
    const execTransport = sm.exec as unknown as ExecFn;
    const statusTransport: StatusFn = (id) => sm.status(id);
    // Live-effect probe for the chamber host-graph state (design 09 module A):
    // adapts probeClientGraphLive (ssh-provider.ts, tunnel RPC) onto
    // plugin-sync's LiveProbe shape. `readyUrl` is main-process only (never
    // the renderer); no ready tunnel → null = "not probed" (the plugin UI then
    // renders 生效状态未知 instead of a guessed claim).
    const liveProbeFor = (id: string): (() => Promise<boolean | null>) => () => {
      const url = sm.readyUrl(id);
      if (url === null) return Promise.resolve(null);
      try {
        const parsed = new URL(url);
        const port = parsed.port === '' ? null : Number(parsed.port);
        if (port === null || !Number.isInteger(port) || port < 1 || port > 65535) return Promise.resolve(null);
        return probeClientGraphLive({ host: parsed.hostname, port }).then(result =>
          result === 'live' ? true : result === 'not-live' ? false : null);
      } catch {
        return Promise.resolve(null);
      }
    };
    // Live-effect probe for the SECOND chamber host package (design 08 §11):
    // same shape as liveProbeFor, hitting gitWorktree/previewCreate. A 404
    // there is deterministic "the running instance never loaded the
    // git-worktree row" — host-graph being live from an older boot does NOT
    // prove it (a ready-time seed can add the git row after that boot).
    const gitWorktreeLiveProbeFor = (id: string): (() => Promise<boolean | null>) => () => {
      const url = sm.readyUrl(id);
      if (url === null) return Promise.resolve(null);
      try {
        const parsed = new URL(url);
        const port = parsed.port === '' ? null : Number(parsed.port);
        if (port === null || !Number.isInteger(port) || port < 1 || port > 65535) return Promise.resolve(null);
        return probeGitWorktreeLive({ host: parsed.hostname, port }).then(result =>
          result === 'live' ? true : result === 'not-live' ? false : null);
      } catch {
        return Promise.resolve(null);
      }
    };
    // Exact-incarnation single-flight for ready/manual host-package seeds. A
    // changed same-id target supersedes immediately; stale finally/log/result
    // paths cannot clear or write into its replacement.
    const hostPackageSeeding = new ExactOwnershipRegistry();
    const readySeedEdges = new ReadyPhaseEdges();
    // The authoritative local dsh home is <userData>/state/dsh-home (the real
    // spawn home, design 13 §2.2) — never dsh-chamber:info.dshHome.
    // localDshHome was resolved before control-plane construction so the
    // startup transaction and every plugin action share one authoritative path.
    // Host package sources for the remote seed (design 13 §4.6). Packaged
    // builds carry copies under dist/; dev reads the same source dirs used by
    // the local control-plane seed.
    const moduleASourceDir = app.isPackaged
      ? path.join(pkgDir, 'dist', 'host-graph-package')
      : path.join(repoRoot, 'packages', 'dsh-host-client-graph');
    const gitWorktreeHostSourceDir = app.isPackaged
      ? path.join(pkgDir, 'dist', 'host-git-worktree-package')
      : path.join(repoRoot, 'packages', 'dsh-chamber-host-git-worktree');
    const archiveCleanupHostSourceDir = app.isPackaged
      ? path.join(pkgDir, 'dist', 'host-archive-cleanup-package')
      : path.join(repoRoot, 'packages', 'dsh-host-archive-cleanup');
    const chamberHostPackageSeeds: ChamberHostPackageSeed[] = [
      {
        insertId: CLIENT_GRAPH_INSERT_ID,
        packageName: CLIENT_GRAPH_PACKAGE_NAME,
        sourceDir: moduleASourceDir,
        label: 'host-graph',
      },
      {
        insertId: GIT_WORKTREE_INSERT_ID,
        packageName: GIT_WORKTREE_PACKAGE_NAME,
        sourceDir: gitWorktreeHostSourceDir,
        label: 'git-worktree',
      },
      {
        insertId: ARCHIVE_CLEANUP_INSERT_ID,
        packageName: ARCHIVE_CLEANUP_PACKAGE_NAME,
        sourceDir: archiveCleanupHostSourceDir,
        label: 'archive-cleanup',
      },
    ];
    type RemoteTarget = {
      spec: RemoteSpec
      fingerprint: string
      sourceToken: NotificationSourceToken
    }
    const findRemoteTarget = (id: string): RemoteTarget | null => {
      const instance = sm.listInstances().find((entry) => entry.id === id);
      if (instance === undefined || instance.kind !== 'dsh' || instance.transport !== 'ssh') return null;
      const sourceToken = captureNotificationSource(`${instance.kind}-${instance.id}`);
      if (sourceToken === null) return null;
      return {
        spec: { id: instance.id, remoteDshHome: instance.remoteDshHome ?? null },
        fingerprint: operationalFingerprint(instance),
        sourceToken,
      };
    };
    const ownsRemoteTarget = (target: RemoteTarget): boolean =>
      ownsNotificationSource(target.sourceToken)
      && findRemoteTarget(target.spec.id)?.fingerprint === target.fingerprint;
    const scopedExecForTarget = (target: RemoteTarget, extraOwner: () => boolean = () => true): ExecFn =>
      scopeExecToOwnership(execTransport, target.spec.id, () => extraOwner() && ownsRemoteTarget(target));
    const scopedStatusForTarget = (target: RemoteTarget): StatusFn => id =>
      id === target.spec.id && ownsRemoteTarget(target) ? statusTransport(id) : null;
    const scopedProbeForTarget = (target: RemoteTarget, probe: () => Promise<boolean | null>): (() => Promise<boolean | null>) => async () => {
      if (!ownsRemoteTarget(target)) return null;
      const result = await probe();
      return ownsRemoteTarget(target) ? result : null;
    };
    // Remote install-level fallback path shared by both chamber host packages.
    const remoteHostPackageDir = (spec: RemoteSpec, packageName: string): string =>
      `${remoteHome(spec.remoteDshHome)}/profiles/node_modules/${packageName}`;
    const startAutomaticHostSeed = (id: string): void => {
      const target = findRemoteTarget(id);
      if (target === null) return;
      const begun = hostPackageSeeding.begin(id, target.fingerprint);
      if (!begun.accepted) return;
      const token = begun.token;
      const ownsSeed = () => hostPackageSeeding.owns(token) && ownsRemoteTarget(target);
      const appendSeedLog = (level: 'info' | 'error', message: string): void => {
        if (ownsSeed()) sm.appendLog(id, level, message);
      };
      void (async () => {
        try {
          const builtSeeds = chamberHostPackageSeeds.filter(seed => existsSync(path.join(seed.sourceDir, 'dist', 'index.js')));
          if (builtSeeds.length === 0) {
            if (ownsSeed()) console.log(`[dsh-chamber] chamber host seed skipped for ${id}: no built host package artifacts`);
            appendSeedLog('info', 'chamber host 包未注入：构建产物缺失；远端相关客户端能力不可用');
            return;
          }
          const missingSeeds = chamberHostPackageSeeds.filter(seed => !builtSeeds.includes(seed));
          if (missingSeeds.length > 0) {
            appendSeedLog('info', `chamber host 包部分未注入（构建产物缺失）：${missingSeeds.map(seed => seed.label).join(', ')}`);
          }
          const result = await seedRemoteChamberHostPackages(
            scopedExecForTarget(target, ownsSeed),
            target.spec,
            chamberHostPackageSeeds,
          );
          if (!ownsSeed()) return;
          if (result.ok) {
            const seeded = result.packages.map(entry => entry.insertId).join(',');
            console.log(`[dsh-chamber] chamber host packages seeded onto ${id} (${seeded}; wrote=${result.wrote}, patched=${result.patched})`);
            const packageSummary = result.packages.map(entry =>
              `${entry.insertId}${entry.wrote ? ' 已写入' : ' 已是最新'}（${remoteHostPackageDir(target.spec, entry.packageName)}）`).join('；');
            appendSeedLog('info', `chamber host 包注入完成：${packageSummary}；boot 层${result.patched ? '已合并挂载' : '无需改动'}（重启后生效）`);
          } else {
            console.warn(`[dsh-chamber] chamber host seed failed for ${id}: ${result.error}`);
            appendSeedLog('error', `chamber host 包注入失败：${result.error}`);
          }
        } catch (err) {
          if (!ownsSeed()) return;
          const detail = describeUnknownError(err);
          console.warn(`[dsh-chamber] chamber host seed error for ${id}: ${detail}`);
          appendSeedLog('error', `chamber host 包注入异常：${detail}`);
        } finally {
          hostPackageSeeding.finish(token);
        }
      })();
    };
    // 2026-12 Phase 3: desktop-synced chamber host packages. The local copies
    // (dev source tree / packaged dist) are the same sources the local
    // control-plane seed uses; the sync uploads them into the gateway seed
    // cache after every gateway ready registration.
    const localChamberHostPackageSources = (): Array<{ name: string; packageJsonPath: string; distIndexPath: string }> => {
      const graphDir = app.isPackaged
        ? path.join(pkgDir, 'dist', 'host-graph-package')
        : path.join(repoRoot, 'packages', 'dsh-host-client-graph');
      const gitDir = app.isPackaged
        ? path.join(pkgDir, 'dist', 'host-git-worktree-package')
        : path.join(repoRoot, 'packages', 'dsh-chamber-host-git-worktree');
      const archiveCleanupDir = app.isPackaged
        ? path.join(pkgDir, 'dist', 'host-archive-cleanup-package')
        : path.join(repoRoot, 'packages', 'dsh-host-archive-cleanup');
      return [
        { name: CLIENT_GRAPH_PACKAGE_NAME, packageJsonPath: path.join(graphDir, 'package.json'), distIndexPath: path.join(graphDir, 'dist', 'index.js') },
        { name: GIT_WORKTREE_PACKAGE_NAME, packageJsonPath: path.join(gitDir, 'package.json'), distIndexPath: path.join(gitDir, 'dist', 'index.js') },
        { name: ARCHIVE_CLEANUP_PACKAGE_NAME, packageJsonPath: path.join(archiveCleanupDir, 'package.json'), distIndexPath: path.join(archiveCleanupDir, 'dist', 'index.js') },
      ];
    };
    // Resolves the awaited sync outcome for the caller (the manual
    // gateway_plugin_sync IPC, design 21 §6.5) or null when the instance is
    // missing / no longer a gateway. The ready-registration call site keeps
    // the original fire-and-forget behavior via `void`.
    const syncGatewayChamberPluginsFor = async (
      id: string,
      url: string,
      headers: Record<string, string>,
      spkiPin: string | null,
    ): Promise<{ uploaded: boolean; skipped: boolean; failed?: boolean; error?: string } | null> => {
      const instance = sm.listInstances().find(candidate => candidate.id === id);
      if (instance === undefined || instance.kind !== 'gateway') return null;
      const packages: LocalChamberHostPackage[] = [];
      for (const source of localChamberHostPackageSources()) {
        try {
          packages.push({
            name: source.name,
            packageJson: readFileSync(source.packageJsonPath, 'utf8'),
            distIndex: readFileSync(source.distIndexPath, 'utf8'),
          });
        } catch {
          // Not built/bundled in this runtime — nothing to sync for this entry.
        }
      }
      return syncGatewayChamberPlugins({
        // Sync through the REGISTERED transport origin (the ready URL): for
        // an ssh tunnel that is the loopback endpoint the user verified,
        // never the (usually unreachable) remote host:port. The tunnel
        // authority override presents the remote gateway in the Host header
        // so the gateway's request policy (authority port == listen port)
        // accepts the request — the same discipline the control-plane proxy
        // registration above uses.
        origin: url,
        authority: instance.transport === 'ssh' ? gatewayTunnelAuthority(instance.remotePort) : undefined,
        headers,
        spkiPin,
        packages,
        logger: { warn: message => console.warn(message), log: message => console.log(message) },
      });
    };
    /**
     * Current ready-registration auth facts for one gateway instance (design
     * 17 §9.3): token/password existence, the live cached login cookie +
     * registration auth proof (keyed to the TRANSPORT's origin — for an ssh
     * tunnel the loopback endpoint `http://127.0.0.1:<localPort>` plus the
     * exact connection/target scope; for a direct http(s) endpoint the same
     * key as verifyUp minted), the tunnel Host authority and the SPKI pin.
     * S23: the SPKI pin rides the registration so the reverse proxy gates
     * every outbound https connection on it (the identity probe already
     * enforced it in verifyUp; a pin edit while live restarts the transport,
     * so this derivation always carries the current pin).
     * Derived identically by the ready registration and the post-verify
     * re-registration (onVerified below) so the two can never drift.
     */
    const currentGatewayAuth = (id: string, url: string, registered: TransportInstanceSpec | undefined): {
      auth: ReturnType<typeof gatewayRegistrationAuthHeaders>;
      tunnelAuthority: string | undefined;
      scope: string | undefined;
      spkiPin: string | undefined;
    } => {
      const token = getGatewayToken(id);
      const password = getGatewayPassword(id);
      const tunnelAuthority = registered !== undefined && registered.transport === 'ssh'
        ? gatewayTunnelAuthority(registered.remotePort)
        : undefined;
      const scope = registered === undefined ? undefined : gatewaySessionScopeForConnection(registered);
      let cookie: string | null = null;
      let authProof: GatewayRegistrationAuthProof | null = null;
      if (password !== null) {
        const origin = gatewaySessionOriginForUrl(url, undefined, tunnelAuthority, scope);
        cookie = origin === null ? null : gatewaySessions?.cachedCookie(origin) ?? null;
        authProof = origin === null ? null : gatewaySessions?.registrationAuthProof(origin) ?? null;
      }
      return {
        auth: gatewayRegistrationAuthHeaders(token, password !== null, cookie, authProof),
        tunnelAuthority,
        scope,
        spkiPin: registered !== undefined ? registered.spkiPin : undefined,
      };
    };
    /**
     * Proxy-registration auth-header fingerprints (design 17 §9.3): the ready
     * registration captures the session Cookie at ready time; a ready-state
     * re-verification (heartbeat / user activation) that finds the session
     * revoked and re-logs in (verifyUp's 401 → one stored-password re-login)
     * leaves the session manager with a FRESH cookie while the proxy keeps
     * riding the OLD (dead) one — live traffic would answer 401 until the
     * pre-expiry refresh timer (potentially hours away) or a manual
     * reconnect. The onVerified subscription below therefore re-registers
     * whenever the CURRENT auth headers differ from the registered ones.
     * Only NON-SECRET sha256 fingerprints are kept — header VALUES never
     * enter this map (credentials stay in the session manager / stores).
     */
    const registeredAuthFingerprints = new Map<string, string>();
    const authHeadersFingerprint = (headers: Record<string, string> | undefined): string => {
      const canonical = headers === undefined
        ? 'none'
        : Object.keys(headers).sort().map(key => `${key}:${headers[key]}`).join('|');
      return createHash('sha256').update(canonical).digest('hex');
    };
    const sanitizedRegistrationHeaders = (headers: Record<string, string>): Record<string, string> | undefined =>
      Object.keys(headers).length === 0 ? undefined : headers;
    sm.onStatusChanged((id, status) => {
      // S24 audit (design 17 §13.4.4): record non-secret phase TRANSITIONS
      // only (connecting/ready/error, incl. the requiresUserAction terminal
      // classification) — a summary-only push with the same phase is not a
      // transition. Never a credential, cookie or session body.
      const prevPhase = lastAuditedPhase.get(id);
      if (prevPhase !== status.phase) {
        lastAuditedPhase.set(id, status.phase);
        audit({
          ts: new Date().toISOString(),
          event: 'transport_phase',
          sourceId: id,
          kind: status.kind,
          transport: status.transport,
          detail: status.phase === 'error' && status.requiresUserAction
            ? 'error:requires_user_action'
            : status.phase,
        });
      }
      // Non-secret auth-mode marker for the registration audit (design 17
      // §2.3): token+password | token | password | none — an EXISTENCE projection, never the
      // value (S24). dsh targets have no auth surface → always none.
      const auditAuth = status.kind === 'gateway'
        ? getGatewayToken(id) !== null && getGatewayPassword(id) !== null ? 'token+password'
          : getGatewayToken(id) !== null ? 'token'
            : getGatewayPassword(id) !== null ? 'password' : 'none'
        : 'none';
      const auditDetail = `auth:${auditAuth}${status.insecureHttp ? ',http_plaintext' : ''}`;
      // Ready transport → per-instance reverse proxy (design 05 §7.1):
      // register the instance transport while it is ready, unregister the
      // moment it leaves ready. The transport URL only exists in the main
      // process — it never rides the renderer payload below (design 05 §8).
      const cp = controlPlane;
      if (cp !== null) {
        if (status.phase === 'ready') {
          const url = sm.readyUrl(id);
          if (url !== null) {
            if (status.kind === 'gateway') {
              // The gateway target is authenticated (design 17 §7/§9.3):
              // inject 0..2 sanctioned headers — the shared token as
              // Authorization Bearer when configured AND independently a
              // configured password's login session as the Cookie header
              // (verifyUp ensured the session before this registration, so
              // the cached cookie is header-ready). Neither → register
              // headerless (0 headers is legal — a --no-auth deployment).
              // dsh targets never inject auth headers (transport-
              // independent, §2.1/§9.3); the instance-proxy re-validates
              // the 0..2 whitelist on every registration.
              const registered = sm.listInstances().find(instance => instance.id === id);
              const facts = currentGatewayAuth(id, url, registered);
              const auth = facts.auth;
              if (!auth.ok) {
                // Fail closed on the verify→ready→register TOCTOU. A
                // password-only gateway must never be registered headerless
                // because its verified cookie was evicted/invalidated in the
                // gap. When a token is also configured, the pure decision
                // helper permits the intentional OR-principal bearer fallback.
                cp.unregisterInstanceTransport(`${status.kind}:${id}`);
                registeredAuthFingerprints.delete(`${status.kind}:${id}`);
                sessionRefresh?.disarm(id);
                sm.appendLog(id, 'warn', 'gateway session changed before proxy registration; re-authenticating');
                // Capture ONLY the scope for the recovery microtask — never
                // close over the whole facts object (its auth.headers carry
                // the session cookie).
                const scope = facts.scope;
                queueMicrotask(() => {
                  const currentStatus = sm.status(id);
                  const currentSpec = sm.listInstances().find(instance => instance.id === id);
                  if (currentStatus?.phase !== 'ready' || sm.readyUrl(id) !== url
                    || currentSpec === undefined || currentSpec.kind !== 'gateway'
                    || getGatewayPassword(id) === null
                    || scope === undefined
                    || gatewaySessionScopeForConnection(currentSpec) !== scope) return;
                  sm.disconnect(id);
                  sm.connect(id);
                });
                return;
              }
              const connectionId = `${status.kind}:${id}`;
              const headers = sanitizedRegistrationHeaders(auth.headers);
              cp.registerInstanceTransport(
                connectionId,
                url,
                headers,
                {
                  ...(registered === undefined ? {} : { transport: proxyTransport(registered.transport) }),
                  ...(facts.spkiPin === undefined ? {} : { tls: { spkiPin: facts.spkiPin } }),
                  ...(facts.tunnelAuthority === undefined ? {} : { authority: facts.tunnelAuthority }),
                },
              );
              registeredAuthFingerprints.set(connectionId, authHeadersFingerprint(headers));
              // 2026-12 Phase 3: desktop-synced chamber host packages — after
              // every gateway ready registration, best-effort sync the local
              // host packages into the gateway seed cache (idempotent: only
              // version mismatches re-upload, and the upload asks the gateway
              // for a controlled dsh restart so the running profile picks
              // them up). The gateway no longer ships its own copies, so the
              // managed dsh keeps its chamber host layer version-locked to
              // this desktop. Mobile access is NOT covered here: the mobile
              // plugin ships inside the gateway distribution instead (its
              // access chain has no desktop).
              // Manual-sync re-entry parameters (design 21 §6.5): keep the
              // registration-time origin/auth headers/SPKI pin (main process
              // only — never renderer-supplied, never persisted or logged)
              // so a later gateway_plugin_sync(id) can re-run this exact
              // sync without waiting for a fresh ready edge.
              setGatewaySyncRegistration(id, { url, headers: { ...auth.headers }, spkiPin: facts.spkiPin ?? null });
              void syncGatewayChamberPluginsFor(id, url, auth.headers, facts.spkiPin ?? null);
            } else {
              cp.registerInstanceTransport(`${status.kind}:${id}`, url, undefined, {
                transport: proxyTransport(status.transport),
              });
              registeredAuthFingerprints.set(`${status.kind}:${id}`, authHeadersFingerprint(undefined));
            }
            // Live-proxy session self-healing (design 17 §9.3): arm the
            // pre-expiry refresh for every gateway target — the controller
              // no-ops for no-password targets and re-arms idempotently
            // (a reconnect re-arms under the new tunnel origin). dsh targets
            // have no auth surface → nothing to refresh.
            if (status.kind === 'gateway') sessionRefresh?.arm(id);
            // S24: one registration edge per instance (ready-phase summary
            // pushes are not re-audited); the marker carries auth mode +
            // insecureHttp honesty, never a credential value.
            if (!auditRegistered.has(id)) {
              auditRegistered.add(id);
              audit({
                ts: new Date().toISOString(),
                event: 'transport_registered',
                sourceId: id,
                kind: status.kind,
                transport: status.transport,
                detail: auditDetail,
              });
            }
          }
        } else {
          cp.unregisterInstanceTransport(`${status.kind}:${id}`);
          registeredAuthFingerprints.delete(`${status.kind}:${id}`);
          // Leaving ready cancels the pre-expiry refresh — a disconnected /
          // removed transport must not re-login or re-register (a later ready
          // re-arms with the fresh session).
          sessionRefresh?.disarm(id);
          // Manual gateway_plugin_sync re-entry dies with the ready
          // registration: its transport origin/headers/pin are only valid
          // while the instance is ready (design 21 §6.5).
          setGatewaySyncRegistration(id, null);
          if (auditRegistered.delete(id)) {
            audit({
              ts: new Date().toISOString(),
              event: 'transport_unregistered',
              sourceId: id,
              kind: status.kind,
              transport: status.transport,
              detail: auditDetail,
            });
          }
        }
      }
      // Remote chamber host-package seed: when an SSH-transport dsh target
      // comes ready, materialize every built package and merge their loader
      // rows together (v2 semantics, design 17 §2: kind 'dsh' + transport
      // 'ssh' is the v1 kind 'ssh' shape — the seed runs over the ssh exec
      // channel, so http-direct and gateway targets are excluded).
      // NOT silent — the plugin management UI probes the live state and shows
      // the injection block verbatim (installed/patched), and the seed result
      // is logged here; a failure is retried on the next ready (the seed is
      // idempotent, content-hash skip). The exact token is only an in-flight
      // owner, never a persisted "seeded" claim.
      if (status.kind === 'dsh' && status.transport === 'ssh' && readySeedEdges.observe(id, status.phase)) {
        startAutomaticHostSeed(id);
      }
      const statusWindow = mainWindow;
      if (statusWindow !== null) {
        const pushed = attemptCommittedRegistryPush(() => {
          if (mainWindow !== statusWindow || statusWindow.isDestroyed()) throw new Error('status renderer changed before push');
          if (!edges.rendererPush(IPC_CHANNELS.SSH_STATUS_CHANGED, { id, status })) {
            throw new Error('status renderer push failed');
          }
        });
        if (!pushed.sent) {
          try { console.warn(`[dsh-chamber] transport 状态已更新但 renderer push 失败：${pushed.error}`); } catch { /* callback boundary */ }
        }
      }
    });

    // Ready-state re-verification → proxy re-registration (design 17 §9.3):
    // a heartbeat/user probe can rotate the password session inside verifyUp
    // (401 → one stored-password re-login), leaving the proxy riding the
    // registered (dead) cookie. Re-register ONLY when the current auth
    // headers differ from the registered ones — registerInstanceTransport
    // revokes live traffic, so an unchanged healthy registration must never
    // be re-registered (the 60s heartbeat would otherwise blink every
    // instance every minute). dsh targets have no auth surface and no-op
    // here; failures never emit (they flip the phase instead).
    sm.onVerified(id => {
      const cp = controlPlane;
      const current = sm.status(id);
      if (cp === null || current === null || current.phase !== 'ready' || current.kind !== 'gateway') return;
      const url = sm.readyUrl(id);
      const registered = sm.listInstances().find(instance => instance.id === id);
      if (url === null || registered === undefined || registered.kind !== 'gateway') return;
      const facts = currentGatewayAuth(id, url, registered);
      // Fail closed like the ready registration: never replace the live
      // registration with a headerless one because the cookie vanished in
      // the gap — the next probe/heartbeat re-evaluates.
      if (!facts.auth.ok) return;
      const connectionId = `gateway:${id}`;
      const headers = sanitizedRegistrationHeaders(facts.auth.headers);
      if (authHeadersFingerprint(headers) === registeredAuthFingerprints.get(connectionId)) return;
      cp.registerInstanceTransport(
        connectionId,
        url,
        headers,
        {
          transport: proxyTransport(registered.transport),
          ...(facts.spkiPin === undefined ? {} : { tls: { spkiPin: facts.spkiPin } }),
          ...(facts.tunnelAuthority === undefined ? {} : { authority: facts.tunnelAuthority }),
        },
      );
      registeredAuthFingerprints.set(connectionId, authHeadersFingerprint(headers));
      sm.appendLog(id, 'info', 'gateway session re-established — proxy registration refreshed with the new session');
    });

    /**
     * Finish every committed registry transition through the main-branch
     * source-lifecycle authority. Metadata/secret persistence is owned by the
     * transaction; this sidecar rotates renderer/native-notification proofs,
     * revokes exact plugin-seed owners, and publishes the committed roster.
     * W-10 S2：证明投影/代际同步/队列退役清理在 shell-core
     * （projectNotificationSourceInstances / syncNotificationSourceRegistry），
     * 活跃原生通知的退役驱逐经 edges.retireNotificationsForSources（B4 登记在
     * electron-edges 私有）。
     * W-10 S3：本 sidecar 留 main 装配侧（C 组注册体已迁 shell-core
     * installIpcHandlers ②，save/delete 经 ctx.publishRegistryTransition
     * 调用本函数）；projectInstanceSecrets 定义随投影链迁入 shell-core
     * （core→main 单向 import，S2 同款），本函数不再持有局部定义。
     */
    const publishRegistryTransition = (
      before: readonly TransportInstanceSpec[],
      after: readonly TransportInstanceSpec[],
    ) => {
      const projected = projectNotificationSourceInstances(after);
      if (JSON.stringify(before) === JSON.stringify(after)) {
        return projected.map(projectInstanceSecrets);
      }
      const projectedSaved = projected.map(projectInstanceSecrets);

      const removedIds = computeRemovedInstanceIds(before, after);
      // Manual gateway-sync re-entry dies with the instance (design 21 §6.5):
      // a removed row must never keep a registration a later
      // gateway_plugin_sync(id) call could sync against.
      for (const id of removedIds) {
        setGatewaySyncRegistration(id, null);
        sshPluginJournal.clear(id);
      }
      const retiredIds = computeRetiredInstanceIds(before, after);
      const afterById = new Map(after.map(instance => [instance.id, instance]));
      const reseedIds: string[] = [];
      for (const previous of before) {
        const current = afterById.get(previous.id);
        if (current === undefined || operationalFingerprint(previous) !== operationalFingerprint(current)) {
          readySeedEdges.forget(previous.id);
          hostPackageSeeding.revoke(previous.id);
          // The plugin undo journal is bound to the OPERATIONAL target: an
          // id-stable edit that changed host/user/service/home invalidates
          // every op recorded on the previous target (design 21 §6.4 review
          // P1) — drop them here AND at undo time (latestOkForTarget).
          sshPluginJournal.clear(previous.id);
          if (current?.kind === 'dsh' && current.transport === 'ssh') reseedIds.push(previous.id);
        }
      }

      // W-10 S2：代际同步 + 两条队列的退役丢弃 = shell-core
      // syncNotificationSourceRegistry（返回退役 id）；活跃原生通知驱逐 =
      // edges.retireNotificationsForSources（原 activeNotifications 迭代）。
      const retiredNotificationSources = new Set(syncNotificationSourceRegistry(projected));
      if (retiredNotificationSources.size > 0) {
        edges.retireNotificationsForSources(retiredNotificationSources);
      }

      // A service/home edit may complete while the transport is already
      // ready. Seed the replacement owner explicitly; ordinary reconnects
      // are picked up by the ready edge above.
      for (const id of reseedIds) {
        if (sm.status(id)?.phase === 'ready') startAutomaticHostSeed(id);
      }

      const registryWindow = mainWindow;
      if (registryWindow !== null) {
        const pushed = attemptCommittedRegistryPush(() => {
          if (mainWindow !== registryWindow || registryWindow.isDestroyed()) {
            throw new Error('registry renderer changed before push');
          }
          if (!edges.rendererPush(IPC_CHANNELS.SSH_INSTANCES_CHANGED, { removedIds, retiredIds })) {
            throw new Error('registry renderer push failed');
          }
        });
        if (!pushed.sent) {
          console.warn(`[dsh-chamber] registry 已保存但 lifecycle push 失败（等待 renderer 重拉）：${pushed.error}`);
        }
      }
      return projectedSaved;
    };
    // —— W-10 S3：registry+凭据 C 组 7 注册体（SSH_INSTANCES_GET /
    // SSH_SAVE_CONNECTION / SSH_DELETE_CONNECTION / SSH_INSTANCES_SET /
    // SSH_SET_PASSWORD / GATEWAY_SET_TOKEN / GATEWAY_SET_PASSWORD）自 main.ts
    // 迁入 shell-core installIpcHandlers ② C 组段（注册体/纯辅助/投影链逐字
    // 随迁；装配依赖经 ctx：transportManager/audit/gatewaySessions/
    // publishRegistryTransition）。本 sidecar 与其宿主生命周期对象
    // （readySeedEdges/hostPackageSeeding/sshPluginJournal/… 与
    // SSH_INSTANCES_CHANGED push 文本）留本文件——renderer-trust 锚定。

    // —— W-10 S4：ssh 连接状态 D 组 7 注册体（SSH_CONFIG_LIST / SSH_CONNECT /
    // SSH_DISCONNECT / SSH_STATUS / SSH_REVERIFY / SSH_LOGS / SSH_LOGS_CLEAR）
    // 自 main.ts 迁入 shell-core installIpcHandlers ② D 组段（注册体逐字随迁，
    // 按 C 组之后原序追加；CONFIG_LIST 的非秘密投影纪律注释随迁）。装配依赖
    // 经 ctx：transportManager（Pick 扩 reverify/logs/clearLogs，见
    // ShellAssemblyCtx）；ssh-config 发现经纯模块 ssh-config.ts import（main
    // 侧 import 随迁移除）。exec/systemd（SSH_START/STOP/IS_ACTIVE/
    // RESTART_SERVICE）4 注册体已随 W-10 S5 迁出（见下 E 组标记），插件管理
    // 等其余 handler 留本文件。

    // —— W-10 S5：exec/systemd E 组 4 注册体（SSH_START_SERVICE /
    // SSH_STOP_SERVICE / SSH_IS_ACTIVE / SSH_RESTART_SERVICE）自 main.ts 迁入
    // shell-core installIpcHandlers ② E 组段（D 组之后按原序；注册体逐字随迁，
    // 「Provider exec channel」投影纪律注释随迁）。装配依赖经 ctx：
    // transportManager（Pick 扩 exec，见 ShellAssemblyCtx——装配注入完整现实
    // 例，无新字段）。systemctl argv 固定参数数组 `systemctl <action> -- <
    // serviceName>` 与服务名白名单（SERVICE_NAME_PATTERN，design 02 §3.9——
    // 拒绝发生在任何 spawn 前）及 generation 复验纪律（exec 结果/serviceActive
    // 提交前 execIsCurrent 复验，防旧代污染）在 transport-manager/ssh-provider
    // 纯模块内部，不随迁。restart 注册体原经本文件 execTransport（= sm.exec 的
    // ExecFn 收窄别名）调同一执行面——该别名仍为下方插件管理面 scopedExec 所
    // 用，留本文件。

    // —— W-10 S6：ssh plugin F 组 6 注册体（SSH_PLUGIN_LIST / SSH_PLUGIN_APPLY
    // / SSH_PLUGIN_UNDO / SSH_SEED_HOST_GRAPH / SSH_PLUGIN_MATERIALIZE_ADD /
    // SSH_PLUGIN_MATERIALIZE_ADD_PICK）自本文件迁入 shell-core installIpcHandlers
    // ② F 组段（E 组之后按原序；注册体逐字随迁，trustedIpc 围栏由装配侧注入
    // registrar 包装）。编排纯模块（plugin-sync / ssh-apply-rows /
    // plugin-tarball）在 core 直接 import；共享现实例/闭包束经 ctx 注入
    // （localDshHome / sshPluginJournal / hostPackageSeeding /
    // chamberHostPackageSeeds / sshPluginTargets——自动 seed/ready 撤销路径与
    // F 组共用同一实例/闭包族，本文件侧定义留用）。确认对话框（原
    // confirmPluginAction 形状）与插件源 picker（原模块级 pickPluginSource——
    // 已自本文件删除）宿主函数体迁 electron-edges.ts（HostEdges.showMessage /
    // pickPluginSource）；本文件余下 gateway/local 调用点已改经 edges。
    // transportManager Pick 扩 appendLog。插件管理（GATEWAY_PLUGIN_* 3 注册体
    // 已随 W-10 S7 G 组迁出——见下方 S7 总标记；LOCAL_PLUGIN_* / NPM_SEARCH
    // 5 注册体已随 W-10 S8 H 组迁出——见下方 S8 总标记）注册体至此全部迁出
    // 本文件。

    // —— W-10 S7：gateway 插件 G 组 3 注册体（GATEWAY_PLUGIN_SYNC /
    // GATEWAY_PLUGIN_APPLY / GATEWAY_PLUGIN_MATERIALIZE）自本文件迁入 shell-core
    // installIpcHandlers ② G 组段（F 组之后按原序；注册体逐字随迁，trustedIpc
    // 围栏由装配侧注入 registrar 包装）。编排纯模块（gateway-provider /
    // gateway-sync-registry / gateway-ipc-shared / plugin-tarball）在 core 直接
    // import（本文件 import 面已按迁出收窄：getGatewaySyncRegistration /
    // buildPluginTarball / validateApplyPayload / buildApplyConfirmMessage /
    // gatewayChamberApplyBatch / gatewayChamberMaterialize 随迁删除）。确认
    // 对话框经 core 内 S6 edges 版 confirmPluginAction 助手（宿主腿 =
    // HostEdges.showMessage；本文件原 confirmPluginAction 闭包已随 W-10 S8 H 组
    // 迁出删除——LOCAL_PLUGIN_ADD/REMOVE 迁出后无剩余使用点，见 S8 总标记）、
    // 无存活主窗预检经 edges.mainWindowAlive、
    // 插件源 pick 经 edges.pickPluginSource。手动 sync 的上传执行闭包
    // syncGatewayChamberPluginsFor 经 ctx 注入 core（ready 自动 sync（本文件
    // sm.onStatusChanged ready 边缘）与手动 re-entry 共用同一执行路径与注册
    // 参数，语义不分叉——本文件侧定义留用）。

    // —— W-10 S8：本地插件 + npm 搜索 H 组 5 注册体（LOCAL_PLUGIN_LIST /
    // NPM_SEARCH / LOCAL_PLUGIN_ADD_FILE / LOCAL_PLUGIN_ADD / LOCAL_PLUGIN_REMOVE）
    // 自本文件迁入 shell-core installIpcHandlers ② H 组段（G 组之后按原序；注册体
    // 逐字随迁，trustedIpc 围栏由装配侧注入 registrar 包装）——五注册体原文本整体
    // 移走，本处原位留标记。编排纯模块（plugin-sync：localPluginList /
    // runLocalDshPlugin / describeLocalPluginAddConfirmation /
    // describeLocalPluginRemoveConfirmation；plugin-tarball classifyPluginPick；
    // @dsh-chamber/dsh-runtime isAllowedRegistryUrl——npm 搜索 registry URL
    // 白名单）在 core 直接 import（本文件 import 面已按迁出收窄：以上符号 +
    // NPM_SEARCH_MAX_BODY_BYTES 随迁删除）。插件管理面的 loud 形状纪律与 npm
    // 搜索的 best-effort 语义注释（main-process fetch、renderer 留 127.0.0.1、
    // redirect manual、bounded read）随注册体迁入 core。确认对话框经 core 内 S6
    // edges 版 confirmPluginAction 助手（宿主腿 = HostEdges.showMessage；按钮序/
    // 取消默认/无窗文案逐字一致——本文件 confirmPluginAction 闭包已删除，见上方
    // 定义处标记）、ADD_FILE 的无存活主窗预检经 edges.mainWindowAlive、插件源
    // pick（ADD_FILE）经 edges.pickPluginSource。本地安装的宿主子进程编排
    // （runLocalPluginMutation：runtime writer fence 租约 + runtimeStartBlocked
    // 启动门 + resolveActiveRuntime workspace 解析）本文件侧定义留用、经 ctx
    // 注入 core（fence/启动门归装配侧；add 子进程 env 装配/白名单纪律在
    // plugin-sync runLocalDshPlugin 纯模块内，W-14 关联 C-F12 登记不变）。
    // 宿主生命周期对象（自动 seed / journal / 撤销路径 / reapStaleLocalPluginWriters
    // / disposePluginSyncChildren 等）仍留本文件装配侧。插件管理 IPC 注册体至此
    // 全部迁出本文件。

    // VS Code 深链（design 16 §4/§5）+ open-in 注册表（open-in.ts）的共享宿主
    // 依赖束：wiredCtx 同时供 OS 深链 drain（runVscodeLaunch）与 open-in 执行
    // 管线复用。lookupInstance 查 transportManager 实查；vscodeAvailable 每次
    // 实探（getter 惰性、无缓存陈旧）；openVscodeUrl 包装 shell.openExternal
    // （catch → loud error，返回 {error} 由调用方处理）。
    const wiredCtx: VscodeLaunchContext = {
      lookupInstance: (id) => {
        const instance = sm.listInstances().find(entry => entry.id === id);
        if (instance === undefined) return null;
        // v2 (design 17 §2): the vscode-remote URL is an ssh-TRANSPORT
        // feature — expose the transport, not the target kind.
        return { id: instance.id, host: instance.host, user: instance.user, sshPort: instance.sshPort, transport: instance.transport };
      },
      vscodeAvailable: () => detectVscodeAvailability(process.platform).available,
      // Chamber setting `vscodeOpenInNewWindow`（design 16 §3.3）：每次拉起惰性
      // 读取（与 vscodeAvailable 同款 getter），设置变更即时作用于下一次拉起；
      // 由 open-in 按钮与 OS 深链两条入口共享（同一 wiredCtx）。
      vscodeOpenInNewWindow: () => chamberSettings.vscodeOpenInNewWindow,
      openVscodeUrl: async (url) => {
        // Injection-point scheme re-verification (security-review P2-1, mirror
        // of isAllowedReleaseUrl's discipline): only our constructed targets
        // may ever reach shell.openExternal — the ssh-remote URL for remote
        // sources and the file URL for the local source (user decision
        // 2026-08: local workspaces open as local folders).
        if (typeof url !== 'string' || !(url.startsWith('vscode://vscode-remote/') || url.startsWith('vscode://file/'))) {
          const message = 'refused to open a non-vscode URL';
          console.error(`[dsh-chamber] ${message}:`, url);
          return { ok: false, error: message };
        }
        try {
          await shell.openExternal(url);
          return { ok: true };
        } catch (error) {
          const message = describeUnknownError(error);
          console.error('[dsh-chamber] 打开 vscode URL 失败：', error);
          return { ok: false, error: `open vscode url failed: ${message}` };
        }
      },
    };

    // open-in 注册表（open-in.ts）：apps() 能力协商 + 统一执行管线。wiredCtx
    // 复用 registry/availability/openVscodeUrl 依赖，补 shell 文件系统面
    // （stat/openPath/showItemInFolder 均为主进程包装）。原 design 16 的两个
    // vscode IPC（vscode-availability / open-vscode）随旧插件删除而移除——渲染
    // 层唯一入口收敛为 open-in 两个通道（复核 2026-08）。
    const openInCtx: OpenInLaunchContext = {
      platform: process.platform,
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
        return invokeOpenPath(value => shell.openPath(value), p)
      },
      showItemInFolder: (p) => shell.showItemInFolder(p),
    }
    ipcMain.handle(IPC_CHANNELS.OPEN_IN_APPS, trustedIpc(() => ({
      apps: listOpenInApps(openInCtx, (appId, error) => {
        console.error(`[dsh-chamber] open-in provider ${appId} 可用性探测失败：${error}`)
      }),
    })))
    ipcMain.handle(IPC_CHANNELS.OPEN_IN, trustedIpc(async (payload: unknown) => {
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
    }))

    // Update controller (design 11): silent check on a startup delay + 6h
    // interval; autoDownload=false — checking never downloads, the download
    // starts ONLY when the user clicks「更新」in the settings update section
    // (dsh-chamber:update-download). The user can also check manually from
    // that section (dsh-chamber:update-check — the same silent check path,
    // still no download). Install is deferred to quit
    // (autoInstallOnAppQuit): no dialog, no mid-session interruption — and
    // once the download completed the settings section offers the explicit
    // user-triggered restart (dsh-chamber:update-restart →
    // updater.restartAndInstall → electron-updater quitAndInstall: quit +
    // install + relaunch through the normal before-quit/will-quit cleanup
    // path; 2026-12 user decision, controllable flow). The state projection
    // is non-secret only (versions / channel / release URL / short error
    // text) and every failure is silent (main-process log), never blocking
    // startup — the settings section renders the honest state.
    const updater = createUpdateController({
      version,
      logger: {
        log: (...args) => console.log('[updater]', ...args),
        warn: (...args) => console.warn('[updater]', ...args),
        error: (...args) => console.error('[updater]', ...args),
      },
    });
    // Module-level ref so will-quit can read the update state for the quit-
    // confirmation exemption (design 14 D2).
    updateController = updater;
    updater.subscribe((updateState) => {
      const updateWindow = mainWindow;
      if (updateWindow !== null) {
        const pushed = attemptCommittedRegistryPush(() => {
          if (mainWindow !== updateWindow || updateWindow.isDestroyed()) throw new Error('updater renderer changed before push');
          if (!edges.rendererPush(IPC_CHANNELS.UPDATE_STATE_CHANGED, updateState)) {
            throw new Error('updater renderer push failed');
          }
        });
        if (!pushed.sent) {
          try { console.warn(`[dsh-chamber] updater 状态 push 失败（等待 renderer 重拉）：${pushed.error}`); } catch { /* callback boundary */ }
        }
      }
    });
    ipcMain.handle(IPC_CHANNELS.UPDATE_STATE, trustedIpc(() => updater.state()));
    ipcMain.handle(IPC_CHANNELS.UPDATE_CHECK, trustedIpc(() => updater.checkNow()));
    ipcMain.handle(IPC_CHANNELS.UPDATE_DOWNLOAD, trustedIpc(() => updater.download()));
    // The settings update section's「重启并安装」button (2026-12 user
    // decision): a completed download restarts the app into the install
    // (quitAndInstall) — the user controls when the update applies instead of
    // relying on the quit-install leg alone. Controller-side gates mirror the
    // rendered state (phase downloaded + no install block) — not just UI
    // hiding; quitAndInstall then quits through before-quit (the
    // update-downloaded exemption) and will-quit (cleanup first).
    ipcMain.handle(IPC_CHANNELS.UPDATE_RESTART, trustedIpc(() => updater.restartAndInstall()));
    // The settings update section's「前往下载页」link: popups are denied and
    // navigation is pinned to the control-plane origin, so opening a release
    // page must go through the main process. Strict allowlist — parsed, not
    // prefix-string matched: only this repo's GitHub pages can ever be opened
    // (never an arbitrary URL, subdomain, userinfo or path-root trick).
    ipcMain.handle(IPC_CHANNELS.OPEN_RELEASE, trustedIpc(({ url }) =>
      openReleasePage(url, value => shell.openExternal(value))));
    updater.start();

    // Design 18 runtime management: registry/install state and the startup
    // activation transaction publish through one controller projection.
    const pnpmEntry = app.isPackaged
      ? path.join(process.resourcesPath, 'pnpm', 'bin', 'pnpm.cjs')
      : path.join(pkgDir, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs');
    let storePruneOperation: Promise<void> | null = null;
    // The shared core's default node executor is plain node (design 18 §9.1);
    // the desktop injects its Electron-as-node branch for EVERY pnpm child —
    // installs AND store-prune — so dev and packaged modes run pnpm with the
    // same deliberate process semantics (ELECTRON_RUN_AS_NODE + --expose-internals).
    const runtimeNodeExecutor = (): { file: string; args: string[]; env: Record<string, string> } =>
      process.versions.electron !== undefined
        ? { file: process.execPath, args: ['--expose-internals'], env: { ELECTRON_RUN_AS_NODE: '1' } }
        : { file: process.execPath, args: [], env: {} };
    const runStorePruneIfNeeded = (): Promise<void> => {
      if (storePruneOperation !== null) return storePruneOperation;
      if (quitRequested || readStorePruneRequest(runtimeBaseDir) === null) return Promise.resolve();
      const operation = pruneRuntimeStore({ baseDir: runtimeBaseDir, pnpmEntry, deps: { node: runtimeNodeExecutor } })
        .then(() => { clearStorePruneRequest(runtimeBaseDir); })
        .catch((error) => {
          // Retain the marker: the next safe startup/operation retries. Prune
          // failure is disk hygiene, not permission to block a verified tree.
          console.error('[dsh-chamber] dsh runtime store prune failed:', sanitizeErrorText(error instanceof Error ? error.message : String(error)));
        })
        .finally(() => {
          if (storePruneOperation === operation) storePruneOperation = null;
        });
      storePruneOperation = operation;
      return operation;
    };
    const runtimeInstance = new DshRuntimeController({
      baseDir: runtimeBaseDir,
      bundledVersion,
      packageName: '@deepseek-ai/dsh',
      registryOrigin: chamberSettings.registryOrigin,
      getRegistryOrigin: () => chamberSettings.registryOrigin,
      envVersion: process.env.DSH_CHAMBER_DSH_PATH
        ? readDshVersion(process.env.DSH_CHAMBER_DSH_PATH)
        : null,
      envOverrideActive,
      managementSupported: runtimeManagementSupported,
      managementUnsupportedReason: runtimeManagementSupported
        ? null
        : '当前版本仅在 macOS/Linux 验证了运行时切换与数据恢复；Windows 暂为只读',
      pnpmEntry,
      compatibilityBaseline: bundledVersion,
      deps: {
        fetchMetadata: (pkg, origin) => fetchRegistryMetadata(pkg, { origin }),
        install: async (opts) => {
          await runStorePruneIfNeeded();
          // Merge, never replace: a future caller-supplied deps member (e.g.
          // deps.run) must survive the desktop's node-executor injection.
          return installRuntimeVersion({
            ...opts,
            deps: { ...opts.deps, node: runtimeNodeExecutor },
          });
        },
        store: {
          readOverride: (b) => readOverride(b),
          writeOverride: (b, record) => writeOverride(b, record),
          readCurrentPointer: (b) => readCurrentPointer(b),
          listVersionTrees: (b) => listValidVersionTrees(b),
          validateVersionTree: (b, runtimeVersion) => validateVersionTree(b, runtimeVersion),
          deleteOverride: (b) => deleteOverride(b),
          clearCurrentPointer: (b) => clearCurrentPointer(b),
          recordExplicitInstall: (b, runtimeVersion) => recordExplicitInstall(b, runtimeVersion),
          // perf T3（2026-09）：闸口走异步单遍遍历——等待同一段墙钟时间但
          // 主进程保持响应（大 store 下同步遍历会冻结整个应用）。
          // review N1（2026-09）：此 DI 回调由 controller install() 直接
          // await（安装闸口，见 dsh-runtime-controller.ts），绕过下方
          // refreshDiskUsage coalescer——与证据刷新并发时可能出现两遍全树
          // 遍历（罕见窗口、多一遍墙钟时间，无正确性影响；"绝不重复并发"
          // 不变量只对 coalescer 内的调用点成立）。
          runtimeDiskSummary: (b) => runtimeDiskSummaryAsync(b),
          writeActivationIntent: (b, input) => { writeActivationIntent(b, input); },
          clearActivationJournal: (b) => clearActivationJournal(b),
          recordFailure: (b, failure) => {
            recordRuntimeFailure(b, {
              version: failure.version,
              phase: 'installing',
              error: failure.reason,
              restoreOutcome: 'none',
            });
          },
        },
        shellVersion: version,
        // Live control-plane connection state projected to the renderer so it
        // can mirror the apply-now gate (ready/degraded only). controlPlane may
        // still be null here — the closure re-evaluates at every getState.
        connectionState: () => controlPlane?.connectionState ?? 'unknown',
      },
    });
    runtimeController = runtimeInstance;
    runtimeInstance.onChanged((state) => {
      if (mainWindow !== null && !mainWindow.isDestroyed()) {
        edges.rendererPush(IPC_CHANNELS.RUNTIME_STATE_CHANGED, state);
      }
    });
    const projectMetadataHealth = (
      phase: Parameters<typeof runtimeInstance.setLifecycle>[0]['phase'],
      canRetryRestore: boolean,
      restoreOutcome: 'none' | 'complete' | 'half' | 'incomplete',
    ): {
      metadataHealth: RuntimeMetadataHealthProjection
      metadataComponents: RuntimeMetadataComponent[]
      canRecoverMetadata: boolean
    } => {
      let health: RuntimeMetadataHealth;
      try {
        health = detectRuntimeMetadataHealth(runtimeBaseDir, version);
      } catch {
        return { metadataHealth: 'unknown', metadataComponents: [], canRecoverMetadata: false };
      }
      const components = new Set<RuntimeMetadataComponent>();
      if (health.current.kind === 'corrupt'
        || health.corruptEvidence.some(name => name.startsWith('current.'))) components.add('current');
      if (health.override.kind === 'corrupt'
        || health.corruptEvidence.some(name => name.startsWith('override.json.'))) components.add('override');
      if (health.activationJournal.kind === 'corrupt'
        || health.corruptEvidence.some(name => name.startsWith('activation-journal.json.'))) components.add('activation-journal');
      if (health.recovery.kind === 'corrupt'
        || (health.recovery.kind === 'valid' && health.recovery.record.phase !== 'finalized')) {
        components.add('recovery-marker');
      }
      if (health.corruptEvidence.length > 0) components.add('retained-evidence');
      const effectivePhase = phase ?? runtimeInstance.getState().phase;
      const markerRescueAvailable = health.status === 'recovery-marker-corrupt'
        && inspectCorruptMetadataRecoveryMarker(runtimeBaseDir).recoverable;
      const needsRecovery = health.status === 'selection-corrupt'
        || health.status === 'recovery-in-progress'
        || markerRescueAvailable;
      // 'incomplete' is a permanent restore outcome: the journaled snapshot is
      // missing or untrustworthy, so retry-restore can never succeed and the
      // recover-metadata escape must stay eligible (including when a stale
      // restore marker from the abandoned transaction is still present). A
      // 'half' outcome is transient and retryable, so it keeps the retry gate
      // and the marker gate fully closed.
      const permanentIncomplete = restoreOutcome === 'incomplete';
      const canRecoverMetadata = needsRecovery
        && (effectivePhase === 'idle' || effectivePhase === 'failed')
        && (permanentIncomplete || !canRetryRestore)
        && runtimeManagementSupported
        && !envOverrideActive
        && !runtimeBootstrapWriterUnsafe
        && cp.localWritersQuiescent
        && bundledVersion !== null
        && isSafeVersion(bundledVersion)
        && (permanentIncomplete || restoreMarkerAuthorityStatus(runtimeBaseDir) === 'missing');
      return {
        metadataHealth: health.status,
        metadataComponents: [...components],
        canRecoverMetadata,
      };
    };
    // perf T3（2026-09，D8）：磁盘统计"节流/单飞/终态一次"——版本事务的
    // 15 个 refresh 调用点与 UI/事件驱动的刷新突发共享遍历：单飞合并并发
    // 请求，运行期间到达者补跑一遍（终态一次）。"全树统计绝不重复并发"
    // 不变量仅对经本 coalescer 的 refresh 调用点成立——安装闸口经 controller
    // DI 直接 await runtimeDiskSummaryAsync、绕过本 coalescer（见上方
    // deps.store.runtimeDiskSummary 映射旁注，review N1）。runtimeDiskSummaryAsync
    // 本身按批让渡事件循环，主进程全程不被冻结。
    const refreshDiskUsage = createCoalescedRefresher(() => runtimeDiskSummaryAsync(runtimeBaseDir));
    // 最近一次完成的全树磁盘投影（含错误投影）。D7 进度跳过复用其值——
    // 终态/content 相位永远现场重走，绝不因复用而把陈旧终态交给 UI。
    let lastDiskEvidence: { usage: Awaited<ReturnType<typeof runtimeDiskSummaryAsync>> | null; error: string | null } | null = null;
    // D7 进度跳过的 skip 集与判定在 ./disk-evidence-gate.ts（纯模块 + 单测，
    // 2026-09 perf review M1；判定经 shouldSkipDiskRefresh 注入下方调用）。
    const refreshRuntimeEvidence = async (patch: Parameters<typeof runtimeInstance.setLifecycle>[0] = {}) => {
      const effectivePhase = patch.phase ?? runtimeInstance.getState().phase;
      const effectiveCanRetryRestore = patch.canRetryRestore
        ?? (runtimeInstance.getState().canRetryRestore === true);
      const effectiveRestoreOutcome = patch.restoreOutcome
        ?? runtimeInstance.getState().restoreOutcome
        ?? 'none';
      const showFailure = effectivePhase === 'failed' || effectivePhase === 'rollback'
        || effectivePhase === 'snapshot-failed' || effectivePhase === 'error';
      let snapshotProjection: Parameters<typeof runtimeInstance.setLifecycle>[0];
      try {
        const snapshots = await snapshotSummary(runtimeBaseDir);
        const failures = runtimeFailureSummary(runtimeBaseDir);
        snapshotProjection = {
          snapshotCount: snapshots.count,
          latestSnapshotAt: snapshots.latestAt,
          preRollbackCount: snapshots.preRollbackCount,
          preRollbackLatestName: snapshots.latestStashName,
          snapshotError: null,
          failure: !showFailure || failures.latest === null ? null : {
            version: failures.latest.version,
            at: failures.latest.lastFailedAt,
            reason: failures.latest.error,
          },
        };
      } catch (error) {
        snapshotProjection = {
          snapshotError: sanitizeErrorText(error instanceof Error ? error.message : String(error)),
        };
      }
      let diskProjection: Parameters<typeof runtimeInstance.setLifecycle>[0];
      const skipDisk = shouldSkipDiskRefresh(effectivePhase);
      if (skipDisk && lastDiskEvidence !== null) {
        // 进度相位：复用最近一次完整投影（无新遍历）——复用的是最近一次
        // **成功或失败**投影（review N4）：error 投影（如磁盘统计失败）在
        // 长下载事务中会持续展示，直到终态 patch 现场重走才自愈（取舍：
        // 进度相位优先低延迟展示，而非阻塞在重试统计上）；快照/版本清单等
        // 轻量面照常现场刷新。diskLimitExceeded 等派生字段随复用值同步给出。
        diskProjection = {
          diskUsage: lastDiskEvidence.usage,
          diskError: lastDiskEvidence.error,
          diskLimitBytes: DEFAULT_RUNTIME_LOGICAL_DISK_LIMIT_BYTES,
          diskLimitExceeded: lastDiskEvidence.usage === null
            ? null
            : lastDiskEvidence.usage.totalBytes >= DEFAULT_RUNTIME_LOGICAL_DISK_LIMIT_BYTES,
          explicitlyInstalledVersions: listExplicitlyInstalledVersions(runtimeBaseDir),
        };
      } else {
        try {
          const diskUsage = await refreshDiskUsage();
          lastDiskEvidence = { usage: diskUsage, error: null };
          diskProjection = {
            diskUsage,
            diskError: null,
            diskLimitBytes: DEFAULT_RUNTIME_LOGICAL_DISK_LIMIT_BYTES,
            diskLimitExceeded: diskUsage.totalBytes >= DEFAULT_RUNTIME_LOGICAL_DISK_LIMIT_BYTES,
            explicitlyInstalledVersions: listExplicitlyInstalledVersions(runtimeBaseDir),
          };
        } catch (error) {
          lastDiskEvidence = {
            usage: null,
            error: sanitizeErrorText(error instanceof Error ? error.message : String(error)),
          };
          diskProjection = {
            diskUsage: null,
            diskError: lastDiskEvidence.error,
            diskLimitBytes: DEFAULT_RUNTIME_LOGICAL_DISK_LIMIT_BYTES,
            diskLimitExceeded: null,
            explicitlyInstalledVersions: [],
          };
        }
      }
      runtimeInstance.setLifecycle({
        ...snapshotProjection,
        ...diskProjection,
        ...patch,
        // These fields are an authoritative main-process projection. A stale
        // lifecycle patch must never manufacture metadata-recovery authority.
        ...projectMetadataHealth(effectivePhase, effectiveCanRetryRestore, effectiveRestoreOutcome),
      });
    };

    const setRuntimeGate = (blocked: boolean, reason: string | null = null) => {
      runtimeStartBlocked = blocked;
      runtimeStartBlockedReason = blocked
        ? reason ?? 'dsh 运行时尚未通过安全确认'
        : '';
      cp.refreshLocalExposure();
    };

    const probesPassed = (probes: Awaited<ReturnType<typeof runRuntimeActivationProbes>>) =>
      probes.length > 0 && probes.every(probe => probe.ok);

    const startAndProbeWorkspace = async (workspace: string, signal?: AbortSignal) => {
      if (quitRequested) throw new Error('application is quitting');
      signal?.throwIfAborted();
      runtimeTransactionWorkspace = workspace;
      runtimeInternalStart = true;
      try {
        await cp.startLocal();
      } finally {
        runtimeInternalStart = false;
      }
      try {
        const port = cp.localDshPort;
        if (port === null) throw new Error('local dsh did not publish a probe port');
        return await runRuntimeActivationProbes({
          baseUrl: `http://127.0.0.1:${port}`,
          dshHome: localDshHome,
          call,
          signal,
        });
      } finally {
        runtimeTransactionWorkspace = null;
      }
    };

    const resolveExactRuntimeWorkspace = (runtimeVersion: string, isBuiltin: boolean): string => {
      if (isBuiltin) {
        if (builtinDshWorkspace === null || bundledVersion !== runtimeVersion) {
          throw new Error('内建 dsh 运行时清单与激活目标不一致');
        }
        return builtinDshWorkspace;
      }
      const tree = validateVersionTree(runtimeBaseDir, runtimeVersion);
      if (!tree.ok) throw new Error(`dsh runtime ${runtimeVersion} tree invalid: ${tree.error}`);
      return tree.path;
    };

    const startAndProbeRuntime = async (runtimeVersion: string, isBuiltin: boolean, signal?: AbortSignal) =>
      startAndProbeWorkspace(resolveExactRuntimeWorkspace(runtimeVersion, isBuiltin), signal);

    const startAndProbeCurrent = async (signal?: AbortSignal) => {
      const active = resolveActiveRuntime(runtimeBaseDir, builtinDshWorkspace);
      if (active.path === null) throw new Error(active.blockedReason ?? 'dsh workspace not found');
      return {
        active,
        probes: await startAndProbeWorkspace(active.path, signal),
      };
    };

    const selectedJournalIntent = (state: ActivationJournalState) => {
      if (state.kind !== 'valid') return null;
      if (state.journal.phase === 'applied-monitoring' && state.journal.nextIntent !== null) {
        return state.journal.nextIntent;
      }
      return state.journal;
    };

    const readActivationFacts = () => {
      // ACTIVATION-FACTS DIVERGENCE (stage2 ruling, 2026): the gateway twin
      // (runtime-manager.ts activationFacts) excludes the current POINTER
      // from latestKnownGood and short-circuits win32 (knownGoodVersion
      // null); this side excludes journalIntent.targetVersion ??
      // override.pending and validates the tree. Unification needs one core
      // helper + one exclusion rule (deferred: requires a new dsh-runtime
      // public export, dist locked).
      const pointer = readCurrentPointerState(runtimeBaseDir);
      if (pointer.kind === 'corrupt') throw new Error('current pointer metadata 损坏');
      const overrideState = readOverrideState(runtimeBaseDir);
      if (overrideState.kind === 'corrupt') throw new Error('override metadata 损坏');
      const journalIntent = selectedJournalIntent(readActivationJournalState(runtimeBaseDir));
      const excludedVersion = journalIntent?.targetVersion
        ?? (overrideState.kind === 'valid' ? overrideState.record.pending : null);
      if (pointer.kind === 'valid') {
        const tree = validateVersionTree(runtimeBaseDir, pointer.version);
        if (!tree.ok) throw new Error(`current runtime tree invalid: ${tree.error}`);
        const record = overrideState.kind === 'valid' ? overrideState.record : null;
        return {
          sourceVersion: pointer.version,
          sourceIsBuiltin: false,
          sourceWasKnownGood: listKnownGoodVersions(runtimeBaseDir).includes(pointer.version)
            || (record?.lastOutcome === 'applied' && record.resolvedVersion === pointer.version),
          knownGoodVersion: latestKnownGood(runtimeBaseDir, excludedVersion),
        };
      }
      if (bundledVersion === null || !isSafeVersion(bundledVersion)) {
        throw new Error('无法确认内建 dsh 运行时版本');
      }
      return {
        sourceVersion: bundledVersion,
        sourceIsBuiltin: true,
        sourceWasKnownGood: true,
        knownGoodVersion: latestKnownGood(runtimeBaseDir, excludedVersion),
      };
    };

    const buildStartupDeps = (): StartupDeps => {
      if (bundledVersion === null || !isSafeVersion(bundledVersion)) {
        throw new Error('无法确认内建 dsh 运行时版本');
      }
      return {
        cleanupStaleInstalls: () => cleanupStaleInstalls(runtimeBaseDir),
        evict: () => evictVersions(runtimeBaseDir),
        completeInterruptedRestore: () => completeInterruptedRestore(runtimeBaseDir, localDshHome),
        readOverrideState: () => readOverrideState(runtimeBaseDir),
        writeOverride: record => writeOverride(runtimeBaseDir, record),
        deleteOverride: () => deleteOverride(runtimeBaseDir),
        readCurrentPointerState: () => readCurrentPointerState(runtimeBaseDir),
        readActivationJournal: () => readActivationJournalState(runtimeBaseDir),
        writeActivationJournal: journal => writeActivationJournal(runtimeBaseDir, journal),
        clearActivationJournal: () => clearActivationJournal(runtimeBaseDir),
        envOverrideActive: () => envOverrideActive,
        shellVersion: version,
        builtinVersion: bundledVersion,
        activationFacts: readActivationFacts,
        snapshot: sourceVersion => snapshotDshHome(runtimeBaseDir, localDshHome, sourceVersion),
        resolveSnapshotName: snapshotName => resolveSnapshotName(runtimeBaseDir, snapshotName),
        prepareManualRollback: targetVersion => prepareManualRollbackData(runtimeBaseDir, localDshHome, targetVersion),
        validateTarget: (runtimeVersion, isBuiltin) => {
          if (isBuiltin) {
            return builtinDshWorkspace !== null && runtimeVersion === bundledVersion
              ? { ok: true as const }
              : { ok: false as const, error: '内建运行时清单与目标版本不一致' };
          }
          const tree = validateVersionTree(runtimeBaseDir, runtimeVersion);
          return tree.ok ? { ok: true as const } : { ok: false as const, error: tree.error };
        },
        switchPointer: runtimeVersion => {
          if (runtimeVersion === null) clearCurrentPointer(runtimeBaseDir);
          else writeCurrentPointer(runtimeBaseDir, runtimeVersion);
        },
        // The transaction-level signal flows through spawnAndProbe from
        // runStartupPhase/runDelayedRollback (apply-now S1). Never fall back
        // to a module-level aborted signal here: that would re-inject an
        // aborted signal into rollback verification probes, forging a
        // "candidate + fallback + builtin all failed" terminal state when the
        // abort lands inside the apply-now rollback window.
        spawnAndProbe: (runtimeVersion, isBuiltin, signal) => startAndProbeRuntime(
          runtimeVersion,
          isBuiltin,
          signal,
        ),
        stopHost: () => cp.stopLocal(),
        restore: snapshotPath => restoreSnapshot(runtimeBaseDir, localDshHome, snapshotPath),
        recordProbePass: runtimeVersion => {
          if (validateVersionTree(runtimeBaseDir, runtimeVersion).ok) recordProbePass(runtimeBaseDir, runtimeVersion);
        },
        recordFailure: input => { recordRuntimeFailure(runtimeBaseDir, input); },
      };
    };

    const runSnapshotMaintenance = async () => {
      // Retention evidence and deletion must be one transaction. Otherwise a
      // new activation can publish a journal/snapshot after this function
      // reads the protected set but before it deletes the old tail. The
      // maintenance routine itself is the shared dsh-runtime composite
      // `pruneRuntimeSnapshots` (cleanupSnapshotArtifacts → retention state →
      // pruneSnapshots), the same implementation the gateway runtime manager
      // runs at its own transaction tails — snapshot bounding can never
      // drift between owners.
      const lease = await runtimeWriterFence.acquire('maintenance:snapshot-prune');
      try {
        const maintenance = await pruneRuntimeSnapshots(runtimeBaseDir, localDshHome, 3);
        if (maintenance.artifactCleanup.removedTemporaryEntries.length > 0
          || maintenance.artifactCleanup.removedRestoreBackups.length > 0) {
          console.log(
            `[dsh-chamber] runtime snapshot cleanup removed ${maintenance.artifactCleanup.removedTemporaryEntries.length} temporary entr${maintenance.artifactCleanup.removedTemporaryEntries.length === 1 ? 'y' : 'ies'} and ${maintenance.artifactCleanup.removedRestoreBackups.length} completed restore backup(s)`,
          );
        }
        if (maintenance.artifactCleanup.restoreBackupCleanup !== 'completed') {
          console.warn(`[dsh-chamber] runtime restore-backup cleanup skipped: ${maintenance.artifactCleanup.restoreBackupCleanup}`);
        }
        if (maintenance.skippedReason === 'retention-corrupt') {
          console.warn('[dsh-chamber] runtime snapshot retention metadata is corrupt; snapshots preserved (fail closed)');
        }
      } finally {
        lease.release();
      }
    };

    const publishApplyOutcome = async (
      outcome: NonNullable<StartupResult['applyOutcome']>,
      targetVersion: string | null,
      targetIsBuiltin: boolean,
      sourceVersion: string | null,
    ) => {
      let blocked = outcome.runtimeBlocked;
      let error = outcome.error;
      if (targetVersion !== null && !targetIsBuiltin && outcome.status !== 'applied') {
        try { removeKnownGoodCandidate(runtimeBaseDir, targetVersion); } catch { /* diagnostic retention only */ }
      }
      // Snapshot/validation/initial-pointer failures leave the old pointer
      // authoritative but the transaction stopped its host. Re-open the gate
      // only after that exact current tree passes the full probe set again.
      if (!blocked && (outcome.status === 'snapshot-failed' || !cp.localProcessAlive)) {
        try {
          const resumed = await startAndProbeCurrent(runtimeOperationAbort?.signal);
          if (!probesPassed(resumed.probes)) throw new Error('原运行时兼容性探针失败');
        } catch (resumeError) {
          await cp.stopLocal().catch(() => undefined);
          blocked = true;
          error = `${error === null ? '' : `${error}; `}无法安全恢复当前运行时：${sanitizeErrorText(resumeError instanceof Error ? resumeError.message : String(resumeError))}`;
        }
      }
      if (outcome.status === 'applied' && targetVersion !== null && !targetIsBuiltin) {
        try { clearRuntimeFailure(runtimeBaseDir, targetVersion); } catch { /* diagnostic cleanup only */ }
        noteBoot(runtimeBaseDir, targetVersion);
        promoteDueCandidates(runtimeBaseDir);
      }
      const blockedReason = blocked ? error ?? 'dsh 运行时恢复尚未完成' : null;
      setRuntimeGate(blocked, blockedReason);
      const override = readOverrideState(runtimeBaseDir);
      const shellFallback = targetIsBuiltin
        && override.kind === 'valid'
        && override.record.invalidatedAt != null;
      await refreshRuntimeEvidence({
        // A rolled-back outcome stays in the retryable 'rollback' phase; an
        // 'incomplete' data restore is permanent (missing/untrustworthy
        // snapshot — no retry can succeed), so it is a terminal 'failed'
        // phase where the recover-metadata escape stays eligible.
        phase: outcome.status === 'rolled-back' && outcome.restoreOutcome !== 'incomplete'
          ? 'rollback'
          : outcome.status === 'rolled-back'
            ? 'failed'
            : outcome.status === 'applied' && targetIsBuiltin
              ? shellFallback ? 'rollback' : 'idle'
              : outcome.status,
        error,
        targetVersion,
        sourceVersion,
        rollbackTarget: outcome.rollbackTarget,
        restoreOutcome: outcome.restoreOutcome,
        snapshotError: outcome.status === 'snapshot-failed' ? error : null,
        canRetryApply: outcome.retryAction === 'apply',
        canRetryRestore: outcome.retryAction === 'restore',
        runtimeBlocked: blocked,
        runtimeBlockedReason: blockedReason,
        swapAttempted: outcome.swapAttempted,
      });
    };

    const publishBlockedStartup = async (
      reason: string,
      patch: Parameters<typeof runtimeInstance.setLifecycle>[0] = {},
    ) => {
      const safeReason = sanitizeErrorText(reason);
      setRuntimeGate(true, safeReason);
      await refreshRuntimeEvidence({
        phase: 'failed',
        error: safeReason,
        canRetryApply: false,
        canRetryRestore: false,
        runtimeBlocked: true,
        runtimeBlockedReason: safeReason,
        ...patch,
      });
    };

    const metadataProbeError = (
      probes: Awaited<ReturnType<typeof runRuntimeActivationProbes>>,
    ): string => {
      const failed = probes.filter(probe => !probe.ok).map(probe => (
        `${probe.name}: ${probe.error ?? '探针未通过'}`
      ));
      return sanitizeErrorText(
        failed.length === 0
          ? '内建 dsh 运行时探针未返回完整成功结果'
          : `内建 dsh 运行时探针失败：${failed.join('; ')}`,
      );
    };

    /** Execute inside runtimeOperation + runtimeWriterFence. The public gate
     * remains closed until the exact bundled tree passes the full probe set
     * and the durable recovery marker is finalized. */
    type RecoverableMetadataStatus = 'selection-corrupt' | 'recovery-in-progress' | 'recovery-marker-corrupt';
    const executeMetadataRecovery = async (
      signal: AbortSignal,
      expectedStatus: RecoverableMetadataStatus,
      markerRescueConfirmed: boolean,
    ): Promise<boolean> => {
      if (bundledVersion === null || !isSafeVersion(bundledVersion)) {
        await publishBlockedStartup('无法确认内建 dsh 运行时版本；拒绝恢复元数据');
        return false;
      }
      const initialHealth = detectRuntimeMetadataHealth(runtimeBaseDir, version);
      if (initialHealth.status !== expectedStatus) {
        await publishBlockedStartup('元数据恢复状态已变更；必须重新确认后才能继续');
        return false;
      }
      if (initialHealth.status === 'recovery-marker-corrupt' && !markerRescueConfirmed) {
        await publishBlockedStartup('元数据恢复标记已损坏；自动续作已停止，必须由用户显式确认二阶恢复');
        return false;
      }
      setRuntimeGate(true, '正在保留 DSH_HOME 与元数据证据，并恢复内建 dsh');
      await refreshRuntimeEvidence({
        phase: 'applying',
        error: null,
        targetVersion: bundledVersion,
        canRetryApply: false,
        canRetryRestore: false,
        canRecoverMetadata: false,
        runtimeBlocked: true,
        runtimeBlockedReason: '正在保留 DSH_HOME 与元数据证据，并恢复内建 dsh',
      });
      try {
        const recoveryOptions = {
          baseDir: runtimeBaseDir,
          dshHome: localDshHome,
          builtinVersion: bundledVersion,
          shellVersion: version,
          stopHost: () => cp.stopLocal(),
          completeRestore: () => completeInterruptedRestore(runtimeBaseDir, localDshHome),
          probeBuiltin: async () => {
            const probes = await startAndProbeRuntime(bundledVersion, true, signal);
            return probesPassed(probes)
              ? { ok: true as const }
              : { ok: false as const, error: metadataProbeError(probes) };
          },
        };
        const health = detectRuntimeMetadataHealth(runtimeBaseDir, version);
        if (health.status !== expectedStatus) {
          await publishBlockedStartup('元数据恢复状态在执行前发生变化；本地实例继续隔离');
          return false;
        }
        const result = health.status === 'recovery-marker-corrupt'
          ? await rescueCorruptMetadataRecoveryMarker(recoveryOptions)
          : await recoverRuntimeMetadata(recoveryOptions);
        if (result.status === 'finalized') {
          setRuntimeGate(false);
          await refreshRuntimeEvidence({
            phase: 'idle',
            error: null,
            targetVersion: null,
            sourceVersion: null,
            rollbackTarget: null,
            // A finalized recovery resolved any interrupted DSH_HOME restore
            // (the stale marker, if any, was archived as evidence). Do not let
            // an 'incomplete' outcome linger and keep blocking local start.
            restoreOutcome: result.restoreOutcome === 'incomplete' ? 'none' : result.restoreOutcome,
            canRetryApply: false,
            canRetryRestore: false,
            canRecoverMetadata: false,
            runtimeBlocked: false,
            runtimeBlockedReason: null,
          });
          return true;
        }
        if (result.status === 'restore-blocked') {
          await publishBlockedStartup(
            result.restoreOutcome === 'half'
              ? '数据恢复只完成一部分；已保留现场，必须先重试恢复'
              : '数据恢复未完成；已保留现场，必须先重试恢复',
            {
              restoreOutcome: result.restoreOutcome,
              canRetryRestore: true,
              canRecoverMetadata: false,
            },
          );
          return false;
        }
        if (result.status === 'probe-failed') {
          await publishBlockedStartup(result.error, {
            restoreOutcome: result.restoreOutcome,
            canRecoverMetadata: true,
          });
          return false;
        }
        // A user/startup eligibility re-read guarantees an unfinished
        // transaction. A no-op/finalized result here means the authority
        // changed underneath us; never open exposure without a fresh probe.
        await publishBlockedStartup('元数据恢复状态已变更；未经新的内建运行时探针，本地实例继续隔离');
        return false;
      } catch (error) {
        await cp.stopLocal().catch(() => undefined);
        await publishBlockedStartup(`元数据恢复失败：${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
    };

    /** Probe an explicit env tree without reading, archiving, or changing any
     * dormant chamber selection metadata. Restore completion remains the only
     * permitted metadata-adjacent operation before the env probe. */
    const runEnvOverrideStartup = async (signal: AbortSignal): Promise<void> => {
      try {
        await cp.stopLocal();
        const restored = await completeInterruptedRestore(runtimeBaseDir, localDshHome);
        if (restored === 'half' || restored === 'incomplete') {
          await publishBlockedStartup('数据恢复未完成（现场已保留），请重试恢复', {
            restoreOutcome: restored,
            canRetryRestore: true,
          });
          return;
        }
        const current = await startAndProbeCurrent(signal);
        if (current.active.source !== 'env' || !probesPassed(current.probes)) {
          throw new Error('env runtime compatibility probes failed');
        }
        setRuntimeGate(false);
        await refreshRuntimeEvidence({
          phase: 'idle', error: null, runtimeBlocked: false, runtimeBlockedReason: null,
          canRetryApply: false, canRetryRestore: false,
        });
      } catch (error) {
        await cp.stopLocal().catch(() => undefined);
        await publishBlockedStartup(error instanceof Error ? error.message : String(error));
      }
    };

    const runRuntimeStartup = (): Promise<StartupResult | null> => {
      if (runtimeOperation !== null) return runtimeOperation;
      let operationLease: OperationLease | null = null;
      const operation = (async (): Promise<StartupResult | null> => {
        runtimeOperationAbort = new AbortController();
        setRuntimeGate(true, '正在确认 dsh 运行时与数据恢复状态');
        operationLease = await runtimeWriterFence.acquire('runtime:startup', runtimeOperationAbort.signal);

        // A persisted wall clock is not uptime. Close every candidate health
        // window before the first probe of this transaction; a successful
        // full compatibility probe/boot below opens a fresh window.
        resetCandidateHealthWindow(runtimeBaseDir);

        const bootstrapMetadataCorrupt = startupOverrideState.kind === 'corrupt'
          || startupPointerState.kind === 'corrupt';
        if (runtimeBootstrapFailure !== null && runtimeBootstrapWriterUnsafe) {
          await publishBlockedStartup(runtimeBootstrapFailure);
          return null;
        }
        if (!cp.localWritersQuiescent) {
          await publishBlockedStartup('无法确认旧 dsh 写进程已完全回收；为保护 DSH_HOME，已阻止本地实例启动与版本切换');
          return null;
        }

        let metadataHealth: RuntimeMetadataHealth;
        try {
          metadataHealth = detectRuntimeMetadataHealth(runtimeBaseDir, version);
        } catch (error) {
          await publishBlockedStartup(`无法检查 dsh 运行时选择元数据：${error instanceof Error ? error.message : String(error)}`);
          return null;
        }
        if (metadataHealth.status === 'recovery-in-progress') {
          if (!runtimeManagementSupported || envOverrideActive) {
            await publishBlockedStartup('元数据恢复事务未完成；当前平台或 env 运行时不允许续作管理事务');
            return null;
          }
          await executeMetadataRecovery(
            runtimeOperationAbort.signal,
            'recovery-in-progress',
            false,
          );
          return null;
        }
        // A valid env workspace has highest selection priority. Corrupt
        // dormant current/override/journal bytes remain untouched evidence;
        // only an independently authoritative restore may finish first.
        if (shouldProbeEnvWithDormantCorruptSelection(metadataHealth.status, envOverrideActive)) {
          await runEnvOverrideStartup(runtimeOperationAbort.signal);
          return null;
        }
        if (metadataHealth.status === 'selection-corrupt') {
          // A crash-interrupted DSH_HOME restore outranks metadata archival.
          // Complete/retry it first so the stash never captures a half restore.
          if (restoreMarkerAuthorityStatus(runtimeBaseDir) !== 'missing') {
            await cp.stopLocal();
            const restored = await completeInterruptedRestore(runtimeBaseDir, localDshHome);
            if (restored === 'half' || restored === 'incomplete') {
              await publishBlockedStartup('数据恢复未完成；必须先重试恢复，再处理运行时元数据', {
                restoreOutcome: restored,
                canRetryRestore: true,
                canRecoverMetadata: false,
              });
              return null;
            }
            metadataHealth = detectRuntimeMetadataHealth(runtimeBaseDir, version);
          }
          if (metadataHealth.status === 'selection-corrupt') {
            await publishBlockedStartup('运行时选择元数据损坏；已保留证据并等待用户确认“保留数据并恢复内建”', {
              canRecoverMetadata: runtimeManagementSupported && !envOverrideActive,
            });
            return null;
          }
        }
        if (metadataHealth.status === 'recovery-marker-corrupt') {
          // A snapshot restore marker is independently authoritative. Finish
          // it before offering second-order metadata recovery so the new stash
          // can never capture a half-restored DSH_HOME.
          if (restoreMarkerAuthorityStatus(runtimeBaseDir) !== 'missing') {
            await cp.stopLocal();
            const restored = await completeInterruptedRestore(runtimeBaseDir, localDshHome);
            if (restored === 'half' || restored === 'incomplete') {
              await publishBlockedStartup('数据恢复未完成；必须先重试恢复，再处理损坏的元数据恢复标记', {
                restoreOutcome: restored,
                canRetryRestore: true,
                canRecoverMetadata: false,
              });
              return null;
            }
            metadataHealth = detectRuntimeMetadataHealth(runtimeBaseDir, version);
          }
          if (metadataHealth.status === 'recovery-marker-corrupt') {
            const capability = inspectCorruptMetadataRecoveryMarker(runtimeBaseDir);
            await publishBlockedStartup(
              capability.recoverable
                ? '元数据恢复标记损坏；已保留现场并等待用户确认二阶恢复'
                : '元数据恢复标记不是可安全归档的普通文件；已保留现场并拒绝自动修复',
              { canRecoverMetadata: capability.recoverable && runtimeManagementSupported && !envOverrideActive },
            );
            return null;
          }
        }
        if (runtimeBootstrapFailure !== null && !bootstrapMetadataCorrupt) {
          const restored = await completeInterruptedRestore(runtimeBaseDir, localDshHome);
          if (restored === 'half' || restored === 'incomplete') {
            await publishBlockedStartup('数据恢复未完成（现场已保留），请重试恢复', {
              restoreOutcome: restored,
              canRetryRestore: true,
            });
            return null;
          }
          await publishBlockedStartup(runtimeBootstrapFailure);
          return null;
        }
        if (!runtimeManagementSupported) {
          try {
            const restored = await completeInterruptedRestore(runtimeBaseDir, localDshHome);
            if (restored === 'half' || restored === 'incomplete') {
              await publishBlockedStartup('未完成的数据恢复仍需人工重试；Windows 运行时版本管理保持只读', {
                restoreOutcome: restored,
                canRetryRestore: true,
              });
              return null;
            }
            const current = await startAndProbeCurrent(runtimeOperationAbort.signal);
            if (!probesPassed(current.probes)) throw new Error('runtime compatibility probes failed');
            setRuntimeGate(false);
            await refreshRuntimeEvidence({
              phase: 'idle', error: null, runtimeBlocked: false, runtimeBlockedReason: null,
              canRetryApply: false, canRetryRestore: false,
            });
          } catch (error) {
            await cp.stopLocal().catch(() => undefined);
            await publishBlockedStartup(error instanceof Error ? error.message : String(error));
          }
          return null;
        }

        // An explicit env workspace is independent of the chamber-managed
        // builtin and selection metadata. It still waits for writer
        // quiescence and completes a crash-interrupted DSH_HOME restore, but
        // it must not require a readable bundled manifest or mutate dormant
        // current/override/journal state before probing the env tree.
        if (envOverrideActive) {
          await runEnvOverrideStartup(runtimeOperationAbort.signal);
          return null;
        }

        const journalBefore = readActivationJournalState(runtimeBaseDir);
        const intentBefore = selectedJournalIntent(journalBefore);
        const overrideBefore = readOverrideState(runtimeBaseDir);
        // Pending replay projection before the startup transaction: use the
        // shared core effectivePending so a pending whose override is
        // invalidated OR written by an older shell version never resolves a
        // target here (matches the core startup replay decision — previously
        // only invalidatedAt was consulted here).
        const pendingBefore = overrideBefore.kind === 'valid'
          ? effectivePending(overrideBefore.record, version)
          : null;
        // Env is authoritative over dormant chamber selection metadata. The
        // startup module must first complete any restore and then return its
        // env-override verdict; reading corrupt current/override facts here
        // would incorrectly make that safe path unreachable.
        let sourceFacts: ReturnType<typeof readActivationFacts> | null = null;
        if (!envOverrideActive) {
          try {
            sourceFacts = readActivationFacts();
          } catch (error) {
            await publishBlockedStartup(error instanceof Error ? error.message : String(error));
            return null;
          }
        }

        // Stop unconditionally: restart backoff can own a future spawn even
        // while no child is alive. stopLocal cancels that epoch before any
        // snapshot/restore touches the shared DSH_HOME.
        await cp.stopLocal();
        if (!envOverrideActive
          && (intentBefore !== null || pendingBefore !== null
            || restoreMarkerAuthorityStatus(runtimeBaseDir) !== 'missing')) {
          await refreshRuntimeEvidence({
            phase: 'applying',
            error: null,
            targetVersion: intentBefore?.targetVersion ?? pendingBefore,
            sourceVersion: sourceFacts?.sourceVersion ?? null,
            canRetryApply: false,
            canRetryRestore: false,
            runtimeBlocked: true,
            runtimeBlockedReason: '正在执行 dsh 运行时激活或数据恢复事务',
          });
        }

        const deps = buildStartupDeps();
        const result = await runStartupPhase(deps, runtimeOperationAbort?.signal);
        const outcomeTarget = intentBefore?.targetVersion
          ?? result.monitoringJournal?.targetVersion
          ?? pendingBefore;
        const targetIsBuiltin = intentBefore?.targetIsBuiltin
          ?? result.monitoringJournal?.targetIsBuiltin
          ?? false;
        const durableJournal = readActivationJournalState(runtimeBaseDir);
        const durableSource = durableJournal.kind === 'valid' && durableJournal.journal.sourceVersion !== null
          ? durableJournal.journal.sourceVersion
          : sourceFacts?.sourceVersion ?? null;

        if (result.applyOutcome !== null) {
          await publishApplyOutcome(
            result.applyOutcome,
            outcomeTarget,
            targetIsBuiltin,
            durableSource,
          );
          return result;
        }

        if (result.blockedReason === 'restore-half' || result.blockedReason === 'restore-incomplete') {
          await publishBlockedStartup(
            result.blockedReason === 'restore-half'
              ? '数据恢复失败（现场已保留），请重试恢复'
              : '数据恢复未完成（现场已保留），请重试恢复',
            {
              restoreOutcome: result.restored === 'half' ? 'half' : 'incomplete',
              canRetryRestore: true,
            },
          );
          return result;
        }

        // FATAL metadata-corruption set — shared single source with the
        // gateway composition boundary (dsh-runtime FATAL_STARTUP_BLOCK_REASONS).
        const hardBlockedReasons = new Set<string>(FATAL_STARTUP_BLOCK_REASONS);
        if (result.blockedReason !== null && hardBlockedReasons.has(result.blockedReason)) {
          await publishBlockedStartup(`运行时恢复元数据异常（${result.blockedReason}）；拒绝启动以保护 DSH_HOME`);
          return result;
        }
        if (result.blockedReason === 'swap-attempted') {
          await publishBlockedStartup('上次运行时指针切换未完成；请显式重试应用', {
            canRetryApply: true,
            swapAttempted: true,
          });
          return result;
        }

        try {
          const current = await startAndProbeCurrent(runtimeOperationAbort.signal);
          if (!probesPassed(current.probes)) throw new Error('runtime compatibility probes failed');
          if (current.active.source === 'user' && current.active.version !== null) {
            noteBoot(runtimeBaseDir, current.active.version);
            promoteDueCandidates(runtimeBaseDir);
          }
          setRuntimeGate(false);
          await refreshRuntimeEvidence({
            phase: result.blockedReason === 'snapshot-failed' ? 'snapshot-failed' : 'idle',
            error: result.blockedReason === 'snapshot-failed'
              ? readOverride(runtimeBaseDir)?.lastError ?? '快照失败；当前运行时仍可安全使用'
              : null,
            canRetryApply: result.blockedReason === 'snapshot-failed',
            canRetryRestore: false,
            runtimeBlocked: false,
            runtimeBlockedReason: null,
            snapshotError: result.blockedReason === 'snapshot-failed'
              ? readOverride(runtimeBaseDir)?.lastError ?? '快照失败'
              : null,
          });
        } catch (error) {
          await cp.stopLocal().catch(() => undefined);
          const monitoring = result.monitoringJournal;
          if (monitoring !== null && monitoring.targetIsBuiltin === false && !envOverrideActive) {
            try {
              removeKnownGoodCandidate(runtimeBaseDir, monitoring.targetVersion);
              const rollbackOutcome = await runDelayedRollback(deps, monitoring, runtimeOperationAbort?.signal);
              await publishApplyOutcome(
                rollbackOutcome,
                monitoring.targetVersion,
                false,
                monitoring.sourceVersion,
              );
              return result;
            } catch (rollbackError) {
              await publishBlockedStartup(`运行时探针失败且自动回退未完成：${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
              return result;
            }
          }
          await publishBlockedStartup(error instanceof Error ? error.message : String(error));
        }
        return result;
      })().catch(async (error) => {
        await cp.stopLocal().catch(() => undefined);
        await publishBlockedStartup(error instanceof Error ? error.message : String(error));
        return null;
      }).finally(() => {
        runtimeInternalStart = false;
        runtimeTransactionWorkspace = null;
        operationLease?.release();
        runtimeOperationAbort = null;
        runtimeOperation = null;
        void runStorePruneIfNeeded();
        void runSnapshotMaintenance().catch(error => {
          console.error('[dsh-chamber] dsh runtime snapshot maintenance failed:', sanitizeErrorText(error instanceof Error ? error.message : String(error)));
        });
      });
      runtimeOperation = operation;
      return operation;
    };

    const runRestartExhaustedRollback = (): Promise<StartupResult | null> | null => {
      if (quitRequested || runtimeOperation !== null || envOverrideActive || !runtimeManagementSupported) return null;
      let operationLease: OperationLease | null = null;
      const operation = (async (): Promise<StartupResult | null> => {
        runtimeOperationAbort = new AbortController();
        setRuntimeGate(true, 'dsh 运行时连续重启失败，正在自动回退');
        operationLease = await runtimeWriterFence.acquire('runtime:restart-exhausted', runtimeOperationAbort.signal);
        // Re-read after the shared fence. An install may have been in flight
        // when restart-exhausted fired and may have durably queued nextIntent.
        const state = runtimeInstance.getState();
        const failedVersion = state.source === 'user' ? state.active : null;
        if (failedVersion === null) return null;
        const plan = planRestartExhaustedRollback({
          restartExhausted: true,
          activeIsOverride: state.source === 'user',
          failedVersion,
          journalState: readActivationJournalState(runtimeBaseDir),
        });
        if (plan.status === 'not-triggered') return null;
        if (plan.status === 'planned') {
          // Exactly-once latch: rollback-needed reaches disk before candidate
          // mutation, host stop, pointer switch, or DSH_HOME restore.
          writeActivationJournal(runtimeBaseDir, {
            ...plan.journal,
            nextIntent: plan.deferredIntent,
          });
        }
        const rollbackTarget = plan.rollbackTarget;
        const sourceVersion = plan.journal.sourceVersion;
        await refreshRuntimeEvidence({
          phase: 'applying',
          error: 'dsh 运行时连续重启失败，正在自动回退',
          targetVersion: failedVersion,
          rollbackTarget,
          runtimeBlocked: true,
          runtimeBlockedReason: 'dsh 运行时连续重启失败，正在自动回退',
          canRetryApply: false,
          canRetryRestore: false,
        });
        removeKnownGoodCandidate(runtimeBaseDir, failedVersion);
        const result = await runStartupPhase(buildStartupDeps(), runtimeOperationAbort?.signal);
        if (result.applyOutcome === null) {
          await publishBlockedStartup(`restart-exhausted 回退未完成${result.blockedReason === null ? '' : `：${result.blockedReason}`}`);
          return result;
        }
        await publishApplyOutcome(
          result.applyOutcome,
          failedVersion,
          false,
          sourceVersion,
        );
        return result;
      })().catch(async (error) => {
        await cp.stopLocal().catch(() => undefined);
        await publishBlockedStartup(`restart-exhausted 回退失败：${error instanceof Error ? error.message : String(error)}`);
        return null;
      }).finally(() => {
        runtimeInternalStart = false;
        runtimeTransactionWorkspace = null;
        operationLease?.release();
        runtimeOperationAbort = null;
        runtimeOperation = null;
        void runStorePruneIfNeeded();
        void runSnapshotMaintenance().catch(error => {
          console.error('[dsh-chamber] dsh runtime snapshot maintenance failed:', sanitizeErrorText(error instanceof Error ? error.message : String(error)));
        });
      });
      runtimeOperation = operation;
      return operation;
    };

    cp.onLocalStateChange((snapshot) => {
      if (snapshot.status === 'degraded' || snapshot.status === 'restarting'
        || snapshot.status === 'error' || snapshot.status === 'restart-exhausted') {
        try { resetCandidateHealthWindow(runtimeBaseDir); } catch (error) {
          console.error('[dsh-chamber] known-good 健康窗口重置失败：', sanitizeErrorText(error instanceof Error ? error.message : String(error)));
        }
      }
      if (snapshot.status === 'restart-exhausted') void runRestartExhaustedRollback();
    });

    const confirmRuntimeMutation = async (message: string, detail: string, confirmLabel: string): Promise<boolean> => {
      const win = mainWindow;
      if (win === null || win.isDestroyed()) return false;
      const { response } = await dialog.showMessageBox(win, {
        type: 'warning', title: message, message, detail,
        buttons: ['取消', confirmLabel], defaultId: 0, cancelId: 0, noLink: true,
      });
      return response === 1;
    };

    const authoritativeMetadataRecoveryStatus = (): RecoverableMetadataStatus | null => {
      const state = runtimeInstance.getState();
      // 'incomplete' is a permanent restore outcome (the journaled snapshot is
      // missing or untrustworthy): retry-restore can never succeed, so the
      // recover-metadata escape stays eligible even while canRetryRestore is
      // still advertised and even when a stale restore marker from the
      // abandoned transaction is still present. 'half' remains transient and
      // retryable, so it keeps every gate closed.
      const permanentIncomplete = state.restoreOutcome === 'incomplete';
      if (quitRequested
        || state.runtimeBlocked !== true
        || (state.phase !== 'idle' && state.phase !== 'failed')
        || (state.canRetryRestore === true && !permanentIncomplete)
        || state.restoreOutcome === 'half'
        || state.source === 'env'
        || state.managementSupported === false
        || runtimeBootstrapWriterUnsafe
        || !cp.localWritersQuiescent
        || bundledVersion === null
        || !isSafeVersion(bundledVersion)
        || (!permanentIncomplete && restoreMarkerAuthorityStatus(runtimeBaseDir) !== 'missing')) return null;
      try {
        const health = detectRuntimeMetadataHealth(runtimeBaseDir, version);
        if (state.metadataHealth !== health.status) return null;
        if (health.status === 'selection-corrupt' || health.status === 'recovery-in-progress') {
          return health.status;
        }
        if (health.status === 'recovery-marker-corrupt'
          && inspectCorruptMetadataRecoveryMarker(runtimeBaseDir).recoverable) {
          return health.status;
        }
        return null;
      } catch {
        return null;
      }
    };

    const runUserMetadataRecovery = (
      expectedStatus: RecoverableMetadataStatus,
    ): Promise<StartupResult | null> | null => {
      if (runtimeOperation !== null || authoritativeMetadataRecoveryStatus() !== expectedStatus) return null;
      let operationLease: OperationLease | null = null;
      const operation = (async (): Promise<StartupResult | null> => {
        runtimeOperationAbort = new AbortController();
        operationLease = runtimeWriterFence.tryAcquire('runtime:metadata-recovery');
        if (operationLease === null || authoritativeMetadataRecoveryStatus() !== expectedStatus) return null;
        await executeMetadataRecovery(
          runtimeOperationAbort.signal,
          expectedStatus,
          expectedStatus === 'recovery-marker-corrupt',
        );
        return null;
      })().catch(async (error) => {
        await cp.stopLocal().catch(() => undefined);
        await publishBlockedStartup(`元数据恢复事务失败：${error instanceof Error ? error.message : String(error)}`);
        return null;
      }).finally(() => {
        runtimeInternalStart = false;
        runtimeTransactionWorkspace = null;
        operationLease?.release();
        runtimeOperationAbort = null;
        runtimeOperation = null;
        void runStorePruneIfNeeded();
      });
      runtimeOperation = operation;
      return operation;
    };

    ipcMain.handle(IPC_CHANNELS.RUNTIME_STATE, trustedIpc(() => runtimeInstance.getState()));
    // Transactional managed-dsh restart (design 18 §3.6 项 8): refreshes mounted
    // plugins. Not a version mutation — the pointer/tree is untouched, so no
    // snapshot/probe gate; the control-plane restartLocal() is single-flight,
    // serialized with health restarts, and respects canStartLocal.
    ipcMain.handle(IPC_CHANNELS.RUNTIME_RESTART, trustedIpc(async () => {
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
      if (runtimeOperation !== null || runtimeWriterFence.busy || busyPhase
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
        if (controlPlane === null) throw new Error('control plane not initialized')
        await controlPlane.restartLocal();
        // CONTRACT (design 18 §9.3): resolve ≠ success — a restart that
        // exhausted the shared window settles into restart-exhausted (or
        // error) and RESOLVES; project that honestly instead of a silent
        // "healthy" runtime state.
        const connectionState = controlPlane.connectionState;
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
    }));
    const runtimeActionAllowed = (action: Parameters<typeof allowedActions>[0] extends never ? never : ReturnType<typeof allowedActions>[number]) => {
      const state = runtimeInstance.getState();
      if (state.managementSupported === false && action !== 'retry-restore') return false;
      if (action === 'recover-metadata' && state.source === 'env') return false;
      const applyingReset = action === 'reset-builtin'
        && state.phase === 'applying'
        && state.source !== 'env'
        && state.hasOverride === true;
      if (runtimeWriterFence.busy && !applyingReset) return false;
      if (state.runtimeBlocked === true) {
        if (action === 'retry-restore') return state.canRetryRestore === true
          && (state.phase === 'rollback' || state.phase === 'failed');
        if (action === 'recover-metadata') return (state.canRetryRestore !== true
            || state.restoreOutcome === 'incomplete')
          && state.canRecoverMetadata === true
          && (state.metadataHealth === 'selection-corrupt'
            || state.metadataHealth === 'recovery-in-progress'
            || state.metadataHealth === 'recovery-marker-corrupt')
          && (state.phase === 'idle' || state.phase === 'failed');
        if (action === 'retry-apply') return state.canRetryApply === true
          && (state.phase === 'snapshot-failed' || state.phase === 'failed');
        if (applyingReset) return true;
        return false;
      }
      return allowedActions(state.phase, {
        canRetryApply: state.canRetryApply,
        canRetryRestore: state.canRetryRestore,
        canRecoverMetadata: state.canRecoverMetadata,
      }).includes(action);
    };
    const runRuntimeCheck = async () => {
      if (quitRequested || runtimeOperation !== null || !runtimeActionAllowed('check')) {
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
    ipcMain.handle(IPC_CHANNELS.RUNTIME_CHECK, trustedIpc(runRuntimeCheck));
    ipcMain.handle(IPC_CHANNELS.RUNTIME_INSTALL, trustedIpc(async (args) => {
      const v = args !== null && typeof args === 'object' ? (args as Record<string, unknown>).version : undefined;
      if (typeof v !== 'string' || v.length > 128 || !isSafeVersion(v)) return runtimeInstance.getState();
      const requestedVersion = v.trim();
      const before = runtimeInstance.getState();
      if (runtimeOperation !== null || before.source === 'env' || !runtimeActionAllowed('install')) {
        return before;
      }
      if (!await confirmRuntimeMutation(
        `安装 dsh 运行时 ${requestedVersion}？`,
        `将从 ${chamberSettings.registryOrigin} 下载并执行白名单依赖的安装脚本；切换将在下次启动应用。`,
        '安装',
      )) return runtimeInstance.getState();
      const current = runtimeInstance.getState();
      if (runtimeOperation !== null || current.source === 'env' || !runtimeActionAllowed('install')) {
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
    }));
    ipcMain.handle(IPC_CHANNELS.RUNTIME_CLEANUP_VERSION, trustedIpc(async (args) => {
      const rawVersion = args !== null && typeof args === 'object'
        ? (args as Record<string, unknown>).version
        : undefined;
      if (typeof rawVersion !== 'string' || rawVersion.length > 128 || !isSafeVersion(rawVersion)) {
        return runtimeInstance.getState();
      }
      const requestedVersion = rawVersion.trim();
      const before = runtimeInstance.getState();
      if (runtimeOperation !== null
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
      if (runtimeOperation !== null
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
    }));
    // 失败现场清除（settings polish D3-A）：仅本地入口（gateway 无现成路由，
    // 登记偏差）。版本必须真实存在于失败记录名集（主进程 re-read，绝不信任
    // renderer），且不得有在飞运行时事务；只删除 failures/*.json 记录本身，
    // 不动任何版本树/快照/回滚现场。清除后刷新磁盘与失败投影并返回最新 state。
    ipcMain.handle(IPC_CHANNELS.RUNTIME_CLEAR_FAILURE, trustedIpc(async (args) => {
      const rawVersion = args !== null && typeof args === 'object'
        ? (args as Record<string, unknown>).version
        : undefined;
      if (typeof rawVersion !== 'string' || rawVersion.length > 128 || !isSafeVersion(rawVersion)) {
        return runtimeInstance.getState();
      }
      const requestedVersion = rawVersion.trim();
      if (runtimeOperation !== null
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
    }));
    ipcMain.handle(IPC_CHANNELS.RUNTIME_RECOVER_METADATA, trustedIpc(async () => {
      const before = runtimeInstance.getState();
      const expectedStatus = authoritativeMetadataRecoveryStatus();
      // First authority read occurs before showing a destructive native
      // confirmation. A forged renderer action cannot manufacture eligibility.
      if (runtimeOperation !== null
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
      if (runtimeOperation !== null
        || !runtimeActionAllowed('recover-metadata')
        || authoritativeMetadataRecoveryStatus() !== expectedStatus) return runtimeInstance.getState();
      const operation = runUserMetadataRecovery(expectedStatus);
      if (operation === null) return runtimeInstance.getState();
      await operation;
      return runtimeInstance.getState();
    }));
    ipcMain.handle(IPC_CHANNELS.RUNTIME_RESET_BUILTIN, trustedIpc(async () => {
      const before = runtimeInstance.getState();
      const queueBehindApplying = runtimeOperation !== null && before.phase === 'applying';
      if ((!queueBehindApplying && runtimeOperation !== null) || before.source === 'env' || before.hasOverride !== true
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
      const inFlight = runtimeOperation;
      const stillQueueing = inFlight !== null && current.phase === 'applying';
      if ((!stillQueueing && runtimeOperation !== null) || current.source === 'env' || current.hasOverride !== true
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
    }));
    ipcMain.handle(IPC_CHANNELS.RUNTIME_RETRY_APPLY, trustedIpc(async () => {
      const before = runtimeInstance.getState();
      if (runtimeOperation !== null || before.source === 'env'
        || !runtimeActionAllowed('retry-apply')) return before;
      const overrideState = readOverrideState(runtimeBaseDir);
      const journalState = readActivationJournalState(runtimeBaseDir);
      const retryTarget = selectedJournalIntent(journalState)?.targetVersion
        ?? (overrideState.kind === 'valid' ? overrideState.record.pending : null);
      if (retryTarget === null) return runtimeInstance.getState();
      if (!await confirmRuntimeMutation(`重试应用 dsh ${retryTarget}？`, '将停止本地实例并从持久化事务安全续作。', '重试应用')) return runtimeInstance.getState();
      const current = runtimeInstance.getState();
      if (runtimeOperation !== null || current.source === 'env'
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
    }));
    // Apply-now (design 18 addendum §4.1): run the existing activation
    // transaction in the CURRENT session instead of waiting for the next
    // launch. Entry pattern mirrors RUNTIME_RETRY_APPLY (F1): no outer
    // writer-fence lease is held across the transaction — runRuntimeStartup
    // acquires 'runtime:startup' itself, and an outer lease would deadlock
    // with it. The transaction window is the existing applying projection;
    // publishApplyOutcome settles the terminal state.
    // The gate is the pure evaluateApplyNowGate (apply-now-gate.ts), evaluated
    // BEFORE and AFTER the native confirm dialog from the SAME input builder
    // (TOCTOU parity, review R5). Both gates resolve the target identically —
    // pending ?? journalTarget ?? overridePending — and preflight the target
    // tree, so the second gate can never accept something the first would
    // reject, and a corrupt tree never starts a doomed stop/respawn cycle.
    const readApplyNowGateInput = (): ApplyNowGateInput => {
      const state = runtimeInstance.getState();
      const journalState = readActivationJournalState(runtimeBaseDir);
      const overrideState = readOverrideState(runtimeBaseDir);
      const journalTarget = selectedJournalIntent(journalState)?.targetVersion ?? null;
      // Same predicate as state.pending's projection (dsh-runtime-controller):
      // an invalidated or old-shell override's raw pending must not resolve a
      // durable target for apply-now.
      const overridePending = overrideState.kind === 'valid' && !envOverrideActive
        ? effectivePending(overrideState.record, version)
        : null;
      const target = state.pending ?? journalTarget ?? overridePending;
      const override = readOverride(runtimeBaseDir);
      return {
        phase: state.phase,
        source: state.source,
        runtimeBlocked: state.runtimeBlocked === true,
        managementSupported: state.managementSupported !== false,
        hasOverride: state.hasOverride === true,
        pending: state.pending,
        journalTarget,
        overridePending,
        connectionState: controlPlane === null ? 'none' : controlPlane.connectionState,
        operationBusy: runtimeOperation !== null,
        fenceBusy: runtimeWriterFence.busy,
        snapshotFailed: override?.lastOutcome === 'snapshot-failed',
        treeValid: target === null || validateVersionTree(runtimeBaseDir, target).ok,
      };
    };
    ipcMain.handle(IPC_CHANNELS.RUNTIME_APPLY_NOW, trustedIpc(async () => {
      const before = runtimeInstance.getState();
      // Quit is in flight: never start a transaction that the quit path will
      // immediately abort (same gate as runRuntimeCheck).
      if (quitRequested) return before;
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
    }));
    ipcMain.handle(IPC_CHANNELS.RUNTIME_RETRY_RESTORE, trustedIpc(async () => {
      const before = runtimeInstance.getState();
      if (runtimeOperation !== null
        || !runtimeActionAllowed('retry-restore')) return before;
      if (!await confirmRuntimeMutation('重试恢复 dsh 数据？', '将停止本地实例并从已记录的快照事务继续恢复。', '重试恢复')) return runtimeInstance.getState();
      const current = runtimeInstance.getState();
      if (runtimeOperation !== null
        || !runtimeActionAllowed('retry-restore')) return current;
      await runRuntimeStartup();
      return runtimeInstance.getState();
    }));
    ipcMain.handle(IPC_CHANNELS.RUNTIME_RESTORE_PRE_ROLLBACK, trustedIpc(async (args) => {
      // Only a stash-shaped basename is accepted; the main process re-validates
      // it against its own private pre-rollback listing before any mutation.
      const stashName = args !== null && typeof args === 'object'
        ? (args as Record<string, unknown>).stashName
        : undefined;
      if (typeof stashName !== 'string' || !/^\d{13}-[0-9a-f]{8}$/.test(stashName)) {
        return runtimeInstance.getState();
      }
      const before = runtimeInstance.getState();
      if (runtimeOperation !== null
        || !runtimeActionAllowed('restore-pre-rollback')) return before;
      if (!await confirmRuntimeMutation(
        '恢复回滚前数据？',
        '将停止本地实例，把当前 DSH_HOME 保留为 dsh-home.old，再用最近一次手动回滚前保存的数据覆盖恢复。恢复事务崩溃安全，可在下次启动续作。',
        '恢复回滚前数据',
      )) return runtimeInstance.getState();
      const current = runtimeInstance.getState();
      if (runtimeOperation !== null
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
          await cp.stopLocal();
          restoreResult.outcome = await restorePreRollback(runtimeBaseDir, localDshHome, stashName);
        } finally {
          lease.release();
        }
        return null;
      })().catch(async (error) => {
        await cp.stopLocal().catch(() => undefined);
        // Recorded, not hard-blocked: the startup transaction below restarts
        // the instance (a thrown transaction leaves a resumeable marker).
        restoreResult.error = sanitizeErrorText(error instanceof Error ? error.message : String(error));
        return null;
      }).finally(() => {
        runtimeOperation = null;
      });
      runtimeOperation = operation;
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
    }));

    const maybeCheckRuntime = () => {
      if (quitRequested || runtimeOperation !== null || !runtimeActionAllowed('check')) return;
      void runRuntimeCheck();
    };
    // Startup refresh plus a real periodic cycle. Both share the same core
    // gate, so apply/restore suspends checks and the next cycle resumes them.
    const startupRuntimeCheck = setTimeout(maybeCheckRuntime, 15_000);
    startupRuntimeCheck.unref();
    const periodicRuntimeCheck = setInterval(maybeCheckRuntime, 6 * 60 * 60 * 1_000);
    periodicRuntimeCheck.unref();
    // Promotion needs a real in-process health interval. The state listener
    // above closes the window on any unhealthy transition; this timer merely
    // commits candidates whose still-open window has actually elapsed.
    const knownGoodPromotionTimer = setInterval(() => {
      if (quitRequested || runtimeOperation !== null || !cp.localProcessAlive) return;
      try { promoteDueCandidates(runtimeBaseDir); } catch (error) {
        console.error('[dsh-chamber] known-good 晋升检查失败：', sanitizeErrorText(error instanceof Error ? error.message : String(error)));
      }
    }, 60 * 60 * 1_000);
    knownGoodPromotionTimer.unref();

    // Single frame, single origin: the control plane serves the built dsh
    // frontend (design 05 §1) — no local file loads. A load failure is a
    // loud startup failure (dialog + exit), never a silently broken window;
    // the control plane is stopped first so no local dsh child is orphaned.
    // The runtime startup transaction (runRuntimeStartup, below) starts after
    // the window is created, so the first screen finds the local instance
    // ready only when the transaction wins the race against the renderer
    // boot; the renderer's own auto-start POST stays idempotent on the same
    // path, and a spawn failure here is non-fatal (the renderer surfaces the
    // instance error state). The ~seconds of spawn boot time still overlap
    // the page/bundle load instead of sitting between the renderer's POST and
    // the ready push.
    // Deny Web permission requests by default: Electron default-grants these to
    // same-origin content, and the control plane also serves proxied remote-instance
    // content under /api/i/<id>/* (same origin). Keep one benign exception —
    // clipboard-sanitized-write, which is exactly what navigator.clipboard.writeText()
    // requests in Blink (clipboard_promise.cc: writeText performs a permission
    // REQUEST, not a check; Electron routes it to the session's request handler,
    // so a deny here silently breaks every copy button while permissions.query
    // still reports granted). The check handler below is only consulted for
    // navigator.permissions.query() and must mirror the same allowlist so the
    // query result is honest. The grant is per-session: every same-origin frame
    // incl. proxied remote-instance HTML can write sanitized text/HTML
    // (write-only, no custom formats, Blink still requires document focus for
    // writes) — the same pastejacking surface the official dsh web app has in
    // a normal browser, accepted. clipboard-read, custom-format writes and
    // media/geolocation/notifications/etc. stay denied.
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) =>
      callback(permission === 'clipboard-sanitized-write'));
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'clipboard-sanitized-write');

    // W-10 S1+S2（design 25 §4.1 seam）：shell IPC 注册点迁入 shell-core 的
    // installIpcHandlers——S1 迁 INFO / SETTINGS_GET / SETTINGS_SET 注册体与其
    // 随迁 settings 辅助（chamberSettingsStatus / applySettingsPatch /
    // pushSettingsChanged）；S2 追加 B 组 6 注册体（NOTIFY / NOTIFICATIONS_READY
    // / NOTIFICATION_OPEN_ACK / BADGE_COUNT / DEEP_LINK_READY / DEEP_LINK_ACK）
    // 与其渲染器投递状态机（队列/ready 位/drain/来源代际/held resume/badge
    // holder）。本文件只做装配与注入：
    //  - ipc：trustedIpc 围栏在此包一层（core 零 electron，语义与搬迁前
    //    `ipcMain.handle(ch, trustedIpc(handler))` 完全一致）；
    //  - edges：createElectronEdges 返回值（S0 rendererPush + S2 渲染器投递/
    //    通知/徽标批成员 + S6 showMessage/pickPluginSource 对话框腿；host 背参
    //    含 click 激活腿与 'show' 订阅面）；
    //  - ctx：宿主事实 + settings 内存 holder / 副作用叶活引用 + S2 quit 门
    //    （holder 仍在本文件——其余 20+ 处直读点随各自批迁入，届时 holder
    //    一并搬家）。
    // 调用点纪律（施工图 S1/S2）：whenReady 内、createMainWindow 之前——窗口
    // 加载前注册完毕（renderer 最早 invoke 也晚于全部启动代码），并完成投递
    // 状态机的 edges/quit 快照（shell-core 单装配不变式）。
    const shellCtx: ShellAssemblyCtx = {
      hostFacts: {
        controlPlaneUrl: rendererOrigin,
        platform: process.platform,
        trayPresent: () => tray !== null,
      },
      runtimeFacts: {
        dshVersion: () => resolveActiveRuntime(runtimeBaseDir, builtinDshWorkspace).version,
      },
      settingsIO: {
        current: () => chamberSettings,
        commit: next => {
          chamberSettings = next;
        },
        persist: next => writeSettingsFile(chamberSettingsFilePath(runtimeBaseDir), next),
      },
      setKeepAwake: enabled => setKeepAwakeActive(enabled),
      setLoginItem: enabled => applyLaunchAtLogin(enabled),
      // W-10 S2：quit 在途门（通知/深链入队与通知投递循环的 ignore 语义——
      // 原 main.ts 模块级 quitRequested 经它注入 core）。
      isQuitting: () => quitRequested,
      // W-10 S3（registry+凭据批）：C 组 7 注册体迁入 installIpcHandlers 的装配
      // 依赖。transportManager = 本作用域 sm 常量（transport-manager 纯模块现实
      // 例，registry 读写 + 状态/生命周期投影）；audit = 绑定 auditLogPath 的
      // S24 审计叶；gatewaySessions = 模块级会话管理器装配期取值（null 仅
      // will-quit 清理可达——处理器不可达，见 ShellAssemblyCtx 字段注释）；
      // publishRegistryTransition = registry 变更生命周期 sidecar（宿主对象
      // readySeedEdges/hostPackageSeeding/sshPluginJournal/… 与
      // SSH_INSTANCES_CHANGED push 文本留本文件，经 ctx 供 core 调用）。
      // W-10 S4（ssh 连接状态批）：D 组 7 注册体同经 transportManager——core 侧
      // Pick 扩 reverify/logs/clearLogs（本装配注入完整现实例，无新增字段）。
      // W-10 S5（exec/systemd 批）：E 组 4 注册体（SSH_START/STOP/IS_ACTIVE/
      // RESTART_SERVICE）同经 transportManager——core 侧 Pick 扩 exec（本装配
      // 注入完整现实例，无新增字段）。
      // W-10 S6（ssh plugin 批）：F 组 6 注册体（SSH_PLUGIN_LIST/APPLY/UNDO /
      // SSH_SEED_HOST_GRAPH / SSH_PLUGIN_MATERIALIZE_ADD(_PICK)）迁入
      // installIpcHandlers ② F 组段的装配依赖——core 侧 Pick 扩 appendLog；
      // 共享现实例/闭包束经 ctx 注入：localDshHome（本作用域装配期解析值——
      // core 不碰 Electron paths）、sshPluginJournal（本作用域现实例——main
      // 的 publishRegistryTransition 撤销清理与 core undo/apply 共用同一 journal
      // 写者）、hostPackageSeeding / chamberHostPackageSeeds（自动 seed 路径与
      // core 手动 seed 共用同一注册表/数组）、sshPluginTargets（findRemoteTarget
      // / ownsRemoteTarget / scoped* / liveProbeFor 闭包——自动 seed 与 ready
      // 边缘同族，core 经 ctx 调用、文本以原名逐字保留）。确认对话框与插件源
      // picker 宿主腿（confirmPluginAction 形状 / pickPluginSource 函数体）已迁
      // electron-edges.ts（HostEdges.showMessage / pickPluginSource）——W-10 S8
      // 起本地插件注册体（H 组）同经 core 内 confirmPluginAction 助手与 edges
      // 宿主腿，本文件 confirmPluginAction 闭包已删除（无使用点，见定义处标记）。
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
      // W-10 S7（gateway 插件批）：G 组 3 注册体（GATEWAY_PLUGIN_SYNC/APPLY/
      // MATERIALIZE）迁入 installIpcHandlers ② G 组段的装配依赖——syncGateway
      // ChamberPluginsFor（本作用域定义的上传执行闭包，ready 自动 sync 与手动
      // gateway_plugin_sync 共用同一执行路径：注册 transport 来源/授权头/SPKI
      // pin + 本地 chamber host 包源（app.isPackaged/pkgDir/repoRoot 解析在
      // 闭包内））；core 侧确认对话框复用 S6 edges 助手、窗口预检与 pick 经
      // edges——本装配不再新增宿主叶。
      syncGatewayChamberPluginsFor,
      // W-10 S8（本地插件批）：H 组 3 个本地插件注册体（LOCAL_PLUGIN_ADD/
      // ADD_FILE/REMOVE）的本地执行叶——runLocalPluginMutation（本作用域定义，
      // 见定义处注释：runtime writer fence 租约 + runtimeStartBlocked 启动门 +
      // resolveActiveRuntime workspace 解析归装配侧），core 经 ctx 调用同一执行
      // 路径，与搬迁前不分叉。
      runLocalPluginMutation,
      confirmRegistryOriginSwitch: async (currentOrigin, nextOrigin) => {
        const win = mainWindow;
        if (win === null || win.isDestroyed()) return 'unavailable';
        const { response } = await dialog.showMessageBox(win, {
          type: 'warning',
          title: '切换 dsh 运行时版本源？',
          message: '切换 dsh 运行时版本源？',
          detail: `版本检查、下载与安装的信任边界将从\n${currentOrigin}\n切换到\n${nextOrigin}`,
          buttons: ['取消', '切换版本源'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        });
        return response === 1 ? 'confirmed' : 'cancelled';
      },
    };
    installIpcHandlers({
      ipc: {
        handle: (channel, handler) => ipcMain.handle(channel, trustedIpc(handler)),
      },
      edges,
      ctx: shellCtx,
    });

    // 启动期创建主窗口：加载失败 = 大声失败 + 退出（createMainWindow 内）；
    // activate/托盘/second-instance 恢复路径共用同一创建函数。
    createMainWindow(rendererOrigin, true);
    void refreshRuntimeEvidence().then(() => runRuntimeStartup()).catch(error => {
      console.error('[dsh-chamber] dsh 运行时启动事务失败：', error);
      runtimeStartBlocked = true;
      runtimeInstance.setLifecycle({ phase: 'failed', error: error instanceof Error ? error.message : String(error) });
    });

    // 深链统一 drain（design 16 §4.2）：startup 完成（transportManager 装载）
    // 后顺序消费有界队列。VS Code 启动不等待 renderer；成功 intent 进入独立的
    // renderer hold/replay 队列（W-10 S2——该队列/入队/drain 已迁 shell-core，
    // 此处经 core 导出 enqueueRendererDeepLinkIntent + ownsNotificationSource
    // 接入），直到 onIntent + ready 握手完成。失败 loud（对话框 + 日志）。quit
    // 在途的新深链已在 enqueueDeepLink 被 ignore。本消费循环整体留 main 至 S9。
    drainPendingIntents = () => {
      if (drainingPendingIntents || quitRequested) return;
      drainingPendingIntents = true;
      void (async () => {
        for (;;) {
          if (quitRequested) return;
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
              dialog.showErrorBox('打开 VS Code 失败', error);
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
        if (!quitRequested && pendingIntents.pendingCount > 0) drainPendingIntents?.();
      });
    };
    drainPendingIntents();
    // —— W-10 S2：通知打开 drain（drainPendingNotificationOpens 赋值与末次调用）
    // 已迁 shell-core 投递状态机（send 叶 = edges.rendererPush；NOTIFICATION_OPEN
    // 推送源随迁）——
  });
}
