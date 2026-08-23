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
 * - Transport manager (transport-manager.ts + the `ssh` provider in
 *   ssh-provider.ts, design 03 §2.2): persisted instance registry
 *   (<userData>/ssh-instances.json), transport lifecycle, remote systemd
 *   exec (start/stop/is-active).
 * - Transport registration: ready transport → registerInstanceTransport
 *   ('<kind>:<id>', readyUrl); leaving ready → unregisterInstanceTransport.
 *   (design 03 §2.2, driven by transport-manager + the `ssh` provider's
 *   tunnel phase).
 * - IPC (preload whitelist, design 05 §7.4): dsh-chamber:info, the
 *   desktop_ssh_* surface incl. start/stop/is-active, status pushes.
 * - Tray (packaged only, defensive), single-instance lock.
 */

import { app, BrowserWindow, crashReporter, dialog, ipcMain, Menu, Tray, nativeImage, powerMonitor, powerSaveBlocker, session, shell } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PlaneHandle } from '@dsh-chamber/control-plane';
import { createTransportManager } from './transport-manager.ts';
import { INSTANCE_ID_PATTERN } from './transport-manager.ts';
import type { TransportManager } from './transport-manager.ts';
import { MAX_SSH_PASSWORD_CHARS, sshProvider, probeClientGraphLive, probeGitWorktreeLive } from './ssh-provider.ts';
import { cleanupStaleAskpassHelpers, configureSshPasswordStore, setSshPassword, sshPasswordSupported } from './ssh-provider.ts';
import { discoverSshConfigHosts } from './ssh-config.ts';
import { isTrustedIpcSender, isTrustedRendererUrl } from './renderer-trust.ts';
import { detectVscodeAvailability, parseOpenVscodeIntent, runVscodeLaunch } from './deep-link.ts';
import type { VscodeLaunchContext, VscodeLaunchRequest } from './deep-link.ts';
import { createUpdateController } from './updater.ts';
import { DEFAULT_RUNTIME_LOGICAL_DISK_LIMIT_BYTES, DshRuntimeController } from './dsh-runtime-controller.ts';
import type { RuntimeMetadataComponent, RuntimeMetadataHealthProjection } from './dsh-runtime-controller.ts';
import { fetchRegistryMetadata } from './registry-metadata.ts';
import { isAllowedRegistryUrl } from './registry-url.ts';
import { sanitizeErrorText } from './sanitize-error.ts';
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
import type { ActivationJournal, ActivationJournalState } from './dsh-runtime-store.ts';
import {
  cleanupSnapshotArtifacts,
  completeInterruptedRestore,
  prepareManualRollbackData,
  pruneSnapshots,
  resolveSnapshotName,
  restoreMarkerAuthorityStatus,
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
  disposeLocalPluginChildren,
  GIT_WORKTREE_INSERT_ID,
  GIT_WORKTREE_PACKAGE_NAME,
  localPluginList,
  materializeAndAdd,
  remoteHome,
  remotePluginList,
  reapStaleLocalPluginWriters,
  resolveLocalMaterializeDirectory,
  runLocalDshPlugin,
  seedRemoteChamberHostPackages,
} from './plugin-sync.ts';
import type { ChamberHostPackageSeed, ExecFn, StatusFn, RemoteSpec } from './plugin-sync.ts';
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

// Last-resort crash boundary. Expected socket/stream failures are handled at
// their owners; an unknown uncaught exception means the privileged main
// process may be inconsistent and must fail closed rather than keep serving
// IPC, transports and persistence from an indeterminate state.
let fatalExceptionInProgress = false;
process.on('uncaughtException', (error) => {
  console.error('[dsh-chamber] fatal uncaught exception:', error instanceof Error ? error.stack : String(error));
  if (fatalExceptionInProgress) {
    process.abort();
    return;
  }
  fatalExceptionInProgress = true;
  app.exit(1);
});
process.on('unhandledRejection', (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  process.emit('uncaughtException', error, 'unhandledRejection');
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

// 打包态导入编译产物（Node 类型擦除不覆盖 node_modules，workspace 包的 TS
// 源码无法在 asar 内运行）；开发态走 workspace 符号链接直接运行源码。类型
// 以源码包为准（编译产物由 build:control-plane 生成，产物缺省时类型检查不
// 可依赖它）。
const CONTROL_PLANE_ENTRY = path.join(pkgDir, 'dist', 'control-plane', 'index.js');
const controlPlaneEntrySpecifier = './dist/control-plane/index.js';
const controlPlaneModule: typeof import('@dsh-chamber/control-plane') = await (app.isPackaged
  ? import(controlPlaneEntrySpecifier)
  : import('@dsh-chamber/control-plane'));
const { call, createControlPlane } = controlPlaneModule;

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

/**
 * Open-external allowlist for the settings「前往下载页」link (design 11 §7):
 * only this repo's GitHub pages may ever be opened. Parsed with URL (not a
 * startsWith string check) so scheme/host/path-root are pinned exactly.
 *
 * Two extra defenses (2026-08 review):
 * - `new URL` does NOT decode percent-encoded path segments, so an encoded
 *   `..%2f..%2f` traversal would pass a raw pathname prefix check yet land on
 *   an arbitrary github.com path (the browser decodes on request). Decode the
 *   pathname and re-normalize through a fresh URL before the prefix check.
 * - userinfo (`https://user:pass@github.com/...`) is ignored by `origin`;
 *   reject any non-empty username/password so the allowlist can never be
 *   pointed at a credentialed github.com URL.
 */
function isAllowedReleaseUrl(raw: unknown): boolean {
  if (typeof raw !== 'string') return false;
  try {
    const url = new URL(raw);
    if (url.origin !== 'https://github.com') return false;
    if (url.username !== '' || url.password !== '') return false;
    // Decode + re-normalize the pathname: an encoded traversal then normalizes
    // like a literal one and fails the prefix check instead of escaping it.
    const normalized = new URL(`https://github.com${decodeURIComponent(url.pathname)}`).pathname;
    return normalized.startsWith('/panzeyu2013/dsh-chamber/');
  } catch {
    return false;
  }
}

let mainWindow: BrowserWindow | null = null;
let controlPlane: PlaneHandle | null = null;
let transportManager: TransportManager | null = null;
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
// second-instance argv / 冷启动 argv）统一入 pendingIntents 队列，startup 完成
// （transportManager 装载 + 主窗口就绪）后统一 drain。seenDeepLinkUrls 去重
// （macOS open-url 与 argv 双触发同一 URL）；超过 64 条整体清空防无限增长
// （非 LRU——清空后同 URL 可重放，打开 VS Code 幂等，无害；security-review
// P2-4 注释与实现语义对齐）。
// drainPendingIntents 在 whenReady 内赋值（依赖 wiredCtx/transportManager），
// 冷启动到达的深链只入队、drain 就绪后消费。
let pendingIntents: VscodeLaunchRequest[] = [];
const seenDeepLinkUrls = new Set<string>();
let drainPendingIntents: (() => void) | null = null;

/** 扫描 argv 中的 dsh-chamber:// 深链（防御式：非深链 argv 零副作用、绝不 throw）。 */
function scanDeepLinkUrls(argv: readonly string[]): string[] {
  const urls: string[] = [];
  for (const arg of argv) {
    if (typeof arg === 'string' && arg.startsWith('dsh-chamber://')) urls.push(arg);
  }
  return urls;
}

/** 深链入队：quit 在途 ignore（不启动 VS Code）；同 URL 去重；解析失败 loud。 */
function enqueueDeepLink(rawUrl: string): void {
  if (quitRequested) return;
  if (seenDeepLinkUrls.has(rawUrl)) return;
  seenDeepLinkUrls.add(rawUrl);
  if (seenDeepLinkUrls.size > 64) seenDeepLinkUrls.clear();
  const parsed = parseOpenVscodeIntent(rawUrl);
  if (!parsed.ok) {
    console.error(`[dsh-chamber] 深链解析失败：${parsed.error}`);
    return;
  }
  pendingIntents.push(parsed.intent);
  drainPendingIntents?.();
}

/** 退出清理（will-quit：transport dispose + 控制面 stop）的最长等待；超时强制
 *  退出，防「窗口已关、主进程永久滞留」的半退出态。子进程回收用短窗口
 *  （transport 1s / 本地 dsh 1s → SIGKILL）+ 传输层与控制面并行化，正常
 *  ~1-2s 完成；5s 硬顶仅为异常路径（如残留连接使 server.close 不回调）兜底
 *  （2026-08 排查；2026-08 提速，15s → 5s）。 */
const QUIT_CLEANUP_TIMEOUT_MS = 5_000;
// Update controller ref (created in whenReady): the quit-confirmation exemption
// (design 14 D2) reads its state at will-quit time.
let updateController: { state(): { phase: string; installBlockedReason: string | null } } | null = null;
// dsh runtime version controller (design 16 M2): module-level ref so the
// settings「dsh 运行时」block's install/check/reset always reach the same
// instance; state pushes go to the (single) main window.
let runtimeController: DshRuntimeController | null = null;
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
    console.warn('[dsh-chamber] 托盘创建失败，跳过：', String(error));
  }
}

/**
 * 深链协议注册（design 16 §4.3）：`app.isPackaged` 门控——开发态注册会把裸
 * Electron 注册成 scheme handler，污染 LaunchServices，与打包版 bundle id
 * （com.dshchamber.desktop）冲突（镜像托盘先例）。win32 首版门控（暂缓一致性，
 * 镜像 ssh 密码 askpass 门控）；linux 需显式 execPath + relaunch args
 * （Electron 文档）；macOS 打包版由 electron-builder `protocols` 键自动生成
 * CFBundleURLTypes，此处 setAsDefaultProtocolClient 兜底。失败 loud，绝不
 * 打断启动。
 */
function registerDeepLinkProtocol(): void {
  if (!app.isPackaged || process.platform === 'win32') return;
  try {
    if (process.platform === 'linux') {
      const relaunchArgs = process.argv.length >= 2 ? [path.resolve(process.argv[1])] : [];
      app.setAsDefaultProtocolClient('dsh-chamber', process.execPath, relaunchArgs);
    } else {
      app.setAsDefaultProtocolClient('dsh-chamber');
    }
  } catch (error) {
    console.error('[dsh-chamber] 深链协议注册失败：', error);
  }
}

/**
 * 显示/恢复主窗口；窗口已不存在（被关闭）时按控制面 origin 重建。Dock
 * 图标点击（macOS activate）、二次启动（second-instance）与托盘菜单共用
 * 这一条恢复路径——没有重建分支时，窗口一旦关闭应用就以无窗口状态常驻，
 * 点任何入口都毫无反应。
 */
function showMainWindow(): void {
  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  if (mainWindowUrl !== null) createMainWindow(mainWindowUrl, false);
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
  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('dsh-chamber:settings-changed', chamberSettingsStatus());
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
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 应用一个已校验的设置 patch（design 14 D7）：先应用副作用（keep-awake /
 * 登录自启），**全部成功并持久化成功后才更新 holder**——任何失败 loud 返回
 * {error} 并回滚已应用的副作用（绝不落半个设置、绝不内存与磁盘不一致）。
 * windowCloseBehavior 无副作用（影响未来的 close 事件）。
 */
function applySettingsPatch(patch: Partial<ChamberSettings>): { ok: true } | { ok: false; error: string } {
  const next: ChamberSettings = { ...chamberSettings, ...patch };
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
  const reload = () => {
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
  win.webContents.on('did-finish-load', () => {
    loadedOnce = true;
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') return; // 用户关窗等正常退出
    console.error(
      `[dsh-chamber] 渲染进程退出：reason=${details.reason} exitCode=${details.exitCode}`,
    );
    // 稍候重载，避开崩溃拆除期（崩溃后立即 reload 偶发与拆除竞争）。
    setTimeout(() => {
      if (!win.isDestroyed()) reload();
    }, 500);
  });
  let unresponsiveTimer: NodeJS.Timeout | null = null;
  win.webContents.on('unresponsive', () => {
    if (!loadedOnce) {
      console.warn('[dsh-chamber] 渲染进程无响应（首次加载中，仅记录不重载）');
      return;
    }
    console.warn('[dsh-chamber] 渲染进程无响应，15s 内未恢复将重载');
    unresponsiveTimer = setTimeout(() => {
      if (!win.isDestroyed()) reload();
    }, 15_000);
  });
  win.webContents.on('responsive', () => {
    if (unresponsiveTimer !== null) {
      clearTimeout(unresponsiveTimer);
      unresponsiveTimer = null;
    }
  });
  win.on('closed', () => {
    if (unresponsiveTimer !== null) clearTimeout(unresponsiveTimer);
  });
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
  // control-plane document: deny popups and cancel cross-origin navigation
  // or redirects before another page can receive the same preload bridge.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedRendererUrl(url, rendererOrigin)) event.preventDefault();
  });
  win.webContents.on('will-redirect', (event, url) => {
    if (!isTrustedRendererUrl(url, rendererOrigin)) event.preventDefault();
  });
  installRendererRecovery(win);
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
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
    if (lastResume !== null) {
      win.webContents.send('dsh-chamber:system-resume', { timestamp: lastResume });
      lastResume = null;
    }
  });
  void win.loadURL(url).catch((loadError) => {
    const detail = loadError instanceof Error ? (loadError.stack ?? loadError.message) : String(loadError);
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
  // pendingIntents 队列；与冷启动 argv 扫描的双触发由 seenDeepLinkUrls 去重。
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
    event.preventDefault();
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
      transportManager?.disposeAsync().catch((err) => console.error('[dsh-chamber] 传输层关闭失败：', err)),
      cp?.stop().catch((err) => console.error('[dsh-chamber] 控制面停止失败：', err)),
      disposeRuntimeInstaller().catch((err) => console.error('[dsh-chamber] 运行时安装器关闭失败：', err)),
      disposeLocalPluginChildren().catch((err) => console.error('[dsh-chamber] 本地插件子进程关闭失败：', err)),
      runtimeOperation?.catch((err) => console.error('[dsh-chamber] 运行时事务关闭失败：', err)),
    ]).finally(() => {
      clearTimeout(cleanupTimer);
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
      startupMetadataHealth = detectRuntimeMetadataHealth(runtimeBaseDir);
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
      const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
      dialog.showErrorBox('dsh-chamber 启动失败', `控制面启动失败：\n${detail}`);
      app.exit(1);
      return;
    }

    if (app.isPackaged && !existsSync(CONTROL_PLANE_ENTRY)) {
      dialog.showErrorBox(
        'dsh-chamber 启动失败',
        `未找到控制面编译产物：${CONTROL_PLANE_ENTRY}\n请先执行 pnpm --filter @dsh-chamber/desktop run build:control-plane`,
      );
      app.exit(1);
      return;
    }

    // Capture the non-null control plane before registering closures over it
    // (the handler runs later, after startup).
    const cp = controlPlane;
    const rendererOrigin = `http://127.0.0.1:${cp.port}`;
    const trustedIpc = (handler: (...args: any[]) => any) =>
      (event: IpcMainInvokeEvent, ...args: any[]) => {
        const win = mainWindow;
        if (win === null || win.isDestroyed() || !isTrustedIpcSender(event, win.webContents, rendererOrigin)) {
          const error = new Error('forbidden IPC sender') as Error & { code?: string };
          error.code = 'ipc_sender_forbidden';
          throw error;
        }
        return handler(...args);
      };
    const runLocalPluginMutation = async <T>(
      owner: string,
      mutate: (dshWorkspace: string) => Promise<T>,
    ): Promise<T | { ok: false; error: string }> => {
      const lease = runtimeWriterFence.tryAcquire(owner);
      if (lease === null) return { ok: false, error: 'dsh runtime/data operation in progress' };
      try {
        if (runtimeStartBlocked) return { ok: false, error: runtimeStartBlockedReason };
        // Resolve again only after acquiring the writer fence. A folder picker
        // or queued IPC must never retain a workspace across a runtime swap.
        const resolved = resolveActiveRuntime(runtimeBaseDir);
        if (resolved.path === null) return { ok: false, error: resolved.blockedReason ?? 'dsh workspace not found' };
        return await mutate(resolved.path);
      } finally {
        lease.release();
      }
    };
    ipcMain.handle('dsh-chamber:info', trustedIpc(() => ({
      controlPlaneUrl: `http://127.0.0.1:${cp.port}`,
      dshVersion: resolveActiveRuntime(runtimeBaseDir).version,
      version,
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
    ipcMain.handle('dsh-chamber:settings-get', trustedIpc(() => chamberSettingsStatus()));
    ipcMain.handle('dsh-chamber:settings-set', trustedIpc(async ({ patch }) => {
      const validated = validatePatch(patch);
      if (!validated.ok) return { error: validated.error };
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
        if (response !== 1) return { error: 'cancelled' };
      }
      const applied = applySettingsPatch(validated.patch);
      if (!applied.ok) return applied;
      pushSettingsChanged();
      return chamberSettingsStatus();
    }));

    // OS 唤醒即时重探 + 推送（design 14 D4）：主进程对 error/degraded 实例
    // 立即重探（绝不触碰 idle），并向渲染端 push（dsh 前端连接立即重连）。
    powerMonitor.on('resume', () => {
      lastResume = Date.now();
      if (mainWindow !== null && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('dsh-chamber:system-resume', { timestamp: lastResume });
        // 窗口存活（含隐藏）已即时收到：清空 held 值，避免 hide→show 补发过期事件。
        lastResume = null;
      }
      reconnectStaleTransports();
    });

    maybeCreateTray(controlPlane);
    registerDeepLinkProtocol();

    // Transport manager (design 03 §2.2 / 05 §7-§8): persisted instance
    // registry under <userData>/ssh-instances.json; instance CRUD, transport
    // lifecycle and the provider exec channel (ssh: remote systemd) stay in
    // the main process; the renderer only ever sees non-secret status
    // projections (never a transport URL, never credential material).
    //
    // SSH password store (design 05 §8, user decision 2026-08 — plaintext
    // file fallback): passwords mirror to <userData>/ssh-passwords.json
    // (0600, atomic write) and load back at startup so password-only hosts
    // auto-connect after a restart. The file never touches the registry,
    // logs, or the renderer; a corrupt file is preserved as *.corrupt and
    // reported loudly.
    const askpassNotice = cleanupStaleAskpassHelpers();
    if (askpassNotice !== null) console.error(`[dsh-chamber] ${askpassNotice}`);
    const passwordNotice = configureSshPasswordStore(path.join(app.getPath('userData'), 'ssh-passwords.json'));
    if (passwordNotice !== null) console.error(`[dsh-chamber] ssh password store: ${passwordNotice}`);
    transportManager = createTransportManager({
      provider: sshProvider,
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
      // *.corrupt, reversible) before starting empty; the user's next
      // instances_set re-persists the set (never silently faked as empty).
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
    // In-flight guard for the ready-time chamber host-package seed (design 09 §6
    // 遗留 1): a Set of instance ids whose seed is currently running — pure
    // concurrency guard, not a "seeded" flag (the seed is idempotent, so
    // reconnects re-run a cheap content-hash no-op instead).
    const hostPackageSeeding = new Set<string>();
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
    const findRemoteSpec = (id: string): RemoteSpec | null => {
      const instance = sm.listInstances().find((entry) => entry.id === id);
      if (instance === undefined) return null;
      return { id: instance.id, remoteDshHome: instance.remoteDshHome ?? null };
    };
    // Remote install-level fallback path shared by both chamber host packages.
    const remoteHostPackageDir = (spec: RemoteSpec, packageName: string): string =>
      `${remoteHome(spec.remoteDshHome)}/profiles/node_modules/${packageName}`;
    sm.onStatusChanged((id, status) => {
      // Ready transport → per-instance reverse proxy (design 05 §7.1):
      // register the instance transport while it is ready, unregister the
      // moment it leaves ready. The transport URL only exists in the main
      // process — it never rides the renderer payload below (design 05 §8).
      const cp = controlPlane;
      if (cp !== null) {
        if (status.phase === 'ready') {
          const url = sm.readyUrl(id);
          if (url !== null) cp.registerInstanceTransport(`${status.kind}:${id}`, url);
        } else {
          cp.unregisterInstanceTransport(`${status.kind}:${id}`);
        }
      }
      // Remote chamber host-package seed: when an SSH instance comes ready,
      // materialize every built package and merge their loader rows together.
      // NOT silent — the plugin management UI probes the live state and shows
      // the injection block verbatim (installed/patched), and the seed result
      // is logged here; a failure is retried on the next ready (the seed is
      // idempotent, content-hash skip). Idempotency also makes the guard a
      // pure in-flight Set: reconnects re-run a cheap no-op seed instead of
      // tracking a persisted "seeded" flag that could drift from the remote.
      if (status.kind === 'ssh' && status.phase === 'ready' && !hostPackageSeeding.has(id)) {
        hostPackageSeeding.add(id);
        void (async () => {
          try {
            const builtSeeds = chamberHostPackageSeeds.filter(seed => existsSync(path.join(seed.sourceDir, 'dist', 'index.js')));
            if (builtSeeds.length === 0) {
              console.log(`[dsh-chamber] chamber host seed skipped for ${id}: no built host package artifacts`);
              sm.appendLog(id, 'info', 'chamber host 包未注入：构建产物缺失；远端相关客户端能力不可用');
              return;
            }
            const missingSeeds = chamberHostPackageSeeds.filter(seed => !builtSeeds.includes(seed));
            if (missingSeeds.length > 0) {
              sm.appendLog(id, 'info', `chamber host 包部分未注入（构建产物缺失）：${missingSeeds.map(seed => seed.label).join(', ')}`);
            }
            const spec = findRemoteSpec(id);
            if (spec === null) return;
            const result = await seedRemoteChamberHostPackages(execTransport, spec, chamberHostPackageSeeds);
            if (result.ok) {
              const seeded = result.packages.map(entry => entry.insertId).join(',');
              const message = `chamber host packages seeded onto ${id} (${seeded}; wrote=${result.wrote}, patched=${result.patched})`;
              console.log(`[dsh-chamber] ${message}`);
              const packageSummary = result.packages.map(entry =>
                `${entry.insertId}${entry.wrote ? ' 已写入' : ' 已是最新'}（${remoteHostPackageDir(spec, entry.packageName)}）`).join('；');
              sm.appendLog(id, 'info', `chamber host 包注入完成：${packageSummary}；boot 层${result.patched ? '已合并挂载' : '无需改动'}（重启后生效）`);
            } else {
              console.warn(`[dsh-chamber] chamber host seed failed for ${id}: ${result.error}`);
              sm.appendLog(id, 'error', `chamber host 包注入失败：${result.error}`);
            }
          } catch (err) {
            const message = `chamber host seed error for ${id}: ${String(err)}`;
            console.warn(`[dsh-chamber] ${message}`);
            sm.appendLog(id, 'error', `chamber host 包注入异常：${String(err)}`);
          } finally {
            hostPackageSeeding.delete(id);
          }
        })();
      }
      if (mainWindow !== null && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('desktop_ssh_status_changed', { id, status });
      }
    });

    ipcMain.handle('desktop_ssh_instances_get', trustedIpc(() => sm.listInstances()));
    ipcMain.handle('desktop_ssh_instances_set', trustedIpc((instances) => {
      const before = new Set(sm.listInstances().map(instance => instance.id));
      const saved = sm.saveInstances(instances);
      // A removed instance's in-memory password dies with its registry entry
      // (memory-only credentials never outlive the instance they belong to).
      for (const id of before) {
        if (!saved.some(instance => instance.id === id)) setSshPassword(id, null);
      }
      // Registry-change push: the renderer App layer re-pulls immediately
      // (roster/auto-connect/reap), so add/edit/delete propagates without
      // waiting for the 30s roster poll fallback.
      if (mainWindow !== null && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('desktop_ssh_instances_changed');
      }
      return saved;
    }));
    // Password auth (design 05 §8, plaintext-file fallback): the password is
    // held in MAIN-PROCESS memory and mirrored to <userData>/ssh-passwords.json
    // (0600, atomic write, loaded at startup) so password-only hosts
    // auto-connect after a restart — never in the registry, never logged,
    // and the renderer only ever holds it transiently in the form input
    // before forwarding it here. '' / null clears it (and removes the file
    // entry). The IPC is the platform gate: Win32-OpenSSH askpass support is
    // not reliable, so Windows refuses password auth loudly (keys/agent
    // remain the universal path) instead of silently failing at connect time.
    ipcMain.handle('desktop_ssh_set_password', trustedIpc(({ id, password }) => {
      if (typeof id !== 'string' || !INSTANCE_ID_PATTERN.test(id) || !sm.listInstances().some(instance => instance.id === id)) {
        return { error: 'invalid or unknown instance id' };
      }
      if (!sshPasswordSupported()) {
        return { error: 'SSH password auth is not supported on this platform yet — use a key or ssh-agent' };
      }
      if (typeof password === 'string' && password.length > MAX_SSH_PASSWORD_CHARS) {
        return { error: `SSH password is limited to ${MAX_SSH_PASSWORD_CHARS} characters` };
      }
      try {
        setSshPassword(id, typeof password === 'string' && password !== '' ? password : null);
        return { ok: true };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    }));
    // ~/.ssh/config discovery (design 05 §5): non-secret host projections
    // only (alias/hostName/user/port) — keys/proxies/credentials never leave
    // the main process.
    ipcMain.handle('desktop_ssh_config_list', trustedIpc(() => discoverSshConfigHosts()));
    ipcMain.handle('desktop_ssh_connect', trustedIpc(({ id }) => sm.connect(id)));
    ipcMain.handle('desktop_ssh_disconnect', trustedIpc(({ id }) => {
      sm.disconnect(id);
      return sm.status(id);
    }));
    ipcMain.handle('desktop_ssh_status', trustedIpc(({ id }) => sm.status(id)));
    ipcMain.handle('desktop_ssh_logs', trustedIpc(({ id }) => sm.logs(id)));
    ipcMain.handle('desktop_ssh_logs_clear', trustedIpc(({ id }) => sm.clearLogs(id)));
    // Provider exec channel (design 05 §7.4, ssh: remote systemd): the fresh
    // status projection on success (serviceActive included), {error} on
    // failure — loud, never a silent empty success, never an unhandled
    // rejection.
    ipcMain.handle('desktop_ssh_start_service', trustedIpc(({ id }) =>
      sm.exec(id, 'start').then(result => (result.ok ? result.status : { error: result.error })).catch(err => ({ error: `exec failed: ${String(err)}` })),
    ));
    ipcMain.handle('desktop_ssh_stop_service', trustedIpc(({ id }) =>
      sm.exec(id, 'stop').then(result => (result.ok ? result.status : { error: result.error })).catch(err => ({ error: `exec failed: ${String(err)}` })),
    ));
    ipcMain.handle('desktop_ssh_is_active', trustedIpc(({ id }) =>
      sm.exec(id, 'is-active').then(result => (result.ok ? result.status : { error: result.error })).catch(err => ({ error: `exec failed: ${String(err)}` })),
    ));
    // Plugin management surface (design 13 M2+M3, contract B): restart the remote
    // service, read the remote/local plugin manifests, apply a plugin-set change,
    // and best-effort npm search (main-process fetch; the renderer stays on
    // 127.0.0.1). All handlers go through the trustedIpc fence and resolve loud
    // {error} / {ok:...} shapes — never a silent empty success, never an
    // unhandled rejection. renderer-supplied specs are re-validated inside
    // applyPlugins (defense in depth).
    ipcMain.handle('desktop_ssh_restart_service', trustedIpc(({ id }) =>
      execTransport(id, 'restart').then(result =>
        (result.ok ? (result.status ?? { error: 'restart completed but no status projection' }) : { error: result.error }),
      ).catch(err => ({ error: `exec failed: ${String(err)}` })),
    ));
    ipcMain.handle('desktop_ssh_plugin_list', trustedIpc(async ({ id }) => {
      const spec = findRemoteSpec(id);
      if (spec === null) return { ok: false, error: 'ssh instance not found' };
      return remotePluginList(execTransport, spec, { liveProbe: liveProbeFor(id), gitWorktreeLiveProbe: gitWorktreeLiveProbeFor(id) });
    }));
    ipcMain.handle('desktop_ssh_plugin_apply', trustedIpc(async ({ id, add, remove, restart }) => {
      const spec = findRemoteSpec(id);
      if (spec === null) return { ok: false, error: 'ssh instance not found' };
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
      return applyPlugins(execTransport, statusTransport, spec, { add, remove, restart }, { knownBundles });
    }));
    ipcMain.handle('desktop_local_plugin_list', trustedIpc(() => {
      try {
        return { ok: true, manifest: localPluginList(localDshHome) };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }));
    ipcMain.handle('desktop_npm_search', trustedIpc(async ({ query }) => {
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
        const response = await fetch(searchUrl, {
          signal: controller.signal,
        });
        if (!response.ok) return { ok: false, error: `npm search failed (HTTP ${response.status})` };
        const data = (await response.json()) as { objects?: Array<{ package?: { name?: unknown; version?: unknown; description?: unknown } }> };
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
        return { ok: false, error: `npm search failed: ${String(error)}` };
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
    ipcMain.handle('desktop_ssh_seed_host_graph', trustedIpc(async ({ id }) => {
      const spec = findRemoteSpec(id);
      if (spec === null) return { ok: false, error: 'ssh instance not found' };
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
      if (hostPackageSeeding.has(id)) return { ok: false, error: 'chamber host seed in progress' };
      hostPackageSeeding.add(id);
      try {
        const result = await seedRemoteChamberHostPackages(execTransport, spec, chamberHostPackageSeeds);
        // Surface the outcome in the instance's ring-buffer log (the connections
        // UI log panel) — the injection is never a silent modification.
        if (result.ok) {
          const summary = result.packages.map(entry => `${entry.insertId}${entry.wrote ? ' 已写入' : ' 已是最新'}`).join('、');
          sm.appendLog(id, 'info', `chamber host 包注入完成：${summary}；boot 层${result.patched ? '已挂载' : '无需改动'}（重启后生效）`);
        } else {
          sm.appendLog(id, 'error', `chamber host 包注入失败：${result.error}`);
        }
        return result;
      } finally {
        hostPackageSeeding.delete(id);
      }
    }));
    // materialize_add (sync view): renderer supplies only the dependency NAME.
    // Main re-reads the authoritative local manifest and resolves/canonicalizes
    // its path; an IPC caller can never choose an arbitrary local directory.
    ipcMain.handle('desktop_ssh_plugin_materialize_add', trustedIpc(async ({ id, name }) => {
      const spec = findRemoteSpec(id);
      if (spec === null) return { ok: false, error: 'ssh instance not found' };
      if (typeof name !== 'string') return { ok: false, error: 'invalid plugin name' };
      const resolved = resolveLocalMaterializeDirectory(localDshHome, name);
      if (!resolved.ok) return resolved;
      return materializeAndAdd(execTransport, spec, resolved.path);
    }));
    // materialize_add_pick (add view): PICK-ONLY — the folder picker runs here in
    // the main process, so a compromised renderer can never drive the pack surface
    // to an arbitrary local directory (design 13 §5.8 hardening).
    ipcMain.handle('desktop_ssh_plugin_materialize_add_pick', trustedIpc(async ({ id }) => {
      const spec = findRemoteSpec(id);
      if (spec === null) return { ok: false, error: 'ssh instance not found' };
      if (mainWindow === null || mainWindow.isDestroyed()) return { ok: false, error: 'no main window' };
      const picked = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
      if (picked.canceled || picked.filePaths.length === 0) return { ok: true, cancelled: true };
      return materializeAndAdd(execTransport, spec, picked.filePaths[0]);
    }));
    ipcMain.handle('desktop_local_plugin_add_file', trustedIpc(async () => {
      if (mainWindow === null || mainWindow.isDestroyed()) return { ok: false, error: 'no main window' };
      const picked = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
      if (picked.canceled || picked.filePaths.length === 0) return { ok: true, cancelled: true };
      return runLocalPluginMutation('plugin:add-file', async (dshWorkspace) => {
        const result = await runLocalDshPlugin(dshWorkspace, localDshHome, 'add', `file:${picked.filePaths[0]}`);
        return result.ok ? { ok: true } : { ok: false, error: result.error ?? 'local add failed' };
      });
    }));
    ipcMain.handle('desktop_local_plugin_add', trustedIpc(async ({ spec: specArg }) => {
      // `file:` imports must go through the main-process folder picker
      // (desktop_local_plugin_add_file); this spec channel only accepts registry
      // specs so a compromised renderer can never drive the local pack surface
      // to an arbitrary directory (design 13 §5.8 hardening).
      if (typeof specArg === 'string' && specArg.startsWith('file:')) {
        return { ok: false, error: 'local file imports must use the folder picker' };
      }
      return runLocalPluginMutation('plugin:add', async (dshWorkspace) => {
        const result = await runLocalDshPlugin(dshWorkspace, localDshHome, 'add', specArg);
        return result.ok ? { ok: true } : { ok: false, error: result.error ?? 'local add failed' };
      });
    }));
    ipcMain.handle('desktop_local_plugin_remove', trustedIpc(async ({ name }) => {
      return runLocalPluginMutation('plugin:remove', async (dshWorkspace) => {
        const result = await runLocalDshPlugin(dshWorkspace, localDshHome, 'remove', name);
        return result.ok ? { ok: true } : { ok: false, error: result.error ?? 'local remove failed' };
      });
    }));

    // VS Code 深链（design 16 §4/§5）：IPC 只是可信渲染端触发的 intent，与 OS
    // 深链共用同一 runVscodeLaunch 管线（注册表实查 + authority 构造 + 可用性
    // 二次校验，§3.4）。wiredCtx.lookupInstance 查 transportManager 实查；
    // vscodeAvailable 每次实探（getter 惰性、无缓存陈旧）；openVscodeUrl 包装
    // shell.openExternal（catch → loud error，返回 {error} 由调用方处理）。
    const wiredCtx: VscodeLaunchContext = {
      lookupInstance: (id) => {
        const instance = sm.listInstances().find(entry => entry.id === id);
        if (instance === undefined) return null;
        return { id: instance.id, host: instance.host, user: instance.user, sshPort: instance.sshPort, kind: instance.kind };
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
          const message = error instanceof Error ? error.message : String(error);
          console.error('[dsh-chamber] 打开 vscode URL 失败：', error);
          return { ok: false, error: `open vscode url failed: ${message}` };
        }
      },
    };
    ipcMain.handle('dsh-chamber:vscode-availability', trustedIpc(() => detectVscodeAvailability(process.platform)));
    ipcMain.handle('dsh-chamber:open-vscode', trustedIpc(async ({ instanceId, path }) => {
      const result = await runVscodeLaunch({ instanceId, path }, wiredCtx);
      // 成功后 best-effort 推送 intent 激活渲染层对应来源（窗口未就绪/销毁则跳过，
      // 不阻塞 VS Code 启动）；失败 {error} 由调用方展示。
      if (result.ok && mainWindow !== null && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('dsh-chamber:deep-link-intent', { instanceId, path });
      }
      return result;
    }));

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
      if (mainWindow !== null && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('dsh-chamber:update-state-changed', updateState);
      }
    });
    ipcMain.handle('dsh-chamber:update-state', trustedIpc(() => updater.state()));
    ipcMain.handle('dsh-chamber:update-check', trustedIpc(() => updater.checkNow()));
    ipcMain.handle('dsh-chamber:update-download', trustedIpc(() => updater.download()));
    // The settings update section's「前往下载页」link: popups are denied and
    // navigation is pinned to the control-plane origin, so opening a release
    // page must go through the main process. Strict allowlist — parsed, not
    // prefix-string matched: only this repo's GitHub pages can ever be opened
    // (never an arbitrary URL, subdomain, userinfo or path-root trick).
    ipcMain.handle('dsh-chamber:open-release', trustedIpc(({ url }) => {
      if (!isAllowedReleaseUrl(url)) {
        return { ok: false, error: 'url not allowed' };
      }
      void shell.openExternal(url).catch(err => console.error('[dsh-chamber] 打开下载页失败：', err));
      return { ok: true };
    }));
    updater.start();

    // Design 17 runtime management: registry/install state and the startup
    // activation transaction publish through one controller projection.
    const pnpmEntry = app.isPackaged
      ? path.join(process.resourcesPath, 'pnpm', 'bin', 'pnpm.cjs')
      : path.join(pkgDir, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs');
    let storePruneOperation: Promise<void> | null = null;
    const runStorePruneIfNeeded = (): Promise<void> => {
      if (storePruneOperation !== null) return storePruneOperation;
      if (quitRequested || readStorePruneRequest(runtimeBaseDir) === null) return Promise.resolve();
      const operation = pruneRuntimeStore({ baseDir: runtimeBaseDir, pnpmEntry })
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
          return installRuntimeVersion(opts);
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
      },
    });
    runtimeController = runtimeInstance;
    runtimeInstance.onChanged((state) => {
      if (mainWindow !== null && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('dsh-chamber:runtime-state-changed', state);
      }
    });
    const projectMetadataHealth = (
      phase: Parameters<typeof runtimeInstance.setLifecycle>[0]['phase'],
      canRetryRestore: boolean,
    ): {
      metadataHealth: RuntimeMetadataHealthProjection
      metadataComponents: RuntimeMetadataComponent[]
      canRecoverMetadata: boolean
    } => {
      let health: RuntimeMetadataHealth;
      try {
        health = detectRuntimeMetadataHealth(runtimeBaseDir);
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
      const canRecoverMetadata = needsRecovery
        && (effectivePhase === 'idle' || effectivePhase === 'failed')
        && !canRetryRestore
        && runtimeManagementSupported
        && !envOverrideActive
        && !runtimeBootstrapWriterUnsafe
        && cp.localWritersQuiescent
        && bundledVersion !== null
        && isSafeVersion(bundledVersion)
        && restoreMarkerAuthorityStatus(runtimeBaseDir) === 'missing';
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
      const showFailure = effectivePhase === 'failed' || effectivePhase === 'rollback'
        || effectivePhase === 'snapshot-failed' || effectivePhase === 'error';
      let snapshotProjection: Parameters<typeof runtimeInstance.setLifecycle>[0];
      try {
        const snapshots = await snapshotSummary(runtimeBaseDir);
        const failures = runtimeFailureSummary(runtimeBaseDir);
        snapshotProjection = {
          snapshotCount: snapshots.count,
          latestSnapshotAt: snapshots.latestAt,
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
        ...projectMetadataHealth(effectivePhase, effectiveCanRetryRestore),
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
        spawnAndProbe: (runtimeVersion, isBuiltin) => startAndProbeRuntime(
          runtimeVersion,
          isBuiltin,
          runtimeOperationAbort?.signal,
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
        phase: outcome.status === 'rolled-back'
          ? 'rollback'
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
      const initialHealth = detectRuntimeMetadataHealth(runtimeBaseDir);
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
          stopHost: () => cp.stopLocal(),
          completeRestore: () => completeInterruptedRestore(runtimeBaseDir, localDshHome),
          probeBuiltin: async () => {
            const probes = await startAndProbeRuntime(bundledVersion, true, signal);
            return probesPassed(probes)
              ? { ok: true as const }
              : { ok: false as const, error: metadataProbeError(probes) };
          },
        };
        const health = detectRuntimeMetadataHealth(runtimeBaseDir);
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
            restoreOutcome: result.restoreOutcome,
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
          metadataHealth = detectRuntimeMetadataHealth(runtimeBaseDir);
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
            metadataHealth = detectRuntimeMetadataHealth(runtimeBaseDir);
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
            metadataHealth = detectRuntimeMetadataHealth(runtimeBaseDir);
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
        const result = await runStartupPhase(deps);
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
              const rollbackOutcome = await runDelayedRollback(deps, monitoring);
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
        const result = await runStartupPhase(buildStartupDeps());
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
      if (quitRequested
        || state.runtimeBlocked !== true
        || (state.phase !== 'idle' && state.phase !== 'failed')
        || state.canRetryRestore === true
        || state.restoreOutcome === 'half'
        || state.restoreOutcome === 'incomplete'
        || state.source === 'env'
        || state.managementSupported === false
        || runtimeBootstrapWriterUnsafe
        || !cp.localWritersQuiescent
        || bundledVersion === null
        || !isSafeVersion(bundledVersion)
        || restoreMarkerAuthorityStatus(runtimeBaseDir) !== 'missing') return null;
      try {
        const health = detectRuntimeMetadataHealth(runtimeBaseDir);
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

    ipcMain.handle('dsh-chamber:runtime-state', trustedIpc(() => runtimeInstance.getState()));
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
        if (action === 'recover-metadata') return state.canRetryRestore !== true
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
    ipcMain.handle('dsh-chamber:runtime-check', trustedIpc(runRuntimeCheck));
    ipcMain.handle('dsh-chamber:runtime-install', trustedIpc(async (args) => {
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
    ipcMain.handle('dsh-chamber:runtime-cleanup-version', trustedIpc(async (args) => {
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
    ipcMain.handle('dsh-chamber:runtime-recover-metadata', trustedIpc(async () => {
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
    ipcMain.handle('dsh-chamber:runtime-reset-builtin', trustedIpc(async () => {
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
    ipcMain.handle('dsh-chamber:runtime-retry-apply', trustedIpc(async () => {
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
    ipcMain.handle('dsh-chamber:runtime-retry-restore', trustedIpc(async () => {
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
    // clipboard-sanitized-write (navigator.clipboard copy) — which carries no
    // read/privacy risk; clipboard-read and media/geolocation/notifications stay
    // denied.
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'clipboard-sanitized-write');

    // 启动期创建主窗口：加载失败 = 大声失败 + 退出（createMainWindow 内）；
    // activate/托盘/second-instance 恢复路径共用同一创建函数。
    createMainWindow(rendererOrigin, true);
    void refreshRuntimeEvidence().then(() => runRuntimeStartup()).catch(error => {
      console.error('[dsh-chamber] dsh 运行时启动事务失败：', error);
      runtimeStartBlocked = true;
      runtimeInstance.setLifecycle({ phase: 'failed', error: error instanceof Error ? error.message : String(error) });
    });

    // 深链统一 drain（design 16 §4.2）：startup 完成（transportManager 装载 +
    // 主窗口就绪）后消费 pendingIntents。深链执行（VS Code 启动）不阻塞窗口；
    // 成功后 best-effort 推送 intent（窗口未就绪/销毁则跳过）；失败 loud
    // （对话框 + 日志）。quit 在途的深链已在 enqueueDeepLink 被 ignore。
    drainPendingIntents = () => {
      const intents = pendingIntents;
      pendingIntents = [];
      for (const intent of intents) {
        if (quitRequested) return;
        void (async () => {
          const result = await runVscodeLaunch(intent, wiredCtx);
          if (result.ok) {
            if (mainWindow !== null && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('dsh-chamber:deep-link-intent', intent);
            }
          } else {
            console.error(`[dsh-chamber] 深链执行失败：${result.error}`);
            dialog.showErrorBox('打开 VS Code 失败', result.error);
          }
        })().catch((error) => {
          // runVscodeLaunch 内部已兜底，此处只防意外 rejection 成为
          // unhandled（security-review：drain 的 async IIFE 无 catch）。
          console.error('[dsh-chamber] 深链执行异常：', error);
        });
      }
    };
    drainPendingIntents();
  });
}
