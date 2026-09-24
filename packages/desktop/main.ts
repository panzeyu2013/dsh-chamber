/**
 * dsh-chamber desktop main process (design 05, connection-manager form).
 *
 * The single window loads the control plane origin directly
 * (loadURL http://127.0.0.1:<cp.port>/) — one frame, one origin; the
 * control plane serves the built dsh frontend (webDistDir = <pkg>/dist/web in
 * dev and packaged alike — renderer/dist isolation — design 05 §7.1) and proxies every instance over
 * /api/i/<id>/*. There are no injected connection adapters: remote
 * instances reach the control plane through registerInstanceTransport /
 * unregisterInstanceTransport (design 03 §2.2), driven by the transport
 * manager's ready phase — the transport URL stays in the main process and
 * never enters a renderer payload (design 05 §8).
 *
 * 职责清单（design 25 §4.1 seam；60 handler 在 shell-core.ts 的
 * installIpcHandlers——本文件零 handler 注册点、零
 * webContents.send 调用；唯一的 ipcMain.handle 拼写 = 下方 whenReady 装配侧
 * registrar 包装 `ipcMain.handle(channel, trustedIpc(handler))`，即 trustedIpc
 * 围栏注入点；send 面全走 electron-edges.ts HostEdges rendererPush 叶）：
 * - 宿主装配 = host-assembly.createHostAssembly（**与 Swift sidecar 同一实现**，
 *   审计 R1/arch-01 P1-1）：本文件只注入 Electron edge 事实（edges 适配、
 *   safeStorage crypto 适配器、packaged/repo host 包目录、pnpm 入口、
 *   electron-updater 控制器/退出腿、resourcesPath 锚锁文件叶、窗口/tray 事实）并
 *   回报差异（日志 tag、窗口存活判据）。transportManager / gateway 会话 /
 *   publishRegistryTransition（SSH_INSTANCES_CHANGED/SSH_STATUS_CHANGED
 *   committed push 文本与插件 seed/journal 撤销）/ runtime 启动事务宿主
 *   （runRuntimeStartup 及共享闭包、runtimeState 事务槽、restartLocalDsh/
 *   stopLocalDsh 等 PlaneHandle 宿主叶）全部由该单一实现拥有。
 * - 窗口 glue：createMainWindow/单窗恢复（activate/托盘/second-instance）、
 *   navigation/window-open 围栏、renderer 恢复、权限请求 allowlist。
 * - 生命周期：单实例锁、before-quit 退出确认（D2，退出事实经
 *   hostAssembly.quitFacts）/will-quit 清理（control plane stop + 装配侧
 *   dispose + badge 清 0 + tray destroy——宿主生命周期动作保持本文件）。
 * - 启动事务宿主：启动尾部 = hostAssembly.runStartupTail；首检/周期计时器（经
 *   core 导出入口 runRuntimeCheckCycle）与 known-good 晋升计时器仍在
 *   runtime-startup-host.ts。
 *
 * Responsibilities:
 * - Single-frame BrowserWindow (contextIsolation, no nodeIntegration).
 * - Control plane lifecycle: spawn on ready, stop() on will-quit.
 * - Transport registration: ready transport → registerInstanceTransport
 *   ('<kind>:<id>', readyUrl); leaving ready → unregisterInstanceTransport.
 *   (design 03 §2.2, driven by transport-manager + the `ssh` provider's
 *   tunnel phase).
 * - Tray (packaged only, defensive), single-instance lock.
 */

import { app, BrowserWindow, crashReporter, dialog, ipcMain, Menu, Tray, nativeImage, powerMonitor, powerSaveBlocker, safeStorage, session } from 'electron';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import type { PlaneHandle } from '@dsh-chamber/control-plane';
import { applyWindowsAclTightening } from './win-acl.ts';
import { verifyRuntimeClientClosure } from './runtime-tree-check.ts';
import { createTrustedIpc, isChamberPermissionGranted, isExternalLinkUrl, isTrustedIpcSender, isTrustedRendererUrl } from './renderer-trust.ts';
import { createControlPlane } from './control-plane-module.ts';
import { attemptDeepLinkProtocolRegistration, canRestoreMainWindow, decideDeepLinkProtocolRegistration, describeUnknownError, ensureLinuxProtocolDesktopFile, linuxAutostartDesktopEntry, linuxAutostartDirectory, resolveLinuxLaunchExecutable } from './deep-link.ts';
import { createUpdateController } from './updater.ts';
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
import { RENDERER_CRASH_RELOAD_DELAY_MS, RENDERER_HANG_RELOAD_DELAY_MS, RENDERER_RECOVERY_MAX_RELOADS, noteRendererReload, shouldReloadAfterChildProcessGone, auditLogFilePath, chamberSettingsFilePath, gatewaySecretsFilePath, QUIT_CLEANUP_TIMEOUT_MS, resolveControlPlanePort, scanDeepLinkUrls, sshPasswordsFilePath, stateRootDir, installIpcHandlers, clearBadgeIntentForQuit, drainDeepLinkLaunches, enqueueDeepLink, onRendererLifecycle, openExternally, resolveDevBuiltinDshWorkspace, shouldReloadAfterCrash, shouldScheduleHangReload } from './shell-core.ts';
import type { RendererReloadBudgetState } from './shell-core.ts';
import { createElectronEdges } from './electron-edges.ts';
import { RendererFrameWatchdog, RENDERER_FRAME_PROGRESS_SCRIPT, RENDERER_INPUT_BLOCK_RTT_MS } from './renderer-frame-watchdog.ts';

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
  productName: 'dsh-chamber-electron',
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

function resolveBuiltinDshWorkspace(): string | null {
  if (app.isPackaged) {
    const bundled = path.join(process.resourcesPath, 'vendor', 'dsh');
    return existsSync(bundled) ? bundled : null;
  }
  // dev 候选顺序由 shell-core 单源提供（<repoRoot>/ref-dsh →
  // <pkgDir>/vendor/dsh）——Electron-free sidecar 的 dev 回退必须与这里逐字
  // 同序（resolveSidecarBuiltinDshWorkspace），两侧共用同一 helper。
  return resolveDevBuiltinDshWorkspace(pkgDir);
}

/**
 * 运行时线锚锁文件（design 21 §6.11.1 的 F 首选事实源）：随应用发布的
 * `vendor/dsh/pnpm-lock.yaml`，也是 C11 门禁断言的那个文件。dev 形态指向仓库里的
 * 同一份（活动树此时可能是源码线 `ref-dsh`，其闭包含 opt-in 段，不能当 F）。
 */
function resolvePinnedRuntimeLockfile(): string | null {
  const candidate = app.isPackaged
    ? path.join(process.resourcesPath, 'vendor', 'dsh', 'pnpm-lock.yaml')
    : path.join(pkgDir, 'vendor', 'dsh', 'pnpm-lock.yaml');
  return existsSync(candidate) ? candidate : null;
}

const builtinDshWorkspace = resolveBuiltinDshWorkspace();
if (builtinDshWorkspace === null) {
  console.warn(
    '[dsh-chamber] 未找到 dsh 工作区（DSH_CHAMBER_DSH_PATH / <repoRoot>/ref-dsh / <pkg>/vendor/dsh 均不可用），连接页将显示错误',
  );
}

let mainWindow: BrowserWindow | null = null;
let controlPlane: PlaneHandle | null = null;
// 共享宿主装配（host-assembly.createHostAssembly——transport/gateway/seed/runtime
// 单一实现，与 Swift sidecar 同一份）：whenReady 装配后赋值；will-quit/before-quit
// 经它读退出事实与回收腿（模块级 transportManager/gatewaySessions/sessionRefresh
// ref 已随重复装配一并删除）。
let hostAssembly: HostAssembly | null = null;
let tray: Tray | null = null;
// 当前窗口 URL（控制面 origin，控制面启动后赋值）。窗口被关闭后可据此
// 重建（macOS activate 路径）——没有它，窗口一旦关闭应用就永久无窗。
let mainWindowUrl: string | null = null;

// 主窗口 'show' 事件订阅面（HostEdges.onMainWindowShown 的装配侧注册
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

// 「重启并安装」在途标志。electron-updater 的
// quitAndInstall 在 macOS 上「先关闭全部窗口、再退出」（Electron 43.4.0 typings
// AutoUpdater#before-quit-for-update 明文：before-quit 不会在窗口关闭前发出；
// autoUpdater 的 before-quit-for-update 与窗口 close 都发生在 quitAndInstall()
// 调用内部、远早于 before-quit），
// 而关窗到托盘（design 14 D1，默认 hide-to-tray）只在 quitRequested（由 before-quit
// 置位）后才放行关窗——更新退出腿的关窗若被 hide 吞掉，窗口消失、进程（连同本地
// dsh 与隧道）永久留存、更新永不安装。
// 该标志由控制器的 onQuitAndInstallArmed 回调在**调用 quitAndInstall 之前**置位
// （关窗发生在调用内部，返回后再置位就晚了）；原生退出每次到达都会重新武装
// （armNativeUpdaterQuit），失败/停滞时由 updater 状态订阅撤回。
let updaterQuitArmed = false;
// 原生更新器退出兜底计时器（见 armNativeUpdaterQuit）：原生 macOS 退出腿只关窗、
// 不保证走到 app.quit()，宽限期内未退出即由主进程接管退出。
let updaterQuitFallback: ReturnType<typeof setTimeout> | null = null;

/** 更新退出兜底的宽限期（armNativeUpdaterQuit）：原生更新器已发出
 *  before-quit-for-update 后，正常腿应当立即 app.quit()（win: setImmediate；
 *  mac: 原生终止）。超过这个窗口仍未进入退出序列，就由主进程接管退出——
 *  取 5s 与退出清理上限同量级，绝不会等到 60s 的重启停滞 watchdog。 */
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
  // 更新退出腿已经把窗口关掉、重启却没走完时，唯一能如实显示失败/停滞文案的
  // 入口就是主窗口——把它拉回来（无窗口常驻绝不能是「更新卡住」的表现形式）。
  if (mainWindow === null || mainWindow.isDestroyed()) showMainWindow();
}

/** 原生更新器正在关窗退出（Electron autoUpdater `before-quit-for-update`，
 *  在 quitAndInstall 内部、关窗之前发出——Electron 43.4.0/darwin）。两件事：
 *  1) 武装关窗豁免：这一次关窗属于安装退出腿，绝不能被 hide 吞掉（也覆盖
 *     「首次武装已被停滞 watchdog 撤回、原生退出迟到」的窗口）；
 *  2) 兜底自退：macOS 原生腿只关窗、不保证走到 app.quit()，进程会以「无窗口仍在
 *     运行」滞留。这里在宽限期后仍未退出就由主进程 app.quit() 走正常
 *     before-quit/will-quit 清理路径。兜底本身在两种情形下都安全：before-quit 会到
 *     时 `quitRequested` 已置位、兜底直接 stand down（见 shouldUpdaterQuitTakeOver）。
 *     此刻退出是安全的：该事件只在 Squirrel 已完成 staging 后发出
 *     （MacUpdater 仅在 squirrelDownloadedUpdate / 原生 update-downloaded 之后
 *     才调原生 quitAndInstall），退出即安装。 */
function armNativeUpdaterQuit(): void {
  armUpdaterQuit();
  if (updaterQuitFallback !== null) return;
  updaterQuitFallback = setTimeout(() => {
    updaterQuitFallback = null;
    // 三个守卫（真退出已在途 / 武装已撤回 / 窗口仍在）是纯判定
    // shouldUpdaterQuitTakeOver：只在「窗口确已被更新退出腿关掉」时接管退出——原生腿
    // 没走到关窗（或用户又从 Dock 拉回了窗口）就绝不能在用户眼皮底下把应用拽下去，那种
    // 情况交给 60s 停滞 watchdog 如实呈现与恢复，而不是制造一次无预警退出。
    const windowAlive = mainWindow !== null && !mainWindow.isDestroyed();
    if (!shouldUpdaterQuitTakeOver(quitRequested, updaterQuitArmed, windowAlive)) return;
    console.warn('[dsh-chamber] 原生更新退出腿未完成退出：进程仍在，改由主进程 app.quit()（已 staged 的更新随退出安装）');
    app.quit();
  }, UPDATER_QUIT_FALLBACK_MS);
  updaterQuitFallback.unref?.();
}
// Runtime lifecycle gate（runtimeState / 事务槽 / 本地 spawn 门）与退出事实全部
// 归共享装配（host-assembly.createHostAssembly）——本文件不再持有运行时状态。
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
  // 候选路径 = 真实打包资源 resources/icon.png（extraResources 将
  // resources/icon.png 拷入 resources/ 根）。未来引入专用托盘图标资产时改这里。
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
 * Windows NSIS 安装器可能同样写 HKCU\Software\Classes，此处
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
  const result = attemptDeepLinkProtocolRegistration(() => app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME));
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

/** Windows 打包态身份（design 21 M3）：通知 AUMID、登录自启 Run 值名与卸载器
 *  三处必须同一个字面量。Electron 43.4.0 的 setLoginItemSettings 在省略 `name`
 *  时写 AppUserModelId()，而 getLoginItemSettings() 也只按该 AUMID 回读
 *  （browser_win.cc），所以显式钉住它既不改写读回语义、又让卸载器有确定的键名
 *  （scripts/nsis-uninstall-cleanup.nsh）。 */
const WINDOWS_APP_USER_MODEL_ID = 'com.dshchamber.desktop';

/**
 * 登录自启（design 14 D6）：macOS setLoginItemSettings；Linux XDG autostart
 * （手写最小 .desktop）；Windows setLoginItemSettings（HKCU Run 键,design 21
 * M4）。卸载残留由 NSIS 卸载段清理（scripts/nsis-uninstall-cleanup.nsh）。
 * 失败 loud 返回 {error}，绝不静默假成功。
 */
function applyLaunchAtLogin(enabled: boolean): { ok: true } | { ok: false; error: string } {
  try {
    if (process.platform === 'darwin' || process.platform === 'win32') {
      // Windows 上 Electron 写入 HKCU\...\Run（当前用户,无需管理员）;路径为
      // process.execPath(打包态=dsh-chamber.exe)。开发态同样可用,但仅打包
      // 形态属于产品承诺(design 14 D6 / 21 M4)。Windows 显式钉 `name` = AUMID：
      // 与省略 name 时 Electron 的默认键名逐字相同（回读不受影响），但键名从此
      // 由本仓单一常量决定，卸载器按同一名字清理（design 21 M4 / C19）。
      // macOS 保持 openAtLogin-only 调用不变（`name` 是 Windows 专属选项）。
      if (process.platform === 'win32') {
        app.setLoginItemSettings({ openAtLogin: enabled, name: WINDOWS_APP_USER_MODEL_ID });
      } else {
        app.setLoginItemSettings({ openAtLogin: enabled });
      }
      // 写完必须回读——OS 可能静默拒绝，macOS 还可能
      // 把条目停在 requires-approval（系统设置里等用户批准，此时根本不会
      // 自启）。Swift 腿的 SMAppService status 预检 + apply-failed 是这里的
      // 对偶；绝不无回读地回 {ok:true}。
      const observed = app.getLoginItemSettings();
      const verdict = verifyLaunchAtLoginReadBack(enabled, observed, process.platform);
      if (!verdict.ok) {
        console.warn(`[dsh-chamber] 登录自启写入后回读不符：${verdict.error}`);
      }
      return verdict;
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
      // OTHER XDG_CONFIG_HOME resolution (or at the fixed
      // ~/.config path), remove it there too — disabling must never leave a
      // live entry behind with a silent ok:true.
      const legacyFile = path.join(os.homedir(), '.config', 'autostart', 'dsh-chamber.desktop');
      if (legacyFile !== desktopFile) rmSync(legacyFile, { force: true });
    }
    // 同一条纪律（文件面）：写入/删除后回读目标态，绝不无验证地回
    // {ok:true}（getLoginItemSettings 在 Linux 不存在，登录自启就是这个文件）。
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

/**
 * 渲染进程崩溃/卡死恢复（有界自动重载）：`render-process-gone` 或长时间
 * 无响应 → 60s 窗口内至多重载 3 次，超出即大声失败（错误框一次，绝不静默
 * 白屏）。正常退出（clean-exit，如用户关窗）不重载。
 */
function installRendererRecovery(win: BrowserWindow): void {
  // 预算/门判定全部走 shell-core 的共享纯函数（main-decision-gates
  // 行为单测；Swift RendererRecoveryPolicy/HangWatchdog 同参数），本文件只留
  // 计时器与窗口销毁守卫。
  const reloadBudget: RendererReloadBudgetState = { windowStart: 0, count: 0 };
  // 首次加载完成标志：dsh 前端 boot（加载数十个插件模块）期间渲染进程
  // 主线程长时间忙碌是合法的，unresponsive 只在"已成功加载过"之后才触发
  // 重载，避免打断正常启动。
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
      dialog.showErrorBox('dsh-chamber 前端异常', '前端渲染器反复异常或无进度，已停止自动恢复。请重新启动应用。');
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
  win.webContents.on('render-process-gone', (_event, details) => {
    frameWatchdog.reset();
    clearUnresponsiveTimer();
    clearCrashReloadTimer();
    // 用户关窗/退出等正常路径（判定单源 = shouldReloadAfterCrash）。
    if (!shouldReloadAfterCrash(details.reason, quitRequested)) return;
    // 通知就绪标志立即失效（design 19 §3.3）：崩溃到 500ms 后 reload 之间没有
    // 导航事件（did-start-loading 不会触发），不重置则向死 frame 推送丢事件。
    // （ready 位复位 + in-flight 重排在 shell-core onRendererLifecycle。）
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
  // request handler.
  const url = `${rendererOrigin.replace(/\/+$/, '')}/`;
  mainWindowUrl = url;
  // 沙箱 preload 只接受 build:preload 的编译产物
  // dist/preload.cjs（纯 CJS，无 TS 类型擦除）。源码 preload.cts 不能作静默
  // 回退——Electron 在沙箱/CJS 语义下加载 .cts 会 SyntaxError，缺失即 loud
  // 失败（宁可启动失败也不带病开窗）。
  const preloadPath = path.join(pkgDir, 'dist', 'preload.cjs');
  if (!existsSync(preloadPath)) {
    // 缺失 = 安装/构建回归。必须 loud——dev 终端可见抛错即可,
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
    // 固定窗口标题：官方 dsh 前端（标题投影在 ui-renderer 行内）
    // 会把当前会话名投影到 document.title——若不拦截 page-title-updated，
    // 原生标题栏会随选中会话变化。单 frame 壳的品牌标识恒定，会话名在应用内可见。
    title: 'dsh-chamber-electron',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      // Keep Electron's renderer sandbox explicit: this window only needs the
      // narrow contextBridge surface from preload, never Electron/Node powers.
      sandbox: true,
      // backgroundThrottling 保持默认（design 14 §D1）：关闭它会让 Electron 永久
      // 抑制隐藏态（backgroundThrottling=false 时
      // electron_api_web_contents.cc 置 disable_hidden_=true）——窗口
      // 隐藏后 rAF 仍 120/s、document.visibilityState 恒 'visible'、
      // visibilitychange 0 次，retention.ts 的 shouldRunBackgroundPhase 因此
      // 在 Electron 上从不生效，隐藏期 renderer CPU 最高 28.1%。
      // 默认节流下同一测量台（Electron 43.4.0 / Chromium 150 / M5 Pro
      // 120 Hz）：隐藏期 rAF 0、动画停、visibilitychange 恢复，renderer CPU
      // 0.0–0.1%；SSE 是网络流不受影响（隐藏 9s 收 9/9 条、maxGap 1005ms、
      // 0 错误），唤醒即时重连由 powerMonitor resume 的 IPC 推送驱动（不依赖
      // 隐藏期计时器）。代价仅 <1s 定时器被钳到 1Hz（100ms→1Hz，1s 不变），
      // 而 3s/15s/30s/60s/120s 各档看门狗节奏不变。
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
  // （ready 位复位/requeue/drain 在 shell-core onRendererLifecycle——
  // 本 glue 只转发当前主窗的生命周期事件。）
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
  // 更新退出腿（updaterQuitArmed）例外：关窗是更新安装的前置步骤，hide 会截断
  // quitAndInstall 的退出链（见 armUpdaterQuit 的注释与该函数的契约）。
  win.on('close', (event) => {
    const recoveryAvailable = process.platform === 'darwin' || tray !== null;
    // close 决策统一走纯函数（chamber-settings
    // decideMainWindowClose）。hide 分支保持 hide；任何会走到退出的 close
    // （close-behavior='quit'、无恢复面的关窗）一律 **defer**：先
    // preventDefault，把窗口留到退出决策拍板之后再销毁——窗口先被销毁
    // （window-all-closed → app.quit()）时，取消退出只能重建 = 整页重载、
    // 页面态丢失；Swift 全部退出腿都由 NSApp.terminate 承担，窗口不销毁，
    // 取消只 restoreMainWindow()（原地恢复）。
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
      // 决策在 before-quit（D2 确认）：窗口此刻仍然存活；确认后退出序列
      // 再次触发 close（quitConfirmed=true → 'close'）才真正销毁。
      event.preventDefault();
      app.quit();
    }
  });
  // 无窗口常驻（托盘态）期间的唤醒事件由 core held（lastResume），窗口恢复可见
  // 时一次性补发（design 14 D4——补发逻辑在 shell-core
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
  // macOS Electron 43 主进程的 `process.on('SIGTERM')`
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
    // app.quit()，经 before-quit 的 D2 确认。该关窗
    // 路径的窗口在确认前不会被销毁（close 被 defer），取消时窗口原地存活，
    // 绝无「取消后重建 = 页面重载」；本条仍覆盖其它真正关完窗的退出腿
    // （hide-to-tray 关窗销毁等）。非 darwin 恒退出。
    if (process.platform !== 'darwin' || chamberSettings.windowCloseBehavior === 'quit') app.quit();
  });

  // 退出确认（design 14 D2）在 **before-quit**（窗口关闭前）拦截：
  // 显式退出（Cmd+Q / 托盘退出 / Dock 退出 / 设置=quit 的关窗）仅在「退出确认
  // 开关开启 且 本地 dsh 实例运行中」时先确认（远程隧道不影响关闭）；
  // 更新已下载待装（设计 11 autoInstallOnAppQuit，用户已确认过「更新」）时豁免。
  // 关键时序：close-to-tray 的 close 处理器靠 quitRequested 区分「退出在途」
  // vs「普通关窗」——而 will-quit 要等所有窗口关闭后才触发，在 will-quit 内置
  // 位为时已晚（close 先 hide+preventDefault 会把退出吞掉）。before-quit 先
  // 置位/拦截：确认后重触发才放行；取消时窗口从未关闭（拦截在先），不丢窗口。
  // X 关窗路径同样「从未关闭」：close 处理器对
  // 会退出的关窗先 preventDefault（decideMainWindowClose）、再 app.quit()，
  // 因此 before-quit 的确认/取消在两种入口下都面对存活的窗口。
  // async handler：preventDefault 在第一个 await 前同步执行（Electron 不等待
  // handler 的 promise）；await 仅用于把确认框的同步/异步失败统一进 try/catch。
  app.on('before-quit', async (event) => {
    if (quitConfirmed) return; // 已确认/豁免：放行（重入）
    const cp = controlPlane;
    if (cp === null) {
      // 控制面未就绪：无可保护内容，放行。必须同时置位确认位——
      // defer 分支在关窗处理器里重入 app.quit()，若这条放行路径不置位，
      // 退出序列的关窗会再次命中 defer 分支，形成 app.quit() ↔ close 的
      // 自递归（窗口永远关不掉）。
      quitRequested = true;
      quitConfirmed = true;
      return;
    }
    if (confirmingQuit) {
      event.preventDefault(); // 确认框已打开：忽略重入（单飞）
      return;
    }
    // 退出事实投影归装配侧（host-assembly.quitFacts——本地实例在跑判据
    // localRunning 与更新豁免 updateDownloadReady 均为同一实现，与 Swift sidecar
    // 同源）；远程隧道不影响关闭——风险只看本地实例；退出确认开关
    //（quitConfirmation）关闭时永不确认。状态机显示 running 还不够——必须实际有
    // 存活进程（restart backoff / 死亡未探活期间状态机可能误报 running）。
    const quitFacts = hostAssembly?.quitFacts();
    const risk = computeQuitRisk({
      quitConfirmation: chamberSettings.quitConfirmation,
      localRunning: quitFacts?.localRunning ?? false,
      updateDownloadReady: quitFacts?.updateDownloadReady ?? false,
    });
    if (!risk.needsConfirm) {
      // 无风险或更新安装豁免：置位后直接 return 放行本次退出（未 preventDefault，
      // 退出继续走 will-quit）——不在此处再调 app.quit() 重入（重入虽被
      // quitConfirmed 早退兜住，但属不必要的退出重入）。
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
        // 取消：quitRequested 保持 false。关窗路径
        // 不先销毁窗口——close 在决策前被 defer（decideMainWindowClose），
        // 所以这里**原地恢复**（show/restore/focus）仍然存活的窗口即可，绝不
        // 重建、绝不重载页面：页面态保留，与 Swift 取消分支
        // restoreMainWindow() 对偶。showMainWindow 内部仍保留「窗口意外不在
        // 则按 mainWindowUrl 重建」的防御兜底。SIGTERM 已置位 quitRequested
        // 的退出在途则**不**恢复——取消对已确认的退出无效力。
        if (!quitRequested) showMainWindow();
      });
    } catch (error) {
      // showMessageBox 同步/异步失败都必须复位 confirmingQuit，否则后续所有
      // before-quit 都被单飞闸拦死、应用再也退不出。
      confirmingQuit = false;
      console.error('[dsh-chamber] 退出确认对话框失败，取消退出：', error);
      // 与取消同义：这次退出作废，原地恢复存活的窗口；showMainWindow
      // 自带无窗重建兜底。
      if (!quitRequested) showMainWindow();
    }
  });

  app.on('will-quit', (event) => {
    if (willQuitCleanupComplete) return;
    // 真正退出在途（窗口已全部关闭）：close 分支不再 hide；keep-awake 停止
    // （design 14 D5）。确认/豁免已在 before-quit 完成，这里只剩清理。
    quitRequested = true;
    setKeepAwakeActive(false);
    // 兜底清除未读徽标（退出在途不留 Dock 残留；曾有意图才触碰，避免无谓日志）。
    // clearBadgeIntentForQuit 内部做「曾有意图」守卫与意图清空，原生清除叶在此
    // 注入（typeof 守卫）。
    // badge 清 0 / tray destroy / keep-awake 停止等清理动作依附 app 生命周期
    // （will-quit 事件、app.setBadgeCount、Tray 对象销毁），是宿主生命周期职责
    // 而非 IPC/业务注册面。
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
    // 装配侧公共回收腿（host-assembly.dispose——quitting 门置位 + 启动门关闭 +
    // RUNTIME_ABORT_REASON 事务 abort + transport/插件子进程/安装器/在飞事务并行
    // 回收 + session refresh/gateway 会话清理，与 Swift sidecar 同一实现）与控制面
    // stop 并行等待。
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
      // 跳过。注意：「重启并安装」腿（restartAndInstall
      // 已点击）不受此影响——NSIS 安装器在 quit 前已 detached 先行、
      // AppImage 点击时已原位替换，即使 app.exit(1) 安装也照常完成；
      // mac 原生腿未实机确证（见 design 11 §9 断言清单）。
      console.error('[dsh-chamber] 退出清理超时，强制退出（可能有子进程残留；退出腿的已下载更新不会安装）');
      app.exit(1);
    }, QUIT_CLEANUP_TIMEOUT_MS);
    const cp = controlPlane;
    controlPlane = null;
    const assembly = hostAssembly;
    void Promise.allSettled([
      assembly === null ? Promise.resolve() : assembly.dispose(),
      cp?.stop().catch((err) => console.error('[dsh-chamber] 控制面停止失败：', err)),
    ]).finally(() => {
      // The cached gateway login sessions and the pre-expiry refresh timers are
      // dropped inside assembly.dispose() (pure-memory hygiene, design 17 §13.5）；
      // here only the timers/quit bookkeeping remain.
      clearTimeout(cleanupTimer);
      quitCleanupInProgress = false;
      willQuitCleanupComplete = true;
      // Will-quit cleanup completion marker: the mac
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
    if (process.platform === 'win32') app.setAppUserModelId(WINDOWS_APP_USER_MODEL_ID);
    // 冷启动深链 argv（design 16 §4.2）：macOS argv 含 -psn_ 噪声，防御式扫描
    // （非深链 argv 零副作用、绝不 throw 打断启动）；与 open-url 双触发由去重兜底。
    for (const url of scanDeepLinkUrls(process.argv)) enqueueDeepLink(url);
    // HostEdges 的 Electron 实现（design 25 §4.1 seam）：
    // showMainWindow = 通知 click 激活腿（本函数模块级语义——
    // restore/show/focus、无窗则重建）；onMainWindowShown = 主窗口 'show' 事件
    // 订阅面（createMainWindow glue 每窗挂接）。
    const edges = createElectronEdges({
      mainWindow: () => mainWindow,
      showMainWindow: () => showMainWindow(),
      onMainWindowShown: subscriber => {
        mainWindowShownSubscribers.add(subscriber);
        return () => { mainWindowShownSubscribers.delete(subscriber); };
      },
    });
    const runtimeBaseDir = app.getPath('userData');
    // 双 flavor 跨进程互斥锁（design 25 §6.3；Electron 侧 O_EXLOCK——见
    // chamber-lock.ts 的平台范围说明）：另一 flavor 持有 → fail-closed 拒绝
    // 启动，绝不让两个 writer 并发同一 registry/凭据/runtime 树。
    const chamberLock = acquireChamberLock({ userDataDir: runtimeBaseDir, shell: 'electron' });
    if (!chamberLock.ok) {
      console.error(`[dsh-chamber] ${chamberLock.error}`);
      dialog.showErrorBox('dsh-chamber 已在运行', chamberLock.error);
      app.exit(1);
      return;
    }
    if (chamberLock.unsupported) {
      console.warn('[dsh-chamber] 目录锁：当前平台无 O_EXLOCK（Swift flavor 仅 macOS）——跨 flavor 互斥不适用');
    }
    // host-root 租约（R2 §3.6 L2；scope host-root）：<userData> 的 registry/凭据/
    // runtime 树写者身份，flock 之后、任何 runtime 元数据写入之前取得。失败同
    // flock：loud + 原生对话框 + exit 1（绝不让第二个写者继续装配）。
    let hostRootLease: ReturnType<typeof acquireHostRootLease> | null = null;
    try {
      hostRootLease = acquireHostRootLease(runtimeBaseDir, 'desktop');
    } catch (error) {
      const detail = describeHostRootLeaseFailure(error);
      console.error(`[dsh-chamber] ${detail}`);
      dialog.showErrorBox('dsh-chamber 启动失败', detail);
      app.exit(1);
      return;
    }
    // Release ONLY after the async cleanup finishes (releasing
    // in a will-quit listener would open a window where another flavor could take
    // the lock while transports/control-plane were still writing <userData>).
    // `quit` fires after the cleanup chain settled; the OS also releases on
    // process exit.
    app.on('quit', () => {
      // L2 先于 L1 释放：反序（先放 flock）会让另一 flavor 取得 flock 后立刻撞上
      // 残留 owner.json 而被拒（瞬时假冲突）。两释放都幂等；清理链已在 will-quit
      // 结算，quit 只做这两步。
      try {
        hostRootLease?.release();
      } catch (error) {
        console.error('[dsh-chamber] host-root 租约释放失败：', error);
      }
      chamberLock.handle.release();
    });

    // Chamber settings（design 14 D7）：启动加载 + 应用副作用（keep-awake /
    // 登录自启 reconcile）；损坏 loud（*.corrupt 保留），绝不静默假默认。
    // 先于 createHostAssembly：settings 内存 holder 是共享装配的注入依赖。
    const settingsLoad = readSettingsFile(chamberSettingsFilePath(runtimeBaseDir));
    if (settingsLoad.notice !== null) console.error(`[dsh-chamber] ${settingsLoad.notice}`);
    chamberSettings = settingsLoad.settings;
    setKeepAwakeActive(chamberSettings.keepAwake);
    // 登录自启 reconcile 覆盖全部三平台（design 21 M4:win32 已解锁）。
    // 损坏文件绝不触碰系统登录项——默认值只回落给
    // 内存/UI 使用：损坏文件被保留为 *.corrupt 后，下一次
    // 启动（live 文件缺失 + 副本存在）由 readSettingsFile 判为 corrupt 状态，
    // 仍然 skip——绝不因状态衰减成 missing 而重放默认 false。真正无副本的
    // 缺失文件仍 replay 默认 false。
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
    // path; controllable flow). The state projection
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
      // 更新退出腿的关窗豁免：控制器恰好在调用
      // electron-updater quitAndInstall **之前**同步回调这里——macOS 上该调用
      // 先关闭全部窗口、再退出（Electron 43.4.0 typings，见
      // shouldHideToTray），关窗一旦被 hide 吞掉，安装+重启链就地中断。回调只在
      // 真正武装的路径上触发（拒绝路径不回调），失败/停滞由状态订阅撤回。
      onQuitAndInstallArmed: armUpdaterQuit,
      // 原生更新器开始关窗退出（Electron autoUpdater before-quit-for-update）：
      // 关窗豁免 + 原生退出腿的兜底自退（见 armNativeUpdaterQuit）。
      onNativeUpdaterQuitting: armNativeUpdaterQuit,
    });
    // Gateway credentials store（design 17 §12）：token + password secrets
    // mirror to <userData>/gateway-secrets.json (schemaVersion 3, 0600, atomic
    // write) — encrypted via Electron safeStorage (macOS Keychain / Windows
    // DPAPI / Linux libsecret) when available, else the documented 0600
    // plaintext fallback. Never in the registry, never logged, never returned
    // to/prefilled in the renderer；非空 legacy 文件无 credential-domain binding
    // 时唯一保留为 unbound evidence 并禁用至重录。
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
    // （windowsRefusePlaintext 判据与 loud 文案在 host-assembly 单源。）
    // Host package sources for the remote seed (design 13 §3). Packaged
    // builds carry copies under dist/; dev reads the same source dirs used by
    // the local control-plane seed.
    const moduleASourceDir = app.isPackaged
      ? path.join(pkgDir, 'dist', 'host-graph-package')
      : path.join(repoRoot, 'packages', 'dsh-chamber-seed-client-graph');
    const gitWorktreeHostSourceDir = app.isPackaged
      ? path.join(pkgDir, 'dist', 'host-git-worktree-package')
      : path.join(repoRoot, 'packages', 'dsh-chamber-seed-git-worktree');
    const archiveCleanupHostSourceDir = app.isPackaged
      ? path.join(pkgDir, 'dist', 'host-archive-cleanup-package')
      : path.join(repoRoot, 'packages', 'dsh-chamber-seed-archive-cleanup');
    // Per-package SOURCE DIRS are desktop-specific (packaged vs repo paths);
    // the insert id/name come from the control-plane registry, so a registry
    // addition/rename can never drift from the seed list. This ONE map feeds
    // both consumers — the remote ssh seed list and the gateway sync upload.
    const chamberHostSourceDirs: Record<string, string> = {
      [CLIENT_GRAPH_PACKAGE_NAME]: moduleASourceDir,
      [GIT_WORKTREE_PACKAGE_NAME]: gitWorktreeHostSourceDir,
      [ARCHIVE_CLEANUP_PACKAGE_NAME]: archiveCleanupHostSourceDir,
      // Registry rows marked `localOnly` are deliberately ABSENT here: this map
      // feeds the two REMOTE consumers (the ssh seed list and the gateway sync
      // upload), and a local-shape-only domain must never reach another machine.
      // Their local source dir is passed to the control plane separately
      // (hostOpenInPackageSourceDir, design 20 §6).
    };
    // pnpm 入口解析：候选集/顺序/选择算法的唯一实现在 pnpm-launcher
    // （bundledPnpmEntryCandidates + firstExistingPnpmEntry）——packaged 走
    // <resourcesPath>/pnpm/bin/pnpm.cjs，dev 走 <pkgDir>/node_modules/pnpm/...；
    // 全缺失时保留安装形状（安装路径上的 loud 失败语义不变）。
    const pnpmEntryCandidates = bundledPnpmEntryCandidates({
      platform: process.platform,
      moduleDir: pkgDir,
      resourcesPath: app.isPackaged ? process.resourcesPath : null,
    });
    const pnpmEntry = firstExistingPnpmEntry(pnpmEntryCandidates, existsSync) ?? pnpmEntryCandidates[0];

    // —— 共享宿主装配（host-assembly.createHostAssembly——Electron 与 Swift
    // sidecar 同一实现；本文件只保留宿主 edge 接线与差异注入）——
    // 装配顺序与 sidecar 同一权威：registry/凭据 → transportManager → seed 目标
    // 闭包 → gateway 会话 refresh → onStatusChanged/onVerified 订阅 →
    // publishRegistryTransition → runtime 启动事务宿主 → ctx 完成形态。
    const assembly = await createHostAssembly({
      logTag: '[dsh-chamber]',
      userDataDir: runtimeBaseDir,
      shellVersion: version,
      builtinDshWorkspace,
      edges: {
        rendererPush: (channel, payload) => edges.rendererPush(channel, payload),
        mainWindowAlive: () => mainWindow !== null && !mainWindow.isDestroyed(),
        retireNotificationsForSources: retiredSourceIds => edges.retireNotificationsForSources(retiredSourceIds),
        // 原生确认对话框腿（registryOrigin 切换）：mainWindow 预检在装配体内
        // （edges.mainWindowAlive 同值判据），这里只把捕获的窗口对象交给
        // dialog；窗口在预检与调用间销毁 → 抛错 → 装配体折算 'unavailable'。
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
      controlPlane = createControlPlane({
        port: controlPlanePort,
        stateDir: stateRootDir(app.getPath('userData')),
        // 租约记录的诊断 flavor（冲突方读到「desktop」而不是笼统的 control-plane）。
        stateWriter: 'desktop',
        // 本地 dsh spawn 门 = 共享装配的 localSpawnGates（runtime 启动门/事务
        // workspace 权威，与 Swift sidecar 同一实现与同一语义）。
        getDshWorkspacePath: () => assembly.localSpawnGates.getDshWorkspacePath(),
        canStartLocal: () => assembly.localSpawnGates.canStartLocal(),
        // A privileged activation may internally spawn a candidate while
        // public starts remain blocked. Keep its HTTP/WS and ready projection
        // quarantined until the full probe verdict opens runtimeState.startBlocked.
        canExposeLocal: () => assembly.localSpawnGates.canExposeLocal(),
        // The built dsh frontend (renderer vite output) served by the control
        // plane (design 05 §7.3): <pkg>/dist/web in dev and packaged (asar)
        // alike (renderer/dist isolation: renderer owns dist/web only; preload.cjs /
        // control-plane / host packages live beside it in dist/).
        webDistDir: path.join(pkgDir, 'dist', 'web'),
        // Host-graph package source (design 09 §3.5): the control plane seeds
        // it into the local web profile at start. Dev reads the source tree;
        // the packaged app uses the copy bundled into dist/ by
        // build-host-graph-package.mjs (inside the asar). Missing → the seed
        // degrades gracefully (no --patch overlay, v4 baseline spawn).
        hostGraphPackageSourceDir: app.isPackaged
          ? path.join(pkgDir, 'dist', 'host-graph-package')
          : path.join(repoRoot, 'packages', 'dsh-chamber-seed-client-graph'),
        hostGitWorktreePackageSourceDir: app.isPackaged
          ? path.join(pkgDir, 'dist', 'host-git-worktree-package')
          : path.join(repoRoot, 'packages', 'dsh-chamber-seed-git-worktree'),
        hostArchiveCleanupPackageSourceDir: app.isPackaged
          ? path.join(pkgDir, 'dist', 'host-archive-cleanup-package')
          : path.join(repoRoot, 'packages', 'dsh-chamber-seed-archive-cleanup'),
        // The open-in host domain (design 20 §6) is a LOCAL-shape-only seed:
        // the local profile is the only target that ever receives it, so it is
        // absent from `chamberHostSourceDirs` below (the remote seed list and
        // the gateway upload both read that map).
        hostOpenInPackageSourceDir: app.isPackaged
          ? path.join(pkgDir, 'dist', 'host-open-in-package')
          : path.join(repoRoot, 'packages', 'dsh-chamber-seed-open-in'),
      });
      // plane 先绑定再 start：localSpawnGates 的 writers-quiescent 门在启动期即读
      // 同一实例，onLocalStateChange 订阅也只接线一次（Swift sidecar 在 start 后
      // bindPlane，两 flavor 的 plane 生命周期由各自入口持有）。
      assembly.bindPlane(controlPlane);
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
    // 宿主事实回填：装配体在控制面之前构造（hostFacts.controlPlaneUrl 占位 ''），
    // 端口确定后写入——与 sidecar-entry 的 ready 前回填同形。
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

    // OS 唤醒即时重探（design 14 D4，传输层腿）：主进程对 error/degraded 实例
    // 立即重探（绝不触碰 idle）。held lastResume 补发 + SYSTEM_RESUME 推送在
    // shell-core（electron-edges 的 onSystemResume 订阅 = 装配于 installIpcHandlers
    // ① 段；此处另挂一条独立监听专做重探——重探叶归共享装配）。
    powerMonitor.on('resume', () => {
      assembly.reconnectStaleTransports();
    });

    maybeCreateTray(cp);
    registerDeepLinkProtocol();

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
    // 安装树上游 client-plugin 闭包抽样（全平台）：
    // afterPack 只证构建树，NSIS 长路径 / Defender 中断 / 部分安装丢掉一个上游
    // 包时，前端只静默少一行（sidebarRight 的唯一 provider 就在抽样里）。这里对
    // 已安装运行树做同一抽样，缺件大声报出且绝不阻断启动（与上面 ACL 收紧同一
    // 纪律）。dev 形态的 ref-dsh / vendor/dsh 是源码树与锁文件锚、不是"装出来的
    // 树"，所以只在打包态断言；未解析到内建树时 resolveBuiltinDshWorkspace 已有
    // 自己的 loud 警告。
    if (app.isPackaged) {
      const runtimeClosure = verifyRuntimeClientClosure(builtinDshWorkspace);
      if (!runtimeClosure.ok) {
        console.error(
          `[dsh-chamber] 已安装 dsh 运行树缺少上游 client-plugin：missing ${runtimeClosure.missing.join(', ')} — `
          + '请重装应用或删除 resources/vendor/dsh 后重跑 bundle:dsh；否则 sidebarRight/chat/resources 行会静默不可用',
        );
      }
    }

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
      callback(isChamberPermissionGranted(permission)));
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => isChamberPermissionGranted(permission));

    // shell IPC 注册点 = shell-core 的 installIpcHandlers（design 25 §4.1 seam）
    // ——本文件只做装配与注入：
    //  - ipc：trustedIpc 围栏在此包一层（core 零 electron，语义与
    //    `ipcMain.handle(ch, trustedIpc(handler))` 完全一致）；
    //  - edges：createElectronEdges 返回值（rendererPush + 渲染器投递/
    //    通知/徽标批成员 + showMessage/pickPluginSource 对话框腿；host 背参
    //    含 click 激活腿与 'show' 订阅面）；
    //  - ctx：共享装配的 host-assembly ctx（宿主事实 + settings 内存 holder /
    //    副作用叶活引用 + quit 门）。
    // 调用点纪律：whenReady 内、createMainWindow 之前——窗口
    // 加载前注册完毕（renderer 最早 invoke 也晚于全部启动代码），并完成投递
    // 状态机的 edges/quit 快照（shell-core 单装配不变式）。
    installIpcHandlers({
      ipc: {
        handle: (channel, handler) => ipcMain.handle(channel, trustedIpc(handler)),
      },
      edges,
      ctx: assembly.ctx,
    });
    updater.start();

    // 启动期创建主窗口：加载失败 = 大声失败 + 退出（createMainWindow 内）；
    // activate/托盘/second-instance 恢复路径共用同一创建函数。
    createMainWindow(rendererOrigin, true);
    // 启动尾部（host-assembly.runStartupTail——refreshRuntimeEvidence().then(
    // runRuntimeStartup) + catch 折叠 loud/启动门/failed 投影；与 Swift sidecar
    // 同一实现；无内建树时的静默窗在 Electron 为 0）。
    void assembly.runStartupTail();

    // 深链统一 drain（design 16 §4.2）：OS 深链启动队列（pendingIntents）与消费
    // 循环（drain 闭包）在 shell-core installIpcHandlers（成功 intent 经 core 导出
    // enqueueRendererDeepLinkIntent + ownsNotificationSource 接入 renderer
    // hold/replay 队列；失败 loud = core 内 edges.showError 对话框 + 日志；quit
    // 在途的新深链在 core 导出 enqueueDeepLink 内被 ignore）。此处只保留 startup
    // 完成后的首次显式 drain（冷启动 argv 入队先于装配——经导出入口
    // drainDeepLinkLaunches 消费；随后 OS 入口（open-url / second-instance）入队
    // 即触发消费）。
    drainDeepLinkLaunches();
  });
}
