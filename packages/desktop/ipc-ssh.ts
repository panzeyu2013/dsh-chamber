/**
 * SSH transport wiring (design 03 §2.2 / 05 §7-§8, split from main.ts — A1):
 * the transport manager lifecycle (persisted instance registry, askpass
 * cleanup + password store), the desktop_ssh_* IPC surface, the status push
 * listener (control-plane transport registration + renderer push) and the
 * OS-wake reconnect helper. The generic runtime lives in transport-manager.ts
 * and the ssh provider in ssh-provider.ts; only the electron/IPC wiring and
 * the startup orchestration live here.
 *
 * main.ts keeps two handles: transportManager() (will-quit disposeAsync) and
 * reconnectStaleTransports() (powerMonitor resume).
 */

import path from 'node:path'
import { renameSync } from 'node:fs'
import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import type { PlaneHandle } from '@dsh-chamber/control-plane'
import { IPC_CHANNELS } from './ipc-events.ts'
import type { TrustedIpc } from './renderer-trust.ts'
import { createTransportManager, INSTANCE_ID_PATTERN } from './transport-manager.ts'
import type { TransportManager } from './transport-manager.ts'
import {
  MAX_SSH_PASSWORD_CHARS,
  cleanupStaleAskpassHelpers,
  configureSshPasswordStore,
  setSshPassword,
  sshPasswordSupported,
  sshProvider,
} from './ssh-provider.ts'
import { discoverSshConfigHosts } from './ssh-config.ts'

/** Dependencies injected by main.ts at startup (whenReady assembly). */
export interface SshWiringCtx {
  trustedIpc: TrustedIpc
  mainWindow: () => BrowserWindow | null
  controlPlane: () => PlaneHandle | null
  /** Quit-in-progress gate (resume reconnect must not spawn into shutdown). */
  quitRequested: () => boolean
  /** <userData> path (registry + password store live there). */
  userDataPath: string
}

/** The handle main.ts keeps: will-quit dispose + OS-wake reconnect. */
export interface SshWiring {
  transportManager(): TransportManager | null
  /** powerMonitor resume: reconnect only transiently-failed instances (never
   *  idle; never terminal requiresUserAction failures). */
  reconnectStaleTransports(): void
}

export function registerSsh(ctx: SshWiringCtx): SshWiring {
  const { trustedIpc, mainWindow, controlPlane, quitRequested, userDataPath } = ctx
  let transportManager: TransportManager | null = null

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
  const askpassNotice = cleanupStaleAskpassHelpers()
  if (askpassNotice !== null) console.error(`[dsh-chamber] ${askpassNotice}`)
  const passwordNotice = configureSshPasswordStore(path.join(userDataPath, 'ssh-passwords.json'))
  if (passwordNotice !== null) console.error(`[dsh-chamber] ssh password store: ${passwordNotice}`)
  transportManager = createTransportManager({
    provider: sshProvider,
    instancesFile: path.join(userDataPath, 'ssh-instances.json'),
    logger: {
      log: (...args) => console.log('[transport-manager]', ...args),
      warn: (...args) => console.warn('[transport-manager]', ...args),
      error: (...args) => console.error('[transport-manager]', ...args),
    },
  })
  try {
    transportManager.loadInstances()
  } catch (loadError) {
    // Corrupt instance file: loud failure — PRESERVE the file (rename to
    // *.corrupt, reversible) before starting empty; the user's next
    // instances_set re-persists the set (never silently faked as empty).
    console.error('[dsh-chamber] 加载 SSH 实例失败：', loadError)
    const file = path.join(userDataPath, 'ssh-instances.json')
    try {
      renameSync(file, `${file}.corrupt`)
      console.warn(`[dsh-chamber] 已保留损坏的实例文件为 ${file}.corrupt`)
    } catch (renameError) {
      console.error('[dsh-chamber] 保留损坏实例文件失败：', renameError)
    }
  }
  // Capture the non-null manager before registering closures over it (the
  // ipc handlers run later, after startup).
  const sm = transportManager

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
    if (quitRequested()) return
    const smLocal = transportManager
    if (smLocal === null) return
    for (const instance of smLocal.listInstances()) {
      const status = smLocal.status(instance.id)
      if (status === null) continue
      if (status.phase !== 'error' && status.phase !== 'degraded') continue
      if (status.requiresUserAction === true) continue
      try {
        smLocal.connect(instance.id)
      } catch (error) {
        console.warn(`[dsh-chamber] 唤醒重探 ${instance.id} 失败：`, error)
      }
    }
  }

  sm.onStatusChanged((id, status) => {
    // Ready transport → per-instance reverse proxy (design 05 §7.1):
    // register the instance transport while it is ready, unregister the
    // moment it leaves ready. The transport URL only exists in the main
    // process — it never rides the renderer payload below (design 05 §8).
    const cp = controlPlane()
    if (cp !== null) {
      if (status.phase === 'ready') {
        const url = sm.readyUrl(id)
        if (url !== null) cp.registerInstanceTransport(`${status.kind}:${id}`, url)
      } else {
        cp.unregisterInstanceTransport(`${status.kind}:${id}`)
      }
    }
    const win = mainWindow()
    if (win !== null && !win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.SSH_STATUS_CHANGED, { id, status })
    }
  })

  ipcMain.handle(IPC_CHANNELS.SSH_INSTANCES_GET, trustedIpc(() => sm.listInstances()))
  ipcMain.handle(IPC_CHANNELS.SSH_INSTANCES_SET, trustedIpc((instances) => {
    // Non-array input (a page script) must not become an IPC rejection —
    // refuse the change and return the CURRENT registry (same family as
    // the {error}/null shapes of the other channels; 2026 review).
    if (!Array.isArray(instances)) {
      console.warn('[dsh-chamber] desktop_ssh_instances_set: non-array input refused')
      return sm.listInstances()
    }
    const before = new Set(sm.listInstances().map(instance => instance.id))
    let saved
    try {
      saved = sm.saveInstances(instances)
    } catch (saveError) {
      console.warn('[dsh-chamber] desktop_ssh_instances_set: save refused: ', saveError)
      return sm.listInstances()
    }
    // A removed instance's in-memory password dies with its registry entry
    // (memory-only credentials never outlive the instance they belong to).
    for (const id of before) {
      if (!saved.some(instance => instance.id === id)) setSshPassword(id, null)
    }
    // Registry-change push: the renderer App layer re-pulls immediately
    // (roster/auto-connect/reap), so add/edit/delete propagates without
    // waiting for the 30s roster poll fallback.
    const win = mainWindow()
    if (win !== null && !win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.SSH_INSTANCES_CHANGED)
    }
    return saved
  }))
  // Password auth (design 05 §8, plaintext-file fallback): the password is
  // held in MAIN-PROCESS memory and mirrored to <userData>/ssh-passwords.json
  // (0600, atomic write, loaded at startup) so password-only hosts
  // auto-connect after a restart — never in the registry, never logged,
  // and the renderer only ever holds it transiently in the form input
  // before forwarding it here. '' / null clears it (and removes the file
  // entry). The IPC is the platform gate: Win32-OpenSSH askpass support is
  // not reliable, so Windows refuses password auth loudly (keys/agent
  // remain the universal path) instead of silently failing at connect time.
  ipcMain.handle(IPC_CHANNELS.SSH_SET_PASSWORD, trustedIpc(({ id, password }) => {
    if (typeof id !== 'string' || !INSTANCE_ID_PATTERN.test(id) || !sm.listInstances().some(instance => instance.id === id)) {
      return { error: 'invalid or unknown instance id' }
    }
    if (!sshPasswordSupported()) {
      return { error: 'SSH password auth is not supported on this platform yet — use a key or ssh-agent' }
    }
    if (typeof password === 'string' && password.length > MAX_SSH_PASSWORD_CHARS) {
      return { error: `SSH password is limited to ${MAX_SSH_PASSWORD_CHARS} characters` }
    }
    try {
      setSshPassword(id, typeof password === 'string' && password !== '' ? password : null)
      return { ok: true }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }))
  // ~/.ssh/config discovery (design 05 §5): non-secret host projections
  // only (alias/hostName/user/port) — keys/proxies/credentials never leave
  // the main process.
  ipcMain.handle(IPC_CHANNELS.SSH_CONFIG_LIST, trustedIpc(() => discoverSshConfigHosts()))
  ipcMain.handle(IPC_CHANNELS.SSH_CONNECT, trustedIpc(({ id }) => {
    // Unknown ids throw ssh_instance_not_found inside connect — converge
    // it to the null shape the other status channels use (2026 review).
    try {
      return sm.connect(id)
    } catch (connectError) {
      if ((connectError as Error & { code?: string }).code === 'ssh_instance_not_found') return null
      throw connectError
    }
  }))
  ipcMain.handle(IPC_CHANNELS.SSH_DISCONNECT, trustedIpc(({ id }) => {
    sm.disconnect(id)
    return sm.status(id)
  }))
  ipcMain.handle(IPC_CHANNELS.SSH_STATUS, trustedIpc(({ id }) => sm.status(id)))
  ipcMain.handle(IPC_CHANNELS.SSH_LOGS, trustedIpc(({ id }) => sm.logs(id)))
  ipcMain.handle(IPC_CHANNELS.SSH_LOGS_CLEAR, trustedIpc(({ id }) => sm.clearLogs(id)))
  // Provider exec channel (design 05 §7.4, ssh: remote systemd): the fresh
  // status projection on success (serviceActive included), {error} on
  // failure — loud, never a silent empty success, never an unhandled
  // rejection.
  ipcMain.handle(IPC_CHANNELS.SSH_START_SERVICE, trustedIpc(({ id }) =>
    sm.exec(id, 'start').then(result => (result.ok ? result.status : { error: result.error })).catch(err => ({ error: `exec failed: ${String(err)}` })),
  ))
  ipcMain.handle(IPC_CHANNELS.SSH_STOP_SERVICE, trustedIpc(({ id }) =>
    sm.exec(id, 'stop').then(result => (result.ok ? result.status : { error: result.error })).catch(err => ({ error: `exec failed: ${String(err)}` })),
  ))
  ipcMain.handle(IPC_CHANNELS.SSH_IS_ACTIVE, trustedIpc(({ id }) =>
    sm.exec(id, 'is-active').then(result => (result.ok ? result.status : { error: result.error })).catch(err => ({ error: `exec failed: ${String(err)}` })),
  ))
  ipcMain.handle(IPC_CHANNELS.SSH_RESTART_SERVICE, trustedIpc(({ id }) =>
    sm.exec(id, 'restart').then(result =>
      (result.ok ? (result.status ?? { error: 'restart completed but no status projection' }) : { error: result.error }),
    ).catch(err => ({ error: `exec failed: ${String(err)}` })),
  ))

  return {
    transportManager: () => transportManager,
    reconnectStaleTransports,
  }
}
