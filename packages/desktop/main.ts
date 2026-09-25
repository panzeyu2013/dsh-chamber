/**
 * dsh-chamber desktop main process (connection-manager form).
 * The single window loads the control-plane origin directly — one frame, one origin;
 * the control plane serves the built dsh frontend and proxies every instance over
 * /api/i/<id>/*. Remote instances reach the control plane through
 * registerInstanceTransport / unregisterInstanceTransport, driven by the transport
 * manager's ready phase; the transport URL never enters a renderer payload.
 * Host assembly (transport/gateway/seed/runtime) is the SAME implementation the Swift
 * sidecar uses (createHostAssembly); this file only injects Electron edge facts and
 * owns window/tray/lifecycle glue — zero IPC handler registrations, zero
 * webContents.send calls (handlers live in shell-core.ts, pushes in electron-edges.ts).
 */

import { app, BrowserWindow, crashReporter, dialog, ipcMain, Menu, Tray, nativeImage, nativeTheme, powerMonitor, powerSaveBlocker, safeStorage, session } from 'electron';
import {
  SAFE_MODE_ENV,
  backupChamberStateForRecovery,
  formatStartupFailureDetail,
  isSafeModeEnabled,
  planStartupRecovery,
  resolveStartupRecoveryAction,
} from './startup-error.ts';
import type { StartupFailureKind, StartupRecoveryAction } from './startup-error.ts';
/** 上游 windows-layout.ts 的镜像值（Windows caption 高度，dip）——preload.cts 内另有
 *  同值副本（preload 运行时自带，不跨 CJS 边界导入）；两处相等由 upstream-seats 用例钉住。 */
const WINDOWS_TITLEBAR_HEIGHT = 40;
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import type { PlaneHandle } from '@dsh-chamber/control-plane';
import { applyWindowsAclTightening } from './win-acl.ts';
import { verifyRuntimeClientClosure } from './runtime-tree-check.ts';
import { createTrustedIpc, isChamberPermissionGranted, isExternalLinkUrl, isTrustedIpcSender, isTrustedRendererUrl } from './renderer-trust.ts';
import type { TrustedIpc } from './renderer-trust.ts';
import { atomicWritePrivateFileNoFollow, createControlPlane, ensurePrivateDirectoryNoFollow, readPrivateFileNoFollow } from './control-plane-module.ts';
import { attemptDeepLinkProtocolRegistration, canRestoreMainWindow, decideDeepLinkProtocolRegistration, describeUnknownError, ensureLinuxProtocolDesktopFile, linuxAutostartDesktopEntry, linuxAutostartDirectory, resolveLinuxLaunchExecutable } from './deep-link.ts';
import { createUpdateController, flashUpdateAttentionWindow } from './updater.ts';
import { shellStrings } from './shell-locale.ts';
import { acquireChamberLock } from './chamber-lock.ts';
import { acquireHostRootLease, describeHostRootLeaseFailure } from './host-root-lease.ts';
import { DEFAULT_CHAMBER_SETTINGS, computeQuitRisk, decideMainWindowClose, launchAtLoginReconcileDecision, readSettingsFile, shouldUpdaterQuitTakeOver, verifyLaunchAtLoginReadBack } from './chamber-settings.ts';
import type { ChamberSettings } from './chamber-settings.ts';
import { shouldFocusApplicationBeforeShowing } from './notifications.ts';
import { ARCHIVE_CLEANUP_PACKAGE_NAME, CLIENT_GRAPH_PACKAGE_NAME, GIT_WORKTREE_PACKAGE_NAME } from './plugin-sync.ts';
// 共享宿主装配（transport/gateway/seed/runtime 单一实现，与 Swift sidecar 同一份）。
import { createHostAssembly } from './host-assembly.ts';
import type { HostAssembly } from './host-assembly.ts';
// pnpm 入口候选集/选择算法的单一实现（runtime 安装器 + sidecar 装配共用）。
import { bundledPnpmEntryCandidates, firstExistingPnpmEntry } from './pnpm-launcher.ts';
// 深链 scheme 的单一来源（协议注册字面量）。
import { DEEP_LINK_SCHEME } from './deep-link-scheme.ts';
import { IPC_CHANNELS } from './ipc-events.ts';
import { DESKTOP_SHORTCUTS_CHANNELS, DesktopShortcutsBridge, desktopKeyEvent, loadDesktopShortcutProtocol } from './shortcuts-bridge.ts';
import type { ShortcutStorage } from './shortcuts-bridge.ts';
import { RENDERER_CRASH_RELOAD_DELAY_MS, RENDERER_HANG_RELOAD_DELAY_MS, RENDERER_RECOVERY_MAX_RELOADS, noteRendererReload, shouldReloadAfterChildProcessGone, auditLogFilePath, chamberSettingsFilePath, gatewaySecretsFilePath, QUIT_CLEANUP_TIMEOUT_MS, resolveActiveRuntime, resolveControlPlanePort, scanDeepLinkUrls, sshPasswordsFilePath, stateRootDir, installIpcHandlers, clearBadgeIntentForQuit, drainDeepLinkLaunches, enqueueDeepLink, onRendererLifecycle, openExternally, resolveDevBuiltinDshWorkspace, shouldReloadAfterCrash, shouldScheduleHangReload } from './shell-core.ts';
import type { RendererReloadBudgetState } from './shell-core.ts';
import { createElectronEdges } from './electron-edges.ts';
import { describeFatalError } from './describe-error.ts';
import { ConsoleRing, pushConsoleMessage, recordFatalReport } from './fatal-report.ts';
import { RendererFrameWatchdog, RENDERER_FRAME_PROGRESS_SCRIPT, RENDERER_INPUT_BLOCK_RTT_MS } from './renderer-frame-watchdog.ts';

// Last-resort crash boundary: an unknown uncaught exception means the
// privileged main process may be inconsistent and must fail closed rather than
// keep serving IPC, transports and persistence from an indeterminate state.
let fatalExceptionInProgress = false;
// 渲染端 console 错误的**有界环**（64KiB，只留尾部）：主进程此前零 hook，
// 打包态 renderer 白屏只剩系统考古；环只进本地 fatal 报告，绝不外发、不转发。
const rendererConsoleRing = new ConsoleRing();

/**
 * 把一条致命事件落进本地报告，并返回可拼进对话框的「报告：<path>」行。
 * 只落盘、不外发；写入失败时如实说明（绝不给用户一个不存在的路径）。
 * @param input - 事件种类/阶段/正文与附加事实。
 * @returns 面向对话框的一行 + 写入结果。
 */
function noteFatalReport(input: {
  event: string
  phase: 'startup' | 'running'
  detail: string
  extras?: readonly string[]
}): string {
  const consoleTail = rendererConsoleRing.snapshot();
  const extras = [...(input.extras ?? [])];
  if (consoleTail !== '') extras.push('renderer-console-tail=' + consoleTail);
  const { line } = recordFatalReport({
    userDataDir: app.getPath('userData'),
    record: {
      at: new Date().toISOString(),
      version: app.getVersion(),
      source: 'electron-main',
      phase: input.phase,
      event: input.event,
      detail: input.detail,
      extras,
    },
  });
  console.log('[dsh-chamber] ' + line);
  return line;
}
/**
 * 呈一次致命启动失败恢复框（上游 fatal-recovery.ts 的等价物；C4 启动与修复）。
 * 按钮布局/按键语义全部由 startup-error.ts 的纯函数给定：三选 = 退出 / 重启 /
 * 安全模式重启（默认与 Esc 都落安全项），锁冲突两选 = 退出 / 重启。
 * 单次呈现门：同一 fatal 经多条腿上报时只弹一次；对话框不可用按退出 fail-closed。
 * @param input - 标题与明细（明细经 formatStartupFailureDetail 截断）。
 * @param kind - 'startup'（致命启动失败）或 'already-running'（目录锁冲突）。
 */
function reportFatalStartupFailure(input: { title: string; detail: string }, kind: StartupFailureKind): void {
  console.error(`[dsh-chamber] ${input.title}：${input.detail}`);
  if (startupRecoveryShown) return;
  startupRecoveryShown = true;
  // 本地报告（§18 行 1）：完整现场落盘，对话框只给截断文案 + **报告路径**——
  // 用户不必再猜「日志在哪」，也不必把整段 stderr 抄进截图。
  const reportLine = noteFatalReport({
    event: kind === 'already-running' ? 'lock-conflict' : 'startup-failure',
    phase: kind === 'already-running' ? 'startup' : (mainWindow === null || mainWindow.isDestroyed() ? 'startup' : 'running'),
    detail: input.detail,
  });
  const copy = shellStrings(app.getLocale());
  const plan = planStartupRecovery(
    { exit: copy.quitButton, restart: copy.restartButton, safeModeRestart: copy.safeModeRestartButton },
    kind,
  );
  let response: number | null = null;
  try {
    response = dialog.showMessageBoxSync({
      type: 'error',
      title: input.title,
      message: input.title,
      detail: formatStartupFailureDetail(input.detail) + '\n\n' + reportLine,
      buttons: [...plan.buttons],
      defaultId: plan.defaultId,
      cancelId: plan.cancelId,
      noLink: true,
    });
  } catch (error) {
    console.error('[dsh-chamber] 启动失败恢复框不可用，按退出处理：', describeUnknownError(error));
  }
  applyStartupRecoveryAction(response === null ? 'exit' : resolveStartupRecoveryAction(plan, response));
}

/**
 * 恢复动作的唯一执行出口（呈现后进程去向只能由用户选择决定，绝不静默 exit(1)）。
 * @param action - 三选/两选决策结果。
 */
function applyStartupRecoveryAction(action: StartupRecoveryAction): void {
  if (action === 'exit') {
    console.log('[dsh-chamber] 恢复动作：退出（exit 1）');
    app.exit(1);
    return;
  }
  const safeMode = action === 'safe-mode-restart';
  console.log(`[dsh-chamber] 恢复动作：${safeMode ? '安全模式重启' : '重启'}——先走既有退出清理链（传输层/控制面/本地 dsh），再重启`);
  void relaunchForRecovery(safeMode);
}

/**
 * 恢复重启腿：先排队 app.relaunch()（清理腿超时强退也不丢重启），再 await 既有
 * 退出清理链（与 will-quit 同一份 runQuitCleanupChain），释放目录锁后才
 * app.exit(0)。安全模式：先备份 chamber 自持文件（只备份、绝不改写 dsh profile），
 * 再把 DSH_CHAMBER_SAFE_MODE=1 写进本进程 env——app.relaunch() 的新实例继承该环境，
 * 下次普通启动自动恢复。
 * @param safeMode - true = 安全模式重启（跳过 chamber 宿主包 seeding 与 extra rows）。
 */
async function relaunchForRecovery(safeMode: boolean): Promise<void> {
  if (recoveryRelaunchInProgress) return;
  recoveryRelaunchInProgress = true;
  if (safeMode) {
    process.env[SAFE_MODE_ENV] = '1';
    const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
    for (const outcome of backupChamberStateForRecovery({ userDataDir: app.getPath('userData'), stamp })) {
      const suffix = outcome.error === undefined ? '' : `（${outcome.error}）`;
      console.log(`[dsh-chamber] 安全模式备份 ${outcome.id}：${outcome.status}${suffix} → ${outcome.destination}`);
    }
  }
  app.relaunch();
  await runQuitCleanupChain();
  try {
    chamberLockHandle?.release();
    chamberLockHandle = null;
  } catch (error) {
    console.warn('[dsh-chamber] 目录锁释放失败（进程退出由内核兜底）：', describeUnknownError(error));
  }
  console.log(`[dsh-chamber] 清理完成：控制面已停止、目录锁已释放——重启新实例（安全模式=${safeMode}）`);
  app.exit(0);
}

/**
 * 退出清理链（will-quit 主体 + 恢复重启腿共享；单飞：重复调用返回同一份 promise）。
 * 装配侧公共回收腿（dispose：quitting 门 + 事务 abort + transport/插件子进程/在飞
 * 事务并行回收 + 会话清理）与控制面 stop 并行等待（互不依赖，总耗时 = max）；
 * 兜底：清理链挂起则超时强制退出，绝不留下「窗口已关、进程仍在」的半退出态。
 * @returns 清理链 settle 后的 promise。
 */
function runQuitCleanupChain(): Promise<void> {
  if (quitCleanupPromise !== null) return quitCleanupPromise;
  const cleanupTimer = setTimeout(() => {
    // 超时强制退出走 app.exit()：quit 事件不触发，autoInstallOnAppQuit 不执行
    // ——退出腿下「已下载」更新会被跳过；「重启并安装」腿不受影响。
    console.error('[dsh-chamber] 退出清理超时，强制退出（可能有子进程残留；退出腿的已下载更新不会安装）');
    app.exit(1);
  }, QUIT_CLEANUP_TIMEOUT_MS);
  const cp = controlPlane;
  controlPlane = null;
  const assembly = hostAssembly;
  quitCleanupPromise = Promise.allSettled([
    assembly === null ? Promise.resolve() : assembly.dispose(),
    cp?.stop().catch((err) => console.error('[dsh-chamber] 控制面停止失败：', err)),
  ]).then(() => undefined).finally(() => {
    // Gateway 会话与 pre-expiry 刷新计时器已在 assembly.dispose() 内丢弃；
    // 这里只剩计时器与退出簿记。
    clearTimeout(cleanupTimer);
    willQuitCleanupComplete = true;
    console.log('[dsh-chamber] will-quit 清理完成，进程退出');
  });
  const pending = quitCleanupPromise;
  return pending;
}

function fatalMainError(reason: unknown): void {
  if (fatalExceptionInProgress) {
    try { process.abort(); } catch { /* no further recovery is trustworthy */ }
    return;
  }
  // Claim terminal ownership before any formatting/logging/host call: those
  // boundaries can themselves throw and must not recurse through this path.
  fatalExceptionInProgress = true;
  let detail = 'unknown error';
  // 有界致命描述（含 code/syscall/path/cause）：只进本地报告与 stderr，不进任何外发面。
  try { detail = describeFatalError(reason); } catch { detail = 'unknown error'; }
  try { noteFatalReport({ event: 'uncaught-exception', phase: 'running', detail }); } catch { /* 报告失败不阻断 fail-closed */ }
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

// 本地崩溃记录（不上传）：Crashpad 落盘到 <userData>/Crashpad，缺它就只剩
// 系统 DiagnosticReports 考古"前端消失/白屏"。uploadToServer=false 时
// submitURL 可省略。
crashReporter.start({
  productName: 'dsh-chamber-electron',
  companyName: 'dsh-chamber',
  uploadToServer: false,
});

// 诊断留痕：GPU/Utility 子进程异常退出（渲染进程由窗口级恢复覆盖）。
app.on('child-process-gone', (_event, details) => {
  if (details.type === 'GPU' || details.type === 'Utility') {
    const summary = `子进程退出：type=${details.type} reason=${details.reason} exitCode=${details.exitCode} name=${details.name ?? ''}`;
    console.error('[dsh-chamber] ' + summary);
    // 同一份报告：GPU/Utility 消失是「白屏/黑屏」的常见根因，此前只进 console。
    try {
      noteFatalReport({
        event: 'child-process-gone',
        phase: 'running',
        detail: summary,
        extras: ['serviceName=' + (details.serviceName ?? ''), 'reason=' + String(details.reason ?? '')],
      });
    } catch { /* 报告失败不改子进程语义 */ }
  }
});

const pkgDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(pkgDir, '..', '..');
const { version } = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));

function resolveBuiltinDshWorkspace(): string | null {
  if (app.isPackaged) {
    const bundled = path.join(process.resourcesPath, 'vendor', 'dsh');
    return existsSync(bundled) ? bundled : null;
  }
  // dev 候选顺序由 shell-core 单源提供（<repoRoot>/ref-dsh → <pkgDir>/vendor/dsh）
  // ——Electron-free sidecar 的 dev 回退必须与这里逐字同序（共用同一 helper）。
  return resolveDevBuiltinDshWorkspace(pkgDir);
}

/** 运行时线锚锁文件（F 首选事实源）：随应用发布的 vendor/dsh/pnpm-lock.yaml。
 *  dev 形态指向仓库里的同一份（活动树可能是源码线 ref-dsh，其闭包含 opt-in
 *  段，不能当 F）。 */
function resolvePinnedRuntimeLockfile(): string | null {
  const candidate = app.isPackaged
    ? path.join(process.resourcesPath, 'vendor', 'dsh', 'pnpm-lock.yaml')
    : path.join(pkgDir, 'vendor', 'dsh', 'pnpm-lock.yaml');
  return existsSync(candidate) ? candidate : null;
}

/** userData/keybindings.json 存储（upstream keybindings.ts 的同位文件）：快捷键
 *  偏好非凭证，仍走同一 no-follow/私有权限纪律（0600 + 原子替换），绝不静默读写
 *  一个被替换/多链接的叶子。 */
function createKeybindingsStorage(filePath: string): ShortcutStorage {
  return {
    read: () => {
      try {
        return readPrivateFileNoFollow(filePath, { tightenMode: 0o600 }).value;
      } catch (error) {
        // 缺文件 = 首次运行（upstream readFile ENOENT -> null）；其余错误如实上抛，
        // 由 ShortcutPersistence 结算为 unreadable。
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
    write: (raw) => {
      ensurePrivateDirectoryNoFollow(path.dirname(filePath), 0o700);
      atomicWritePrivateFileNoFollow(filePath, raw, { mode: 0o600 });
    },
  };
}

/** dshDesktop 推送叶：只投给当前主窗口的存活 webContents，绝不 throw。 */
function pushToMainWindow(channel: string, payload: unknown): boolean {
  const win = mainWindow;
  if (win === null || win.isDestroyed()) return false;
  try {
    win.webContents.send(channel, payload);
    return true;
  } catch (error) {
    console.warn('[dsh-chamber] dshDesktop 推送失败：', describeUnknownError(error));
    return false;
  }
}

/**
 * dshDesktop.shortcuts-* 的 main 处理器（rc.2 官方 preload 的 keyboard/shortcut
 * 面）：get/edit 的语义与校验在 DesktopShortcutsBridge（upstream protocol），
 * 此处只做 IPC 接线；trustedIpc 围栏由调用方包装（design 05 §7.4 sender fence
 * 对 dshDesktop 面同样生效）。
 */
function registerDesktopShortcutsIpc(bridge: DesktopShortcutsBridge, trustedIpc: TrustedIpc): void {
  ipcMain.handle(DESKTOP_SHORTCUTS_CHANNELS.GET, trustedIpc((input: unknown) => bridge.get(input)));
  ipcMain.handle(DESKTOP_SHORTCUTS_CHANNELS.EDIT, trustedIpc((input: unknown, revision: unknown) => bridge.edit(input, revision)));
  ipcMain.handle(DESKTOP_SHORTCUTS_CHANNELS.RECORDING, trustedIpc((active: unknown) => {
    const ignore = bridge.recording(active);
    const win = mainWindow;
    if (win !== null && !win.isDestroyed()) win.webContents.setIgnoreMenuShortcuts(ignore);
  }));
  ipcMain.handle(DESKTOP_SHORTCUTS_CHANNELS.CLOSE_WINDOW, trustedIpc((expected: unknown) => {
    const win = mainWindow;
    if (win === null || win.isDestroyed()) return;
    if (bridge.closeWindow(expected, { focused: win.isFocused(), enabled: win.isEnabled() })) win.close();
  }));
}

const builtinDshWorkspace = resolveBuiltinDshWorkspace();
if (builtinDshWorkspace === null) {
  console.warn(
    '[dsh-chamber] 未找到 dsh 工作区（DSH_CHAMBER_DSH_PATH / <repoRoot>/ref-dsh / <pkg>/vendor/dsh 均不可用），连接页将显示错误',
  );
}

let mainWindow: BrowserWindow | null = null;
// rc.2 官方 shortcuts 客户端的原生键盘桥（协议来自活动 runtime 树；null = 未接线）。
let shortcutsBridge: DesktopShortcutsBridge | null = null;
let controlPlane: PlaneHandle | null = null;
// 共享宿主装配（与 Swift sidecar 同一份）：whenReady 装配后赋值；
// will-quit/before-quit 经它读退出事实与回收腿。
let hostAssembly: HostAssembly | null = null;
let tray: Tray | null = null;
// 当前窗口 URL（控制面 origin）。窗口被关闭后可据此重建——没有它，窗口
// 一旦关闭应用就永久无窗。
let mainWindowUrl: string | null = null;

// 主窗口 'show' 事件订阅面（HostEdges.onMainWindowShown 的装配侧注册点；
// mainWindow===win 身份守卫在 createMainWindow glue）。
const mainWindowShownSubscribers = new Set<() => void>();

// Chamber settings: loaded at startup from <userData>/chamber-settings.json,
// mutated via dsh-chamber:settings-set. The side effects (keep-awake / login
// autostart / close behavior) are applied in the main process — never in any
// instance's dsh home.
let chamberSettings: ChamberSettings = { ...DEFAULT_CHAMBER_SETTINGS };
let keepAwakeBlockerId: number | null = null;
// Quit state machine: quitRequested 置位后关窗不再 hide（退出在途）；
// quitConfirmed 表示退出已获确认/豁免；confirmingQuit 是确认对话框单飞闸。
let quitRequested = false;
let quitConfirmed = false;
let confirmingQuit = false;
// 启动失败恢复（C4，design 25 §6 / 计划 §12.10）：单次呈现门 + 重启腿单飞 +
// 退出清理链单飞 promise + 目录锁句柄（重启腿要在 app.exit(0) 前显式释放：
// app.exit() 不保证 'quit' 事件，而 chamber-lock 的 release() 幂等）。
let startupRecoveryShown = false;
let recoveryRelaunchInProgress = false;
let quitCleanupPromise: Promise<void> | null = null;
let chamberLockHandle: { release(): void } | null = null;

// 「重启并安装」在途标志。quitAndInstall 在 macOS 上先关闭全部窗口再退出，
// 而 hide-to-tray 只在 quitRequested 后才放行关窗——若被 hide 吞掉，窗口消失、
// 进程（连同本地 dsh 与隧道）永久留存、更新永不安装。控制器的
// onQuitAndInstallArmed 在调用 quitAndInstall 之前置位（关窗发生在调用内部），
// 原生退出每次到达重新武装，失败/停滞由状态订阅撤回。
let updaterQuitArmed = false;
// 原生更新器退出兜底计时器（见 armNativeUpdaterQuit）。
let updaterQuitFallback: ReturnType<typeof setTimeout> | null = null;

/** 更新退出兜底宽限期：原生 before-quit-for-update 已发出后正常腿应立即退出
 *  （win: setImmediate；mac: 原生终止）；超过 5s（与退出清理上限同量级）仍未
 *  进入退出序列，就由主进程接管退出。 */
const UPDATER_QUIT_FALLBACK_MS = 5_000;

/** 武装「更新退出腿」：期间关窗一律真正关闭，绝不 hide 到托盘。 */
function armUpdaterQuit(): void {
  if (updaterQuitArmed) return;
  updaterQuitArmed = true;
  console.log('[dsh-chamber] 更新重启已武装：更新退出腿的关窗不再隐藏到托盘');
}

/** 撤回武装（重启失败/停滞，或本次调用什么都没武装）：恢复正常关窗语义。 */
function disarmUpdaterQuit(reason: string): void {
  if (updaterQuitFallback !== null) {
    clearTimeout(updaterQuitFallback);
    updaterQuitFallback = null;
  }
  if (!updaterQuitArmed) return;
  updaterQuitArmed = false;
  console.warn(`[dsh-chamber] 更新重启未成立（${reason}），恢复关窗到托盘语义`);
  // 把主窗口拉回来——无窗口常驻绝不能是「更新卡住」的表现形式。
  if (mainWindow === null || mainWindow.isDestroyed()) showMainWindow();
}

/** 原生更新器正在关窗退出（autoUpdater `before-quit-for-update`，在
 *  quitAndInstall 内部、关窗之前发出）。两件事：1) 武装关窗豁免——这次关窗属于
 *  安装退出腿，绝不能被 hide 吞掉；2) 兜底自退——macOS 原生腿只关窗、不保证走到
 *  app.quit()，宽限期后仍未退出就由主进程走正常清理路径。此刻退出是安全的：该
 *  事件只在 Squirrel 已完成 staging 后发出，退出即安装。 */
function armNativeUpdaterQuit(): void {
  armUpdaterQuit();
  if (updaterQuitFallback !== null) return;
  updaterQuitFallback = setTimeout(() => {
    updaterQuitFallback = null;
    // 三个守卫（退出在途 / 武装已撤回 / 窗口仍在）是纯判定
    // shouldUpdaterQuitTakeOver：原生腿没走到关窗就绝不能无预警把应用拽下去，
    // 那种情况交给 60s 停滞 watchdog 呈现与恢复。
    const windowAlive = mainWindow !== null && !mainWindow.isDestroyed();
    if (!shouldUpdaterQuitTakeOver(quitRequested, updaterQuitArmed, windowAlive)) return;
    console.warn('[dsh-chamber] 原生更新退出腿未完成退出：进程仍在，改由主进程 app.quit()（已 staged 的更新随退出安装）');
    app.quit();
  }, UPDATER_QUIT_FALLBACK_MS);
  updaterQuitFallback.unref?.();
}
// Runtime 生命周期门与退出事实全部归共享装配——本文件不再持有运行时状态。
let willQuitCleanupComplete = false;

/** Minimal tray（打包态 + 图标资源存在才创建）：状态 tooltip + 显示/退出菜单。
 *  Defensive by construction — any failure skips the tray with a log and never
 *  blocks startup; dev checkouts log the skip reason. */
function maybeCreateTray(cp: PlaneHandle) {
  if (!app.isPackaged) {
    console.log('[dsh-chamber] 跳过托盘：开发模式（app.isPackaged=false）');
    return;
  }
  // 候选 = 打包资源 resources/icon.png（extraResources 拷入 resources/ 根）。
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
    // 原生 chrome 文案走 shell-locale（上游 locale.ts 的等价物）：tray/对话框
    // 由壳自己渲染，页面 i18n 管不到它们。
    const copy = shellStrings(app.getLocale());
    tray.setToolTip(`dsh-chamber · ${copy.controlPlane} http://127.0.0.1:${cp.port} · ${cp.connectionState}`);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: copy.trayShowWindow,
          click: () => showMainWindow(),
        },
        { type: 'separator' },
        // Quit goes through before-quit → will-quit cleanup.
        { label: copy.trayQuit, click: () => app.quit() },
      ]),
    );
    console.log('[dsh-chamber] 托盘已创建');
  } catch (error) {
    tray = null;
    console.warn('[dsh-chamber] 托盘创建失败，跳过：', describeUnknownError(error));
  }
}

/** 深链协议注册：`app.isPackaged` 门控——开发态注册会把裸 Electron 注册成
 *  scheme handler，污染 LaunchServices/注册表并与打包身份冲突。打包形态用无
 *  relaunch args 形态：argv[1] 可能正是本次冷启动 URL，固化会毒化后续启动；
 *  setAsDefaultProtocolClient 统一兜底（同目标幂等）。失败 loud，绝不打断启动。 */
function registerDeepLinkProtocol(): void {
  const decision = decideDeepLinkProtocolRegistration({ isPackaged: app.isPackaged, platform: process.platform });
  if (decision.action === 'skip') return;
  // Packaged Linux uses the same no-args form as macOS; argv[1] may be the
  // cold-start URL, and persisting it as a relaunch arg poisons later launches.
  // Linux rewrites the per-user handler entry on EVERY launch: it must target
  // the running AppImage ($APPIMAGE), whose path changes on upgrade — a stale
  // Exec would silently break `dsh-chamber://`.
  if (process.platform === 'linux') {
    const launchExecutable = resolveLinuxLaunchExecutable({ execPath: process.execPath });
    const ensured = ensureLinuxProtocolDesktopFile({
      executable: launchExecutable,
    });
    if (!ensured.ok) {
      console.error(`[dsh-chamber] Linux 协议 .desktop 写入失败：${ensured.error}`);
    }
    // Electron's Linux registration resolves the handler .desktop through
    // $CHROME_DESKTOP, which the AppImage runtime usually does not export, so
    // point it at OUR per-user entry unless the launcher already chose one.
    process.env.CHROME_DESKTOP ??= 'dsh-chamber.desktop';
  }
  const result = attemptDeepLinkProtocolRegistration(() => app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME));
  if (!result.ok) {
    console.error(`[dsh-chamber] 深链协议注册失败：${result.error}`);
  }
}

/** 显示/恢复主窗口；窗口已关闭时按控制面 origin 重建。Dock activate /
 *  second-instance / 托盘菜单共用这条恢复路径——没有重建分支时，窗口一旦关闭
 *  应用就以无窗口状态常驻，点任何入口都毫无反应。 */
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

/** keep-awake：powerSaveBlocker prevent-app-suspension。 */
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

/** Windows 打包态身份：通知 AUMID、登录自启 Run 值名与卸载器三处必须同一个
 *  字面量；省略 `name` 时 Electron 写/读 AUMID，显式钉住既不改写读回语义，
 *  又让卸载器有确定的键名（scripts/nsis-uninstall-cleanup.nsh）。 */
const WINDOWS_APP_USER_MODEL_ID = 'com.dshchamber.desktop';

/** 登录自启：macOS/Windows setLoginItemSettings；Linux 手写最小 XDG
 *  .desktop。卸载残留由 NSIS 卸载段清理。失败 loud 返回 {error}，绝不静默假成功。 */
function applyLaunchAtLogin(enabled: boolean): { ok: true } | { ok: false; error: string } {
  try {
    if (process.platform === 'darwin' || process.platform === 'win32') {
      // Windows 显式钉 `name` = AUMID：与 Electron 默认键名逐字相同（回读不
      // 受影响），从此由本仓单一常量决定，卸载器按同一名字清理。macOS 保持
      // openAtLogin-only 不变（`name` 是 Windows 专属选项）。
      if (process.platform === 'win32') {
        app.setLoginItemSettings({ openAtLogin: enabled, name: WINDOWS_APP_USER_MODEL_ID });
      } else {
        app.setLoginItemSettings({ openAtLogin: enabled });
      }
      // 写完必须回读——OS 可能静默拒绝，macOS 还可能停在 requires-approval
      // （此时根本不会自启）；绝不无回读地回 {ok:true}。
      const observed = app.getLoginItemSettings();
      const verdict = verifyLaunchAtLoginReadBack(enabled, observed, process.platform);
      if (!verdict.ok) {
        console.warn(`[dsh-chamber] 登录自启写入后回读不符：${verdict.error}`);
      }
      return verdict;
    }
    // Linux XDG autostart: honor an absolute XDG_CONFIG_HOME and target the
    // RUNNING AppImage ($APPIMAGE) — execPath under an AppImage is the per-launch
    // squashfs mount, dead after reboot.
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
      // Env-change hygiene: remove the entry under the OTHER XDG_CONFIG_HOME
      // resolution too — disabling must never leave a live entry with ok:true.
      const legacyFile = path.join(os.homedir(), '.config', 'autostart', 'dsh-chamber.desktop');
      if (legacyFile !== desktopFile) rmSync(legacyFile, { force: true });
    }
    // 文件面同样纪律：写入/删除后回读目标态，绝不无验证地回 {ok:true}。
    if (existsSync(desktopFile) !== enabled) {
      return {
        ok: false,
        error: `autostart entry read-back mismatch: requested enabled=${enabled}, observed ${existsSync(desktopFile)}`,
      };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: describeUnknownError(error) };
  }
}

/** 渲染进程崩溃/卡死恢复（有界自动重载）：60s 窗口内至多重载 3 次，超出即
 *  大声失败（错误框一次，绝不静默白屏）；正常退出不重载。 */
function installRendererRecovery(win: BrowserWindow): void {
  // 预算/门判定走 shell-core 共享纯函数（Swift RendererRecoveryPolicy/
  // HangWatchdog 同参数），本文件只留计时器与窗口销毁守卫。
  const reloadBudget: RendererReloadBudgetState = { windowStart: 0, count: 0 };
  // 首次加载完成标志：boot（加载数十个插件模块）期间主线程长时间忙碌是合法
  // 的，unresponsive 只在成功加载过之后才触发重载，避免打断正常启动。
  let loadedOnce = false;
  let recoveryGaveUp = false;
  let unresponsiveTimer: NodeJS.Timeout | null = null;
  let crashReloadTimer: NodeJS.Timeout | null = null;
  const frameWatchdog = new RendererFrameWatchdog();
  // The page delivery owner consumes the same strike evidence the shell acts on
  // (schedule stall / input block); the push is transient and re-emitted on every
  // counter change, so a push lost while the renderer was replacing its listener is
  // simply superseded by the next observation.
  frameWatchdog.onChange = observation => {
    if (quitRequested || win.isDestroyed() || win.webContents.isDestroyed()) return;
    win.webContents.send(IPC_CHANNELS.RENDERER_STALL_EVIDENCE, {
      scheduleStrikes: observation.scheduleStrikes,
      inputBlockStrikes: observation.inputBlockStrikes,
      at: Date.now(),
    });
  };
  let frameProbeTimer: NodeJS.Timeout | null = null;
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
    if (quitRequested || win.isDestroyed() || recoveryGaveUp) return;
    frameWatchdog.reset();
    clearUnresponsiveTimer();
    // A crash deferral inside the 500ms teardown window must not stack a second
    // reload and burn a budget slot.
    clearCrashReloadTimer();
    const { allowed, attempt } = noteRendererReload(reloadBudget, Date.now());
    if (allowed) {
      console.warn(`[dsh-chamber] 渲染器异常或无进度，尝试重载 (${attempt}/${RENDERER_RECOVERY_MAX_RELOADS})`);
      win.setTitle('dsh-chamber-electron — 正在恢复');
      win.webContents.reload();
    } else {
      recoveryGaveUp = true;
      console.error('[dsh-chamber] 渲染器反复异常或无进度，停止自动恢复');
      const copy = shellStrings(app.getLocale());
      reportFatalStartupFailure(
        { title: copy.rendererCrashedTitle, detail: copy.rendererCrashedMessage },
        'startup',
      );
    }
  };
  win.webContents.on('did-start-loading', () => {
    loadedOnce = false;
    frameWatchdog.reset();
    clearUnresponsiveTimer();
    clearCrashReloadTimer();
  });
  win.webContents.on('did-finish-load', () => {
    loadedOnce = true;
    recoveryGaveUp = false;
    frameWatchdog.reset();
    win.setTitle('dsh-chamber-electron');
    // ready() can run while late subresources still keep isLoading() true.
    // The first drain then correctly holds; finish is the deterministic replay
    // edge. Guard window identity so an old window cannot drain/reset a newer
    // main window's queues (drains + ready bits live in shell-core —
    // this glue only forwards the lifecycle event of the current main window).
    if (mainWindow === win) {
      onRendererLifecycle('did-finish-load');
    }
  });
  // 渲染端 console 证据通道：只收 error 级、只进有界环（64KiB），绝不转发/外发。
  // Electron 43 的 console-message 既有旧式位置参数也有 details 对象，两种都收。
  win.webContents.on('console-message', (...args: unknown[]) => {
    pushConsoleMessage(rendererConsoleRing, args);
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    frameWatchdog.reset();
    clearUnresponsiveTimer();
    clearCrashReloadTimer();
    // 终止原因进同一份报告（此前只进 console，退出码/reason 随进程消失）。
    try {
      noteFatalReport({
        event: 'renderer-gone',
        phase: 'running',
        detail: '渲染进程终止：reason=' + details.reason + ' exitCode=' + details.exitCode,
        extras: ['reason=' + details.reason, 'exitCode=' + String(details.exitCode)],
      });
    } catch { /* 报告失败不改恢复语义 */ }
    // 用户关窗/退出等正常路径（判定单源 = shouldReloadAfterCrash）。
    if (!shouldReloadAfterCrash(details.reason, quitRequested)) return;
    // 通知就绪标志立即失效：崩溃到 reload 之间没有导航事件，不重置则向死
    // frame 推送丢事件（ready 位复位 + in-flight 重排在 shell-core）。
    if (mainWindow === win) {
      onRendererLifecycle('crashed');
    }
    console.error(
      `[dsh-chamber] 渲染进程退出：reason=${details.reason} exitCode=${details.exitCode}`,
    );
    // 稍候重载，避开崩溃拆除期（立即 reload 会与拆除竞争）。
    crashReloadTimer = setTimeout(() => {
      crashReloadTimer = null;
      reload();
    }, RENDERER_CRASH_RELOAD_DELAY_MS);
  });
  win.webContents.on('unresponsive', () => {
    if (!shouldScheduleHangReload(loadedOnce)) {
      console.warn('[dsh-chamber] 渲染进程无响应（首次加载中，仅记录不重载）');
      return;
    }
    if (unresponsiveTimer !== null) return;
    console.warn('[dsh-chamber] 渲染进程无响应，15s 内未恢复将重载');
    unresponsiveTimer = setTimeout(() => {
      unresponsiveTimer = null;
      reload();
    }, RENDERER_HANG_RELOAD_DELAY_MS);
  });
  win.webContents.on('responsive', clearUnresponsiveTimer);
  const frameProbeAllowed = (): boolean => loadedOnce && !quitRequested && !recoveryGaveUp
    && !win.isDestroyed() && !win.webContents.isDestroyed()
    && win.isVisible() && !win.isMinimized() && win.isFocused()
    && !win.webContents.isLoading() && crashReloadTimer === null;
  const resolveFrameProbe = (id: number, result: unknown, failed: boolean, rttMs: number): void => {
    if (!frameProbeAllowed()) { frameWatchdog.reset(); return; }
    // The page may become hidden between the native visibility check and the
    // JS read. `null` is an explicit suspension, not a failed frame. A stale
    // callback is fenced by its probe id inside suspended().
    if (!failed && result === null) { frameWatchdog.suspended(id); return; }
    const action = failed || typeof result !== 'number' || !Number.isSafeInteger(result)
      ? frameWatchdog.failed(id)
      : frameWatchdog.succeeded(id, result, rttMs);
    if (action.kind === 'reload') {
      console.warn('[dsh-chamber] 可见页面 JS/rAF 连续无进度或 JS 线程连续延迟，执行有界重载');
      reload();
    } else if (action.kind === 'input-block') {
      // 主进程 → 渲染器 → 主进程的往返延迟：JS 线程被长任务占住（rAF 可能仍在走）。
      // 单次只作为证据记录并计数；连续超预算才升级重载（同一 strike 上界）。
      console.warn(
        `[dsh-chamber] 可见页面 JS 线程延迟证据：探针往返 ${action.rttMs}ms 超预算 ${RENDERER_INPUT_BLOCK_RTT_MS}ms`,
      );
    }
  };
  // Chromium's unresponsive event sees a blocked main thread. This probe also
  // sees a page that can answer JS while its animation-frame loop is stopped.
  // It runs only while the main window is focused and visible; background frame
  // throttling is expected and cannot count as renderer failure.
  frameProbeTimer = setInterval(() => {
    if (!frameProbeAllowed()) { frameWatchdog.reset(); return; }
    const action = frameWatchdog.tick(performance.now());
    if (action.kind === 'reload') {
      console.warn('[dsh-chamber] 可见页面 JS 探针连续超时，执行有界重载');
      reload();
    } else if (action.kind === 'probe') {
      try {
        const startedAt = Date.now();
        void win.webContents.executeJavaScript(RENDERER_FRAME_PROGRESS_SCRIPT).then(
          result => resolveFrameProbe(action.id, result, false, Date.now() - startedAt),
          () => resolveFrameProbe(action.id, undefined, true, 0),
        );
      } catch {
        resolveFrameProbe(action.id, undefined, true, 0);
      }
    }
  }, 1_000);
  // Paint freeze without a renderer stall: a crashed GPU process leaves the
  // window surface frozen while the page keeps scheduling frames. The reload is
  // the only in-shell recovery and stays inside the same bounded reload budget.
  const onChildProcessGone = (
    _event: unknown,
    details: { readonly type: string; readonly reason: string; readonly exitCode: number },
  ): void => {
    if (!shouldReloadAfterChildProcessGone(details.type, details.reason, quitRequested)) return;
    console.warn(
      `[dsh-chamber] GPU 进程退出（reason=${details.reason} exitCode=${details.exitCode}）——画面合成已失效，执行有界重载`,
    );
    reload();
  };
  app.on('child-process-gone', onChildProcessGone);
  win.on('closed', () => {
    app.off('child-process-gone', onChildProcessGone);
    if (frameProbeTimer !== null) clearInterval(frameProbeTimer);
    frameProbeTimer = null;
    frameWatchdog.reset();
    clearUnresponsiveTimer();
    clearCrashReloadTimer();
  });
}

/** 非可信导航统一处理（will-navigate / will-redirect 共用，与
 *  setWindowOpenHandler 同款 scheme + 同源白名单）：非 shell 文档导航一律
 *  preventDefault；外链（外部 http(s)/mailto）转交系统默认处理器——否则
 *  mailto:（不带 target，走导航事件）仍是死链。 */
function handleUntrustedNavigation(event: { preventDefault(): void }, url: string, rendererOrigin: string): void {
  if (isTrustedRendererUrl(url, rendererOrigin)) return;
  event.preventDefault();
  if (isExternalLinkUrl(url, rendererOrigin)) {
    openExternally(url);
  }
}

/** 创建主窗口（单 frame，控制面 origin）。启动期与 activate 重建共用：
 *  fatalOnLoadFailure=true 时加载失败 = 大声失败 + 退出；重建路径只记录。 */
function createMainWindow(rendererOrigin: string, fatalOnLoadFailure: boolean): BrowserWindow | null {
  // Normalize a possibly-trailing-slash origin: appending unconditionally would
  // produce a `//`-leading path that `new URL('//', base)` rejects and crashes
  // the control plane's request handler.
  const url = `${rendererOrigin.replace(/\/+$/, '')}/`;
  mainWindowUrl = url;
  // 沙箱 preload 只接受 build:preload 的 dist/preload.cjs（纯 CJS）；源码
  // preload.cts 不能作静默回退（沙箱/CJS 下会 SyntaxError）——缺失即 loud 失败。
  const preloadPath = path.join(pkgDir, 'dist', 'preload.cjs');
  if (!existsSync(preloadPath)) {
    // 缺失 = 安装/构建回归，必须 loud：打包态 stderr 不可见，统一走启动失败
    // 对话框 + 退出（与 loadURL 失败同 UX）。
    const message = `preload 构建产物缺失：${preloadPath}（先运行 build:preload）`;
    console.error(`[dsh-chamber] ${message}`);
    reportFatalStartupFailure(
      { title: shellStrings(app.getLocale()).startupFailedTitle, detail: message },
      'startup',
    );
    return null;
  }
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    // Windows：上游形态（官方 desktop main 的 win32 分支）——隐藏系统标题栏，
    // 由 titleBarOverlay 提供 caption 区；页面按 preload 打的 [data-windows-titlebar]
    // 与 --dsh-windows-titlebar-height 布局（无该标记时仍是普通标题栏）。
    // 其余平台保持首帧底色（与 dsh 前端深色主题一致，消除白屏闪烁）。
    ...(process.platform === 'win32'
      ? {
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: {
            height: WINDOWS_TITLEBAR_HEIGHT,
            color: nativeTheme.shouldUseDarkColors ? '#1b1b1c' : '#f9fafb',
            symbolColor: nativeTheme.shouldUseDarkColors ? '#f9fafb' : '#0f1115',
          },
        }
      : { backgroundColor: '#0f1115' }),
    // 固定窗口标题：官方前端会把当前会话名投影到 document.title，不拦截
    // page-title-updated 则原生标题栏随选中会话变化。
    title: 'dsh-chamber-electron',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      // Keep Electron's renderer sandbox explicit: this window only needs the
      // narrow contextBridge surface, never Electron/Node powers.
      sandbox: true,
      // backgroundThrottling 保持默认：关闭它会让 Electron 永久抑制隐藏态
      // （rAF 仍 120/s、visibilityState 恒 visible），隐藏期 renderer CPU 显著
      // 升高；默认节流下 SSE（网络流）不受影响，唤醒即时重连由 powerMonitor
      // resume 的 IPC 推送驱动，不依赖隐藏期计时器。
    },
  });
  mainWindow = win;
  // 冻结窗口标题：不 preventDefault 则原生标题栏跟随会话切换。
  win.on('page-title-updated', (event) => {
    event.preventDefault();
  });
  // The preload exposes host-impacting IPC: keep it confined to the exact
  // control-plane document — never open a popup/new WebContents (it would inherit
  // the bridge), cancel cross-origin navigation/redirects, and hand genuinely
  // external http(s)/mailto targets to the OS while always denying the window.
  // Same-origin targets, file:/custom schemes and parse failures stay denied.
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
  // rc.2 原生键盘门（upstream keyboard.ts before-input-event 语义）：只有命中已
  // 接受命令目录的组合才 preventDefault + 投递；其余键保持正常 DOM 交付。
  const shortcuts = shortcutsBridge;
  if (shortcuts !== null) {
    shortcuts.resetInput();
    win.webContents.on('before-input-event', (event, input) => {
      const focused = win.webContents.focusedFrame;
      const frameName = focused === null ? null
        : focused === win.webContents.mainFrame ? '' : focused.name;
      const decision = shortcuts.handleKeyEvent(desktopKeyEvent(input, frameName, win.isFocused() && win.isEnabled()));
      win.webContents.setIgnoreMenuShortcuts(decision.ignoreMenuShortcuts);
      if (decision.preventDefault) event.preventDefault();
      if (decision.input !== null) win.webContents.send(DESKTOP_SHORTCUTS_CHANNELS.INPUT, decision.input);
    });
    win.webContents.on('blur', () => {
      shortcuts.resetInput();
      win.webContents.setIgnoreMenuShortcuts(false);
    });
    win.on('blur', () => { shortcuts.resetInput(); });
    win.webContents.on('did-start-navigation', (navigation) => {
      // 主 frame 导航（重载/换实例根）重建接受态：旧目录不得继续拦截新文档。
      if (navigation.isMainFrame && !navigation.isSameDocument) shortcuts.clearCatalog();
    });
    win.on('closed', () => { shortcuts.resetInput(); });
  }
  installRendererRecovery(win);
  // 通知点击的重建竞态兜底：点击时窗口若在重建/加载中，打开意图入队，renderer
  // 就绪后统一补发。就绪标志重置点选 did-start-loading（而非 did-finish-load）：
  // finish 可能被慢子资源拖到 ready() 之后，在 finish 重置会把已置位标志
  // clobber 成永久 false；start-loading 必先于页面脚本执行（invoke 恒在其后）。
  // （ready 位复位/requeue/drain 在 shell-core，本 glue 只转发事件。）
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
  // 关窗到托盘：hide-to-tray 且存在恢复入口（win/linux 需托盘；macOS Dock
  // 常驻）且非退出在途 → hide（不 destroy），控制面/传输层/dsh 继续运行；托盘
  // 缺失时回退关窗即退——绝不允许窗口隐藏后无恢复入口。更新退出腿
  // （updaterQuitArmed）例外：hide 会截断 quitAndInstall 的退出链。
  win.on('close', (event) => {
    const recoveryAvailable = process.platform === 'darwin' || tray !== null;
    // close 决策走纯函数 decideMainWindowClose。hide 分支保持 hide；任何会走到
    // 退出的 close 一律 defer：先 preventDefault，把窗口留到退出决策拍板之后
    // ——窗口先销毁会让取消退出只能重建 = 整页重载；Swift 腿则原地 resume。
    const closeAction = decideMainWindowClose({
      behavior: chamberSettings.windowCloseBehavior,
      recoveryAvailable,
      quitRequested,
      quitConfirmed,
      updateRestartArmed: updaterQuitArmed,
    });
    if (closeAction === 'hide') {
      event.preventDefault();
      win.hide();
      return;
    }
    if (closeAction === 'defer-quit') {
      // 决策在 before-quit：窗口此刻仍存活；确认后重触发 close 才真正销毁。
      event.preventDefault();
      app.quit();
    }
  });
  // 无窗口常驻期间的唤醒事件由 core held，窗口恢复可见时一次性补发（补发在
  // shell-core；此处经 mainWindowShownSubscribers 通知订阅面）。
  win.on('show', () => {
    if (mainWindow !== win) return;
    for (const subscriber of mainWindowShownSubscribers) {
      try { subscriber(); } catch (error) {
        try { console.warn(`[dsh-chamber] 主窗口 show 订阅回调失败：${describeUnknownError(error)}`); } catch { /* subscriber boundary must never throw */ }
      }
    }
  });
  void win.loadURL(url).catch((loadError) => {
    // Closing/quitting intentionally aborts navigation: not a startup failure.
    if (quitRequested || win.isDestroyed()) return;
    const detail = describeUnknownError(loadError);
    if (fatalOnLoadFailure) {
      reportFatalStartupFailure(
        { title: shellStrings(app.getLocale()).startupFailedTitle, detail: `前端加载失败：\n${detail}` },
        'startup',
      );
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
    // Win/Linux 二次启动：无深链 argv → 仅恢复窗口；深链 argv 且 quit 在途 →
    // ignore（不重建窗口）；否则入队并恢复窗口。
    const urls = scanDeepLinkUrls(commandLine);
    if (urls.length === 0) {
      showMainWindow();
      return;
    }
    if (quitRequested) return;
    for (const url of urls) enqueueDeepLink(url);
    showMainWindow();
  });

  // macOS 深链：冷启动 URL 先于 startup 完成到达，必须入队；与 argv 扫描的
  // 双触发由归一化 intent key 去重。注册在 whenReady 之前，冷启动 URL 不丢。
  app.on('open-url', (event, url) => {
    event.preventDefault();
    enqueueDeepLink(url);
  });

  // 终止信号转 app.quit() 优雅路径：will-quit 先回收传输层/控制面/本地 dsh，
  // 不让 detached 子进程成孤儿。macOS Electron 43 主进程的 process.on('SIGTERM')
  // 不触发（Chromium 消费信号并走自身优雅退出），本 handler 在 macOS 是死代码，
  // 保留给 linux/win。信号是明确退出意图，跳过确认框（quitConfirmed 提前置位）。
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      if (quitRequested) return;
      quitRequested = true;
      quitConfirmed = true;
      app.quit();
    });
  }

  // macOS Dock 点击：没有此处理时，窗口关闭（darwin 不退出）后点图标毫无反应。
  app.on('activate', () => {
    showMainWindow();
  });

  app.on('window-all-closed', () => {
    // macOS 默认常驻（Dock 恢复入口），但设置 = quit 的关窗意图是退出：darwin
    // 也走 app.quit()。该路径的窗口在确认前不会被销毁（close 被 defer），取消
    // 即原地存活；本条仍覆盖其它真正关完窗的退出腿。非 darwin 恒退出。
    if (process.platform !== 'darwin' || chamberSettings.windowCloseBehavior === 'quit') app.quit();
  });

  // 退出确认在 before-quit（窗口关闭前）拦截：显式退出仅在「确认开关开启 且
  // 本地 dsh 实例运行中」时先确认（远程隧道不影响关闭）；更新已下载待装时豁免。
  // 关键时序：close-to-tray 的 close 处理器靠 quitRequested 区分退出在途 vs
  // 普通关窗，而 will-quit 要等窗口全关后才触发——在 will-quit 内置位已太晚
  // （close 会先 hide+preventDefault 吞掉退出）。before-quit 先置位/拦截：确认后
  // 重触发才放行，取消时窗口从未关闭。async handler 的 preventDefault 在第一个
  // await 前同步执行；await 只用于把确认框失败统一进 try/catch。
  app.on('before-quit', async (event) => {
    if (quitConfirmed) return; // 已确认/豁免：放行（重入）
    const cp = controlPlane;
    if (cp === null) {
      // 控制面未就绪：无可保护内容，放行；必须同时置位确认位，否则 defer 分支
      // 重入 app.quit() 会与 close 形成自递归（窗口永远关不掉）。
      quitRequested = true;
      quitConfirmed = true;
      return;
    }
    if (confirmingQuit) {
      event.preventDefault(); // 确认框已打开：忽略重入（单飞）
      return;
    }
    // 退出事实投影归装配侧（与 Swift sidecar 同源）；远程隧道不影响关闭——风险
    // 只看本地实例，确认开关关闭时永不确认。状态机显示 running 不够：必须有实际
    // 存活进程（restart backoff / 死亡未探活期间可能误报）。
    const quitFacts = hostAssembly?.quitFacts();
    const risk = computeQuitRisk({
      quitConfirmation: chamberSettings.quitConfirmation,
      localRunning: quitFacts?.localRunning ?? false,
      updateDownloadReady: quitFacts?.updateDownloadReady ?? false,
    });
    if (!risk.needsConfirm) {
      // 无风险或更新安装豁免：置位后直接放行（未 preventDefault），不再重入
      // app.quit()。
      quitRequested = true;
      quitConfirmed = true;
      return;
    }
    // 需确认：在关窗前拦截（风险计算在前，异常不会静默吞掉退出）。
    event.preventDefault();
    confirmingQuit = true;
    const copy = shellStrings(app.getLocale());
    const detail = `${copy.quitDetailPrefix}${risk.reasons.join(copy.quitDetailJoin)}${copy.quitDetailSuffix}`;
    try {
      await dialog.showMessageBox({
        type: 'warning',
        title: copy.quitConfirmTitle,
        message: copy.quitConfirmTitle,
        detail,
        buttons: [copy.quitButton, copy.cancelButton],
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
        // 取消：quitRequested 保持 false。窗口未先销毁（close 被 defer），这里
        // 原地恢复即可，绝不重建/重载页面（与 Swift 取消分支对偶）；SIGTERM 已
        // 置位退出在途则不恢复——取消对已确认的退出无效力。
        if (!quitRequested) showMainWindow();
      });
    } catch (error) {
      // showMessageBox 同步/异步失败都必须复位 confirmingQuit，否则后续所有
      // before-quit 都被单飞闸拦死、应用再也退不出。
      confirmingQuit = false;
      console.error('[dsh-chamber] 退出确认对话框失败，取消退出：', error);
      // 与取消同义：本次退出作废，原地恢复存活的窗口。
      if (!quitRequested) showMainWindow();
    }
  });

  app.on('will-quit', (event) => {
    if (willQuitCleanupComplete) return;
    // 真正退出在途（窗口已全部关闭）：close 分支不再 hide；keep-awake 停止。
    // 确认/豁免已在 before-quit 完成，这里只剩清理。
    quitRequested = true;
    setKeepAwakeActive(false);
    // 兜底清除未读徽标（曾有意图才触碰，避免无谓日志）；badge 清 0 / tray
    // destroy / keep-awake 停止等属宿主生命周期职责，依附 will-quit。
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
    event.preventDefault();
    // 清理链与恢复重启腿共享（单飞 promise）；完成后再 app.quit() 收尾。
    void runQuitCleanupChain().finally(() => {
      app.quit();
    });
  });

  app.whenReady().then(async () => {
    // Windows toast identity: native notifications require the AppUserModelID to
    // match the NSIS shortcut, so packaged builds bind Action Center reliably;
    // dev/portable builds stay best-effort. POSIX unaffected.
    if (process.platform === 'win32') app.setAppUserModelId(WINDOWS_APP_USER_MODEL_ID);
    // 冷启动深链 argv：macOS argv 含 -psn_ 噪声，防御式扫描（非深链零副作用、
    // 绝不 throw 打断启动）；与 open-url 双触发由去重兜底。
    for (const url of scanDeepLinkUrls(process.argv)) enqueueDeepLink(url);
    // HostEdges 的 Electron 实现：showMainWindow = 通知 click 激活腿；
    // onMainWindowShown = 主窗口 'show' 事件订阅面。
    const edges = createElectronEdges({
      mainWindow: () => mainWindow,
      showMainWindow: () => showMainWindow(),
      onMainWindowShown: subscriber => {
        mainWindowShownSubscribers.add(subscriber);
        return () => { mainWindowShownSubscribers.delete(subscriber); };
      },
    });
    const runtimeBaseDir = app.getPath('userData');
    // 双 flavor 跨进程互斥锁（Electron 侧 O_EXLOCK）：另一 flavor 持有则
    // fail-closed 拒绝启动，绝不让两个 writer 并发同一 registry/凭据/runtime 树。
    const chamberLock = acquireChamberLock({ userDataDir: runtimeBaseDir, shell: 'electron' });
    if (!chamberLock.ok) {
      console.error(`[dsh-chamber] ${chamberLock.error}`);
      reportFatalStartupFailure(
        { title: shellStrings(app.getLocale()).alreadyRunningTitle, detail: chamberLock.error },
        'already-running',
      );
      return;
    }
    // 句柄供恢复重启腿在 app.exit(0) 前显式释放（app.exit 不保证 'quit' 事件）。
    chamberLockHandle = chamberLock.handle;
    if (chamberLock.unsupported) {
      console.warn('[dsh-chamber] 目录锁：当前平台无 O_EXLOCK（Swift flavor 仅 macOS）——跨 flavor 互斥不适用');
    }
    // host-root 租约：<userData> 的写者身份，flock 之后、任何 runtime 元数据
    // 写入之前取得；失败同 flock（loud + 对话框 + exit 1）。
    let hostRootLease: ReturnType<typeof acquireHostRootLease> | null = null;
    try {
      hostRootLease = acquireHostRootLease(runtimeBaseDir, 'desktop');
    } catch (error) {
      const detail = describeHostRootLeaseFailure(error);
      console.error(`[dsh-chamber] ${detail}`);
      reportFatalStartupFailure(
        { title: shellStrings(app.getLocale()).startupFailedTitle, detail },
        'startup',
      );
      return;
    }
    // Release ONLY after the async cleanup finishes (releasing in a will-quit
    // listener would let another flavor take the lock while transports and
    // control-plane were still writing <userData>); `quit` fires after the
    // cleanup chain settled.
    app.on('quit', () => {
      // L2 先于 L1 释放：反序会让另一 flavor 取得 flock 后立刻撞上残留
      // owner.json 而被拒（瞬时假冲突）。两释放都幂等。
      try {
        hostRootLease?.release();
      } catch (error) {
        console.error('[dsh-chamber] host-root 租约释放失败：', error);
      }
      chamberLock.handle.release();
    });

    // Chamber settings：启动加载 + 应用副作用（keep-awake / 登录自启 reconcile）；
    // 损坏 loud（*.corrupt 保留），绝不静默假默认。先于 createHostAssembly
    // ——settings 内存 holder 是共享装配的注入依赖。
    const settingsLoad = readSettingsFile(chamberSettingsFilePath(runtimeBaseDir));
    if (settingsLoad.notice !== null) console.error(`[dsh-chamber] ${settingsLoad.notice}`);
    chamberSettings = settingsLoad.settings;
    setKeepAwakeActive(chamberSettings.keepAwake);
    // 损坏文件绝不触碰系统登录项——默认值只回落给内存/UI：文件被保留为
    // *.corrupt 后，下次启动仍判 corrupt 并 skip，绝不因状态衰减成 missing 而
    // 重放默认 false（真正无副本的缺失文件仍 replay 默认 false）。
    {
      const loginItemDecision = launchAtLoginReconcileDecision(settingsLoad.state, chamberSettings.launchAtLogin);
      if (loginItemDecision.action === 'skip') {
        console.warn('[dsh-chamber] chamber settings 损坏——本次启动不改动系统登录项（S-41）');
      } else {
        const loginItemResult = applyLaunchAtLogin(loginItemDecision.enabled);
        if (!loginItemResult.ok) {
          console.warn(`[dsh-chamber] 登录自启 reconcile 失败：${loginItemResult.error}`);
        }
      }
    }

    // Update controller: silent startup check + 6h interval; autoDownload=false —
    // checking never downloads (the download starts only on the user's「更新」
    // click), install is deferred to quit (autoInstallOnAppQuit, no mid-session
    // interruption), and the explicit restart goes through the normal before-quit/
    // will-quit cleanup. The state projection is non-secret (versions / channel /
    // release URL / short error text) and no failure blocks startup.
    const updater = createUpdateController({
      version,
      logger: {
        log: (...args) => console.log('[updater]', ...args),
        warn: (...args) => console.warn('[updater]', ...args),
        error: (...args) => console.error('[updater]', ...args),
      },
      // 更新退出腿的关窗豁免：控制器恰好在调用 quitAndInstall 之前同步回调；
      // 关窗一旦被 hide 吞掉，安装+重启链就地中断。只在真正武装的路径上触发，
      // 失败/停滞由状态订阅撤回。
      onQuitAndInstallArmed: armUpdaterQuit,
      // 原生更新器开始关窗退出：关窗豁免 + 兜底自退。
      onNativeUpdaterQuitting: armNativeUpdaterQuit,
      // Windows 任务栏注意力：seam 只在 win32 驱动当前主窗（macOS 继续走 app.dock.bounce，
      // 不双触发；无窗/已销毁静默）。每次调用实时读 mainWindow——窗口可能在检查期间重建/关闭。
      flashFrame: (on) => flashUpdateAttentionWindow(on, { window: mainWindow }),
    });
    // Gateway credentials store：token + password 镜像到 gateway-secrets.json
    // (schemaVersion 3, 0600, atomic write)，safeStorage 可用时加密（Keychain /
    // DPAPI / libsecret），否则走记录的 0600 明文回退。Never logged, never
    // returned to/prefilled in the renderer；无 credential-domain binding 的 legacy
    // 文件只保留为 unbound evidence 并禁用至重录。
    const gatewaySecretsCrypto = safeStorage.isEncryptionAvailable()
      ? {
        isAvailable: () => safeStorage.isEncryptionAvailable(),
        encrypt: (plain: string) => safeStorage.encryptString(plain).toString('base64'),
        decrypt: (blob: string) => safeStorage.decryptString(Buffer.from(blob, 'base64')),
      }
      : undefined;
    // On Windows DPAPI is available in every interactive session; an unavailable
    // keychain must NEVER silently fall back to a plaintext mirror (0600 cannot
    // be expressed there). The store is memory-only (file null), so credentials
    // last for the session and re-entry is required per connect.
    // Host package sources for the remote seed: packaged builds carry copies
    // under dist/; dev reads the same source dirs the local control-plane seed uses.
    const moduleASourceDir = app.isPackaged
      ? path.join(pkgDir, 'dist', 'host-graph-package')
      : path.join(repoRoot, 'packages', 'dsh-chamber-seed-client-graph');
    const gitWorktreeHostSourceDir = app.isPackaged
      ? path.join(pkgDir, 'dist', 'host-git-worktree-package')
      : path.join(repoRoot, 'packages', 'dsh-chamber-seed-git-worktree');
    const archiveCleanupHostSourceDir = app.isPackaged
      ? path.join(pkgDir, 'dist', 'host-archive-cleanup-package')
      : path.join(repoRoot, 'packages', 'dsh-chamber-seed-archive-cleanup');
    // Per-package SOURCE DIRS are desktop-specific (packaged vs repo); insert
    // id/name come from the control-plane registry, so a registry rename can
    // never drift from the seed list. This ONE map feeds the remote ssh seed
    // list and the gateway sync upload.
    const chamberHostSourceDirs: Record<string, string> = {
      [CLIENT_GRAPH_PACKAGE_NAME]: moduleASourceDir,
      [GIT_WORKTREE_PACKAGE_NAME]: gitWorktreeHostSourceDir,
      [ARCHIVE_CLEANUP_PACKAGE_NAME]: archiveCleanupHostSourceDir,
      // Registry rows marked `localOnly` are deliberately ABSENT: this map feeds
      // the two REMOTE consumers, and a local-shape-only domain must never reach
      // another machine (its dir is passed to the control plane separately).
    };
    // pnpm 入口解析：候选集/顺序/选择算法的唯一实现在 pnpm-launcher
    // ——packaged 走 <resourcesPath>/pnpm/...，dev 走 <pkgDir>/node_modules/pnpm/...；
    // 全缺失时保留安装形状（安装路径上的 loud 失败语义不变）。
    const pnpmEntryCandidates = bundledPnpmEntryCandidates({
      platform: process.platform,
      moduleDir: pkgDir,
      resourcesPath: app.isPackaged ? process.resourcesPath : null,
    });
    const pnpmEntry = firstExistingPnpmEntry(pnpmEntryCandidates, existsSync) ?? pnpmEntryCandidates[0];

    // —— 共享宿主装配（与 Swift sidecar 同一实现；本文件只保留宿主 edge 接线
    // 与差异注入）——装配顺序与 sidecar 同一权威：registry/凭据 → transportManager
    // → seed 目标闭包 → gateway 会话 refresh → 订阅 → runtime 启动事务宿主。
    const assembly = await createHostAssembly({
      logTag: '[dsh-chamber]',
      userDataDir: runtimeBaseDir,
      shellVersion: version,
      builtinDshWorkspace,
      edges: {
        rendererPush: (channel, payload) => edges.rendererPush(channel, payload),
        mainWindowAlive: () => mainWindow !== null && !mainWindow.isDestroyed(),
        retireNotificationsForSources: retiredSourceIds => edges.retireNotificationsForSources(retiredSourceIds),
        // 原生确认对话框腿：窗口在预检与调用间销毁 → 抛错 → 装配体折算
        // 'unavailable'。
        showNativeMessage: async (opts) => {
          const win = mainWindow;
          if (win === null || win.isDestroyed()) throw new Error('native confirmation unavailable');
          const { response } = await dialog.showMessageBox(win, opts);
          return response;
        },
      },
      settings: {
        current: () => chamberSettings,
        commit: next => { chamberSettings = next; },
      },
      setKeepAwake: enabled => setKeepAwakeActive(enabled),
      setLoginItem: enabled => applyLaunchAtLogin(enabled),
      isQuitting: () => quitRequested,
      markQuitting: () => { quitRequested = true; },
      hostFacts: { flavor: 'electron', trayPresent: () => tray !== null },
      gatewaySecretsCrypto,
      hostPackageSourceDirs: chamberHostSourceDirs,
      pnpmEntry,
      updateController: updater,
      disarmUpdaterQuit: reason => disarmUpdaterQuit(reason),
      // 退出确认豁免：更新已下载且无安装阻塞（autoInstallOnAppQuit 会装）→ 不弹确认。
      updateQuitExempt: () => {
        const state = updater.state();
        return state.phase === 'downloaded' && state.installBlockedReason === null;
      },
      pinnedRuntimeLockfilePath: () => resolvePinnedRuntimeLockfile(),
    });
    hostAssembly = assembly;

    try {
      const controlPlanePort = await resolveControlPlanePort();
      const portSourceLabel = process.env.DSH_CHAMBER_CP_PORT
        ? 'DSH_CHAMBER_CP_PORT 固定覆盖'
        : process.env.DSH_CHAMBER_ELECTRON_DEV === '1'
          ? 'dev 自动退避（17520 起，首个空闲端口）'
          : '打包默认';
      console.log(`[dsh-chamber] 控制面端口：${controlPlanePort}（${portSourceLabel}${controlPlanePort === 0 ? '；0 = 系统临时分配' : ''}）`);
      // C4 安全模式（design 25 §6 / 计划 §12.5）：env 不落盘，只影响本次进程；
      // 一行声明生效面，并显式传给控制面（选项优先于 env，两个读点不分叉）。
      const safeModeActive = isSafeModeEnabled(process.env);
      if (safeModeActive) {
        console.log(`[dsh-chamber] 安全模式生效（${SAFE_MODE_ENV}=1）：跳过 chamber 宿主包 seeding 与 extra rows 装载；下次普通启动自动恢复`);
      }
      controlPlane = createControlPlane({
        port: controlPlanePort,
        stateDir: stateRootDir(app.getPath('userData')),
        // 租约记录的诊断 flavor（冲突方读到「desktop」而不是笼统的 control-plane）。
        stateWriter: 'desktop',
        // 本地 dsh spawn 门 = 共享装配的 localSpawnGates（与 Swift sidecar 同一语义）。
        getDshWorkspacePath: () => assembly.localSpawnGates.getDshWorkspacePath(),
        canStartLocal: () => assembly.localSpawnGates.canStartLocal(),
        // A privileged activation may spawn a candidate while public starts remain
        // blocked; keep its HTTP/WS and ready projection quarantined until the full
        // probe verdict opens runtimeState.startBlocked.
        canExposeLocal: () => assembly.localSpawnGates.canExposeLocal(),
        // The built dsh frontend served by the control plane: <pkg>/dist/web in
        // dev and packaged alike (renderer owns dist/web only; preload and host
        // packages live beside it in dist/).
        webDistDir: path.join(pkgDir, 'dist', 'web'),
        safeMode: safeModeActive,
        // Host-graph package source: seeded into the local web profile at start
        // (dev source tree; packaged copy in dist/). Missing → graceful
        // degradation (no --patch overlay, v4 baseline spawn).
        hostGraphPackageSourceDir: app.isPackaged
          ? path.join(pkgDir, 'dist', 'host-graph-package')
          : path.join(repoRoot, 'packages', 'dsh-chamber-seed-client-graph'),
        hostGitWorktreePackageSourceDir: app.isPackaged
          ? path.join(pkgDir, 'dist', 'host-git-worktree-package')
          : path.join(repoRoot, 'packages', 'dsh-chamber-seed-git-worktree'),
        hostArchiveCleanupPackageSourceDir: app.isPackaged
          ? path.join(pkgDir, 'dist', 'host-archive-cleanup-package')
          : path.join(repoRoot, 'packages', 'dsh-chamber-seed-archive-cleanup'),
        // The open-in host domain is LOCAL-shape-only: the local profile is the
        // only target, so it is absent from `chamberHostSourceDirs` (the remote
        // seed list and the gateway upload both read that map).
        hostOpenInPackageSourceDir: app.isPackaged
          ? path.join(pkgDir, 'dist', 'host-open-in-package')
          : path.join(repoRoot, 'packages', 'dsh-chamber-seed-open-in'),
      });
      // plane 先绑定再 start：writers-quiescent 门启动期即读同一实例，
      // onLocalStateChange 订阅只接线一次。
      assembly.bindPlane(controlPlane);
      await controlPlane.start();
    } catch (err) {
      const detail = describeUnknownError(err);
      reportFatalStartupFailure(
        { title: shellStrings(app.getLocale()).startupFailedTitle, detail: `控制面启动失败：\n${detail}` },
        'startup',
      );
      return;
    }

    // Capture the non-null control plane before registering closures over it.
    const cp = controlPlane;
    const rendererOrigin = `http://127.0.0.1:${cp.port}`;
    // 宿主事实回填：装配体构造时 controlPlaneUrl 占位 ''，端口确定后写入。
    assembly.ctx.hostFacts.controlPlaneUrl = rendererOrigin;
    const trustedIpc = createTrustedIpc({
      isTrustedSender: event => {
        const win = mainWindow;
        return win !== null
          && !win.isDestroyed()
          && isTrustedIpcSender(event, win.webContents, rendererOrigin);
      },
      isQuitting: () => quitRequested,
    });

    // rc.2 原生键盘桥装配：官方 shortcuts 服务从实例 client graph 挂载，构造期
    // 要求 window.dshDesktop.keyboard；其 native input 又以
    // userData/keybindings.json 事务（main 侧唯一 revision 源）为准。协议实现从
    // 活动 runtime 树加载——页面加载的 client 半来自同一棵树，规范化/校验/revision
    // 无双源。协议缺失只降级到「壳可挂载、快捷键走 DOM 默认」，绝不半接线拦截。
    const activeRuntimePath = resolveActiveRuntime(runtimeBaseDir, builtinDshWorkspace).path;
    const shortcutProtocol = await loadDesktopShortcutProtocol([
      activeRuntimePath ?? '',
      builtinDshWorkspace ?? '',
    ]);
    if (shortcutProtocol === null) {
      console.error('[dsh-chamber] 未找到 dsh-client-shortcuts/protocol：原生键盘桥未接线'
        + '（dshDesktop.keyboard 仍存在，官方壳可挂载；快捷键停留在 DOM 默认）');
    } else {
      shortcutsBridge = new DesktopShortcutsBridge({
        protocol: shortcutProtocol,
        platform: process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux',
        storage: createKeybindingsStorage(path.join(runtimeBaseDir, 'keybindings.json')),
        send: pushToMainWindow,
      });
      registerDesktopShortcutsIpc(shortcutsBridge, trustedIpc);
      console.log('[dsh-chamber] rc.2 原生键盘桥已接线（偏好文件 = '
        + path.join(runtimeBaseDir, 'keybindings.json') + '）');
    }

    // OS 唤醒即时重探（传输层腿）：对 error/degraded 实例立即重探，绝不触碰
    // idle；held lastResume 补发 + SYSTEM_RESUME 推送在 shell-core。
    powerMonitor.on('resume', () => {
      assembly.reconnectStaleTransports();
      // 系统唤醒同时驱动更新检查的 resume 腿：闭包读到的是已构造的实例；未构造
      // （启动早期/极晚期唤醒）时静默跳过。
      updater.noteActivity('resume');
    });

    maybeCreateTray(cp);
    registerDeepLinkProtocol();

    // Windows privacy tightening: owner-private state root and pre-existing
    // secret leaves get explicit user-only ACLs at startup (directory grants
    // propagate to future children). Failures are loud and never block startup;
    // POSIX hosts are unaffected.
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
    // 安装树上游 client-plugin 闭包抽样（仅打包态）：部分安装丢包时前端会静默
    // 少一行（sidebarRight 的唯一 provider 就在抽样里），这里对已安装运行树做
    // 同一抽样，缺件大声报出且绝不阻断启动。dev 形态是源码树锚，不在此断言。
    if (app.isPackaged) {
      const runtimeClosure = verifyRuntimeClientClosure(builtinDshWorkspace);
      if (!runtimeClosure.ok) {
        console.error(
          `[dsh-chamber] 已安装 dsh 运行树缺少上游 client-plugin：missing ${runtimeClosure.missing.join(', ')} — `
          + '请重装应用或删除 resources/vendor/dsh 后重跑 bundle:dsh；否则 sidebarRight/chat/resources 行会静默不可用',
        );
      }
    }

    // Single frame, single origin: the control plane serves the built dsh frontend — no
    // local file loads; a load failure is a loud startup failure (dialog + exit, control
    // plane stopped first so no local dsh child orphans). The runtime startup transaction
    // starts after window creation, so spawn boot overlaps the page load while the
    // renderer's auto-start POST stays idempotent.
    // Deny Web permissions by default; the one benign exception, clipboard-sanitized-write,
    // is what Blink actually REQUESTS for navigator.clipboard.writeText() — denying it
    // silently breaks every copy button while permissions.query still reports granted.
    // The check handler mirrors the same allowlist; clipboard-read, custom formats and
    // media/geolocation/notifications stay denied.
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) =>
      callback(isChamberPermissionGranted(permission)));
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => isChamberPermissionGranted(permission));

    // shell IPC 注册点 = shell-core 的 installIpcHandlers；本文件只做装配与注入
    // （ipc：trustedIpc 围栏；edges：createElectronEdges；ctx：装配体 ctx）。调用
    // 点：whenReady 内、createMainWindow 之前——窗口加载前注册完毕（renderer 最早
    // invoke 也晚于全部启动代码）。
    installIpcHandlers({
      ipc: {
        handle: (channel, handler) => ipcMain.handle(channel, trustedIpc(handler)),
      },
      edges,
      ctx: assembly.ctx,
    });
    updater.start();

    // 启动期创建主窗口：加载失败 = 大声失败 + 退出；恢复路径共用同一创建函数。
    // null = 致命失败已呈现恢复框（退出或重启在途）：启动尾部不得再跑。
    const created = createMainWindow(rendererOrigin, true);
    if (created === null) return;
    // 启动尾部（host-assembly.runStartupTail，与 Swift sidecar 同一实现）。
    void assembly.runStartupTail();

    // 深链统一 drain：队列与消费循环在 shell-core（失败 loud 走对话框+日志；
    // quit 在途的新深链在 core 内 ignore）；此处只保留启动完成后的首次 drain。
    drainDeepLinkLaunches();
  });
}
