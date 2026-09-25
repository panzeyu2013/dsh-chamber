/**
 * Shell-owned copy for the Electron flavor — the upstream analogue is
 * apps/desktop/src/locale.ts (typed en/zh dictionaries + resolveDesktopLocale()).
 * Scope: the strings the **native chrome** renders itself (tray, error boxes, the
 * quit dialog). The Web UI owns its own i18n and is untouched.
 *
 * Rule mirrored from upstream: `zh*` → zh-CN, everything else → en.
 */

export type ShellLocaleId = 'zh-CN' | 'en'

export interface ShellStrings {
  /** Word used in the tray tooltip next to the control-plane URL. */
  readonly controlPlane: string
  readonly trayShowWindow: string
  readonly trayQuit: string
  readonly startupFailedTitle: string
  readonly rendererCrashedTitle: string
  readonly rendererCrashedMessage: string
  readonly alreadyRunningTitle: string
  readonly quitConfirmTitle: string
  /** `<prefix><reasons joined by join><suffix>` — the reasons come from core. */
  readonly quitDetailPrefix: string
  readonly quitDetailJoin: string
  readonly quitDetailSuffix: string
  readonly quitButton: string
  readonly cancelButton: string
  /** 致命启动失败恢复框：重启（走既有清理链后 relaunch）。 */
  readonly restartButton: string
  /** 致命启动失败恢复框：安全模式重启（跳过 chamber 宿主包 seeding 与 extra rows）。 */
  readonly safeModeRestartButton: string
}

const ZH: ShellStrings = {
  controlPlane: '控制面',
  trayShowWindow: '显示窗口',
  trayQuit: '退出 dsh-chamber',
  startupFailedTitle: 'dsh-chamber 启动失败',
  rendererCrashedTitle: 'dsh-chamber 前端异常',
  rendererCrashedMessage: '前端渲染进程反复崩溃，已停止自动恢复。请重新启动应用。',
  alreadyRunningTitle: 'dsh-chamber 已在运行',
  quitConfirmTitle: '退出 dsh-chamber？',
  quitDetailPrefix: '退出将停止',
  quitDetailJoin: '与',
  quitDetailSuffix: '。确定退出？',
  quitButton: '退出',
  cancelButton: '取消',
  restartButton: '重启',
  safeModeRestartButton: '安全模式重启',
}

const EN: ShellStrings = {
  controlPlane: 'control plane',
  trayShowWindow: 'Show Window',
  trayQuit: 'Quit dsh-chamber',
  startupFailedTitle: 'dsh-chamber failed to start',
  rendererCrashedTitle: 'dsh-chamber renderer error',
  rendererCrashedMessage: 'The renderer process crashed repeatedly, so automatic recovery stopped. Restart the application.',
  alreadyRunningTitle: 'dsh-chamber is already running',
  quitConfirmTitle: 'Quit dsh-chamber?',
  quitDetailPrefix: 'Quitting stops ',
  quitDetailJoin: ' and ',
  quitDetailSuffix: '. Quit anyway?',
  quitButton: 'Quit',
  cancelButton: 'Cancel',
  restartButton: 'Restart',
  safeModeRestartButton: 'Restart in safe mode',
}

export const SHELL_STRINGS: Record<ShellLocaleId, ShellStrings> = { 'zh-CN': ZH, en: EN }

/** Upstream `resolveDesktopLocale(locale)`: any `zh*` locale → zh-CN, else en. */
export function resolveShellLocale(locale: string): ShellLocaleId {
  return locale.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'
}

/** The shell copy for Electron's `app.getLocale()`. */
export function shellStrings(locale: string): ShellStrings {
  return SHELL_STRINGS[resolveShellLocale(locale)]
}
