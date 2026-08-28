/**
 * Update wiring (design 11, split from main.ts — A1): the update controller
 * lifecycle (silent startup-delay + 6h checks, user-confirmed download, quit-
 * time install), the update IPC surface and the settings section's「前往下载
 * 页」allowlist. The controller state machine lives in updater.ts; the IPC
 * handlers and the main-process shell/dialog side effects live here.
 *
 * main.ts keeps the updateState() handle for the before-quit confirmation
 * exemption (design 14 D2: a downloaded update installs on quit — the user
 * already confirmed「更新」).
 */

import { ipcMain, shell } from 'electron'
import type { BrowserWindow } from 'electron'
import { IPC_CHANNELS } from './ipc-events.ts'
import type { TrustedIpc } from './renderer-trust.ts'
import { createUpdateController, openReleasePage } from './updater.ts'

/** Dependencies injected by main.ts at startup (whenReady assembly). */
export interface UpdateWiringCtx {
  trustedIpc: TrustedIpc
  mainWindow: () => BrowserWindow | null
  /** The running chamber version (desktop package.json). */
  appVersion: string
}

/** The handle main.ts keeps: the before-quit exemption read. */
export interface UpdateWiring {
  /** Current controller state subset read by the quit-confirmation exemption
   *  (undefined = the controller was never created). */
  updateState(): { phase: string; installBlockedReason: string | null } | undefined
}

export function registerUpdate(ctx: UpdateWiringCtx): UpdateWiring {
  const { trustedIpc, mainWindow, appVersion } = ctx

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
    version: appVersion,
    logger: {
      log: (...args) => console.log('[updater]', ...args),
      warn: (...args) => console.warn('[updater]', ...args),
      error: (...args) => console.error('[updater]', ...args),
    },
  })
  updater.subscribe((updateState) => {
    const win = mainWindow()
    if (win !== null && !win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.UPDATE_STATE_CHANGED, updateState)
    }
  })
  ipcMain.handle(IPC_CHANNELS.UPDATE_STATE, trustedIpc(() => updater.state()))
  ipcMain.handle(IPC_CHANNELS.UPDATE_CHECK, trustedIpc(() => updater.checkNow()))
  ipcMain.handle(IPC_CHANNELS.UPDATE_DOWNLOAD, trustedIpc(() => updater.download()))
  // The settings update section's「前往下载页」link: popups are denied and
  // navigation is pinned to the control-plane origin, so opening a release
  // page must go through the main process. Strict allowlist — parsed, not
  // prefix-string matched: only this repo's GitHub pages can ever be opened
  // (never an arbitrary URL, subdomain, userinfo or path-root trick).
  ipcMain.handle(IPC_CHANNELS.OPEN_RELEASE, trustedIpc(async ({ url }) => {
    const result = await openReleasePage(url, value => shell.openExternal(value))
    if (!result.ok && result.error === 'open release page failed') {
      // Do not print the thrown error: an OS handler can include a local path.
      console.error('[dsh-chamber] 打开下载页失败')
    }
    return result
  }))
  updater.start()

  return {
    updateState: () => updater.state(),
  }
}
