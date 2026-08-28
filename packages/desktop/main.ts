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
 * This file is the thin boot after the A1 split: window lifecycle
 * (single-frame BrowserWindow, renderer recovery, tray, deep-link intake
 * handlers), the exit state machine (before-quit confirmation / will-quit
 * parallel cleanup + 5s force quit) and the wiring assembly. The IPC
 * surfaces live in the domain wiring modules, each registered with a
 * `register*` call injecting its dependencies:
 * - ipc-settings.ts — chamber settings holder + side effects (design 14 D7)
 * - ipc-notifications.ts — native notification chain + open queue (design 19)
 * - ipc-ssh.ts — transport manager + desktop_ssh_* surface (design 03/05)
 * - ipc-plugin-sync.ts — remote/local plugin management (design 13)
 * - ipc-open-in.ts — open-in registry (designs 16/17)
 * - ipc-deep-link.ts — VS Code deep-link queue + drain (design 16)
 * - ipc-update.ts — update controller (design 11)
 *
 * Responsibilities kept here:
 * - Single-frame BrowserWindow (contextIsolation, no nodeIntegration).
 * - Control plane lifecycle: spawn on ready, stop() on will-quit.
 * - Quit state machine (design 14 D2) + cleanup ordering (before-quit /
 *   will-quit parallel + QUIT_CLEANUP_TIMEOUT_MS force quit).
 * - Tray (packaged only, defensive), single-instance lock, OS wake handling.
 * - The dsh-chamber:info bootstrap channel (needs every boot fact).
 */

import { app, BrowserWindow, crashReporter, dialog, ipcMain, Menu, Tray, nativeImage, powerMonitor, session } from 'electron';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PlaneHandle } from '@dsh-chamber/control-plane';
// The dual-path control-plane resolution (packaged → compiled artifact,
// dev → workspace source) is single-sourced in control-plane-module.ts (A2
// cross-package protocol single-sourcing) — the same module ssh-provider.ts
// and plugin-sync.ts consume their shared envelope/cordis primitives from.
import { createControlPlane } from './control-plane-module.ts';
import { createTrustedIpc, isTrustedIpcSender, isTrustedRendererUrl } from './renderer-trust.ts';
import { IPC_CHANNELS } from './ipc-events.ts';
import {
  DEFAULT_CHAMBER_SETTINGS,
  closeToTrayRecoveryAvailable,
  computeQuitRisk,
  shouldHideToTray,
} from './chamber-settings.ts';
import type { ChamberSettings } from './chamber-settings.ts';
import { isLocalProcessRunning, isUpdateDownloadReady } from './wiring.ts';
import { registerSettings } from './ipc-settings.ts';
import type { SettingsWiring } from './ipc-settings.ts';
import { registerNotifications } from './ipc-notifications.ts';
import type { NotificationsWiring } from './ipc-notifications.ts';
import { registerSsh } from './ipc-ssh.ts';
import type { SshWiring } from './ipc-ssh.ts';
import { registerPluginSync } from './ipc-plugin-sync.ts';
import type { PluginSyncWiring } from './ipc-plugin-sync.ts';
import { registerOpenIn } from './ipc-open-in.ts';
import { enqueueDeepLink, registerDeepLink, scanDeepLinkUrls } from './ipc-deep-link.ts';
import type { DeepLinkWiring } from './ipc-deep-link.ts';
import { registerUpdate } from './ipc-update.ts';
import type { UpdateWiring } from './ipc-update.ts';

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

function resolveDshWorkspace(): string | null {
  if (process.env.DSH_CHAMBER_DSH_PATH) {
    return process.env.DSH_CHAMBER_DSH_PATH;
  }
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

const dshWorkspace = resolveDshWorkspace();
if (dshWorkspace === null) {
  console.warn(
    '[dsh-chamber] 未找到 dsh 工作区（DSH_CHAMBER_DSH_PATH / <repoRoot>/ref-dsh / <pkg>/vendor/dsh 均不可用），连接页将显示错误',
  );
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
let tray: Tray | null = null;
// 当前窗口 URL（控制面 origin，控制面启动后赋值）。窗口被关闭后可据此
// 重建（macOS activate 路径）——没有它，窗口一旦关闭应用就永久无窗。
let mainWindowUrl: string | null = null;

// Quit state machine (design 14 D2): quitRequested 置位后关窗不再 hide（真正
// 退出在途）；quitConfirmed 表示退出已获确认/豁免；confirmingQuit 是确认
// 对话框单飞闸（防连点/双路径重复弹窗）。
let quitRequested = false;
let quitConfirmed = false;
let confirmingQuit = false;
// will-quit cleanup is asynchronous. A second app.quit()/OS quit event while
// it is running must remain prevented; otherwise `controlPlane = null` from
// the first pass would let the second event exit immediately and orphan the
// still-draining SSH/dsh children.
let quitCleanupInProgress = false;
// 最近一次 OS 唤醒时间戳：无窗口常驻（托盘态）期间 held，窗口 show 时补发。
let lastResume: number | null = null;

// Wiring handles (created in whenReady; null before startup so the pre-ready
// paths — e.g. the single-instance-lock failure quit — stay inert).
let settingsWiring: SettingsWiring | null = null;
let notificationsWiring: NotificationsWiring | null = null;
let sshWiring: SshWiring | null = null;
let pluginSyncWiring: PluginSyncWiring | null = null;
let deepLinkWiring: DeepLinkWiring | null = null;
let updateWiring: UpdateWiring | null = null;

/** 当前 chamber 设置快照：wiring 装配前（whenReady 前）回落 DEFAULT（与
 *  旧 main.ts 的模块级 holder 初始化语义一致）。 */
function chamberSettingsSnapshot(): ChamberSettings {
  return settingsWiring === null ? { ...DEFAULT_CHAMBER_SETTINGS } : settingsWiring.get();
}

/** 退出清理（will-quit：transport dispose + 控制面 stop）的最长等待；超时强制
 *  退出，防「窗口已关、主进程永久滞留」的半退出态。子进程回收用短窗口
 *  （transport 1s / 本地 dsh 1s → SIGKILL）+ 传输层与控制面并行化，正常
 *  ~1-2s 完成；5s 硬顶仅为异常路径（如残留连接使 server.close 不回调）兜底
 *  （2026-08 排查；2026-08 提速，15s → 5s）。 */
const QUIT_CLEANUP_TIMEOUT_MS = 5_000;

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
 * 显示/恢复主窗口；窗口已不存在（被关闭）时按控制面 origin 重建。Dock
 * 图标点击（macOS activate）、二次启动（second-instance）与托盘菜单共用
 * 这一条恢复路径——没有重建分支时，窗口一旦关闭应用就以无窗口状态常驻，
 * 点任何入口都毫无反应。
 */
function showMainWindow(): void {
  // Notification clicks, Dock activation and a second-instance event can
  // race before/will-quit. Never resurrect or reload the privileged renderer
  // after teardown has begun.
  if (quitRequested) return;
  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  if (mainWindowUrl !== null) createMainWindow(mainWindowUrl, false);
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
    // A reload starts a fresh boot. A timer owned by the previous renderer
    // must never reload its healthy replacement later.
    loadedOnce = false;
    clearUnresponsiveTimer();
    clearCrashReloadTimer();
  });
  win.webContents.on('did-finish-load', () => {
    loadedOnce = true;
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    clearUnresponsiveTimer();
    clearCrashReloadTimer();
    if (details.reason === 'clean-exit' || quitRequested) return; // 用户关窗/退出等正常路径
    // 通知就绪标志立即失效（design 19 §3.3）：崩溃到 500ms 后 reload 之间没有
    // 导航事件（did-start-loading 不会触发），不重置则向死 frame 推送丢事件。
    notificationsWiring?.resetDrainReady();
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
  // 通知点击的重建竞态兜底（design 19 §3.3）：点击时窗口若在重建/加载中，打开
  // 意图入队；renderer 就绪后统一补发（照搬 pendingIntents 模式，不丢事件）。
  // 就绪标志的重置点选在 did-start-loading（而非 did-finish-load）：页面刚加载
  // 完成时 renderer 的 onOpen 监听尚未注册（preload 桥异步 expose → React mount
  // → sshBridgeReady effect），而 did-finish-load 可能被 >500ms 的慢子资源拖迟
  // 到 ready() invoke 之后——若在 finish 时重置会把已置位的标志 clobber 成永久
  // false。start-loading 必先于页面脚本执行（invoke 恒在其后），顺序保证成立。
  win.webContents.on('did-start-loading', () => {
    notificationsWiring?.resetDrainReady();
    notificationsWiring?.drainOpens();
  });
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  // 关窗到托盘（design 14 D1）：设置 = hide-to-tray 且存在恢复入口（win/linux
  // 需托盘；macOS Dock 常驻）且非真正退出在途 → hide（不 destroy），控制面/
  // 传输层/dsh 子进程继续运行。托盘缺失时回退现状（关窗即退，受 D2 确认保护）
  // ——绝不允许窗口被隐藏后无任何恢复入口。
  win.on('close', (event) => {
    const recoveryAvailable = closeToTrayRecoveryAvailable(process.platform, tray !== null);
    if (shouldHideToTray(chamberSettingsSnapshot().windowCloseBehavior, recoveryAvailable, quitRequested)) {
      event.preventDefault();
      win.hide();
    }
  });
  // 无窗口常驻（托盘态）期间的唤醒事件由主进程 held（lastResume），窗口
  // 恢复可见时一次性补发（design 14 D4）。
  win.on('show', () => {
    if (lastResume !== null) {
      win.webContents.send(IPC_CHANNELS.SYSTEM_RESUME, { timestamp: lastResume });
      lastResume = null;
    }
  });
  void win.loadURL(url).catch((loadError) => {
    // Closing/quitting aborts outstanding navigation by design; that is not
    // a startup failure and must not show a spurious fatal dialog or re-enter
    // teardown through app.exit().
    if (quitRequested || win.isDestroyed()) return;
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
  // pendingIntents 队列（ipc-deep-link 模块级队列，register 前即可用）；与
  // 冷启动 argv 扫描的双触发由 seenDeepLinkUrls 去重。在模块顶层（whenReady
  // 之前）注册，冷启动 URL 不丢。
  app.on('open-url', (event, url) => {
    event.preventDefault();
    enqueueDeepLink(url);
  });

  // 终止信号（终端 Ctrl+C / Activity Monitor「退出」/ 进程管理器 SIGTERM）：
  // 转 app.quit() 优雅路径——will-quit 会先回收传输层/控制面/本地 dsh 实例，
  // 而不是让 Electron 直接终止，把 detached 的 dsh 子进程留成孤儿。
  // **2026-08 实机验证**：macOS 与 Linux 的 Electron 43 主进程收到 SIGTERM
  // 时，`process.on('SIGTERM')` **不触发**——Chromium 消费信号并走自身的默认
  // 优雅退出（同样触发 before-quit → will-quit，资源回收完整）；本 handler
  // 保留作为其他运行时/平台上 process.on 生效时的兜底。Chromium 接管的信号
  // 场景因此走正常退出确认（quitConfirmation=true 且本地实例在跑时会弹确认
  // 框，等待用户确认后走 will-quit 清理——不是卡死）。信号本身是明确的退出
  // 意图，handler 真正触发时跳过确认框（quitConfirmed 提前置位）。
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
    if (process.platform !== 'darwin' || chamberSettingsSnapshot().windowCloseBehavior === 'quit') app.quit();
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
    // 2026-08 修订：远程隧道不影响关闭（用户拍板）——风险只看本地实例；退出
    // 确认开关（quitConfirmation）关闭时永不确认。2026-08 二次修订：状态机
    // 显示 running 还不够——必须实际有存活进程（restart backoff / 死亡未探活
    // 期间状态机可能误报 running）。
    const updateDownloadReady = isUpdateDownloadReady(updateWiring?.updateState());
    const localRunning = isLocalProcessRunning(cp.connectionState, cp.localProcessAlive);
    const risk = computeQuitRisk({
      quitConfirmation: chamberSettingsSnapshot().quitConfirmation,
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
    // 真正退出在途（窗口已全部关闭）：close 分支不再 hide；keep-awake 停止
    // （design 14 D5）。确认/豁免已在 before-quit 完成，这里只剩清理。
    quitRequested = true;
    settingsWiring?.shutdownKeepAwake();
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
    const cp = controlPlane;
    if (cp === null) return;
    event.preventDefault();
    quitCleanupInProgress = true;
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
    controlPlane = null;
    const pluginSync = pluginSyncWiring;
    pluginSyncWiring = null;
    void Promise.allSettled([
      pluginSync?.disposeAsync().catch((err) => console.error('[dsh-chamber] 插件子进程关闭失败：', err)),
      sshWiring?.transportManager()?.disposeAsync().catch((err) => console.error('[dsh-chamber] 传输层关闭失败：', err)),
      cp.stop().catch((err) => console.error('[dsh-chamber] 控制面停止失败：', err)),
    ]).finally(() => {
      clearTimeout(cleanupTimer);
      quitCleanupInProgress = false;
      app.quit();
    });
  });

  app.whenReady().then(async () => {
    // 冷启动深链 argv（design 16 §4.2）：macOS argv 含 -psn_ 噪声，防御式扫描
    // （非深链 argv 零副作用、绝不 throw 打断启动）；与 open-url 双触发由去重兜底。
    for (const url of scanDeepLinkUrls(process.argv)) enqueueDeepLink(url);
    try {
      const controlPlanePort = resolveControlPlanePort();
      console.log(`[dsh-chamber] 控制面端口：${controlPlanePort}（${process.env.DSH_CHAMBER_CP_PORT ? 'DSH_CHAMBER_CP_PORT 覆盖' : process.env.DSH_CHAMBER_ELECTRON_DEV === '1' ? 'dev 默认' : '打包默认'}）`);
      controlPlane = createControlPlane({
        port: controlPlanePort,
        stateDir: path.join(app.getPath('userData'), 'state'),
        // null and undefined fall through the option's ?? chain identically.
        dshWorkspacePath: dshWorkspace as string | undefined,
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

    // Capture the non-null control plane before registering closures over it
    // (the handler runs later, after startup).
    const cp = controlPlane;
    const rendererOrigin = `http://127.0.0.1:${cp.port}`;
    // trustedIpc 围栏（design 05 §7.4）：每个 ipcMain.handle 注册都经它——
    // sender 校验（当前主窗口 + 固定 chamber 文档）+ quit 在途拒绝（2026
    // final review，防御纵深：teardown 已开始，late connect/exec/apply 不得
    // 向 shutdown 注入新工作）。语义见 renderer-trust.ts 的 createTrustedIpc。
    const trustedIpc = createTrustedIpc({
      isTrustedSender: (event) => {
        const win = mainWindow;
        return win !== null && !win.isDestroyed() && isTrustedIpcSender(event, win.webContents, rendererOrigin);
      },
      isQuitting: () => quitRequested,
    });
    ipcMain.handle(IPC_CHANNELS.INFO, trustedIpc(() => ({
      controlPlaneUrl: `http://127.0.0.1:${cp.port}`,
      dshVersion: readDshVersion(dshWorkspace),
      version,
      platform: process.platform,
    })));

    // ---- wiring 装配（顺序与旧 main.ts 的启动序一致）----

    // Chamber settings（design 14 D7）：启动加载 + 应用副作用（keep-awake /
    // 登录自启 reconcile）+ settings IPC 面。损坏 loud（*.corrupt 保留）。
    settingsWiring = registerSettings({
      trustedIpc,
      mainWindow: () => mainWindow,
      userDataPath: app.getPath('userData'),
      trayAvailable: () => tray !== null,
    });
    const settings = settingsWiring;
    settings.loadAndReconcile();

    // 桌面通知（design 19 §3.3）：notify / notifications-ready 通道 + 点击
    // 打开队列。窗口生命周期（did-start-loading / render-process-gone）经
    // notificationsWiring 复位/补发。
    notificationsWiring = registerNotifications({
      trustedIpc,
      mainWindow: () => mainWindow,
      quitRequested: () => quitRequested,
      showMainWindow,
      getChamberNotificationSettings: () => settings.get().notifications,
    });

    // 托盘（打包态防御性创建）：settings 投影的 closeToTray 门控依赖它。
    maybeCreateTray(controlPlane);

    // SSH 传输层（design 03 §2.2 / 05 §7-§8）：transport manager 创建 + 实例
    // 装载 + desktop_ssh_* IPC + 状态推送（控制面 transport 注册 + renderer push）。
    sshWiring = registerSsh({
      trustedIpc,
      mainWindow: () => mainWindow,
      controlPlane: () => controlPlane,
      quitRequested: () => quitRequested,
      userDataPath: app.getPath('userData'),
    });
    const sm = sshWiring;

    // OS 唤醒即时重探 + 推送（design 14 D4）：主进程对 error/degraded 实例
    // 立即重探（绝不触碰 idle），并向渲染端 push（dsh 前端连接立即重连）。
    powerMonitor.on('resume', () => {
      lastResume = Date.now();
      const win = mainWindow;
      if (win !== null && !win.isDestroyed()) {
        win.webContents.send(IPC_CHANNELS.SYSTEM_RESUME, { timestamp: lastResume });
        // 窗口存活（含隐藏）已即时收到：清空 held 值，避免 hide→show 补发过期事件。
        lastResume = null;
      }
      sshWiring?.reconnectStaleTransports();
    });

    // 插件管理（design 13 M2+M3）：远端/本地插件 IPC + chamber host 包
    // ready-time seed（与 ipc-ssh 的 status listener 并行注册）。
    pluginSyncWiring = registerPluginSync({
      trustedIpc,
      transportManager: () => sm.transportManager(),
      mainWindow: () => mainWindow,
      dshWorkspace,
      userDataPath: app.getPath('userData'),
    });

    // open-in 注册表（designs 16/17）：apps() 协商 + 统一执行管线；同时构建
    // 与深链共享的 vscodeCtx（runVscodeLaunch 宿主依赖）。
    const openInWiring = registerOpenIn({
      trustedIpc,
      transportManager: () => sm.transportManager(),
      mainWindow: () => mainWindow,
    });

    // VS Code 深链（design 16 §4/§5）：协议注册 + pendingIntents drain 绑定
    // （vscodeCtx 来自 open-in）。入队在模块顶层即可用（冷启动 open-url）。
    deepLinkWiring = registerDeepLink({
      quitRequested: () => quitRequested,
      mainWindow: () => mainWindow,
      vscodeCtx: openInWiring.vscodeCtx,
    });

    // Update controller（design 11）：静默检查 + 用户确认下载 + 退出时安装。
    // 模块级 ref 供 before-quit 的退出豁免读取（design 14 D2）。
    updateWiring = registerUpdate({
      trustedIpc,
      mainWindow: () => mainWindow,
      appVersion: version,
    });

    // Single frame, single origin: the control plane serves the built dsh
    // frontend (design 05 §1) — no local file loads. A load failure is a
    // loud startup failure (dialog + exit), never a silently broken window;
    // the control plane is stopped first so no local dsh child is orphaned.
    // The local instance is pre-spawned BEFORE the window loads (05 §7.5):
    // the first screen finds it already ready — the spawn's ~seconds of
    // boot time overlap the page/bundle load instead of sitting between the
    // renderer's auto-start POST and the ready push. The renderer's own
    // POST stays idempotent on the same path; a spawn failure here is
    // non-fatal (the renderer surfaces the instance error state).
    // Deny Web permission requests by default: Electron default-grants these to
    // same-origin content, and the control plane also serves proxied remote-instance
    // content under /api/i/<id>/* (same origin). Keep one benign exception —
    // clipboard-sanitized-write (navigator.clipboard copy) — which carries no
    // read/privacy risk; clipboard-read and media/geolocation/notifications stay
    // denied.
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'clipboard-sanitized-write');

    void cp.startLocal().catch(err => {
      console.error('[dsh-chamber] 本地实例预启动失败（renderer 仍会尝试）：', err);
    });
    // 启动期创建主窗口：加载失败 = 大声失败 + 退出（createMainWindow 内）；
    // activate/托盘/second-instance 恢复路径共用同一创建函数。
    createMainWindow(rendererOrigin, true);

    // 深链统一 drain（design 16 §4.2）：startup 完成（transportManager 装载 +
    // 主窗口就绪）后消费 pendingIntents（registerDeepLink 已绑定 drain）。
    deepLinkWiring.drainIntents();

    // 通知打开事件统一 drain（design 19 §3.3）：startup 完成 + 窗口就绪后
    // 补发（did-start-loading 已复位，若 renderer 已 ready 则直接推送）。
    notificationsWiring.drainOpens();
  });
}
