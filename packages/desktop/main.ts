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

import { app, BrowserWindow, crashReporter, dialog, ipcMain, Menu, Tray, nativeImage } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { existsSync, readFileSync, renameSync, statSync } from 'node:fs';
import path, { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PlaneHandle } from '@dsh-chamber/control-plane';
import { createTransportManager } from './transport-manager.ts';
import { INSTANCE_ID_PATTERN } from './transport-manager.ts';
import type { TransportManager } from './transport-manager.ts';
import { sshProvider } from './ssh-provider.ts';
import { configureSshPasswordStore, setSshPassword, sshPasswordSupported } from './ssh-provider.ts';
import { discoverSshConfigHosts } from './ssh-config.ts';
import { isTrustedIpcSender, isTrustedRendererUrl } from './renderer-trust.ts';
import { applyPlugins, localPluginList, materializeAndAdd, remotePluginList, runLocalDshPlugin, seedRemoteHostGraph } from './plugin-sync.ts';
import type { ExecFn, StatusFn, RemoteSpec } from './plugin-sync.ts';

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

let mainWindow: BrowserWindow | null = null;
let controlPlane: PlaneHandle | null = null;
let transportManager: TransportManager | null = null;
let tray: Tray | null = null;
// 当前窗口 URL（控制面 origin，控制面启动后赋值）。窗口被关闭后可据此
// 重建（macOS activate 路径）——没有它，窗口一旦关闭应用就永久无窗。
let mainWindowUrl: string | null = null;

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
        // Quit goes through the existing will-quit → cp.stop() path.
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
    // 固定窗口标题：官方 dsh 前端（DocumentTitle.tsx）会把当前会话名
    // 投影到 document.title——若不拦截 page-title-updated，原生标题栏会
    // 随选中会话变化。单 frame 壳的品牌标识恒定，会话名在应用内可见。
    title: 'dsh-chamber',
    webPreferences: {
      // 沙箱 preload 以纯 CJS 执行（无 TS 类型擦除），统一加载编译产物
      // dist/preload.cjs（build:preload 生成）；缺省回退源码仅为兜底。
      preload: existsSync(path.join(pkgDir, 'dist', 'preload.cjs'))
        ? path.join(pkgDir, 'dist', 'preload.cjs')
        : path.join(pkgDir, 'preload.cts'),
      contextIsolation: true,
      nodeIntegration: false,
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

  // macOS：Dock 图标点击触发 activate。没有此处理时，窗口一旦关闭
  // （window-all-closed 在 darwin 不退出），应用以无窗口状态常驻，点
  // 图标毫无反应——"前端消失后点图标回不来"的根源。
  app.on('activate', () => {
    showMainWindow();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('will-quit', (event) => {
    if (!controlPlane) return;
    event.preventDefault();
    // Kill any live tunnels / in-flight execs before the control plane stops
    // (the transport lifecycle is the runtime's alone; dispose() tears
    // everything down). disposeAsync additionally WAITS for every SIGKILL
    // escalation: without the wait, app.quit() can exit within the 2s grace
    // and a SIGTERM-ignoring ssh child would be orphaned (escalation timers
    // are unref'd — quitting loses them).
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
        .finally(() => app.quit());
    })();
  });

  app.whenReady().then(async () => {
    try {
      controlPlane = createControlPlane({
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
      return remotePluginList(execTransport, spec);
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
      return seedRemoteHostGraph(execTransport, spec, moduleASourceDir);
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
