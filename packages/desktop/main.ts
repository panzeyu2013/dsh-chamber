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

import { app, BrowserWindow, dialog, ipcMain, Menu, Tray, nativeImage } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PlaneHandle } from '@dsh-chamber/control-plane';
import { createTransportManager } from './transport-manager.ts';
import { INSTANCE_ID_PATTERN } from './transport-manager.ts';
import type { TransportManager } from './transport-manager.ts';
import { sshProvider } from './ssh-provider.ts';
import { configureSshPasswordStore, setSshPassword, sshPasswordSupported } from './ssh-provider.ts';
import { discoverSshConfigHosts } from './ssh-config.ts';
import { isTrustedIpcSender, isTrustedRendererUrl } from './renderer-trust.ts';

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
          click: () => {
            if (mainWindow !== null && !mainWindow.isDestroyed()) {
              if (mainWindow.isMinimized()) mainWindow.restore();
              mainWindow.show();
              mainWindow.focus();
            }
          },
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

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
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

    mainWindow = new BrowserWindow({
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
    // 冻结窗口标题（与上方 title 配套）：document.title 的每次变化都会触发
    // page-title-updated，不 preventDefault 则原生标题栏仍会跟随会话切换。
    mainWindow.on('page-title-updated', (event) => {
      event.preventDefault();
    });
    // The preload exposes host-impacting IPC. Keep it confined to the exact
    // control-plane document: deny popups and cancel cross-origin navigation
    // or redirects before another page can receive the same preload bridge.
    mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    mainWindow.webContents.on('will-navigate', (event, url) => {
      if (!isTrustedRendererUrl(url, rendererOrigin)) event.preventDefault();
    });
    mainWindow.webContents.on('will-redirect', (event, url) => {
      if (!isTrustedRendererUrl(url, rendererOrigin)) event.preventDefault();
    });
    mainWindow.on('closed', () => {
      mainWindow = null;
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
    void cp.startLocal().catch(err => {
      console.error('[dsh-chamber] 本地实例预启动失败（renderer 仍会尝试）：', err);
    });
    try {
      await mainWindow.loadURL(`http://127.0.0.1:${cp.port}/`);
    } catch (loadError) {
      const detail = loadError instanceof Error ? (loadError.stack ?? loadError.message) : String(loadError);
      dialog.showErrorBox('dsh-chamber 启动失败', `前端加载失败：\n${detail}`);
      await cp.stop().catch(err => console.error('[dsh-chamber] 控制面停止失败：', err));
      app.exit(1);
    }
  });
}
