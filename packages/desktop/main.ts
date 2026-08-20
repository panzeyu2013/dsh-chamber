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

import { app, BrowserWindow, crashReporter, dialog, ipcMain, Menu, Tray, nativeImage, powerMonitor, powerSaveBlocker, shell } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path, { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PlaneHandle } from '@dsh-chamber/control-plane';
import { createTransportManager } from './transport-manager.ts';
import { INSTANCE_ID_PATTERN } from './transport-manager.ts';
import type { TransportManager } from './transport-manager.ts';
import { sshProvider, probeClientGraphLive } from './ssh-provider.ts';
import { configureSshPasswordStore, setSshPassword, sshPasswordSupported } from './ssh-provider.ts';
import { discoverSshConfigHosts } from './ssh-config.ts';
import { isTrustedIpcSender, isTrustedRendererUrl } from './renderer-trust.ts';
import { createUpdateController } from './updater.ts';
import { applyPlugins, CLIENT_GRAPH_PACKAGE_NAME, localPluginList, materializeAndAdd, remoteHome, remotePluginList, runLocalDshPlugin, seedRemoteHostGraph } from './plugin-sync.ts';
import type { ExecFn, StatusFn, RemoteSpec } from './plugin-sync.ts';
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

// Main-process safety net: a stray stream/socket error (e.g. an ECONNRESET
// from a peer that went away mid-request) must never wedge startup behind a
// dialog or a silent stall — log the full stack and continue. The control
// plane and transport layer already attach per-socket handlers; this is the
// last line for anything that escapes them.
process.on('uncaughtException', (error) => {
  console.error('[dsh-chamber] uncaught exception (continuing):', error instanceof Error ? error.stack : String(error));
});
process.on('unhandledRejection', (reason) => {
  console.error('[dsh-chamber] unhandled rejection:', reason instanceof Error ? reason.stack : String(reason));
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
const { createControlPlane } = controlPlaneModule;

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

/** 退出清理（will-quit：transport dispose + 控制面 stop）的最长等待；超时强制
 *  退出，防「窗口已关、主进程永久滞留」的半退出态（2026-08 实机排查）。 */
const QUIT_CLEANUP_TIMEOUT_MS = 15_000;
// Update controller ref (created in whenReady): the quit-confirmation exemption
// (design 14 D2) reads its state at will-quit time.
let updateController: { state(): { phase: string; installBlockedReason: string | null } } | null = null;
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
  const url = `${rendererOrigin}/`;
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
  app.on('second-instance', () => {
    showMainWindow();
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
    // 真正退出在途（窗口已全部关闭）：close 分支不再 hide；keep-awake 停止
    // （design 14 D5）。确认/豁免已在 before-quit 完成，这里只剩清理。
    quitRequested = true;
    setKeepAwakeActive(false);
    if (!controlPlane) return;
    event.preventDefault();
    // Kill any live tunnels / in-flight execs before the control plane stops
    // (the transport lifecycle is the runtime's alone; dispose() tears
    // everything down). disposeAsync additionally WAITS for every SIGKILL
    // escalation: without the wait, app.quit() can exit within the 2s grace
    // and a SIGTERM-ignoring ssh child would be orphaned (escalation timers
    // are unref'd — quitting loses them).
    // 2026-08 兜底：清理链（disposeAsync / cp.stop → server.close）若挂起
    // （例如残留连接使 server.close 不回调），主进程会永久滞留成"窗口已关、
    // 进程仍在"的半退出态——超时后强制退出，绝不无期限滞留。
    const cleanupTimer = setTimeout(() => {
      // 超时强制退出走 app.exit()：quit 事件不会触发，electron-updater 的
      // autoInstallOnAppQuit 也不执行——即使「已下载」豁免放行了退出，更新
      // 安装也会被跳过（接受的取舍，如实记录）。
      console.error('[dsh-chamber] 退出清理超时，强制退出（可能有子进程残留，已下载更新不会安装）');
      app.exit(1);
    }, QUIT_CLEANUP_TIMEOUT_MS);
    void (async () => {
      try {
        await transportManager?.disposeAsync();
      } catch (err) {
        console.error('[dsh-chamber] 传输层关闭失败：', err);
      }
      const cp = controlPlane;
      controlPlane = null;
      cp.stop()
        .catch((err) => console.error('[dsh-chamber] 控制面停止失败：', err))
        .finally(() => {
          clearTimeout(cleanupTimer);
          app.quit();
        });
    })();
  });

  app.whenReady().then(async () => {
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
    ipcMain.handle('dsh-chamber:info', trustedIpc(() => ({
      controlPlaneUrl: `http://127.0.0.1:${cp.port}`,
      dshWorkspace,
      dshVersion: readDshVersion(dshWorkspace),
      dshHome: path.join(app.getPath('userData'), 'dsh-home'),
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
    ipcMain.handle('dsh-chamber:settings-set', trustedIpc(({ patch }) => {
      const validated = validatePatch(patch);
      if (!validated.ok) return { error: validated.error };
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
    // In-flight guard for the ready-time remote host-graph seed (design 09 §6
    // 遗留 1): a Set of instance ids whose seed is currently running — pure
    // concurrency guard, not a "seeded" flag (the seed is idempotent, so
    // reconnects re-run a cheap content-hash no-op instead).
    const hostGraphSeeding = new Set<string>();
    // The authoritative local dsh home is <userData>/state/dsh-home (the real
    // spawn home, design 13 §2.2) — never dsh-chamber:info.dshHome.
    const localDshHome = path.join(app.getPath('userData'), 'state', 'dsh-home');
    // Module A package source for the remote host-graph seed (design 13 §4.6):
    // the packaged app bundles it under dist/host-graph-package (build-host-graph-package.mjs),
    // dev reads the repo source tree — same resolution as the control-plane seed.
    const moduleASourceDir = app.isPackaged
      ? path.join(pkgDir, 'dist', 'host-graph-package')
      : path.join(repoRoot, 'packages', 'dsh-host-client-graph');
    const findRemoteSpec = (id: string): RemoteSpec | null => {
      const instance = sm.listInstances().find((entry) => entry.id === id);
      if (instance === undefined) return null;
      return { id: instance.id, remoteDshHome: instance.remoteDshHome ?? null };
    };
    // The remote install-level flat fallback dir the seed writes module A into
    // (design 13 §4.6): same path derivation as the plugin-sync seed/probe
    // (remoteHome semantics + CLIENT_GRAPH_PACKAGE_NAME) — the 注入完成 log
    // states exactly where the files landed.
    const remoteHostGraphPackageDir = (spec: RemoteSpec): string =>
      `${remoteHome(spec.remoteDshHome)}/profiles/node_modules/${CLIENT_GRAPH_PACKAGE_NAME}`;
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
      // Remote host-graph seed (design 09 §6 遗留 1 wiring, 2026-08): when an
      // SSH instance comes ready, seed module A onto it once per process run.
      // NOT silent — the plugin management UI probes the live state and shows
      // the injection block verbatim (installed/patched), and the seed result
      // is logged here; a failure is retried on the next ready (the seed is
      // idempotent, content-hash skip). Idempotency also makes the guard a
      // pure in-flight Set: reconnects re-run a cheap no-op seed instead of
      // tracking a persisted "seeded" flag that could drift from the remote.
      if (status.kind === 'ssh' && status.phase === 'ready' && !hostGraphSeeding.has(id)) {
        hostGraphSeeding.add(id);
        void (async () => {
          try {
            // Module A not shipped (dev before build / broken packaging) is a
            // graceful skip, never a fake "already in sync" (seedRemoteHostGraph
            // would report ok with wrote=false — honest only if we state the
            // reason; the UI probe independently shows 未注入 either way).
            if (!existsSync(moduleASourceDir)) {
              console.log(`[dsh-chamber] host-graph seed skipped for ${id}: module A not shipped (${moduleASourceDir} missing)`);
              sm.appendLog(id, 'info', 'chamber host-graph 未注入：模块 A 未打包（构建缺失），本地实例可正常使用，远端客户端插件图不可用');
              return;
            }
            const spec = findRemoteSpec(id);
            if (spec === null) return;
            const result = await seedRemoteHostGraph(execTransport, spec, moduleASourceDir);
            if (result.ok) {
              const message = `host-graph seeded onto ${id} (wrote=${result.wrote}, patched=${result.patched})`;
              console.log(`[dsh-chamber] ${message}`);
              sm.appendLog(id, 'info', `chamber host-graph 注入完成：模块 A 包${result.wrote ? '已写入' : '已是最新'}（${remoteHostGraphPackageDir(spec)}），boot 层${result.patched ? '已挂载' : '无需改动'}（重启后生效）`);
            } else {
              console.warn(`[dsh-chamber] host-graph seed failed for ${id}: ${result.error}`);
              sm.appendLog(id, 'error', `chamber host-graph 注入失败：${result.error}`);
            }
          } catch (err) {
            const message = `host-graph seed error for ${id}: ${String(err)}`;
            console.warn(`[dsh-chamber] ${message}`);
            sm.appendLog(id, 'error', `chamber host-graph 注入异常：${String(err)}`);
          } finally {
            hostGraphSeeding.delete(id);
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
      setSshPassword(id, typeof password === 'string' && password !== '' ? password : null);
      return { ok: true };
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
      return remotePluginList(execTransport, spec, { liveProbe: liveProbeFor(id) });
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
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5_000);
      timer.unref?.();
      try {
        const response = await fetch(`https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(text)}&size=20`, {
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
      // with an info log instead.
      if (!existsSync(moduleASourceDir)) {
        return { ok: false, error: '模块 A 未打包（host-graph seed 源缺失），无法注入——请先构建 host-graph 包' };
      }
      const result = await seedRemoteHostGraph(execTransport, spec, moduleASourceDir);
      // Surface the outcome in the instance's ring-buffer log (the connections
      // UI log panel) — the injection is never a silent modification.
      if (result.ok) {
        sm.appendLog(id, 'info', `chamber host-graph 注入完成：模块 A 包${result.wrote ? '已写入' : '已是最新'}（${remoteHostGraphPackageDir(spec)}），boot 层${result.patched ? '已挂载' : '无需改动'}（重启后生效）`);
      } else {
        sm.appendLog(id, 'error', `chamber host-graph 注入失败：${result.error}`);
      }
      return result;
    }));
    // materialize_add (sync view): the dir is resolved from the LOCAL manifest's
    // absolute file:/link: spec (renderer-side materializeLocalDir). Main bounds
    // it to an absolute, existing directory — loud failure, never a silent no-op.
    ipcMain.handle('desktop_ssh_plugin_materialize_add', trustedIpc(async ({ id, dir }) => {
      const spec = findRemoteSpec(id);
      if (spec === null) return { ok: false, error: 'ssh instance not found' };
      if (typeof dir !== 'string' || dir === '') return { ok: false, error: 'empty plugin directory' };
      if (!isAbsolute(dir)) return { ok: false, error: 'plugin directory must be absolute' };
      try {
        if (!statSync(dir).isDirectory()) return { ok: false, error: 'plugin path is not a directory' };
      } catch (error) {
        return { ok: false, error: `plugin directory unreadable: ${String(error)}` };
      }
      return materializeAndAdd(execTransport, spec, dir);
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
      if (dshWorkspace === null) return { ok: false, error: 'dsh workspace not found' };
      if (mainWindow === null || mainWindow.isDestroyed()) return { ok: false, error: 'no main window' };
      const picked = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
      if (picked.canceled || picked.filePaths.length === 0) return { ok: true, cancelled: true };
      const result = runLocalDshPlugin(dshWorkspace, localDshHome, 'add', `file:${picked.filePaths[0]}`);
      return result.ok ? { ok: true } : { ok: false, error: result.error ?? 'local add failed' };
    }));
    ipcMain.handle('desktop_local_plugin_add', trustedIpc(({ spec: specArg }) => {
      if (dshWorkspace === null) return { ok: false, error: 'dsh workspace not found' };
      const result = runLocalDshPlugin(dshWorkspace, localDshHome, 'add', specArg);
      return result.ok ? { ok: true } : { ok: false, error: result.error ?? 'local add failed' };
    }));
    ipcMain.handle('desktop_local_plugin_remove', trustedIpc(({ name }) => {
      if (dshWorkspace === null) return { ok: false, error: 'dsh workspace not found' };
      const result = runLocalDshPlugin(dshWorkspace, localDshHome, 'remove', name);
      return result.ok ? { ok: true } : { ok: false, error: result.error ?? 'local remove failed' };
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
    void cp.startLocal().catch(err => {
      console.error('[dsh-chamber] 本地实例预启动失败（renderer 仍会尝试）：', err);
    });
    // 启动期创建主窗口：加载失败 = 大声失败 + 退出（createMainWindow 内）；
    // activate/托盘/second-instance 恢复路径共用同一创建函数。
    createMainWindow(rendererOrigin, true);
  });
}
