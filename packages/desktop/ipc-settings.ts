/**
 * Chamber settings wiring (design 14 D7, split from main.ts — A1): owns the
 * chamber-GLOBAL settings holder (<userData>/chamber-settings.json), the
 * main-process side effects (keep-awake / login autostart / close behavior)
 * and the settings IPC surface. The decision logic lives in chamber-settings.ts
 * (pure); only the electron side effects and the IPC handlers live here.
 *
 * The window lifecycle / exit cleanup in main.ts reads the holder through the
 * returned handle: close-to-tray gating (windowCloseBehavior), the quit-risk
 * gate (quitConfirmation) and the will-quit keep-awake stop.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app, ipcMain, powerSaveBlocker } from 'electron'
import type { BrowserWindow } from 'electron'
import { IPC_CHANNELS } from './ipc-events.ts'
import type { TrustedIpc } from './renderer-trust.ts'
import {
  DEFAULT_CHAMBER_SETTINGS,
  computeSupported,
  readSettingsFile,
  validatePatch,
  writeSettingsFile,
} from './chamber-settings.ts'
import type { ChamberSettings, ChamberSettingsStatus } from './chamber-settings.ts'

/** Dependencies injected by main.ts at startup (whenReady assembly). */
export interface SettingsWiringCtx {
  trustedIpc: TrustedIpc
  mainWindow: () => BrowserWindow | null
  /** <userData> path (the settings file lives at <userData>/chamber-settings.json). */
  userDataPath: string
  /** Tray availability (main.ts's maybeCreateTray state; lazy getter so the
   *  projection reflects the tray after startup). */
  trayAvailable: () => boolean
}

/** The handle main.ts keeps: window-lifecycle reads + will-quit cleanup. */
export interface SettingsWiring {
  /** Startup: read the persisted file (corrupt → loud notice + defaults),
   *  reconcile the side effects (keep-awake / login autostart). */
  loadAndReconcile(): void
  /** Current holder — window close gating / quit risk / window-all-closed. */
  get(): ChamberSettings
  /** Non-secret projection: current values + platform capability gates. */
  settingsStatus(): ChamberSettingsStatus
  /** Apply a renderer-supplied patch (validated, side effects, persist, push). */
  applyPatch(patch: unknown): { ok: true } | { ok: false; error: string }
  /** will-quit: stop the keep-awake blocker (design 14 D5). */
  shutdownKeepAwake(): void
}

/** Chamber 设置文件路径（design 14 D7）：<userData>/chamber-settings.json。 */
const chamberSettingsFile = (userDataPath: string): string => path.join(userDataPath, 'chamber-settings.json');

export function registerSettings(ctx: SettingsWiringCtx): SettingsWiring {
  const { trustedIpc, mainWindow, userDataPath, trayAvailable } = ctx
  let chamberSettings: ChamberSettings = { ...DEFAULT_CHAMBER_SETTINGS }
  let keepAwakeBlockerId: number | null = null

  /** keep-awake（design 14 D5）：powerSaveBlocker prevent-app-suspension。 */
  function setKeepAwakeActive(enabled: boolean): void {
    const current = keepAwakeBlockerId
    const isActive = current !== null && powerSaveBlocker.isStarted(current)
    if (enabled) {
      if (!isActive) {
        keepAwakeBlockerId = powerSaveBlocker.start('prevent-app-suspension')
      }
      return
    }
    if (isActive && current !== null) {
      powerSaveBlocker.stop(current)
      keepAwakeBlockerId = null
    }
  }

  /**
   * 登录自启（design 14 D6）：macOS setLoginItemSettings；Linux XDG autostart
   * （手写最小 .desktop）；Windows v1 门控（supported=false，调用方不得持久化）。
   * 失败 loud 返回 {error}，绝不静默假成功。
   */
  function applyLaunchAtLogin(enabled: boolean): { ok: true } | { ok: false; error: string } {
    if (process.platform === 'win32') {
      return { ok: false, error: 'not supported on this platform' }
    }
    try {
      if (process.platform === 'darwin') {
        app.setLoginItemSettings({ openAtLogin: enabled })
        return { ok: true }
      }
      const autostartDir = path.join(os.homedir(), '.config', 'autostart')
      const desktopFile = path.join(autostartDir, 'dsh-chamber.desktop')
      if (enabled) {
        mkdirSync(autostartDir, { recursive: true })
        writeFileSync(
          desktopFile,
          '[Desktop Entry]\nType=Application\nName=dsh-chamber\n' +
            `Exec="${process.execPath}"\nX-GNOME-Autostart-enabled=true\n`,
          { mode: 0o600 },
        )
      } else {
        rmSync(desktopFile, { force: true })
      }
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 非秘密 chamber 设置投影（design 14 D7）：当前值 + 平台能力门控。 */
  function chamberSettingsStatus(): ChamberSettingsStatus {
    return {
      settings: chamberSettings,
      supported: computeSupported(process.platform, trayAvailable()),
    }
  }

  /** 设置变更推送（主窗口存活时；无窗口常驻期间由下次查询兜底）。 */
  function pushSettingsChanged(): void {
    const win = mainWindow()
    if (win !== null && !win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.SETTINGS_CHANGED, chamberSettingsStatus())
    }
  }

  /**
   * 应用一个已校验的设置 patch（design 14 D7）：先应用副作用（keep-awake /
   * 登录自启），**全部成功并持久化成功后才更新 holder**——任何失败 loud 返回
   * {error} 并回滚已应用的副作用（绝不落半个设置、绝不内存与磁盘不一致）。
   * windowCloseBehavior 无副作用（影响未来的 close 事件）。
   */
  function applySettingsPatch(patch: Partial<ChamberSettings>): { ok: true } | { ok: false; error: string } {
    // notifications 是嵌套对象：patch 可能只带部分子键（validatePatch 允许 partial），
    // 必须 deep-merge 到当前值，绝不整组替换丢开关。
    const next: ChamberSettings = {
      ...chamberSettings,
      ...patch,
      notifications: patch.notifications !== undefined
        ? { ...chamberSettings.notifications, ...patch.notifications }
        : chamberSettings.notifications,
    }
    // 副作用应用包 try：powerSaveBlocker / 登录自启意外抛异常时 loud 失败并
    // best-effort 回滚 keepAwake，绝不带病继续（绝不落半个设置）。
    try {
      if (patch.keepAwake !== undefined) setKeepAwakeActive(patch.keepAwake)
      if (patch.launchAtLogin !== undefined) {
        const result = applyLaunchAtLogin(patch.launchAtLogin)
        if (!result.ok) {
          // 副作用失败：回滚已应用的 keepAwake（保持原状），绝不持久化。
          if (patch.keepAwake !== undefined) setKeepAwakeActive(chamberSettings.keepAwake)
          return result
        }
      }
    } catch (error) {
      console.error('[dsh-chamber] 应用 chamber 设置副作用失败：', error)
      try {
        if (patch.keepAwake !== undefined) setKeepAwakeActive(chamberSettings.keepAwake)
      } catch {
        // 回滚失败也 loud 已记日志，不再叠加异常。
      }
      return { ok: false, error: 'settings apply failed' }
    }
    try {
      writeSettingsFile(chamberSettingsFile(userDataPath), next)
    } catch (error) {
      console.error('[dsh-chamber] 写入 chamber 设置失败：', error)
      // 持久化失败：回滚已应用的副作用，holder 保持旧值——内存/磁盘/实际行为一致。
      if (patch.keepAwake !== undefined) setKeepAwakeActive(chamberSettings.keepAwake)
      if (patch.launchAtLogin !== undefined) {
        const rollback = applyLaunchAtLogin(chamberSettings.launchAtLogin)
        if (!rollback.ok) console.error(`[dsh-chamber] 登录自启回滚失败：${rollback.error}`)
      }
      return { ok: false, error: 'settings persist failed' }
    }
    chamberSettings = next
    return { ok: true }
  }

  /** Chamber settings IPC 面：get 查询 / set 应用并持久化 / 变更推送。全部走
   *  trustedIpc 围栏；失败 loud {error}，绝不静默假成功。 */
  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET, trustedIpc(() => chamberSettingsStatus()))
  ipcMain.handle(IPC_CHANNELS.SETTINGS_SET, trustedIpc(({ patch }) => {
    const validated = validatePatch(patch)
    // Uniform {ok,error} shape for every failure (2026 review) — the
    // validation failure previously returned a bare {error}.
    if (!validated.ok) return { ok: false, error: validated.error }
    const applied = applySettingsPatch(validated.patch)
    if (!applied.ok) return applied
    pushSettingsChanged()
    return chamberSettingsStatus()
  }))

  return {
    loadAndReconcile() {
      // Chamber settings（design 14 D7）：启动加载 + 应用副作用（keep-awake /
      // 登录自启 reconcile）；损坏 loud（*.corrupt 保留），绝不静默假默认。
      const settingsLoad = readSettingsFile(chamberSettingsFile(userDataPath))
      if (settingsLoad.notice !== null) console.error(`[dsh-chamber] ${settingsLoad.notice}`)
      chamberSettings = settingsLoad.settings
      setKeepAwakeActive(chamberSettings.keepAwake)
      if (process.platform !== 'win32') {
        const loginItemResult = applyLaunchAtLogin(chamberSettings.launchAtLogin)
        if (!loginItemResult.ok) {
          console.warn(`[dsh-chamber] 登录自启 reconcile 失败：${loginItemResult.error}`)
        }
      }
    },
    get: () => chamberSettings,
    settingsStatus: chamberSettingsStatus,
    applyPatch: applySettingsPatch,
    shutdownKeepAwake() {
      setKeepAwakeActive(false)
    },
  }
}
