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
import { createUpdateController } from './updater.ts'

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
  if (typeof raw !== 'string') return false
  try {
    const url = new URL(raw)
    if (url.origin !== 'https://github.com') return false
    if (url.username !== '' || url.password !== '') return false
    // Decode + re-normalize the pathname: an encoded traversal then normalizes
    // like a literal one and fails the prefix check instead of escaping it.
    const normalized = new URL(`https://github.com${decodeURIComponent(url.pathname)}`).pathname
    return normalized.startsWith('/panzeyu2013/dsh-chamber/')
  } catch {
    return false
  }
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
  ipcMain.handle(IPC_CHANNELS.OPEN_RELEASE, trustedIpc(({ url }) => {
    if (!isAllowedReleaseUrl(url)) {
      return { ok: false, error: 'url not allowed' }
    }
    void shell.openExternal(url).catch(err => console.error('[dsh-chamber] 打开下载页失败：', err))
    return { ok: true }
  }))
  updater.start()

  return {
    updateState: () => updater.state(),
  }
}
