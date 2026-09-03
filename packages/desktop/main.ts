/**
 * dsh-chamber desktop main process (design 05, connection-manager form).
 *
 * The single window loads the control plane origin directly
 * (loadURL http://127.0.0.1:<cp.port>/) — one frame, one origin; the
 * control plane serves the built dsh frontend (webDistDir = <pkg>/dist in
 * dev and packaged alike, design 05 §7.1) and proxies every instance over
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

import { app, BrowserWindow, crashReporter, dialog, ipcMain, Menu, Notification, Tray, nativeImage, powerMonitor, powerSaveBlocker, safeStorage, session, shell } from 'electron';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, promises as fsp } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PlaneHandle } from '@dsh-chamber/control-plane';
import { attemptCommittedRegistryPush, computeRemovedInstanceIds, computeRetiredInstanceIds, createTransportManager } from './transport-manager.ts';
import { INSTANCE_ID_PATTERN } from './transport-manager.ts';
import type { TransportManager } from './transport-manager.ts';
import { commitTransportCredentialUpdate } from './transport-manager.ts';
import { canonicalizeTransportInstanceInput, type TransportInstanceInput, type TransportInstanceSpec } from './transport-provider.ts';
import { deleteConnectionTransaction, saveConnectionTransaction, validateDeleteOnlyReplacement, type ConnectionCredentialMutations } from './connection-save.ts';
import { MAX_SSH_PASSWORD_CHARS, sshProvider, probeClientGraphLive, probeGitWorktreeLive } from './ssh-provider.ts';
import { cleanupStaleAskpassHelpers, configureSshPasswordStore, getSshPassword, setSshPassword, sshPasswordSupported } from './ssh-provider.ts';
import { configureGatewaySecretStore, configureGatewaySessionProvider, gatewayPasswordValidationError, gatewayProvider, gatewaySecretStorageMode, gatewayTokenValidationError, getGatewayPassword, getGatewayToken, setGatewayPassword, setGatewayToken, setInstanceSecrets, syncGatewayChamberPlugins } from './gateway-provider.ts';
import type { LocalChamberHostPackage } from './gateway-provider.ts';
import { createGatewaySessionManager, gatewayRegistrationAuthHeaders, gatewaySessionScopeForConnection } from './gateway-session.ts';
import { createGatewaySessionRefresh, gatewaySessionOriginForUrl, gatewayTunnelAuthority } from './gateway-session-refresh.ts';
import type { GatewaySessionRefresh } from './gateway-session-refresh.ts';
import { appendAuditEvent, configureAuditLog, type AuditEvent } from './audit-log.ts';
import type { GatewayRegistrationAuthProof, GatewaySessionManager, GatewaySessionOrigin } from './gateway-session.ts';
import { discoverSshConfigHosts } from './ssh-config.ts';
import { createTrustedIpc, isExternalLinkUrl, isTrustedIpcSender, isTrustedRendererUrl } from './renderer-trust.ts';
import { call, createControlPlane } from './control-plane-module.ts';
import {
  attemptDeepLinkProtocolRegistration,
  BoundedAckDeliveryQueue,
  BoundedVscodeIntentQueue,
  canDeliverRendererDeepLink,
  canRestoreMainWindow,
  decideDeepLinkProtocolRegistration,
  describeUnknownError,
  detectVscodeAvailability,
  parseOpenVscodeIntent,
  runVscodeLaunch,
} from './deep-link.ts';
import type { VscodeLaunchContext, VscodeLaunchRequest } from './deep-link.ts';
import { classifyLocalPath, invokeOpenPath, listOpenInApps, runOpenInLaunch } from './open-in.ts';
import type { OpenInLaunchContext, OpenInRequest } from './open-in.ts';
import { createUpdateController, openReleasePage } from './updater.ts';
import { DEFAULT_RUNTIME_LOGICAL_DISK_LIMIT_BYTES, DshRuntimeController } from './dsh-runtime-controller.ts';
import type { RuntimeMetadataComponent, RuntimeMetadataHealthProjection } from './dsh-runtime-controller.ts';
import { fetchRegistryMetadata } from './registry-metadata.ts';
import { isAllowedRegistryUrl } from './registry-url.ts';
import { sanitizeErrorText } from './sanitize-error.ts';
import { evaluateApplyNowGate, type ApplyNowGateInput } from './apply-now-gate.ts';
import { disposeRuntimeInstaller, installRuntimeVersion, pruneRuntimeStore } from './runtime-installer.ts';
import {
  cleanupStaleInstalls,
  cleanupExplicitRuntimeVersion,
  clearActivationJournal,
  clearCurrentPointer,
  clearRuntimeFailure,
  clearStorePruneRequest,
  deleteOverride,
  evictVersions,
  latestKnownGood,
  listKnownGoodVersions,
  listExplicitlyInstalledVersions,
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
  runtimeDiskSummary,
  runtimeFailureSummary,
  runtimeSnapshotRetentionState,
  validateVersionTree,
  writeActivationIntent,
  writeActivationJournal,
  writeCurrentPointer,
  writeOverride,
} from './dsh-runtime-store.ts';
import type { ActivationJournalState } from './dsh-runtime-store.ts';
import {
  cleanupSnapshotArtifacts,
  completeInterruptedRestore,
  listPreRollbackStashes,
  prepareManualRollbackData,
  pruneSnapshots,
  resolveSnapshotName,
  restoreMarkerAuthorityStatus,
  restorePreRollback,
  restoreSnapshot,
  snapshotDshHome,
  snapshotSummary,
} from './snapshot-store.ts';
import {
  noteBoot,
  promoteDueCandidates,
  recordProbePass,
  removeKnownGoodCandidate,
  resetCandidateHealthWindow,
} from './known-good-monitor.ts';
import { invalidate } from './override-lifecycle.ts';
import {
  runDelayedRollback,
  runStartupPhase,
  shouldProbeEnvWithDormantCorruptSelection,
  type StartupDeps,
  type StartupResult,
} from './runtime-startup.ts';
import { planRestartExhaustedRollback } from './restart-exhausted-rollback.ts';
import { RuntimeOperationFence, type OperationLease } from './runtime-operation-fence.ts';
import { runRuntimeActivationProbes } from './runtime-probes.ts';
import {
  detectRuntimeMetadataHealth,
  inspectCorruptMetadataRecoveryMarker,
  recoverRuntimeMetadata,
  rescueCorruptMetadataRecoveryMarker,
  type RuntimeMetadataHealth,
} from './runtime-metadata-recovery.ts';
import { allowedActions } from './runtime-state-machine.ts';
import { isSafeVersion } from './version-safety.ts';
import {
  applyPlugins,
  CLIENT_GRAPH_INSERT_ID,
  CLIENT_GRAPH_PACKAGE_NAME,
  ExactOwnershipRegistry,
  describeLocalPluginAddConfirmation,
  describeLocalPluginRemoveConfirmation,
  GIT_WORKTREE_INSERT_ID,
  GIT_WORKTREE_PACKAGE_NAME,
  localPluginList,
  materializeAndAdd,
  remoteHome,
  remotePluginList,
  ReadyPhaseEdges,
  reapStaleLocalPluginWriters,
  resolveLocalMaterializeDirectory,
  runLocalDshPlugin,
  seedRemoteChamberHostPackages,
  disposePluginSyncChildren,
  scopeExecToOwnership,
  runWithFinalOwnership,
} from './plugin-sync.ts';
import type { ChamberHostPackageSeed, ExactOwnershipToken, ExecFn, StatusFn, RemoteSpec } from './plugin-sync.ts';
import {
  DEFAULT_CHAMBER_SETTINGS,
  computeQuitRisk,
  computeSupported,
  readSettingsFile,
  shouldHideToTray,
  validatePatch,
  writeSettingsFile,
} from './chamber-settings.ts';
import type { ChamberSettings, ChamberSettingsStatus } from './chamber-settings.ts';
import {
  BoundedRateLimiter,
  claimNotificationDetailed,
  decideNotification,
  MAX_ACTIVE_NATIVE_NOTIFICATIONS,
  MAX_PENDING_NOTIFICATION_OPENS,
  NotificationSourceIncarnations,
  NotificationSourceProofs,
  isValidNotificationSourceFingerprint,
  readNotificationHostBoolean,
  releaseNotificationClaim,
  shouldFocusApplicationBeforeShowing,
  showNativeNotificationHonestly,
  validateNotificationRequest,
} from './notifications.ts';
import type { NotificationOpenIntent, NotificationSettingsLike, NotificationSourceToken } from './notifications.ts';
import { IPC_CHANNELS } from './ipc-events.ts';

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

// Control-plane port (design 05 §3.3): the packaged app keeps the documented
// default 17500; the dev launcher (electron-dev.mjs) runs with an isolated
// user-data dir, so its control plane must also avoid the packaged app's port
// — dev defaults to 17520 and can be overridden with DSH_CHAMBER_CP_PORT. The
// renderer origin is derived from the actually bound port at runtime
// (controlPlane.port), so nothing else hardcodes the address.
function resolveControlPlanePort(): number {
  const fromEnv = process.env.DSH_CHAMBER_CP_PORT;
  if (fromEnv !== undefined && fromEnv !== '') {
    const parsed = Number(fromEnv);
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) return parsed;
    console.error(`[dsh-chamber] 忽略非法 DSH_CHAMBER_CP_PORT="${fromEnv}"（须为 1–65535 整数），使用默认端口`);
  }
  return process.env.DSH_CHAMBER_ELECTRON_DEV === '1' ? 17520 : 17500;
}

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

/** The control-plane proxy currently ships the same two transport adapters as
 * the desktop registry. Keep the open-ended provider type at its boundary,
 * then fail loudly if a future adapter reaches registration before the proxy
 * has learned its trust/origin rules. */
function proxyTransport(transport: TransportInstanceSpec['transport']): 'ssh' | 'http' {
  if (transport === 'ssh') return 'ssh';
  if (transport === 'http') return 'http';
  throw new TypeError(`unsupported proxy transport: ${transport}`);
}

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

type ActiveRuntimeSource = 'env' | 'user' | 'bundled';
interface ActiveRuntimeResolution {
  path: string | null
  version: string | null
  source: ActiveRuntimeSource
  blockedReason: string | null
}

/**
 * Synchronous spawn-time resolver: env > valid override/current > builtin.
 * Selection metadata corruption and pointer/override disagreement fail closed;
 * they never alias the absence of a user runtime.
 */
function resolveActiveRuntime(baseDir: string): ActiveRuntimeResolution {
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
  if (
    override !== null
    && override.shellVersion === version
    && override.invalidatedAt == null
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
    path: builtinDshWorkspace,
    version: readDshVersion(builtinDshWorkspace),
    source: 'bundled',
    blockedReason: builtinDshWorkspace === null ? 'bundled dsh workspace not found' : null,
  };
}

function readDshVersion(workspace: string | null): string | null {
  if (workspace === null) return null;
  try {
    const manifest = JSON.parse(readFileSync(path.join(workspace, 'package.json'), 'utf8'));
    return manifest.dependencies?.['@deepseek-ai/dsh'] ?? null;
  } catch {
    return null;
  }
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

// Chamber settings (design 14 D7, v1 scope): loaded at startup from
// <userData>/chamber-settings.json, mutated via dsh-chamber:settings-set. The
// side effects (keep-awake / login autostart / close behavior) are applied
// here in the main process — never in any instance's dsh home (01 §2 P2).
let chamberSettings: ChamberSettings = { ...DEFAULT_CHAMBER_SETTINGS };
let keepAwakeBlockerId: number | null = null;
// 最近一次 OS 唤醒时间戳：无窗口常驻（托盘态）期间 held，窗口 show 时补发。
let lastResume: number | null = null;
// Quit state machine (design 14 D2): quitRequested 置位后关窗不再 hide（真正
// 退出在途）；quitConfirmed 表示退出已获确认/豁免；confirmingQuit 是确认
// 对话框单飞闸（防连点/双路径重复弹窗）。
let quitRequested = false;
let quitConfirmed = false;
let confirmingQuit = false;
let quitCleanupInProgress = false;
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
const LOCAL_RUNNING_STATES: ReadonlySet<string> = new Set(['starting', 'ready', 'degraded', 'restarting']);

// VS Code 深链（design 16 §4.2）：OS 级深链（macOS open-url / Win+Linux
// second-instance argv / 冷启动 argv）统一入有界、归一化 single-flight 队列，
// startup 完成后顺序 drain。key = (instanceId,path)，因此 open-url/argv 的不同
// URL 拼写仍会合并；complete 后允许用户稍后主动再次打开同一目标。
// drainPendingIntents 在 whenReady 内赋值（依赖 wiredCtx/transportManager），
// 冷启动到达的深链只入队、drain 就绪后消费。
const pendingIntents = new BoundedVscodeIntentQueue(64);
let drainPendingIntents: (() => void) | null = null;
let drainingPendingIntents = false;

// 成功启动 VS Code 与 renderer 来源激活是两条独立链：前者不等待 UI，后者
// 必须等 App 安装 onIntent 后通过 deep-link-ready 握手才能发送。窗口加载/崩溃
// 会复位 ready；成功 intent 在有界队列中 hold/replay，绝不发给 about:blank 或
// 尚未订阅的 renderer。
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

// 桌面通知（design 19 §3.3）：pendingNotificationOpens 照搬 pendingIntents 的
// 队列 + drain 模式——点击通知时窗口可能正在重建/加载，事件不能丢；active
// Notifications Set 持有存活引用防 GC 吞 click（macOS 已知坑，OpenChamber 同款）。
const pendingNotificationOpens = new BoundedAckDeliveryQueue<NotificationOpenIntent>(MAX_PENDING_NOTIFICATION_OPENS);
const notificationSourceIncarnations = new NotificationSourceIncarnations();
let drainPendingNotificationOpens: (() => boolean) | null = null;
let drainingNotificationOpens = false;
/** Renderer 就绪标志（design 19 §3.3）：renderer 注册 onOpen 监听后 invoke
 *  dsh-chamber:notifications-ready 置位——did-finish-load 早于监听注册，推送
 *  必须在就绪后才放行，否则窗口重建路径的点击事件会被 IPC 丢弃。 */
let notificationOpenDrainReady = false;
const activeNotifications = new Map<Notification, NotificationSourceToken | null>();
const nativeNotificationRateLimiter = new BoundedRateLimiter();

/** 扫描 argv 中的 dsh-chamber:// 深链（防御式：非深链 argv 零副作用、绝不 throw）。 */
function scanDeepLinkUrls(argv: readonly string[]): string[] {
  const urls: string[] = [];
  for (const arg of argv) {
    if (typeof arg === 'string' && arg.startsWith('dsh-chamber://')) urls.push(arg);
  }
  return urls;
}

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
 * its onIntent listener is installed. Used by both OS deep links and open-in. */
function captureVscodeSource(instanceId: string): NotificationSourceToken | null {
  if (instanceId === 'local') return notificationSourceIncarnations.capture('local');
  const instance = transportManager?.listInstances().find(candidate => candidate.id === instanceId);
  return instance === undefined
    ? null
    : notificationSourceIncarnations.capture(`${instance.kind}-${instance.id}`);
}

function enqueueRendererDeepLinkIntent(intent: VscodeLaunchRequest, sourceToken: NotificationSourceToken): void {
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

function drainPendingRendererDeepLinkIntents(): boolean {
  if (drainingRendererDeepLinkIntents) return true;
  const win = mainWindow;
  const destroyed = win === null || win.isDestroyed();
  if (win === null || !canDeliverRendererDeepLink({
    ready: deepLinkRendererReady,
    currentWindow: mainWindow === win,
    destroyed,
    loading: destroyed ? true : win.webContents.isLoading(),
    crashed: destroyed ? true : win.webContents.isCrashed(),
  })) return true;

  drainingRendererDeepLinkIntents = true;
  try {
    for (;;) {
      const delivery = pendingRendererIntents.shift();
      if (delivery === null) return true;
      const intent = delivery.payload;
      try {
        if (
          mainWindow !== win
          || win.isDestroyed()
          || win.webContents.isLoading()
          || win.webContents.isCrashed()
        ) {
          throw new Error('deep-link renderer changed while draining');
        }
        win.webContents.send(IPC_CHANNELS.DEEP_LINK_INTENT, {
          instanceId: intent.instanceId,
          path: intent.path,
          sourceFingerprint: intent.sourceFingerprint,
          deliveryId: delivery.deliveryId,
          attempt: delivery.attempt,
        });
      } catch (error) {
        // Preserve the failed item for the next renderer handshake instead of
        // converting a transient send race into a lost/reordered activation.
        if (!pendingRendererIntents.rollback(delivery)) {
          console.error(`[dsh-chamber] renderer 深链 intent 回滚失败：${intent.instanceId}`);
        }
        if (mainWindow === win) deepLinkRendererReady = false;
        console.error('[dsh-chamber] 深链 intent 推送失败，等待 renderer 重试：', describeUnknownError(error));
        return false;
      }
    }
  } finally {
    drainingRendererDeepLinkIntents = false;
  }
}

/** 通知点击入队（design 19 §3.3）：quit 在途 ignore；入队后立即 drain（窗口
 *  已加载则直接推送，重建/加载中由 did-finish-load 补发——窗口关闭期间点击
 *  通知不丢事件，照搬 pendingIntents 模式）。有界队列（64 条上限，与
 *  renderer 深链队列同款防御）：窗口长期无法加载时超限丢弃最旧，绝不无限增长。 */
function enqueueNotificationOpen(sourceToken: NotificationSourceToken, sessionId: string): void {
  if (quitRequested) return;
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
  drainPendingNotificationOpens?.();
}

/** 退出清理（will-quit：transport dispose + 控制面 stop）的最长等待；超时强制
 *  退出，防「窗口已关、主进程永久滞留」的半退出态。子进程回收用短窗口
 *  （transport 1s / 本地 dsh 1s → SIGKILL）+ 传输层与控制面并行化，正常
 *  ~1-2s 完成；5s 硬顶仅为异常路径（如残留连接使 server.close 不回调）兜底
 *  （2026-08 排查；2026-08 提速，15s → 5s）。 */
const QUIT_CLEANUP_TIMEOUT_MS = 5_000;
/** Cap on the npm search JSON body (registry search responses are ~KB-scale;
 * 256 KiB bounds a hostile or misbehaving registry). */
const NPM_SEARCH_MAX_BODY_BYTES = 256 * 1024;
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
/** Chamber 设置文件路径（design 14 D7）：<userData>/chamber-settings.json。 */
const chamberSettingsFile = (): string => path.join(app.getPath('userData'), 'chamber-settings.json');

/**
 * Minimal tray（桌面一体形态的最小托盘：状态 tooltip + 显示/退出菜单）: status
 * tooltip + show/quit menu. Defensive by construction — only created when
 * packaged and an icon resource exists; any failure skips the tray with a
 * log and never blocks startup. The repo ships no icon assets yet, so on a
 * stock checkout this logs the skip reason and does nothing.
 */
function maybeCreateTray(cp: PlaneHandle) {
  if (!app.isPackaged) {
    console.log('[dsh-chamber] 跳过托盘：开发模式（app.isPackaged=false）');
    return;
  }
  const candidates = [
    path.join(process.resourcesPath, 'icons', 'tray.png'),
    path.join(process.resourcesPath, 'tray.png'),
    path.join(process.resourcesPath, 'icon.png'),
  ];
  const iconPath = candidates.find((candidate) => existsSync(candidate));
  if (iconPath === undefined) {
    console.warn('[dsh-chamber] 未找到托盘图标资源（resourcesPath/icons/tray.png 等），跳过托盘');
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
 * 深链协议注册（design 16 §4.3）：`app.isPackaged` 门控——开发态注册会把裸
 * Electron 注册成 scheme handler，污染 LaunchServices，与打包版 bundle id
 * （com.dshchamber.desktop）冲突（镜像托盘先例）。win32 首版门控（暂缓一致性，
 * 镜像 ssh 密码 askpass 门控）；打包 Linux/macOS 都使用无 relaunch args 形态——
 * argv[1] 可能正是本次冷启动 URL，绝不能将它固化到后续协议启动；macOS 打包版
 * 另由 electron-builder `protocols` 键自动生成
 * CFBundleURLTypes，此处 setAsDefaultProtocolClient 兜底。失败 loud，绝不
 * 打断启动。
 */
function registerDeepLinkProtocol(): void {
  const decision = decideDeepLinkProtocolRegistration({ isPackaged: app.isPackaged, platform: process.platform });
  if (decision.action === 'skip') return;
  // Packaged Linux is the same no-args form as packaged macOS. argv[1] may be
  // the cold-start protocol URL; persisting it as a relaunch arg poisons all
  // subsequent launches. The executable+script form is only for defaultApp
  // development, and development registration is deliberately gated off.
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

/** 单窗口聚焦判定（通知裁决的权威复查，design 19 §3.3）：渲染端 document.hasFocus
 *  与主进程复查等价（单窗口），主进程再查一次作为权威。窗口必须存在、可见且聚焦
 *  ——隐藏到托盘/后台的窗口不算聚焦。 */
function isAnyWindowFocused(): boolean {
  return mainWindow !== null && !mainWindow.isDestroyed() && mainWindow.isVisible() && mainWindow.isFocused();
}

/** 非秘密 chamber 设置投影（design 14 D7）：当前值 + 平台能力门控。 */
function chamberSettingsStatus(): ChamberSettingsStatus {
  return {
    settings: chamberSettings,
    supported: computeSupported(process.platform, tray !== null),
  };
}

/** 设置变更推送（主窗口存活时；无窗口常驻期间由下次查询兜底）。 */
function pushSettingsChanged(): void {
  const win = mainWindow;
  if (win === null) return;
  const pushed = attemptCommittedRegistryPush(() => {
    if (mainWindow !== win || win.isDestroyed()) throw new Error('settings renderer changed before push');
    win.webContents.send(IPC_CHANNELS.SETTINGS_CHANGED, chamberSettingsStatus());
  });
  if (!pushed.sent) {
    try { console.warn(`[dsh-chamber] settings 已保存但变更 push 失败（等待 renderer 重拉）：${pushed.error}`); } catch { /* best effort */ }
  }
}

function pushHeldSystemResume(win: BrowserWindow, timestamp: number): boolean {
  const pushed = attemptCommittedRegistryPush(() => {
    if (mainWindow !== win || win.isDestroyed()) throw new Error('system-resume renderer changed before push');
    win.webContents.send(IPC_CHANNELS.SYSTEM_RESUME, { timestamp });
  });
  if (!pushed.sent) {
    try { console.warn(`[dsh-chamber] system-resume push 失败，保留待重试：${pushed.error}`); } catch { /* best effort */ }
  }
  return pushed.sent;
}

/**
 * 桌面原生通知主链路（design 19 §3.3）：payload 白名单 → 平台支持 → 设置裁决
 * → 有界 claim / 全局速率 / active cap → 显示。返回是否收到原生 `show` 事件
 * （异步 failed/close/timeout 均为 false）。'test' 绕过 claim 与设置门禁，但仍受
 * 全局宿主预算约束；通知失败降级且 loud，不误报成功，会话业务/侧边栏蓝点不受影响。
 */
async function maybeShowNativeNotification(payload: unknown): Promise<boolean> {
  const validated = validateNotificationRequest(payload);
  if (!validated.ok) {
    console.warn(`[dsh-chamber] 拒绝非法通知 payload：${validated.error}`);
    return false;
  }
  const request = validated.request;
  // 设置权威在主进程内存（chamberSettings.notifications，settings-set 即时更新）；
  // 旧文件缺字段时用 DEFAULT 兜底（normalizeSettings 已归一，此处仅防御）。
  const settings: NotificationSettingsLike = {
    ...DEFAULT_CHAMBER_SETTINGS.notifications,
    ...(chamberSettings.notifications ?? {}),
  };
  const focused = readNotificationHostBoolean(() => isAnyWindowFocused());
  if (!focused.ok) {
    console.warn(`[dsh-chamber] 通知窗口焦点探测失败：${focused.error}`);
    return false;
  }
  const decision = decideNotification({
    request,
    settings,
    anyWindowFocused: focused.value,
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
  // every deliberately suppressed renderer edge.
  const supported = readNotificationHostBoolean(() => Notification.isSupported());
  if (!supported.ok) {
    console.warn(`[dsh-chamber] 原生通知能力探测失败：${supported.error}`);
    return false;
  }
  if (!supported.value) {
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
  if (activeNotifications.size >= MAX_ACTIVE_NATIVE_NOTIFICATIONS) {
    releaseNotificationClaim(claim.token);
    console.warn(`[dsh-chamber] 活跃原生通知已达 ${MAX_ACTIVE_NATIVE_NOTIFICATIONS} 条硬上限，拒绝新通知`);
    return false;
  }
  if (!nativeNotificationRateLimiter.tryAcquire()) {
    releaseNotificationClaim(claim.token);
    console.warn('[dsh-chamber] 原生通知发送速率达到硬上限，拒绝新通知');
    return false;
  }
  let notification: Notification | null = null;
  try {
    const created = new Notification({
      title: request.title,
      body: request.body,
      silent: false,
      // macOS 系统提示音（OpenChamber 同款）；其余平台交给系统默认。
      ...(process.platform === 'darwin' ? { sound: 'Glass' } : {}),
    });
    notification = created;
    // activeNotifications 持有存活引用防 GC 吞 click（macOS 已知坑）。
    activeNotifications.set(created, sourceToken);
    created.on('click', () => {
      try {
        // The native object can outlive registry removal + same-id re-add. Its
        // captured generation must still own the source before either focusing
        // the replacement shell or enqueueing a session-open intent.
        if (sourceToken !== null && !notificationSourceIncarnations.owns(sourceToken)) {
          console.warn(`[dsh-chamber] 忽略旧来源代际的通知点击：${request.sourceId}`);
          return;
        }
        // 聚焦/显示窗口（存在则 restore+focus，无窗则重建）+ 打开对应会话：先把
        // 打开意图入队并 drain，窗口未就绪时由 did-finish-load 补发。'test'
        // 通知（设置页测试按钮）没有会话上下文，click 只聚焦不打开。
        if (!showMainWindow()) return;
        if (sourceToken !== null) enqueueNotificationOpen(sourceToken, request.sessionId);
      } catch (error) {
        try { console.warn(`[dsh-chamber] 原生通知点击处理失败：${describeUnknownError(error)}`); } catch { /* event boundary must never throw */ }
      }
    });
    created.on('close', () => {
      activeNotifications.delete(created);
    });
    const outcome = await showNativeNotificationHonestly(created);
    if (!outcome.shown) {
      activeNotifications.delete(created);
      releaseNotificationClaim(claim.token);
      console.warn(`[dsh-chamber] 原生通知显示失败：${outcome.error}`);
      return false;
    }
    return true;
  } catch (error) {
    if (notification !== null) {
      activeNotifications.delete(notification);
      try { notification.close(); } catch { /* best-effort host cleanup */ }
    }
    releaseNotificationClaim(claim.token);
    try { console.warn('[dsh-chamber] 创建/监听原生通知失败：', describeUnknownError(error)); } catch { /* IPC must still settle false */ }
    return false;
  }
}

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
 * （手写最小 .desktop）；Windows v1 门控（supported=false，调用方不得持久化）。
 * 失败 loud 返回 {error}，绝不静默假成功。
 */
function applyLaunchAtLogin(enabled: boolean): { ok: true } | { ok: false; error: string } {
  if (process.platform === 'win32') {
    return { ok: false, error: 'not supported on this platform' };
  }
  try {
    if (process.platform === 'darwin') {
      app.setLoginItemSettings({ openAtLogin: enabled });
      return { ok: true };
    }
    const autostartDir = path.join(os.homedir(), '.config', 'autostart');
    const desktopFile = path.join(autostartDir, 'dsh-chamber.desktop');
    if (enabled) {
      mkdirSync(autostartDir, { recursive: true });
      writeFileSync(
        desktopFile,
        '[Desktop Entry]\nType=Application\nName=dsh-chamber\n' +
          `Exec="${process.execPath}"\nX-GNOME-Autostart-enabled=true\n`,
        { mode: 0o600 },
      );
    } else {
      rmSync(desktopFile, { force: true });
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: describeUnknownError(error) };
  }
}

/**
 * 应用一个已校验的设置 patch（design 14 D7）：先应用副作用（keep-awake /
 * 登录自启），**全部成功并持久化成功后才更新 holder**——任何失败 loud 返回
 * {error} 并回滚已应用的副作用（绝不落半个设置、绝不内存与磁盘不一致）。
 * windowCloseBehavior 无副作用（影响未来的 close 事件）。
 */
function applySettingsPatch(patch: Partial<ChamberSettings>): { ok: true } | { ok: false; error: string } {
  // notifications 是嵌套对象：patch 可能只带部分子键（validatePatch 允许 partial），
  // 必须 deep-merge 到当前值，绝不整组替换丢开关。
  const next: ChamberSettings = {
    ...chamberSettings,
    ...patch,
    notifications: patch.notifications !== undefined
      ? { ...chamberSettings.notifications, ...patch.notifications }
      : chamberSettings.notifications,
  };
  // 副作用应用包 try：powerSaveBlocker / 登录自启意外抛异常时 loud 失败并
  // best-effort 回滚 keepAwake，绝不带病继续（绝不落半个设置）。
  try {
    if (patch.keepAwake !== undefined) setKeepAwakeActive(patch.keepAwake);
    if (patch.launchAtLogin !== undefined) {
      const result = applyLaunchAtLogin(patch.launchAtLogin);
      if (!result.ok) {
        // 副作用失败：回滚已应用的 keepAwake（保持原状），绝不持久化。
        if (patch.keepAwake !== undefined) setKeepAwakeActive(chamberSettings.keepAwake);
        return result;
      }
    }
  } catch (error) {
    console.error('[dsh-chamber] 应用 chamber 设置副作用失败：', error);
    try {
      if (patch.keepAwake !== undefined) setKeepAwakeActive(chamberSettings.keepAwake);
    } catch {
      // 回滚失败也 loud 已记日志，不再叠加异常。
    }
    return { ok: false, error: 'settings apply failed' };
  }
  try {
    writeSettingsFile(chamberSettingsFile(), next);
  } catch (error) {
    console.error('[dsh-chamber] 写入 chamber 设置失败：', error);
    // 持久化失败：回滚已应用的副作用，holder 保持旧值——内存/磁盘/实际行为一致。
    if (patch.keepAwake !== undefined) setKeepAwakeActive(chamberSettings.keepAwake);
    if (patch.launchAtLogin !== undefined) {
      const rollback = applyLaunchAtLogin(chamberSettings.launchAtLogin);
      if (!rollback.ok) console.error(`[dsh-chamber] 登录自启回滚失败：${rollback.error}`);
    }
    return { ok: false, error: 'settings persist failed' };
  }
  chamberSettings = next;
  return { ok: true };
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
    // main window's queues.
    if (mainWindow === win) {
      drainPendingRendererDeepLinkIntents();
      drainPendingNotificationOpens?.();
    }
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    clearUnresponsiveTimer();
    clearCrashReloadTimer();
    if (details.reason === 'clean-exit' || quitRequested) return; // 用户关窗/退出等正常路径
    // 通知就绪标志立即失效（design 19 §3.3）：崩溃到 500ms 后 reload 之间没有
    // 导航事件（did-start-loading 不会触发），不重置则向死 frame 推送丢事件。
    if (mainWindow === win) {
      notificationOpenDrainReady = false;
      deepLinkRendererReady = false;
      pendingNotificationOpens.requeueInFlight();
      pendingRendererIntents.requeueInFlight();
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
      // 沙箱 preload 以纯 CJS 执行（无 TS 类型擦除），统一加载编译产物
      // dist/preload.cjs（build:preload 生成）；缺省回退源码仅为兜底。
      preload: existsSync(path.join(pkgDir, 'dist', 'preload.cjs'))
        ? path.join(pkgDir, 'dist', 'preload.cjs')
        : path.join(pkgDir, 'preload.cts'),
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
  win.webContents.on('did-start-loading', () => {
    if (mainWindow === win) {
      notificationOpenDrainReady = false;
      deepLinkRendererReady = false;
      pendingNotificationOpens.requeueInFlight();
      pendingRendererIntents.requeueInFlight();
      drainPendingNotificationOpens?.();
    }
  });
  win.on('closed', () => {
    if (mainWindow === win) {
      notificationOpenDrainReady = false;
      deepLinkRendererReady = false;
      pendingNotificationOpens.requeueInFlight();
      pendingRendererIntents.requeueInFlight();
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
  // 无窗口常驻（托盘态）期间的唤醒事件由主进程 held（lastResume），窗口
  // 恢复可见时一次性补发（design 14 D4）。
  win.on('show', () => {
    const heldResume = lastResume;
    if (heldResume !== null && pushHeldSystemResume(win, heldResume)) {
      if (lastResume === heldResume) lastResume = null;
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
      // autoInstallOnAppQuit 也不执行——即使「已下载」豁免放行了退出，更新
      // 安装也会被跳过（接受的取舍，如实记录）。
      console.error('[dsh-chamber] 退出清理超时，强制退出（可能有子进程残留，已下载更新不会安装）');
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
      app.quit();
    });
  });

  app.whenReady().then(async () => {
    // 冷启动深链 argv（design 16 §4.2）：macOS argv 含 -psn_ 噪声，防御式扫描
    // （非深链 argv 零副作用、绝不 throw 打断启动）；与 open-url 双触发由去重兜底。
    for (const url of scanDeepLinkUrls(process.argv)) enqueueDeepLink(url);
    const runtimeBaseDir = app.getPath('userData');
    const localDshHome = path.join(runtimeBaseDir, 'state', 'dsh-home');
    const runtimeWriterFence = new RuntimeOperationFence();
    const envOverrideActive = Boolean(process.env.DSH_CHAMBER_DSH_PATH);
    const runtimeManagementSupported = process.platform !== 'win32';
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
      // A durable invalidation means the builtin fallback verdict already
      // committed. Do not manufacture a fresh snapshot/switch transaction on
      // every later boot; only a newly observed shell-version mismatch starts
      // F4. An interrupted first transaction is resumed from its journal.
      && startupOverrideState.record.invalidatedAt == null
      && startupOverrideState.record.shellVersion !== version
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
          writeOverride(
            runtimeBaseDir,
            invalidate(startupOverrideState.record, `shell updated to ${version}`),
          );
        } catch (error) {
          runtimeBootstrapFailure = `无法持久化 shell 更新回落事务：${sanitizeErrorText(error instanceof Error ? error.message : String(error))}`;
        }
      }
    }
    try {
      const controlPlanePort = resolveControlPlanePort();
      console.log(`[dsh-chamber] 控制面端口：${controlPlanePort}（${process.env.DSH_CHAMBER_CP_PORT ? 'DSH_CHAMBER_CP_PORT 覆盖' : process.env.DSH_CHAMBER_ELECTRON_DEV === '1' ? 'dev 默认' : '打包默认'}）`);
      controlPlane = createControlPlane({
        port: controlPlanePort,
        stateDir: path.join(app.getPath('userData'), 'state'),
        getDshWorkspacePath: () => {
          if (runtimeTransactionWorkspace !== null) return runtimeTransactionWorkspace;
          const resolved = resolveActiveRuntime(runtimeBaseDir);
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
        // plane (design 05 §3.3): <pkg>/dist in dev and packaged (asar) alike.
        webDistDir: path.join(pkgDir, 'dist'),
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
        const resolved = resolveActiveRuntime(runtimeBaseDir);
        if (resolved.path === null) return { ok: false, error: resolved.blockedReason ?? 'dsh workspace not found' };
        return await mutate(resolved.path);
      } finally {
        lease.release();
      }
    };
    const confirmPluginAction = async (
      win: BrowserWindow | null,
      copy: { message: string; detail: string },
    ): Promise<{ ok: true } | { ok: false; error: string } | { cancelled: true }> => {
      if (win === null || win.isDestroyed()) return { ok: false, error: 'native confirmation unavailable' };
      try {
        const { response } = await dialog.showMessageBox(win, {
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
    ipcMain.handle(IPC_CHANNELS.INFO, trustedIpc(() => ({
      controlPlaneUrl: `http://127.0.0.1:${cp.port}`,
      dshVersion: resolveActiveRuntime(runtimeBaseDir).version,
      version,
      platform: process.platform,
    })));

    // Chamber settings（design 14 D7）：启动加载 + 应用副作用（keep-awake /
    // 登录自启 reconcile）；损坏 loud（*.corrupt 保留），绝不静默假默认。
    const settingsLoad = readSettingsFile(chamberSettingsFile());
    if (settingsLoad.notice !== null) console.error(`[dsh-chamber] ${settingsLoad.notice}`);
    chamberSettings = settingsLoad.settings;
    setKeepAwakeActive(chamberSettings.keepAwake);
    if (process.platform !== 'win32') {
      const loginItemResult = applyLaunchAtLogin(chamberSettings.launchAtLogin);
      if (!loginItemResult.ok) {
        console.warn(`[dsh-chamber] 登录自启 reconcile 失败：${loginItemResult.error}`);
      }
    }

    // Chamber settings IPC 面：get 查询 / set 应用并持久化 / 变更推送。全部走
    // trustedIpc 围栏；失败 loud {error}，绝不静默假成功。
    ipcMain.handle(IPC_CHANNELS.SETTINGS_GET, trustedIpc(() => chamberSettingsStatus()));
    ipcMain.handle(IPC_CHANNELS.SETTINGS_SET, trustedIpc(async ({ patch }) => {
      const validated = validatePatch(patch);
      if (!validated.ok) return { error: validated.error };
      // Switching the dsh runtime version source moves the trust boundary of
      // version checks/downloads/installs — require native user confirmation
      // (design 18) before applying the patch.
      const nextOrigin = validated.patch.registryOrigin;
      if (nextOrigin !== undefined && nextOrigin !== chamberSettings.registryOrigin) {
        const win = mainWindow;
        if (win === null || win.isDestroyed()) return { error: 'native confirmation unavailable' };
        const { response } = await dialog.showMessageBox(win, {
          type: 'warning',
          title: '切换 dsh 运行时版本源？',
          message: '切换 dsh 运行时版本源？',
          detail: `版本检查、下载与安装的信任边界将从\n${chamberSettings.registryOrigin}\n切换到\n${nextOrigin}`,
          buttons: ['取消', '切换版本源'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        });
        if (response !== 1) return { error: 'cancelled', code: 'cancelled' };
      }
      const applied = applySettingsPatch(validated.patch);
      if (!applied.ok) return applied;
      pushSettingsChanged();
      return chamberSettingsStatus();
    }));

    // 桌面通知（design 19 §3.3）：渲染端检测会话边沿并组装 payload → notify
    // （invoke，返回是否实际显示）→ 主进程白名单/去重/裁决 + 原生通知。click →
    // notification-open 推送 → 渲染端 openSession（既有路径）。
    ipcMain.handle(IPC_CHANNELS.NOTIFY, trustedIpc(({ payload }) => maybeShowNativeNotification(payload)));
    // Renderer 通知就绪信号（design 19 §3.3）：onOpen 监听注册后调用——通知点击
    // 的推送只在就绪后放行（did-finish-load 早于监听注册，见 drain 条件）。
    // 返回 true 与 preload 的 Promise<boolean> 声明一致（成功置位信号）。
    ipcMain.handle(IPC_CHANNELS.NOTIFICATIONS_READY, trustedIpc(() => {
      notificationOpenDrainReady = true;
      const drainAccepted = drainPendingNotificationOpens?.() ?? true;
      // A send race revokes ready inside the drain. Returning false makes the
      // renderer's bounded readiness retry establish the next handshake.
      return drainAccepted && notificationOpenDrainReady;
    }));
    ipcMain.handle(IPC_CHANNELS.NOTIFICATION_OPEN_ACK, trustedIpc((payload: unknown) => {
      if (payload === null || typeof payload !== 'object') return false;
      const { deliveryId, attempt } = payload as { deliveryId?: unknown; attempt?: unknown };
      return pendingNotificationOpens.acknowledge(deliveryId as number, attempt as number);
    }));
    // Deep-link renderer readiness (design 16 hold/replay): App invokes this
    // only after installing deepLink.onIntent. Successful cold-start launches
    // held before that point are replayed now; navigation/crash resets the bit.
    ipcMain.handle(IPC_CHANNELS.DEEP_LINK_READY, trustedIpc(() => {
      deepLinkRendererReady = true;
      const drainAccepted = drainPendingRendererDeepLinkIntents();
      return drainAccepted && deepLinkRendererReady;
    }));
    ipcMain.handle(IPC_CHANNELS.DEEP_LINK_ACK, trustedIpc((payload: unknown) => {
      if (payload === null || typeof payload !== 'object') return false;
      const { deliveryId, attempt } = payload as { deliveryId?: unknown; attempt?: unknown };
      return pendingRendererIntents.acknowledge(deliveryId as number, attempt as number);
    }));

    // OS 唤醒即时重探 + 推送（design 14 D4）：主进程对 error/degraded 实例
    // 立即重探（绝不触碰 idle），并向渲染端 push（dsh 前端连接立即重连）。
    powerMonitor.on('resume', () => {
      lastResume = Date.now();
      const win = mainWindow;
      const heldResume = lastResume;
      if (win !== null && heldResume !== null && pushHeldSystemResume(win, heldResume)) {
        // 窗口存活（含隐藏）已即时收到：清空 held 值，避免 hide→show 补发过期事件。
        if (lastResume === heldResume) lastResume = null;
      }
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
      path.join(app.getPath('userData'), 'ssh-passwords.json'),
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
    if (gatewaySecretsCrypto === undefined) {
      // S22 (design 17 §13.4.1): the OS keychain is unavailable — the store
      // falls back to the documented 0600 plaintext mirror. LOUD registration
      // (never silent) AND a renderer-visible read-only projection
      // (instances_get merges secretStorage: 'plaintext') so the settings
      // page shows the fallback path.
      console.warn('[dsh-chamber] OS keychain (Electron safeStorage) is unavailable — gateway credentials will be mirrored to the 0600 plaintext file fallback (design 17 §12/S22)');
    }
    const gatewaySecretNotice = configureGatewaySecretStore(
      path.join(app.getPath('userData'), 'gateway-secrets.json'),
      gatewaySecretsCrypto,
      resolveCredentialSpec,
    );
    if (gatewaySecretNotice !== null) console.error(`[dsh-chamber] gateway secrets store: ${gatewaySecretNotice}`);
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
    const auditLogPath = path.join(app.getPath('userData'), 'audit-log.jsonl');
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
      instancesFile: path.join(app.getPath('userData'), 'ssh-instances.json'),
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
      const file = path.join(app.getPath('userData'), 'ssh-instances.json');
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
    type ProjectedTransportInstanceSpec = TransportInstanceSpec & { sourceFingerprint: string }
    const notificationSourceProofs = new NotificationSourceProofs();
    const projectRemoteInstances = (instances: readonly TransportInstanceSpec[]): ProjectedTransportInstanceSpec[] =>
      notificationSourceProofs.replaceRemoteInstances(instances);
    const syncNotificationSources = (instances: readonly ProjectedTransportInstanceSpec[]): string[] =>
      notificationSourceIncarnations.replaceRemoteSources(instances.map(instance => ({
        sourceId: `${instance.kind}-${instance.id}`,
        fingerprint: instance.sourceFingerprint,
      })));
    // Native notifications can be requested only for sources in the loaded
    // authoritative registry. This also establishes the initial incarnation
    // before the notify IPC handler can run.
    syncNotificationSources(projectRemoteInstances(sm.listInstances()));
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
    ];
    type RemoteTarget = {
      spec: RemoteSpec
      fingerprint: string
      sourceToken: NotificationSourceToken
    }
    const findRemoteTarget = (id: string): RemoteTarget | null => {
      const instance = sm.listInstances().find((entry) => entry.id === id);
      if (instance === undefined || instance.kind !== 'dsh' || instance.transport !== 'ssh') return null;
      const sourceToken = notificationSourceIncarnations.capture(`${instance.kind}-${instance.id}`);
      if (sourceToken === null) return null;
      return {
        spec: { id: instance.id, remoteDshHome: instance.remoteDshHome ?? null },
        fingerprint: operationalFingerprint(instance),
        sourceToken,
      };
    };
    const ownsRemoteTarget = (target: RemoteTarget): boolean =>
      notificationSourceIncarnations.owns(target.sourceToken)
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
      return [
        { name: '@dsh-chamber/dsh-host-client-graph', packageJsonPath: path.join(graphDir, 'package.json'), distIndexPath: path.join(graphDir, 'dist', 'index.js') },
        { name: '@dsh-chamber/dsh-host-git-worktree', packageJsonPath: path.join(gitDir, 'package.json'), distIndexPath: path.join(gitDir, 'dist', 'index.js') },
      ];
    };
    const syncGatewayChamberPluginsFor = (id: string, url: string, headers: Record<string, string>, spkiPin: string | null): void => {
      const instance = sm.listInstances().find(candidate => candidate.id === id);
      if (instance === undefined || instance.kind !== 'gateway') return;
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
      void syncGatewayChamberPlugins({
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
              syncGatewayChamberPluginsFor(id, url, auth.headers, facts.spkiPin ?? null);
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
          statusWindow.webContents.send(IPC_CHANNELS.SSH_STATUS_CHANGED, { id, status });
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

    /**
     * Read-time NON-SECRET projections merged onto the registry list (design
     * 17 §2.3/§9.1/§13.4.1): sshPasswordSet/tokenSet/passwordSet are boolean
     * existence markers from the main-process credential stores (never a secret VALUE,
     * never persisted — the registry stays credential-free metadata), and
     * secretStorage is the credential mirror's storage mode ('safeStorage' =
     * OS-keychain-encrypted blobs, 'plaintext' = the documented 0600 fallback,
     * S22). Gateway markers are target-owned; sshPasswordSet is true only for
     * rows currently using the SSH transport.
     */
    const projectInstanceSecrets = (instance: TransportInstanceSpec) => ({
      ...instance,
      sshPasswordSet: instance.transport === 'ssh' && getSshPassword(instance.id) !== null,
      tokenSet: instance.kind === 'gateway' && getGatewayToken(instance.id) !== null,
      passwordSet: instance.kind === 'gateway' && getGatewayPassword(instance.id) !== null,
      secretStorage: gatewaySecretStorageMode(),
    });

    const projectInstances = (instances: readonly TransportInstanceSpec[]) =>
      projectRemoteInstances(instances).map(projectInstanceSecrets);

    /**
     * Finish every committed registry transition through the main-branch
     * source-lifecycle authority. Metadata/secret persistence is owned by the
     * transaction; this sidecar rotates renderer/native-notification proofs,
     * revokes exact plugin-seed owners, and publishes the committed roster.
     */
    const publishRegistryTransition = (
      before: readonly TransportInstanceSpec[],
      after: readonly TransportInstanceSpec[],
    ) => {
      const projected = projectRemoteInstances(after);
      if (JSON.stringify(before) === JSON.stringify(after)) {
        return projected.map(projectInstanceSecrets);
      }
      const projectedSaved = projected.map(projectInstanceSecrets);

      const removedIds = computeRemovedInstanceIds(before, after);
      const retiredIds = computeRetiredInstanceIds(before, after);
      const afterById = new Map(after.map(instance => [instance.id, instance]));
      const reseedIds: string[] = [];
      for (const previous of before) {
        const current = afterById.get(previous.id);
        if (current === undefined || operationalFingerprint(previous) !== operationalFingerprint(current)) {
          readySeedEdges.forget(previous.id);
          hostPackageSeeding.revoke(previous.id);
          if (current?.kind === 'dsh' && current.transport === 'ssh') reseedIds.push(previous.id);
        }
      }

      const retiredNotificationSources = new Set(syncNotificationSources(projected));
      if (retiredNotificationSources.size > 0) {
        pendingNotificationOpens.discardWhere(intent => retiredNotificationSources.has(intent.sourceId));
        pendingRendererIntents.discardWhere(intent => retiredNotificationSources.has(intent.sourceId));
        for (const [notification, token] of activeNotifications) {
          if (token === null || !retiredNotificationSources.has(token.sourceId)) continue;
          activeNotifications.delete(notification);
          try { notification.close(); } catch { /* best-effort stale banner retirement */ }
        }
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
          registryWindow.webContents.send(IPC_CHANNELS.SSH_INSTANCES_CHANGED, { removedIds, retiredIds });
        });
        if (!pushed.sent) {
          console.warn(`[dsh-chamber] registry 已保存但 lifecycle push 失败（等待 renderer 重拉）：${pushed.error}`);
        }
      }
      return projectedSaved;
    };

    ipcMain.handle(IPC_CHANNELS.SSH_INSTANCES_GET, trustedIpc(() =>
      projectInstances(sm.listInstances())
    ));
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
    ipcMain.handle(IPC_CHANNELS.SSH_SAVE_CONNECTION, trustedIpc((payload) => {
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
          return refuse('SSH password auth is not supported on this platform yet — use a key or ssh-agent');
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
    }));
    ipcMain.handle(IPC_CHANNELS.SSH_DELETE_CONNECTION, trustedIpc(({ id }) => {
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
    }));
    ipcMain.handle(IPC_CHANNELS.SSH_INSTANCES_SET, trustedIpc((instances) => {
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
    }));
    // Legacy explicit SSH-password CLEAR action. Non-empty writes are owned
    // exclusively by desktop_ssh_save_connection so metadata + all credential
    // domains share one compensated transaction.
    ipcMain.handle(IPC_CHANNELS.SSH_SET_PASSWORD, trustedIpc(({ id, password }) => {
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
    }));
    // Legacy explicit gateway-token CLEAR action. Non-empty writes use the
    // authoritative save_connection transaction above.
    ipcMain.handle(IPC_CHANNELS.GATEWAY_SET_TOKEN, trustedIpc(({ id, token }) => {
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
    }));
    // Legacy explicit gateway-password CLEAR action. It also invalidates the
    // corresponding cached sessions; non-empty writes use save_connection.
    ipcMain.handle(IPC_CHANNELS.GATEWAY_SET_PASSWORD, trustedIpc(({ id, password }) => {
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
    }));
    // ~/.ssh/config discovery (design 05 §5): non-secret host projections
    // only (alias/hostName/user/port) — keys/proxies/credentials never leave
    // the main process.
    ipcMain.handle(IPC_CHANNELS.SSH_CONFIG_LIST, trustedIpc(() => discoverSshConfigHosts()));
    ipcMain.handle(IPC_CHANNELS.SSH_CONNECT, trustedIpc(({ id }) => sm.connect(id)));
    ipcMain.handle(IPC_CHANNELS.SSH_DISCONNECT, trustedIpc(({ id }) => {
      sm.disconnect(id);
      return sm.status(id);
    }));
    ipcMain.handle(IPC_CHANNELS.SSH_STATUS, trustedIpc(({ id }) => sm.status(id)));
    // On-demand ready-state re-verification (user activation of a source/
    // session): one immediate identity probe for a READY transport — a dead
    // gateway session or remote endpoint flips the phase within one probe
    // round-trip instead of waiting for the periodic heartbeat (transport-
    // manager reverify; see READY_VERIFY_INTERVAL_MS).
    ipcMain.handle(IPC_CHANNELS.SSH_REVERIFY, trustedIpc(({ id }) => sm.reverify(id)));
    ipcMain.handle(IPC_CHANNELS.SSH_LOGS, trustedIpc(({ id }) => sm.logs(id)));
    ipcMain.handle(IPC_CHANNELS.SSH_LOGS_CLEAR, trustedIpc(({ id }) => sm.clearLogs(id)));
    // Provider exec channel (design 05 §7.4, ssh: remote systemd): the fresh
    // status projection on success (serviceActive included), {error} on
    // failure — loud, never a silent empty success, never an unhandled
    // rejection.
    ipcMain.handle(IPC_CHANNELS.SSH_START_SERVICE, trustedIpc(({ id }) =>
      sm.exec(id, 'start').then(result => (result.ok ? result.status : { error: result.error })).catch(err => ({ error: `exec failed: ${describeUnknownError(err)}` })),
    ));
    ipcMain.handle(IPC_CHANNELS.SSH_STOP_SERVICE, trustedIpc(({ id }) =>
      sm.exec(id, 'stop').then(result => (result.ok ? result.status : { error: result.error })).catch(err => ({ error: `exec failed: ${describeUnknownError(err)}` })),
    ));
    ipcMain.handle(IPC_CHANNELS.SSH_IS_ACTIVE, trustedIpc(({ id }) =>
      sm.exec(id, 'is-active').then(result => (result.ok ? result.status : { error: result.error })).catch(err => ({ error: `exec failed: ${describeUnknownError(err)}` })),
    ));
    // Plugin management surface (design 13 M2+M3, contract B): restart the remote
    // service, read the remote/local plugin manifests, apply a plugin-set change,
    // and best-effort npm search (main-process fetch; the renderer stays on
    // 127.0.0.1). All handlers go through the trustedIpc fence and resolve loud
    // {error} / {ok:...} shapes — never a silent empty success, never an
    // unhandled rejection. renderer-supplied specs are re-validated inside
    // applyPlugins (defense in depth).
    ipcMain.handle(IPC_CHANNELS.SSH_RESTART_SERVICE, trustedIpc(({ id }) =>
      execTransport(id, 'restart').then(result =>
        (result.ok ? (result.status ?? { error: 'restart completed but no status projection' }) : { error: result.error }),
      ).catch(err => ({ error: `exec failed: ${describeUnknownError(err)}` })),
    ));
    ipcMain.handle(IPC_CHANNELS.SSH_PLUGIN_LIST, trustedIpc(async ({ id }) => {
      const target = findRemoteTarget(id);
      if (target === null) return { ok: false, error: 'ssh instance not found' };
      return runWithFinalOwnership(
        () => ownsRemoteTarget(target),
        () => remotePluginList(scopedExecForTarget(target), target.spec, {
          liveProbe: scopedProbeForTarget(target, liveProbeFor(id)),
          gitWorktreeLiveProbe: scopedProbeForTarget(target, gitWorktreeLiveProbeFor(id)),
        }),
      );
    }));
    ipcMain.handle(IPC_CHANNELS.SSH_PLUGIN_APPLY, trustedIpc(async ({ id, add, remove, restart }) => {
      const target = findRemoteTarget(id);
      if (target === null) return { ok: false, error: 'ssh instance not found' };
      // A non-boolean `restart` (e.g. the string 'false') must never be
      // treated as truthy and trigger an unwanted restart — refused here
      // before any exec (applyPlugins re-checks too, defense in depth).
      if (restart !== undefined && typeof restart !== 'boolean') {
        return { ok: false, error: 'restart must be a boolean' };
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
          { knownBundles, ownershipKey: `${target.sourceToken.generation}:${target.fingerprint}` },
        ),
      );
    }));
    ipcMain.handle(IPC_CHANNELS.LOCAL_PLUGIN_LIST, trustedIpc(() => {
      try {
        return { ok: true, manifest: localPluginList(localDshHome) };
      } catch (error) {
        return { ok: false, error: describeUnknownError(error) };
      }
    }));
    ipcMain.handle(IPC_CHANNELS.NPM_SEARCH, trustedIpc(async ({ query }) => {
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
    }));

    // Host-graph seed + materialize + local plugin exec (design 13 M4): the M2
    // orchestration functions that were implemented but not yet wired. Seed
    // installs module A onto the remote (09 遗留 1); materialize packs a local
    // plugin dir and installs it remotely — the ADD view goes through
    // materialize_add_pick (folder picker in MAIN, pick-only), the sync view
    // through materialize_add (dir resolved from the local manifest, validated
    // here as absolute + directory); local add/remove run `dsh plugin` against
    // the LOCAL dsh home (05 §5.1).
    ipcMain.handle(IPC_CHANNELS.SSH_SEED_HOST_GRAPH, trustedIpc(async ({ id }) => {
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
    }));
    // materialize_add (sync view): renderer supplies only the dependency NAME.
    // Main re-reads the authoritative local manifest and resolves/canonicalizes
    // its path; an IPC caller can never choose an arbitrary local directory.
    ipcMain.handle(IPC_CHANNELS.SSH_PLUGIN_MATERIALIZE_ADD, trustedIpc(async ({ id, name }) => {
      const target = findRemoteTarget(id);
      if (target === null) return { ok: false, error: 'ssh instance not found' };
      if (typeof name !== 'string') return { ok: false, error: 'invalid plugin name' };
      const resolved = resolveLocalMaterializeDirectory(localDshHome, name);
      if (!resolved.ok) return resolved;
      return runWithFinalOwnership(
        () => ownsRemoteTarget(target),
        () => materializeAndAdd(scopedExecForTarget(target), target.spec, resolved.path),
      );
    }));
    // materialize_add_pick (add view): PICK-ONLY — the folder picker runs here in
    // the main process, so a compromised renderer can never drive the pack surface
    // to an arbitrary local directory (design 13 §5.8 hardening).
    ipcMain.handle(IPC_CHANNELS.SSH_PLUGIN_MATERIALIZE_ADD_PICK, trustedIpc(async ({ id }) => {
      const target = findRemoteTarget(id);
      if (target === null) return { ok: false, error: 'ssh instance not found' };
      if (mainWindow === null || mainWindow.isDestroyed()) return { ok: false, error: 'no main window' };
      const picked = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
      if (picked.canceled || picked.filePaths.length === 0) return { ok: true, cancelled: true };
      if (!ownsRemoteTarget(target)) return { ok: false, error: 'ssh instance changed while folder selection was open' };
      return runWithFinalOwnership(
        () => ownsRemoteTarget(target),
        () => materializeAndAdd(scopedExecForTarget(target), target.spec, picked.filePaths[0]),
      );
    }));
    ipcMain.handle(IPC_CHANNELS.LOCAL_PLUGIN_ADD_FILE, trustedIpc(async () => {
      if (mainWindow === null || mainWindow.isDestroyed()) return { ok: false, error: 'no main window' };
      const picked = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
      if (picked.canceled || picked.filePaths.length === 0) return { ok: true, cancelled: true };
      return runLocalPluginMutation('plugin:add-file', async (dshWorkspace) => {
        const result = await runLocalDshPlugin(dshWorkspace, localDshHome, 'add', `file:${picked.filePaths[0]}`);
        return result.ok ? { ok: true } : { ok: false, error: result.error ?? 'local add failed' };
      });
    }));
    ipcMain.handle(IPC_CHANNELS.LOCAL_PLUGIN_ADD, trustedIpc(async ({ spec: specArg }) => {
      // `file:` imports must go through the main-process folder picker
      // (desktop_local_plugin_add_file); this spec channel only accepts registry
      // specs so a compromised renderer can never drive the local pack surface
      // to an arbitrary directory (design 13 §5.8 hardening).
      if (typeof specArg === 'string' && specArg.startsWith('file:')) {
        return { ok: false, error: 'local file imports must use the folder picker' };
      }
      // User confirmation (design 09 §4 v1 mitigation): installing a registry
      // package into the LOCAL profile creates a persistent execution surface
      // on the next local boot — never a silent script action.
      const confirm = await confirmPluginAction(mainWindow, describeLocalPluginAddConfirmation(specArg));
      if ('cancelled' in confirm) return { ok: true, cancelled: true };
      if (!confirm.ok) return { ok: false, error: confirm.error };
      return runLocalPluginMutation('plugin:add', async (dshWorkspace) => {
        const result = await runLocalDshPlugin(dshWorkspace, localDshHome, 'add', specArg);
        return result.ok ? { ok: true } : { ok: false, error: result.error ?? 'local add failed' };
      });
    }));
    ipcMain.handle(IPC_CHANNELS.LOCAL_PLUGIN_REMOVE, trustedIpc(async ({ name }) => {
      if (typeof name !== 'string' || name === '') return { ok: false, error: 'invalid plugin name' };
      // User confirmation (design 09 §4 v1 mitigation): removal is destructive
      // — a page script must not be able to wipe the local profile silently.
      const confirm = await confirmPluginAction(mainWindow, describeLocalPluginRemoveConfirmation(name));
      if ('cancelled' in confirm) return { ok: true, cancelled: true };
      if (!confirm.ok) return { ok: false, error: confirm.error };
      return runLocalPluginMutation('plugin:remove', async (dshWorkspace) => {
        const result = await runLocalDshPlugin(dshWorkspace, localDshHome, 'remove', name);
        return result.ok ? { ok: true } : { ok: false, error: result.error ?? 'local remove failed' };
      });
    }));

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
      if (!notificationSourceIncarnations.matches(sourceId, req.sourceFingerprint)) {
        return { ok: false, error: 'source changed before open-in request was accepted' };
      }
      const sourceToken = captureVscodeSource(req.instanceId);
      if (sourceToken === null) return { ok: false, error: 'source not found' };
      const ownsSource = () => notificationSourceIncarnations.owns(sourceToken);
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
      // 深链路径对齐）；finder 无对应激活语义。窗口未就绪也不丢，renderer
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
    // (autoInstallOnAppQuit): no dialog, no mid-session interruption. The
    // state projection is non-secret only (versions / channel / release URL /
    // short error text) and every failure is silent (main-process log), never
    // blocking startup — the settings section renders the honest state.
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
          updateWindow.webContents.send(IPC_CHANNELS.UPDATE_STATE_CHANGED, updateState);
        });
        if (!pushed.sent) {
          try { console.warn(`[dsh-chamber] updater 状态 push 失败（等待 renderer 重拉）：${pushed.error}`); } catch { /* callback boundary */ }
        }
      }
    });
    ipcMain.handle(IPC_CHANNELS.UPDATE_STATE, trustedIpc(() => updater.state()));
    ipcMain.handle(IPC_CHANNELS.UPDATE_CHECK, trustedIpc(() => updater.checkNow()));
    ipcMain.handle(IPC_CHANNELS.UPDATE_DOWNLOAD, trustedIpc(() => updater.download()));
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
          runtimeDiskSummary: (b) => runtimeDiskSummary(b),
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
        mainWindow.webContents.send(IPC_CHANNELS.RUNTIME_STATE_CHANGED, state);
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
      try {
        const diskUsage = runtimeDiskSummary(runtimeBaseDir);
        diskProjection = {
          diskUsage,
          diskError: null,
          diskLimitBytes: DEFAULT_RUNTIME_LOGICAL_DISK_LIMIT_BYTES,
          diskLimitExceeded: diskUsage.totalBytes >= DEFAULT_RUNTIME_LOGICAL_DISK_LIMIT_BYTES,
          explicitlyInstalledVersions: listExplicitlyInstalledVersions(runtimeBaseDir),
        };
      } catch (error) {
        diskProjection = {
          diskUsage: null,
          diskError: sanitizeErrorText(error instanceof Error ? error.message : String(error)),
          diskLimitBytes: DEFAULT_RUNTIME_LOGICAL_DISK_LIMIT_BYTES,
          diskLimitExceeded: null,
          explicitlyInstalledVersions: [],
        };
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
      const active = resolveActiveRuntime(runtimeBaseDir);
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

    const pruneRuntimeSnapshots = async () => {
      // Retention evidence and deletion must be one transaction. Otherwise a
      // new activation can publish a journal/snapshot after this function
      // reads the protected set but before it deletes the old tail.
      const lease = await runtimeWriterFence.acquire('maintenance:snapshot-prune');
      try {
        const artifactCleanup = await cleanupSnapshotArtifacts(runtimeBaseDir, localDshHome);
        if (artifactCleanup.removedTemporaryEntries.length > 0
          || artifactCleanup.removedRestoreBackups.length > 0) {
          console.log(
            `[dsh-chamber] runtime snapshot cleanup removed ${artifactCleanup.removedTemporaryEntries.length} temporary entr${artifactCleanup.removedTemporaryEntries.length === 1 ? 'y' : 'ies'} and ${artifactCleanup.removedRestoreBackups.length} completed restore backup(s)`,
          );
        }
        if (artifactCleanup.restoreBackupCleanup !== 'completed') {
          console.warn(`[dsh-chamber] runtime restore-backup cleanup skipped: ${artifactCleanup.restoreBackupCleanup}`);
        }
        if (artifactCleanup.restoreBackupCleanup === 'blocked-marker') return;
        const retention = runtimeSnapshotRetentionState(runtimeBaseDir);
        if (retention.kind === 'corrupt') return;
        await pruneSnapshots(runtimeBaseDir, {
          protectedVersions: retention.protectedVersions,
          protectedSnapshotNames: retention.protectedSnapshotNames,
          keepRecentUnprotected: 3,
        });
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
        const pendingBefore = overrideBefore.kind === 'valid' && overrideBefore.record.invalidatedAt == null
          ? overrideBefore.record.pending
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

        const hardBlockedReasons = new Set([
          'journal-corrupt',
          'current-corrupt',
          'override-corrupt',
          'journal-mismatch',
        ]);
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
        void pruneRuntimeSnapshots().catch(error => {
          console.error('[dsh-chamber] dsh runtime snapshot prune failed:', sanitizeErrorText(error instanceof Error ? error.message : String(error)));
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
        void pruneRuntimeSnapshots().catch(error => {
          console.error('[dsh-chamber] dsh runtime snapshot prune failed:', sanitizeErrorText(error instanceof Error ? error.message : String(error)));
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
      const overridePending = overrideState.kind === 'valid'
        && !envOverrideActive
        && overrideState.record.shellVersion === version
        && overrideState.record.invalidatedAt == null
        ? overrideState.record.pending
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
    // renderer hold/replay 队列，直到 onIntent + ready 握手完成。失败 loud
    // （对话框 + 日志）。quit 在途的新深链已在 enqueueDeepLink 被 ignore。
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
            if (result.ok && sourceToken !== null && notificationSourceIncarnations.owns(sourceToken)) {
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

    // 通知打开事件统一 drain（design 19 §3.3，retain-until-ACK）：窗口
    // 存在、已完成加载且 renderer 已就绪（onOpen 监听注册后经
    // dsh-chamber:notifications-ready 置位）→ 直接推送；任一条件不满足 → 重新
    // hold，did-finish-load / ready IPC 后再补发。send 返回只转为 in-flight，renderer
    // 精确 ACK deliveryId+attempt 后才消费；reload/crash 会重发所有未 ACK 项。
    drainPendingNotificationOpens = () => {
      if (drainingNotificationOpens) return true;
      const win = mainWindow;
      const destroyed = win === null || win.isDestroyed();
      if (
        !notificationOpenDrainReady
        || win === null
        || mainWindow !== win
        || destroyed
        || win.webContents.isLoading()
        || win.webContents.isCrashed()
      ) return true;
      drainingNotificationOpens = true;
      try {
        for (;;) {
          if (quitRequested) return true;
          const delivery = pendingNotificationOpens.shift();
          if (delivery === null) return true;
          try {
            // Re-check every item: Electron can synchronously tear down/replace
            // a window while send() crosses the native boundary.
            if (
              mainWindow !== win
              || win.isDestroyed()
              || win.webContents.isLoading()
              || win.webContents.isCrashed()
            ) throw new Error('notification renderer changed while draining');
            win.webContents.send(IPC_CHANNELS.NOTIFICATION_OPEN, {
              sourceId: delivery.payload.sourceId,
              sourceFingerprint: delivery.payload.sourceFingerprint,
              sessionId: delivery.payload.sessionId,
              deliveryId: delivery.deliveryId,
              attempt: delivery.attempt,
            });
            // Deliberately retain in-flight ownership until renderer ACK.
          } catch (error) {
            const restored = pendingNotificationOpens.rollback(delivery);
            if (!restored && mainWindow === win) {
              console.error(`[dsh-chamber] 通知打开事件回滚失败：delivery=${delivery.deliveryId}`);
            }
            // Only the window whose send failed may lose its handshake. A stale
            // callback must not clobber readiness already established by a newer
            // BrowserWindow.
            if (mainWindow === win) notificationOpenDrainReady = false;
            console.error('[dsh-chamber] 通知打开推送失败，等待 renderer 重试：', describeUnknownError(error));
            return false;
          }
        }
      } finally {
        drainingNotificationOpens = false;
      }
    };
    drainPendingNotificationOpens();
  });
}
